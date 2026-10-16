import { existsSync, readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { workspace } from 'vscode';
import { toFsPath } from '../utils/fileUtils';

export interface LegacyProjectConfig {
    projectFile: string;
    projectDir: string;
    exeOutputDir: string;
    dcuOutputDir: string;
    unitPaths: string[];
    includePaths: string[];
    resourcePaths: string[];
    objectPaths: string[];
    conditionals: string;
    unitAliases: string;
    switches: string[];
    dprUnitFiles: Map<string, string>;
    browsingPaths: string[];
}

const DEFAULT_ALIASES = 'WinTypes=Windows;WinProcs=Windows;DbiTypes=BDE;DbiProcs=BDE;DbiErrs=BDE';

/**
 * Fixes common Windows drive-relative path typos such as "c:Dev\..." -> "c:\Dev\..."
 * and resolves against baseDir when relative.
 */
export function resolveLegacyPath(baseDir: string, rawPath: string): string {
    const trimmed = rawPath.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed || trimmed.includes('${')) {
        return '';
    }
    const fixedDrive = trimmed.replace(/^([a-zA-Z]):(?![\\/])/, '$1:\\');
    return path.isAbsolute(fixedDrive)
        ? path.normalize(fixedDrive)
        : path.resolve(baseDir, fixedDrive);
}

/**
 * Splits a semicolon-separated path list, resolves each against baseDir, and returns existing directories.
 */
function resolvePathList(baseDir: string, rawList: string): string[] {
    const result: string[] = [];
    for (const part of rawList.split(';')) {
        const resolved = resolveLegacyPath(baseDir, part);
        if (resolved && existsSync(resolved)) {
            result.push(resolved);
        }
    }
    return result;
}

/**
 * Deduplicates paths case-insensitively while preserving order.
 */
function uniquePaths(paths: Iterable<string>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const p of paths) {
        if (!p) continue;
        const normalized = path.normalize(p);
        const key = normalized.toLowerCase();
        if (!seen.has(key) && existsSync(normalized)) {
            seen.add(key);
            result.push(normalized);
        }
    }
    return result;
}

interface WantConfig {
    defaultProject?: string;
    exeOutputDir?: string;
    dcuOutputDir?: string;
    unitPaths: string[];
    includePaths: string[];
    resourcePaths: string[];
    defines: string[];
    useCfg: boolean;
    writeableConst: boolean;
}

/**
 * Parses a workspace want.xml file if present.
 */
function parseWantXml(wantXmlPath: string): WantConfig | undefined {
    if (!existsSync(wantXmlPath)) {
        return undefined;
    }
    let content: string;
    try {
        content = readFileSync(wantXmlPath, 'utf8');
    } catch {
        return undefined;
    }

    const wantDir = path.dirname(wantXmlPath);
    const props = new Map<string, string>();
    props.set('basedir', wantDir);

    const propRegex = /<property\s+name="([^"]+)"\s+value="([^"]*)"/gi;
    let match: RegExpExecArray | null;
    while ((match = propRegex.exec(content)) !== null) {
        props.set(match[1], match[2]);
    }

    const interpolate = (val: string): string =>
        val.replace(/\$\{([^}]+)\}/g, (_, name: string) => props.get(name) ?? `\${${name}}`);

    const extractPatternSet = (id: string): string[] => {
        const blockRegex = new RegExp(
            `<patternset\\s+id="${id}"[^>]*>([\\s\\S]*?)<\\/patternset>`,
            'i'
        );
        const blockMatch = blockRegex.exec(content);
        if (!blockMatch) return [];
        const body = blockMatch[1].replace(/<!--[\s\S]*?-->/g, '');
        const incRegex = /<include\s+name="([^"]+)"/gi;
        const paths: string[] = [];
        let incMatch: RegExpExecArray | null;
        while ((incMatch = incRegex.exec(body)) !== null) {
            const resolved = resolveLegacyPath(wantDir, interpolate(incMatch[1]));
            if (resolved && existsSync(resolved)) {
                paths.push(resolved);
            }
        }
        return paths;
    };

    const sourceDir = props.get('sourcedir');
    const sourceName = props.get('source');
    let defaultProject: string | undefined;
    if (sourceDir && sourceName) {
        const candidate = resolveLegacyPath(
            wantDir,
            path.join(interpolate(sourceDir), `${interpolate(sourceName)}.dpr`)
        );
        if (candidate && existsSync(candidate)) {
            defaultProject = candidate;
        }
    }

    const exeOutRaw = props.get('exeout');
    const dcuOutRaw = props.get('dcuout');
    const definesRaw = props.get('defines') ?? '';
    const defines = definesRaw
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean);

    const useCfg = !/<usecfg\s+value="false"/i.test(content);
    const writeableConst = /<writeableconst\s+value="true"/i.test(content);

    return {
        defaultProject,
        exeOutputDir: exeOutRaw ? resolveLegacyPath(wantDir, interpolate(exeOutRaw)) : undefined,
        dcuOutputDir: dcuOutRaw ? resolveLegacyPath(wantDir, interpolate(dcuOutRaw)) : undefined,
        unitPaths: extractPatternSet('unitpath'),
        includePaths: extractPatternSet('includepath'),
        resourcePaths: extractPatternSet('resourcepath'),
        defines,
        useCfg,
        writeableConst,
    };
}

