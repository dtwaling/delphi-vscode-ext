import { ChildProcess, execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
    Disposable,
    languages,
    Position,
    Range,
    StatusBarAlignment,
    StatusBarItem,
    TextDocument,
    Uri,
    window,
    workspace,
} from 'vscode';
import { DCC32_BIN } from '../constants';
import {
    LegacyProjectConfig,
    resolveLegacyPath,
    resolveLegacyProjectConfig,
} from './projectConfig';

export type LegacyDiagnosticsSeverity = 'errors' | 'warnings' | 'hints' | 'off';
export type LegacyDiagnosticsTrigger = 'openAndSave' | 'saveOnly' | 'manual';

export class LegacyDiagnosticsManager implements Disposable {
    private readonly collection: DiagnosticCollection;
    private readonly statusBar: StatusBarItem;
    private readonly disposables: Disposable[] = [];
    private readonly tmpExeDir: string;
    private readonly tmpDcuDir: string;
    private activeProcess: ChildProcess | undefined;
    private cachedConfig: LegacyProjectConfig | undefined;
    private binDir: string;

    constructor(binDir: string) {
        this.binDir = binDir;
        this.collection = languages.createDiagnosticCollection('delphi-dcc32');
        this.statusBar = window.createStatusBarItem(StatusBarAlignment.Left, 0);

        const wsPath = workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
        const hash = createHash('md5').update(wsPath.toLowerCase()).digest('hex').slice(0, 10);
        const cacheBase = path.join(os.tmpdir(), `delphi-vscode-d6-${hash}`);
        this.tmpExeDir = path.join(cacheBase, 'exe');
        this.tmpDcuDir = path.join(cacheBase, 'dcu');
        mkdirSync(this.tmpExeDir, { recursive: true });
        mkdirSync(this.tmpDcuDir, { recursive: true });

        this.disposables.push(
            this.collection,
            this.statusBar,
            workspace.onDidOpenTextDocument((doc) => {
                if (this.getTrigger() === 'openAndSave') {
                    this.checkDocument(doc);
                }
            }),
            workspace.onDidSaveTextDocument((doc) => {
                const trigger = this.getTrigger();
                if (trigger === 'openAndSave' || trigger === 'saveOnly') {
                    this.checkDocument(doc);
                }
            }),
            workspace.onDidCloseTextDocument((doc) => {
                this.collection.delete(doc.uri);
            })
        );

        // Check currently active Pascal editor if trigger is openAndSave
        if (this.getTrigger() === 'openAndSave' && window.activeTextEditor) {
            this.checkDocument(window.activeTextEditor.document);
        }
    }

    public updateBinDir(binDir: string) {
        this.binDir = binDir;
        this.cachedConfig = undefined;
    }

    public invalidateConfig() {
        this.cachedConfig = undefined;
        this.collection.clear();
        if (this.getTrigger() === 'openAndSave' && window.activeTextEditor) {
            this.checkDocument(window.activeTextEditor.document);
        }
    }

    public getProjectConfig(): LegacyProjectConfig {
        if (!this.cachedConfig) {
            const configured = workspace.getConfiguration('delphi').get<string>('configFile');
            this.cachedConfig = resolveLegacyProjectConfig(this.binDir, configured);
        }
        return this.cachedConfig;
    }

    private getSeveritySetting(): LegacyDiagnosticsSeverity {
        return (
            workspace
                .getConfiguration('delphi')
                .get<LegacyDiagnosticsSeverity>('legacyDiagnosticsSeverity') ?? 'errors'
        );
    }

    private getTrigger(): LegacyDiagnosticsTrigger {
        return (
            workspace
                .getConfiguration('delphi')
                .get<LegacyDiagnosticsTrigger>('legacyDiagnosticsTrigger') ?? 'openAndSave'
        );
    }