interface DofConfig {
    searchPaths: string[];
    debugSourceDirs: string[];
    outputDir?: string;
    unitOutputDir?: string;
    conditionals: string[];
    unitAliases?: string;
}

/**
 * Parses a Delphi 6 .dof (INI format) project options file.
 */
function parseDofFile(dofPath: string): DofConfig | undefined {
    if (!existsSync(dofPath)) {
        return undefined;
    }
    let content: string;
    try {
        content = readFileSync(dofPath, 'latin1');
    } catch {
        return undefined;
    }

    const baseDir = path.dirname(dofPath);
    let currentSection = '';
    const searchPaths: string[] = [];
    const debugSourceDirs: string[] = [];
    let outputDir: string | undefined;
    let unitOutputDir: string | undefined;
    const conditionals: string[] = [];
    let unitAliases: string | undefined;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';')) continue;
        const secMatch = /^\[([^\]]+)\]$/.exec(line);
        if (secMatch) {
            currentSection = secMatch[1].toLowerCase();
            continue;
        }
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) continue;
        const key = line.slice(0, eqIdx).trim().toLowerCase();
        const val = line.slice(eqIdx + 1).trim();

        if (currentSection === 'directories') {
            if (key === 'searchpath') {
                searchPaths.push(...resolvePathList(baseDir, val));
            } else if (key === 'debugsourcedirs') {
                debugSourceDirs.push(...resolvePathList(baseDir, val));
            } else if (key === 'outputdir' && val) {
                outputDir = resolveLegacyPath(baseDir, val);
            } else if (key === 'unitoutputdir' && val) {
                unitOutputDir = resolveLegacyPath(baseDir, val);
            } else if (key === 'conditionals' && val) {
                conditionals.push(
                    ...val
                        .split(';')
                        .map((c) => c.trim())
                        .filter(Boolean)
                );
            }
        } else if (currentSection === 'compiler') {
            if (key === 'unitaliases' && val) {
                unitAliases = val.replace(/;+$/, '');
            }
        }
    }

    return {
        searchPaths,
        debugSourceDirs,
        outputDir,
        unitOutputDir,
        conditionals,
        unitAliases,
    };
}

interface CfgConfig {
    unitPaths: string[];
    includePaths: string[];
    resourcePaths: string[];
    objectPaths: string[];
    outputDir?: string;
    unitOutputDir?: string;
    conditionals: string[];
    unitAliases?: string;
    switches: string[];
}

/**
 * Parses a Delphi .cfg file (such as <project>.cfg or dcc32.cfg).
 */