    public checkDocument(document: TextDocument, isManual = false) {
        if (document.languageId !== 'objectpascal' || document.uri.scheme !== 'file') {
            return;
        }
        const filePath = document.uri.fsPath;
        const ext = path.extname(filePath).toLowerCase();
        // .inc files cannot be compiled standalone by dcc32.exe
        if (ext === '.inc' && !isManual) {
            return;
        }

        const severitySetting = this.getSeveritySetting();
        if (severitySetting === 'off' && !isManual) {
            this.collection.clear();
            return;
        }

        const dcc32Path = path.join(this.binDir, DCC32_BIN);
        if (!existsSync(dcc32Path)) {
            return;
        }

        if (this.activeProcess) {
            this.activeProcess.kill();
            this.activeProcess = undefined;
        }

        const config = this.getProjectConfig();
        const fileDir = path.dirname(filePath);
        const isProjectFile = ext === '.dpr' || ext === '.dpk';
        const cwd = isProjectFile ? fileDir : this.tmpExeDir;

        const uPaths = [this.tmpDcuDir, fileDir, ...config.unitPaths].join(';');
        const iPaths = [fileDir, ...config.includePaths].join(';');
        const rPaths = [fileDir, ...config.resourcePaths].join(';');
        const oPaths = [fileDir, ...config.objectPaths].join(';');

        const args: string[] = [
            '-M',
            '-Q',
            ...config.switches,
            `-E${this.tmpExeDir}`,
            `-N${this.tmpDcuDir}`,
            `-U${uPaths}`,
            `-I${iPaths}`,
            `-R${rPaths}`,
            `-O${oPaths}`,
        ];

        if (config.unitAliases) {
            args.push(`-A${config.unitAliases}`);
        }
        if (config.conditionals) {
            args.push(`-D${config.conditionals}`);
        }
        args.push(filePath);

        this.statusBar.text = `$(sync~spin) Delphi 6: Checking ${path.basename(filePath)}...`;
        this.statusBar.show();

        const proc = execFile(
            dcc32Path,
            args,
            { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
            (_error, stdout, stderr) => {
                if (this.activeProcess === proc) {
                    this.activeProcess = undefined;
                    this.statusBar.hide();
                }
                const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
                this.publishDiagnostics(document.uri, cwd, combined, severitySetting, isManual);
            }
        );

        this.activeProcess = proc;
    }

    private publishDiagnostics(
        checkedUri: Uri,
        cwd: string,
        output: string,
        severitySetting: LegacyDiagnosticsSeverity,
        isManual: boolean
    ) {
        const effectiveSetting = severitySetting === 'off' && isManual ? 'errors' : severitySetting;
        const byFile = new Map<string, { uri: Uri; list: Diagnostic[] }>();

        // Always clear previous diagnostics for the checked document
        byFile.set(checkedUri.fsPath.toLowerCase(), { uri: checkedUri, list: [] });

        const lineRegex = /^(.+?)\((\d+)\)\s+(Fatal|Error|Warning|Hint):\s+(.*)$/i;
        for (const rawLine of output.split(/\r?\n|\r/)) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            const match = lineRegex.exec(trimmed);
            if (!match) continue;

            const rawFile = match[1].trim();
            const lineNum = Math.max(0, parseInt(match[2], 10) - 1);
            const kind = match[3].toLowerCase();
            const message = match[4].trim();

            if (!this.shouldIncludeKind(kind, effectiveSetting)) {
                continue;
            }

            const resolvedPath = resolveLegacyPath(cwd, rawFile);
            if (!resolvedPath) continue;

            const severity =
                kind === 'fatal' || kind === 'error'
                    ? DiagnosticSeverity.Error
                    : kind === 'warning'
                      ? DiagnosticSeverity.Warning
                      : DiagnosticSeverity.Information;

            const range = new Range(new Position(lineNum, 0), new Position(lineNum, 200));
            const diag = new Diagnostic(range, message, severity);
            diag.source = `dcc32 (${match[3]})`;

            const key = resolvedPath.toLowerCase();
            let entry = byFile.get(key);
            if (!entry) {
                entry = { uri: Uri.file(resolvedPath), list: [] };
                byFile.set(key, entry);
            }
            entry.list.push(diag);
        }

        for (const { uri, list } of byFile.values()) {
            this.collection.set(uri, list);
        }
    }

    private shouldIncludeKind(kind: string, setting: LegacyDiagnosticsSeverity): boolean {
        if (setting === 'off') return false;
        if (kind === 'fatal' || kind === 'error') return true;
        if (kind === 'warning') return setting === 'warnings' || setting === 'hints';
        if (kind === 'hint') return setting === 'hints';
        return false;
    }

    public clear() {
        if (this.activeProcess) {
            this.activeProcess.kill();
            this.activeProcess = undefined;
        }
        this.statusBar.hide();
        this.collection.clear();
    }

    public dispose() {
        this.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