function parseCfgFile(cfgPath: string): CfgConfig | undefined {
    if (!existsSync(cfgPath)) {
        return undefined;
    }
    let content: string;
    try {
        content = readFileSync(cfgPath, 'latin1');
    } catch {
        return undefined;
    }

    const baseDir = path.dirname(cfgPath);
    const unitPaths: string[] = [];
    const includePaths: string[] = [];
    const resourcePaths: string[] = [];
    const objectPaths: string[] = [];
    let outputDir: string | undefined;
    let unitOutputDir: string | undefined;
    const conditionals: string[] = [];
    let unitAliases: string | undefined;
    const switches: string[] = [];

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('-')) continue;
        if (line.startsWith('-$')) {
            switches.push(line);
            continue;
        }
        const flag = line.slice(0, 2).toUpperCase();
        const rest = line
            .slice(2)
            .trim()
            .replace(/^"(.*)"$/, '$1');
        if (!rest) continue;

        switch (flag) {
            case '-U':
                unitPaths.push(...resolvePathList(baseDir, rest));
                break;
            case '-I':
                includePaths.push(...resolvePathList(baseDir, rest));
                break;
            case '-R':
                resourcePaths.push(...resolvePathList(baseDir, rest));
                break;
            case '-O':
                objectPaths.push(...resolvePathList(baseDir, rest));
                break;
            case '-E':
                outputDir = resolveLegacyPath(baseDir, rest);
                break;
            case '-N':
                unitOutputDir = resolveLegacyPath(baseDir, rest);
                break;
            case '-D':
                conditionals.push(
                    ...rest
                        .split(';')
                        .map((c) => c.trim())
                        .filter(Boolean)
                );
                break;
            case '-A':
                unitAliases = rest.replace(/;+$/, '');
                break;
        }
    }

    return {
        unitPaths,
        includePaths,
        resourcePaths,
        objectPaths,
        outputDir,
        unitOutputDir,
        conditionals,
        unitAliases,
        switches,
    };
}

/**
 * Parses `UnitName in 'path\UnitName.pas'` entries from a .dpr or .dpk file.
 */
function parseDprUnits(dprPath: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!existsSync(dprPath)) {
        return map;
    }
    let content: string;
    try {
        content = readFileSync(dprPath, 'latin1');
    } catch {
        return map;
    }

    const baseDir = path.dirname(dprPath);
    const inRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s+in\s+'([^']+)'/gi;
    let match: RegExpExecArray | null;
    while ((match = inRegex.exec(content)) !== null) {
        const unitName = match[1].toLowerCase();
        const unitPath = resolveLegacyPath(baseDir, match[2]);
        if (unitPath && existsSync(unitPath)) {
            map.set(unitName, unitPath);
        }
    }
    return map;
}

/**
 * Collects subdirectories up to maxDepth that contain .pas or .inc files.
 */
function collectSourceSubdirs(rootDir: string, maxDepth: number): string[] {
    if (!existsSync(rootDir)) {
        return [];
    }
    const result: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > maxDepth) return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        let hasPas = false;
        for (const entry of entries) {
            if (entry.isFile() && /\.(pas|inc)$/i.test(entry.name)) {
                hasPas = true;
            } else if (
                entry.isDirectory() &&
                !/^(demos|backup|indy_old|extradevicesbkup)/i.test(entry.name)
            ) {
                walk(path.join(dir, entry.name), depth + 1);
            }
        }
        if (hasPas) {
            result.push(dir);
        }
    };
    walk(rootDir, 0);
    return result;
}

/**
 * Normalizes a configured project/config path (.dpr, .dpk, .dof, .cfg) to its .dpr or .dpk file.
 */
export function resolveDprFromConfigPath(configPath: string): string | undefined {
    if (!configPath || configPath === 'no_config_available') {
        return undefined;
    }
    const fsPath = toFsPath(configPath);
    if (!existsSync(fsPath)) {
        return undefined;
    }
    const ext = path.extname(fsPath).toLowerCase();
    if (ext === '.dpr' || ext === '.dpk') {
        return fsPath;
    }
    if (ext === '.dof' || ext === '.cfg') {
        const base = fsPath.slice(0, -ext.length);
        for (const candidateExt of ['.dpr', '.dpk']) {
            if (existsSync(base + candidateExt)) {
                return base + candidateExt;
            }
        }
    }
    return undefined;
}

/**
 * Resolves the full LegacyProjectConfig for the active workspace and Delphi 6 bin directory.
 */
export function resolveLegacyProjectConfig(
    binDir: string,
    configuredFile?: string
): LegacyProjectConfig {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const delphiRoot = path.resolve(binDir, '..');
    const wantConfig = parseWantXml(path.join(workspaceRoot, 'want.xml'));

    let projectFile = configuredFile ? resolveDprFromConfigPath(configuredFile) : undefined;
    if (!projectFile && wantConfig?.defaultProject) {
        projectFile = wantConfig.defaultProject;
    }
    if (!projectFile) {
        projectFile = path.join(workspaceRoot, 'default.dpr');
    }

    const projectDir = existsSync(projectFile) ? path.dirname(projectFile) : workspaceRoot;
    const projectBase = projectFile.replace(/\.[^.]+$/, '');
    const dofConfig = parseDofFile(projectBase + '.dof');
    const cfgConfig = parseCfgFile(projectBase + '.cfg');
    const binCfgConfig = parseCfgFile(path.join(binDir, 'dcc32.cfg'));
    const dprUnitFiles = parseDprUnits(projectFile);

    const dprUnitDirs = Array.from(dprUnitFiles.values()).map((f) => path.dirname(f));

    const delphiLibDirs = [
        path.join(delphiRoot, 'Lib'),
        binDir,
        path.join(delphiRoot, 'Imports'),
        path.join(delphiRoot, 'Projects', 'Bpl'),
    ];

    // If want.xml specifies usecfg="false", prefer want.xml's unitpath over .cfg/.dof paths
    // that point into Indy\Lib source folders (which shadow precompiled Indy D6 DCUs).
    const filterShadowingCfgPaths = (paths: string[]): string[] => {
        if (!wantConfig || wantConfig.useCfg) {
            return paths;
        }
        return paths.filter((p) => !/[\\/]indy[\\/]lib[\\/]/i.test(p));
    };

    const unitPaths = uniquePaths([
        ...delphiLibDirs,
        ...(wantConfig?.unitPaths ?? []),
        ...(binCfgConfig?.unitPaths ?? []),
        projectDir,
        ...dprUnitDirs,
        ...filterShadowingCfgPaths(dofConfig?.searchPaths ?? []),
        ...filterShadowingCfgPaths(cfgConfig?.unitPaths ?? []),
    ]);

    const includePaths = uniquePaths([
        ...unitPaths,
        ...(wantConfig?.includePaths ?? []),
        ...(cfgConfig?.includePaths ?? []),
    ]);

    const resourcePaths = uniquePaths([
        ...unitPaths,
        ...(wantConfig?.resourcePaths ?? []),
        ...(cfgConfig?.resourcePaths ?? []),
    ]);

    const objectPaths = uniquePaths([...unitPaths, ...(cfgConfig?.objectPaths ?? [])]);

    const condSet = new Set<string>();
    for (const c of [
        ...(wantConfig?.defines ?? []),
        ...(dofConfig?.conditionals ?? []),
        ...(cfgConfig?.conditionals ?? []),
    ]) {
        if (c) condSet.add(c);
    }
    const conditionals = Array.from(condSet).join(';');

    const unitAliases =
        dofConfig?.unitAliases ??
        cfgConfig?.unitAliases ??
        binCfgConfig?.unitAliases ??
        DEFAULT_ALIASES;

    const switches = [...(cfgConfig?.switches ?? [])];
    if (wantConfig?.writeableConst && !switches.includes('-$J+')) {
        switches.push('-$J+');
    }

    const exeOutputDir =
        wantConfig?.exeOutputDir ?? dofConfig?.outputDir ?? cfgConfig?.outputDir ?? projectDir;
    const dcuOutputDir =
        wantConfig?.dcuOutputDir ??
        dofConfig?.unitOutputDir ??
        cfgConfig?.unitOutputDir ??
        projectDir;

    const delphiSourceDirs = collectSourceSubdirs(path.join(delphiRoot, 'Source'), 3);
    const componentSourceDirs = collectSourceSubdirs(
        path.join(workspaceRoot, 'Components', 'Src'),
        3
    );

    const browsingPaths = uniquePaths([
        projectDir,
        ...dprUnitDirs,
        ...unitPaths,
        ...(dofConfig?.searchPaths ?? []),
        ...(dofConfig?.debugSourceDirs ?? []),
        ...(cfgConfig?.unitPaths ?? []),
        ...componentSourceDirs,
        ...delphiSourceDirs,
    ]);

    return {
        projectFile,
        projectDir,
        exeOutputDir,
        dcuOutputDir,
        unitPaths,
        includePaths,
        resourcePaths,
        objectPaths,
        conditionals,
        unitAliases,
        switches,
        dprUnitFiles,
        browsingPaths,
    };
}
