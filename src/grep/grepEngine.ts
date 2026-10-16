import { execFileSync } from 'child_process';
import { Dirent, existsSync, readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { TabInputText, Uri, window, workspace } from 'vscode';
import { getConfigFilePath, loadConfigFileJson } from '../client/configFile';
import { resolveDprFromConfigPath, resolveLegacyProjectConfig } from '../legacy/projectConfig';
import { isDelphiEnabled, resolveDelphiToolchain } from '../utils/constantUtils';
import { toCleanFsPath, toFsPath } from '../utils/fileUtils';

export type GxGrepScope = 'current' | 'open' | 'project' | 'directory' | 'results';

export interface GxGrepSettings {
    pattern: string;
    scope: GxGrepScope;
    caseSensitive: boolean;
    wholeWord: boolean;
    isRegex: boolean;
    includeForms: boolean;
    dfmMultiline: boolean;
    dfmSpecialChars: boolean;
    includeCode: boolean;
    includeStrings: boolean;
    includeComments: boolean;
    sectionInterface: boolean;
    sectionImplementation: boolean;
    sectionInitialization: boolean;
    sectionFinalization: boolean;
    directoryPath: string;
    fileMask: string;
    includeSubdirs: boolean;
    excludedDirs: string;
    contextRadius: number;
}

export interface GxGrepMatchRange {
    /** 1-based inclusive start column */
    startCol: number;
    /** 1-based inclusive end column */
    endCol: number;
}

export interface GxGrepLineResult {
    /** 1-based line number */
    lineNo: number;
    lineText: string;
    matches: GxGrepMatchRange[];
}

export interface GxGrepFileResult {
    filePath: string;
    relativePath: string;
    isFormFile: boolean;
    expanded: boolean;
    totalLines: number;
    totalMatches: number;
    lines: GxGrepLineResult[];
}

export interface GxGrepSearchResult {
    id: string;
    timestamp: number;
    settings: GxGrepSettings;
    scopeDescription: string;
    filesSearched: number;
    totalMatches: number;
    durationMs: number;
    files: GxGrepFileResult[];
    error?: string;
}

export interface GxGrepContextLine {
    lineNo: number;
    text: string;
    isMatchLine: boolean;
    matches: GxGrepMatchRange[];
}

const FORM_EXTENSIONS = ['.dfm', '.fmx', '.nfm', '.xfm'];
const PASCAL_EXTENSIONS = ['.pas', '.dpr', '.dpk', '.pp', '.inc'];
const UNIT_COMPANION_EXTENSIONS = ['.pas', '.pp', '.dpr'];
const MASK_REPLACEMENT_CHAR = '\n';

const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });

export function createDefaultGrepSettings(): GxGrepSettings {
    return {
        pattern: '',
        scope: 'current',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
        includeForms: true,
        dfmMultiline: true,
        dfmSpecialChars: true,
        includeCode: true,
        includeStrings: true,
        includeComments: true,
        sectionInterface: true,
        sectionImplementation: true,
        sectionInitialization: true,
        sectionFinalization: true,
        directoryPath: '',
        fileMask: '*.pas;*.dpr;*.dpk;*.inc',
        includeSubdirs: true,
        excludedDirs: '.git;node_modules;__history;__recovery;dcu;out;lib',
        contextRadius: 2,
    };
}

export function isFormFilePath(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return FORM_EXTENSIONS.includes(ext);
}

export function isPascalFilePath(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return PASCAL_EXTENSIONS.includes(ext);
}

export function isDelphiRelevantFile(filePath: string): boolean {
    return isPascalFilePath(filePath) || isFormFilePath(filePath);
}

/**
 * Resolves a file in `dir` matching `targetFileName` case-insensitively.
 */
function findFileCaseInsensitive(dir: string, targetFileName: string): string | undefined {
    const direct = path.join(dir, targetFileName);
    if (existsSync(direct)) {
        return toCleanFsPath(direct);
    }
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return undefined;
    }
    const lowerTarget = targetFileName.toLowerCase();
    const match = entries.find((e) => e.isFile() && e.name.toLowerCase() === lowerTarget);
    return match ? toCleanFsPath(path.join(dir, match.name)) : undefined;
}

/**
 * Finds the companion form file (.dfm, .fmx, .nfm, .xfm) for a Pascal source file,
 * checking both sibling files with the same base name and explicit `{$R filename.dfm}` directives.
 */
export function findCompanionFormFile(pasFilePath: string): string | undefined {
    const cleanPath = toCleanFsPath(pasFilePath);
    const ext = path.extname(cleanPath);
    const dir = path.dirname(cleanPath);
    const baseName = path.basename(cleanPath, ext);

    for (const formExt of FORM_EXTENSIONS) {
        const found = findFileCaseInsensitive(dir, baseName + formExt);
        if (found) {
            return found;
        }
    }

    // Also inspect {$R ...} directives in the unit if a custom form filename is referenced
    try {
        const text = loadFileLines(cleanPath).join('\n');
        const directiveRegex = /\{\$R\s+([^\s}*]+?\.(?:dfm|fmx|nfm|xfm))\s*\}/gi;
        let match: RegExpExecArray | null;
        while ((match = directiveRegex.exec(text)) !== null) {
            const refName = match[1].replace(/^['"]|['"]$/g, '');
            const found = findFileCaseInsensitive(dir, refName);
            if (found) {
                return found;
            }
        }
    } catch {
        // Ignore read errors
    }

    return undefined;
}

/**
 * Finds the companion Pascal unit (.pas, .pp, .dpr) for a form file (.dfm, .fmx, .nfm, .xfm).
 */
export function findCompanionUnitFile(formFilePath: string): string | undefined {
    const cleanPath = toCleanFsPath(formFilePath);
    const ext = path.extname(cleanPath);
    const dir = path.dirname(cleanPath);
    const baseName = path.basename(cleanPath, ext);

    for (const unitExt of UNIT_COMPANION_EXTENSIONS) {
        const found = findFileCaseInsensitive(dir, baseName + unitExt);
        if (found) {
            return found;
        }
    }
    return undefined;
}

/**
 * Given either a Pascal unit or a Form file, resolves both the unit and companion form file if present.
 */
export function resolveUnitAndFormPair(filePath: string): {
    unitFile?: string;
    formFile?: string;
} {
    const cleanPath = toCleanFsPath(filePath);
    if (isFormFilePath(cleanPath)) {
        const unitFile = findCompanionUnitFile(cleanPath);
        return {
            unitFile,
            formFile: existsSync(cleanPath) ? cleanPath : undefined,
        };
    }
    if (isPascalFilePath(cleanPath)) {
        const formFile = findCompanionFormFile(cleanPath);
        return {
            unitFile: existsSync(cleanPath) ? cleanPath : undefined,
            formFile,
        };
    }
    return {
        unitFile: existsSync(cleanPath) ? cleanPath : undefined,
    };
}

/**
 * Checks whether a buffer is a binary Delphi form stream (starts with 'TPF0' or $FF $0A $00 header).
 */
function isBinaryFormBuffer(buf: Buffer): boolean {
    if (buf.length >= 4) {
        if (buf[0] === 0x54 && buf[1] === 0x50 && buf[2] === 0x46 && buf[3] === 0x30) {
            return true;
        }
    }
    if (buf.length >= 3) {
        if (buf[0] === 0xff && buf[1] === 0x0a && buf[2] === 0x00) {
            return true;
        }
    }
    return false;
}

/**
 * Converts a binary .dfm file to text lines using Delphi's `convert.exe -t -s` if available,
 * or falls back to extracting printable ASCII/ANSI strings from the binary resource.
 */
function convertBinaryFormToText(filePath: string, buf: Buffer): string {
    const toolchain = resolveDelphiToolchain();
    if (toolchain) {
        const convertExe = path.join(toolchain.binDir, 'convert.exe');
        if (existsSync(convertExe)) {
            try {
                const output = execFileSync(convertExe, ['-t', '-s', filePath], {
                    encoding: 'latin1',
                    timeout: 5000,
                    windowsHide: true,
                });
                if (output && output.trim().length > 0) {
                    return output;
                }
            } catch {
                // Fall back to printable string extraction below
            }
        }
    }

    // Fallback: extract readable strings from the binary TPF0 stream
    const extracted: string[] = [];
    let current = '';
    for (const byte of buf) {
        if (byte >= 32 && byte <= 126) {
            current += String.fromCharCode(byte);
        } else {
            if (current.length >= 3) {
                extracted.push(current);
            }
            current = '';
        }
    }
    if (current.length >= 3) {
        extracted.push(current);
    }
    return extracted.join('\n');
}

/**
 * Decodes a file buffer handling UTF-8 BOM, UTF-16LE/BE BOM, strict UTF-8, and Latin-1 (Delphi ANSI) fallback.
 */
function decodeFileBuffer(filePath: string, buf: Buffer): string {
    if (isFormFilePath(filePath) && isBinaryFormBuffer(buf)) {
        return convertBinaryFormToText(filePath, buf);
    }

    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return buf.subarray(3).toString('utf8');
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return buf.subarray(2).toString('utf16le');
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.allocUnsafe(buf.length - 2);
        for (let i = 2; i + 1 < buf.length; i += 2) {
            swapped[i - 2] = buf[i + 1];
            swapped[i - 1] = buf[i];
        }
        return swapped.toString('utf16le');
    }

    try {
        return utf8StrictDecoder.decode(buf);
    } catch {
        return buf.toString('latin1');
    }
}

/**
 * Loads lines of a file, preferring open unsaved VS Code editor buffers (like GExperts Ota.LoadFileToUnicodeStrings).
 */
export function loadFileLines(filePath: string): string[] {
    const cleanTarget = toCleanFsPath(filePath).toLowerCase();
    const openDoc = workspace.textDocuments.find(
        (doc) =>
            doc.uri.scheme === 'file' && toCleanFsPath(doc.uri.fsPath).toLowerCase() === cleanTarget
    );
    if (openDoc) {
        return openDoc.getText().split(/\r?\n/);
    }

    const buf = readFileSync(filePath);
    const content = decodeFileBuffer(filePath, buf);
    return content.split(/\r?\n/);
}

/**
 * Returns surrounding context lines for a 1-based line number in `filePath`.
 */
export function getFileContextLines(
    filePath: string,
    lineNo: number,
    matchesOnLine: GxGrepMatchRange[],
    radius = 2
): GxGrepContextLine[] {
    try {
        const effectiveRadius = Math.min(5, Math.max(1, Math.trunc(radius)));
        const lines = loadFileLines(filePath);
        const startIdx = Math.max(0, lineNo - 1 - effectiveRadius);
        const endIdx = Math.min(lines.length - 1, lineNo - 1 + effectiveRadius);
        const result: GxGrepContextLine[] = [];
        for (let idx = startIdx; idx <= endIdx; idx++) {
            const currentLineNo = idx + 1;
            result.push({
                lineNo: currentLineNo,
                text: lines[idx],
                isMatchLine: currentLineNo === lineNo,
                matches: currentLineNo === lineNo ? matchesOnLine : [],
            });
        }
        return result;
    } catch {
        return [];
    }
}

function isIdentifierChar(ch: string): boolean {
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return (
        (code >= 48 && code <= 57) || // 0-9
        (code >= 65 && code <= 90) || // A-Z
        (code >= 97 && code <= 122) || // a-z
        code === 95 // _
    );
}

/**
 * GExperts CheckWholeWord equivalent: checks that the match boundaries are not adjacent to identifier characters.
 */
function checkWholeWord(lineStr: string, startCol1: number, endCol1: number): boolean {
    const prevChar = startCol1 >= 2 ? lineStr[startCol1 - 2] : ' ';
    const nextChar = endCol1 < lineStr.length ? lineStr[endCol1] : ' ';
    const firstMatchChar = lineStr[startCol1 - 1] ?? ' ';
    const lastMatchChar = lineStr[endCol1 - 1] ?? ' ';

    const leftOk = !isIdentifierChar(prevChar) || !isIdentifierChar(firstMatchChar);
    const rightOk = !isIdentifierChar(nextChar) || !isIdentifierChar(lastMatchChar);
    return leftOk && rightOk;
}

export interface CompiledMatcher {
    findMatches(lineStr: string, offset: number): GxGrepMatchRange[];
}

export function createMatcher(settings: GxGrepSettings): CompiledMatcher {
    if (settings.isRegex) {
        const flags = settings.caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(settings.pattern, flags);
        return {
            findMatches(lineStr: string, offset: number): GxGrepMatchRange[] {
                const results: GxGrepMatchRange[] = [];
                regex.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = regex.exec(lineStr)) !== null) {
                    const matchLen = match[0].length;
                    if (matchLen === 0) {
                        regex.lastIndex++;
                        continue;
                    }
                    const startCol = match.index + 1;
                    const endCol = startCol + matchLen - 1;
                    if (settings.wholeWord && !checkWholeWord(lineStr, startCol, endCol)) {
                        continue;
                    }
                    results.push({
                        startCol: Math.max(1, startCol + offset),
                        endCol: Math.max(1, endCol + offset),
                    });
                }
                return results;
            },
        };
    }

    const needle = settings.caseSensitive ? settings.pattern : settings.pattern.toLowerCase();
    const needleLen = needle.length;

    return {
        findMatches(lineStr: string, offset: number): GxGrepMatchRange[] {
            const results: GxGrepMatchRange[] = [];
            if (needleLen === 0 || lineStr.length < needleLen) {
                return results;
            }
            const haystack = settings.caseSensitive ? lineStr : lineStr.toLowerCase();
            let fromIndex = 0;
            while (fromIndex <= haystack.length - needleLen) {
                const idx = haystack.indexOf(needle, fromIndex);
                if (idx < 0) {
                    break;
                }
                const startCol = idx + 1;
                const endCol = idx + needleLen;
                if (!settings.wholeWord || checkWholeWord(lineStr, startCol, endCol)) {
                    results.push({
                        startCol: Math.max(1, startCol + offset),
                        endCol: Math.max(1, endCol + offset),
                    });
                }
                fromIndex = idx + 1;
            }
            return results;
        },
    };
}

type UnitSection =
    'start' | 'interface' | 'implementation' | 'initialization' | 'finalization' | 'end';
type CommentMode = 'none' | 'line' | 'curly' | 'parenStar' | 'string';

const SECTION_KEYWORDS: { section: UnitSection; keyword: string }[] = [
    { section: 'interface', keyword: 'interface' },
    { section: 'implementation', keyword: 'implementation' },
    { section: 'initialization', keyword: 'initialization' },
    { section: 'finalization', keyword: 'finalization' },
    { section: 'end', keyword: 'end.' },
];

const SECTION_ORDER: Record<UnitSection, number> = {
    start: 0,
    interface: 1,
    implementation: 2,
    initialization: 3,
    finalization: 4,
    end: 5,
};

function tryMatchSectionKeyword(
    line: string,
    zeroIdx: number,
    currentSection: UnitSection,
    candidate: UnitSection,
    keyword: string
): boolean {
    if (SECTION_ORDER[currentSection] >= SECTION_ORDER[candidate]) {
        return false;
    }
    if (zeroIdx > 0) {
        const prevChar = line[zeroIdx - 1];
        if (isIdentifierChar(prevChar) || prevChar === '.' || prevChar === '&') {
            return false;
        }
    }
    if (line.length < zeroIdx + keyword.length) {
        return false;
    }
    const slice = line.slice(zeroIdx, zeroIdx + keyword.length).toLowerCase();
    if (slice !== keyword) {
        return false;
    }
    if (candidate === 'end') {
        return true;
    }
    const afterChar = line[zeroIdx + keyword.length] ?? '';
    return !isIdentifierChar(afterChar);
}

/**
 * Checks whether a Pascal source file contains unit section declarations (`interface` / `implementation` / etc.)
 * outside comments and string literals. Files without unit sections (e.g. `.dpr`, `.dpk`, `.inc`) should not be
 * blanked out when `sectionInterface` is unchecked.
 */
function hasPascalUnitSections(lines: string[]): boolean {
    const activeSection: UnitSection = 'start';
    let mode: 'none' | 'curly' | 'parenStar' | 'string' = 'none';

    for (const rawLine of lines) {
        if (!rawLine) continue;
        if (mode === 'string') {
            mode = 'none';
        }
        const len = rawLine.length;
        for (let i = 0; i < len; i++) {
            const ch = rawLine[i];
            const next = i + 1 < len ? rawLine[i + 1] : '';
            if (mode === 'curly') {
                if (ch === '}') mode = 'none';
            } else if (mode === 'parenStar') {
                if (ch === '*' && next === ')') {
                    mode = 'none';
                    i++;
                }
            } else if (mode === 'string') {
                if (ch === "'") {
                    if (next === "'") {
                        i++;
                    } else {
                        mode = 'none';
                    }
                }
            } else {
                if (ch === '/' && next === '/') {
                    break;
                } else if (ch === '{') {
                    mode = 'curly';
                } else if (ch === '(' && next === '*') {
                    mode = 'parenStar';
                    i++;
                } else if (ch === "'") {
                    mode = 'string';
                } else {
                    for (const item of SECTION_KEYWORDS) {
                        if (
                            item.section !== 'end' &&
                            tryMatchSectionKeyword(
                                rawLine,
                                i,
                                activeSection,
                                item.section,
                                item.keyword
                            )
                        ) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    return false;
}

/**
 * Searches a Pascal source file (.pas, .dpr, .dpk, .pp, .inc) with GExperts-compatible
 * Code / Strings / Comments and Unit Section filtering.
 */
export function searchPascalLines(
    lines: string[],
    settings: GxGrepSettings,
    matcher: CompiledMatcher
): GxGrepLineResult[] {
    const lineResults: GxGrepLineResult[] = [];
    const filterFragments =
        !settings.includeCode || !settings.includeStrings || !settings.includeComments;
    const rawFilterSections =
        !settings.sectionInterface ||
        !settings.sectionImplementation ||
        !settings.sectionInitialization ||
        !settings.sectionFinalization;
    const filterSections = rawFilterSections && hasPascalUnitSections(lines);

    let activeSection: UnitSection = 'start';
    let mode: CommentMode = 'none';

    const isSectionActive = (sec: UnitSection): boolean => {
        if (!filterSections) return true;
        switch (sec) {
            case 'start':
            case 'interface':
                return settings.sectionInterface;
            case 'implementation':
                return settings.sectionImplementation;
            case 'initialization':
                return settings.sectionInitialization;
            case 'finalization':
                return settings.sectionFinalization;
            case 'end':
                return false;
        }
    };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const rawLine = lines[lineIdx];
        if (!rawLine) {
            continue;
        }

        if (!filterFragments && !filterSections) {
            const matches = matcher.findMatches(rawLine, 0);
            if (matches.length > 0) {
                lineResults.push({
                    lineNo: lineIdx + 1,
                    lineText: rawLine,
                    matches,
                });
            }
            continue;
        }

        // Line-end resets single-line comments and unclosed single-line strings
        if (mode === 'line' || mode === 'string') {
            mode = 'none';
        }

        const len = rawLine.length;
        const maskedChars: string[] = new Array<string>(len);
        const keepMask = new Uint8Array(len);

        for (let i = 0; i < len; i++) {
            maskedChars[i] = rawLine[i];
        }

        for (let i = 0; i < len; i++) {
            const ch = rawLine[i];
            const next = i + 1 < len ? rawLine[i + 1] : '';

            let charKind: 'code' | 'string' | 'comment';

            if (mode === 'curly') {
                charKind = 'comment';
                if (ch === '}') {
                    mode = 'none';
                }
            } else if (mode === 'parenStar') {
                if (ch === '*' && next === ')') {
                    const keepBoth = isSectionActive(activeSection) && settings.includeComments;
                    if (keepBoth) {
                        keepMask[i] = 1;
                        keepMask[i + 1] = 1;
                    } else {
                        maskedChars[i] = MASK_REPLACEMENT_CHAR;
                        maskedChars[i + 1] = MASK_REPLACEMENT_CHAR;
                    }
                    mode = 'none';
                    i++;
                    continue;
                }
                charKind = 'comment';
            } else if (mode === 'line') {
                charKind = 'comment';
            } else if (mode === 'string') {
                if (ch === "'") {
                    if (next === "'") {
                        const keepBoth = isSectionActive(activeSection) && settings.includeStrings;
                        if (keepBoth) {
                            keepMask[i] = 1;
                            keepMask[i + 1] = 1;
                        } else {
                            maskedChars[i] = MASK_REPLACEMENT_CHAR;
                            maskedChars[i + 1] = MASK_REPLACEMENT_CHAR;
                        }
                        i++;
                        continue;
                    }
                    mode = 'none';
                }
                charKind = 'string';
            } else {
                // Currently in code
                if (ch === '/' && next === '/') {
                    mode = 'line';
                    charKind = 'comment';
                } else if (ch === '{') {
                    mode = 'curly';
                    charKind = 'comment';
                } else if (ch === '(' && next === '*') {
                    mode = 'parenStar';
                    const keepBoth = isSectionActive(activeSection) && settings.includeComments;
                    if (keepBoth) {
                        keepMask[i] = 1;
                        keepMask[i + 1] = 1;
                    } else {
                        maskedChars[i] = MASK_REPLACEMENT_CHAR;
                        maskedChars[i + 1] = MASK_REPLACEMENT_CHAR;
                    }
                    i++;
                    continue;
                } else if (ch === "'") {
                    mode = 'string';
                    charKind = 'string';
                } else {
                    charKind = 'code';
                    if (filterSections) {
                        for (const item of SECTION_KEYWORDS) {
                            if (
                                tryMatchSectionKeyword(
                                    rawLine,
                                    i,
                                    activeSection,
                                    item.section,
                                    item.keyword
                                )
                            ) {
                                activeSection = item.section;
                                break;
                            }
                        }
                    }
                }
            }

            const keepChar =
                isSectionActive(activeSection) &&
                ((charKind === 'code' && settings.includeCode) ||
                    (charKind === 'string' && settings.includeStrings) ||
                    (charKind === 'comment' && settings.includeComments));

            if (keepChar) {
                keepMask[i] = 1;
            } else {
                maskedChars[i] = MASK_REPLACEMENT_CHAR;
            }
        }

        // Trim trailing masked characters (like GExperts TSearcher.SearchPascalFile)
        let trimmedLen = len;
        while (trimmedLen > 0 && keepMask[trimmedLen - 1] === 0) {
            trimmedLen--;
        }
        if (trimmedLen === 0) {
            continue;
        }

        const searchLine = maskedChars.slice(0, trimmedLen).join('');
        const rawMatches = matcher.findMatches(searchLine, 0);
        const validMatches = rawMatches.filter((m) => {
            for (let idx = m.startCol - 1; idx < m.endCol; idx++) {
                if (keepMask[idx] === 0) {
                    return false;
                }
            }
            return true;
        });

        if (validMatches.length > 0) {
            lineResults.push({
                lineNo: lineIdx + 1,
                lineText: rawLine,
                matches: validMatches,
            });
        }
    }

    return lineResults;
}

interface DfmCharProvenance {
    ch: string;
    lineIdx: number;
    startCol: number;
    endCol: number;
}

/**
 * Parses a `#NNN` or `#$XX` character code starting at `index` (where `chars[index].ch === '#'`).
 */
function tryParseDfmCharCode(
    chars: DfmCharProvenance[],
    index: number
):
    | { decodedChar: string; nextIndex: number; startCol: number; endCol: number; lineIdx: number }
    | undefined {
    const startItem = chars[index];
    if (!startItem || startItem.ch !== '#' || index + 1 >= chars.length) {
        return undefined;
    }

    let cursor = index + 1;
    let isHex = false;
    if (chars[cursor].ch === '$') {
        isHex = true;
        cursor++;
    }

    let numStr = '';
    let endItem = startItem;
    while (cursor < chars.length && chars[cursor].lineIdx === startItem.lineIdx) {
        const c = chars[cursor].ch;
        const validDigit = isHex ? /^[0-9a-fA-F]$/.test(c) : /^[0-9]$/.test(c);
        if (!validDigit) {
            break;
        }
        numStr += c;
        endItem = chars[cursor];
        cursor++;
    }

    if (numStr.length === 0) {
        return undefined;
    }

    const code = Number.parseInt(numStr, isHex ? 16 : 10);
    if (Number.isNaN(code) || code <= 0 || code > 0xffff) {
        return undefined;
    }

    return {
        decodedChar: String.fromCharCode(code),
        nextIndex: cursor,
        startCol: startItem.startCol,
        endCol: endItem.endCol,
        lineIdx: startItem.lineIdx,
    };
}

/**
 * Decodes Delphi DFM `#NNN` / `#$XX` character sequences outside single-quoted string literals
 * while preserving exact per-character source line and column provenance.
 */
function decodeDfmProvenanceChars(chars: DfmCharProvenance[]): DfmCharProvenance[] {
    const out: DfmCharProvenance[] = [];
    let inString = false;
    let i = 0;

    while (i < chars.length) {
        const curr = chars[i];

        if (inString) {
            if (curr.ch === "'") {
                if (i + 1 < chars.length && chars[i + 1].ch === "'") {
                    // Escaped single quote inside string literal
                    out.push(curr, chars[i + 1]);
                    i += 2;
                    continue;
                }
                // Check if closing quote is immediately followed by one or more #NNN char codes
                const firstCode = tryParseDfmCharCode(chars, i + 1);
                if (firstCode) {
                    let cursor = i + 1;
                    while (cursor < chars.length) {
                        const parsed = tryParseDfmCharCode(chars, cursor);
                        if (!parsed) {
                            break;
                        }
                        out.push({
                            ch: parsed.decodedChar,
                            lineIdx: parsed.lineIdx,
                            startCol: parsed.startCol,
                            endCol: parsed.endCol,
                        });
                        cursor = parsed.nextIndex;
                    }
                    if (cursor < chars.length && chars[cursor].ch === "'") {
                        // Resumes string literal immediately after #NNN (e.g. 'Kurze '#220'berschrift')
                        inString = true;
                        i = cursor + 1;
                    } else {
                        // String ended with #NNN (e.g. 'Line 1'#13#10)
                        out.push(curr);
                        inString = false;
                        i = cursor;
                    }
                    continue;
                }
                out.push(curr);
                inString = false;
                i++;
                continue;
            }
            out.push(curr);
            i++;
            continue;
        }

        // Outside string literal
        if (curr.ch === "'") {
            out.push(curr);
            inString = true;
            i++;
            continue;
        }

        if (curr.ch === '#') {
            const firstCode = tryParseDfmCharCode(chars, i);
            if (firstCode) {
                const decodedItems: DfmCharProvenance[] = [];
                let cursor = i;
                while (cursor < chars.length) {
                    const parsed = tryParseDfmCharCode(chars, cursor);
                    if (!parsed) {
                        break;
                    }
                    decodedItems.push({
                        ch: parsed.decodedChar,
                        lineIdx: parsed.lineIdx,
                        startCol: parsed.startCol,
                        endCol: parsed.endCol,
                    });
                    cursor = parsed.nextIndex;
                }
                // If followed immediately by an opening quote (e.g. Caption = #220'berschrift'),
                // emit the opening quote first and enter string mode so the text is contiguous
                if (cursor < chars.length && chars[cursor].ch === "'") {
                    out.push(chars[cursor]);
                    out.push(...decodedItems);
                    inString = true;
                    i = cursor + 1;
                } else {
                    out.push(...decodedItems);
                    i = cursor;
                }
                continue;
            }
        }

        out.push(curr);
        i++;
    }

    return out;
}

function toProvenanceLine(line: string, lineIdx: number): DfmCharProvenance[] {
    const arr: DfmCharProvenance[] = new Array<DfmCharProvenance>(line.length);
    for (let i = 0; i < line.length; i++) {
        arr[i] = {
            ch: line[i],
            lineIdx,
            startCol: i + 1,
            endCol: i + 1,
        };
    }
    return arr;
}

/**
 * Checks if a DFM line ends with a string continuation (`' +` at the end of the trimmed line)
 * and returns the 0-based index of the closing quote before `+`.
 */
function findDfmContinuationQuoteIndex(line: string): number {
    const match = /'\s*\+\s*$/.exec(line);
    if (!match) {
        return -1;
    }
    // Ensure there is an opening quote earlier on the line
    const firstQuote = line.indexOf("'");
    if (firstQuote < 0 || firstQuote >= match.index) {
        return -1;
    }
    return match.index;
}

/**
 * Searches a Delphi Form file (.dfm, .fmx, .nfm, .xfm) with GExperts-compatible
 * multiline string concatenation and `#NNN` special character handling.
 */
export function searchFormLines(
    lines: string[],
    settings: GxGrepSettings,
    matcher: CompiledMatcher
): GxGrepLineResult[] {
    const resultsByLine = new Map<number, GxGrepLineResult>();

    const evaluateLogicalChars = (rawChars: DfmCharProvenance[]) => {
        if (rawChars.length === 0) {
            return;
        }
        const processed = settings.dfmSpecialChars ? decodeDfmProvenanceChars(rawChars) : rawChars;
        if (processed.length === 0) {
            return;
        }
        const searchStr = processed.map((c) => c.ch).join('');
        const matches = matcher.findMatches(searchStr, 0);
        for (const m of matches) {
            const startIdx = m.startCol - 1;
            const endIdx = Math.min(processed.length - 1, m.endCol - 1);
            if (startIdx < 0 || startIdx >= processed.length || endIdx < startIdx) {
                continue;
            }
            const firstLoc = processed[startIdx];
            const targetLineIdx = firstLoc.lineIdx;
            const startCol = firstLoc.startCol;
            let endCol = firstLoc.endCol;
            for (let k = startIdx; k <= endIdx; k++) {
                if (processed[k].lineIdx === targetLineIdx) {
                    endCol = Math.max(endCol, processed[k].endCol);
                }
            }

            const rawLine = lines[targetLineIdx] ?? '';
            const lineNo = targetLineIdx + 1;
            const existing = resultsByLine.get(lineNo);
            const range: GxGrepMatchRange = { startCol, endCol };
            if (existing) {
                existing.matches.push(range);
            } else {
                resultsByLine.set(lineNo, {
                    lineNo,
                    lineText: rawLine,
                    matches: [range],
                });
            }
        }
    };

    if (!settings.dfmMultiline) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i]) {
                evaluateLogicalChars(toProvenanceLine(lines[i], i));
            }
        }
        return Array.from(resultsByLine.values());
    }

    let accChars: DfmCharProvenance[] = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (!line) {
            if (accChars.length > 0) {
                evaluateLogicalChars(accChars);
                accChars = [];
            }
            continue;
        }

        const contQuoteIdx = findDfmContinuationQuoteIndex(line);
        const leadingQuoteMatch = /^\s*'/.exec(line);

        if (accChars.length > 0 && leadingQuoteMatch) {
            const contentStartIdx = leadingQuoteMatch[0].length; // right after opening quote
            if (contQuoteIdx >= contentStartIdx) {
                // Middle continuation line: append content between opening `'` and closing `' +`
                for (let c = contentStartIdx; c < contQuoteIdx; c++) {
                    accChars.push({
                        ch: line[c],
                        lineIdx,
                        startCol: c + 1,
                        endCol: c + 1,
                    });
                }
                continue;
            } else {
                // Final continuation line: append from after opening `'` to end of line
                for (let c = contentStartIdx; c < line.length; c++) {
                    accChars.push({
                        ch: line[c],
                        lineIdx,
                        startCol: c + 1,
                        endCol: c + 1,
                    });
                }
                evaluateLogicalChars(accChars);
                accChars = [];
                continue;
            }
        }

        if (accChars.length > 0) {
            evaluateLogicalChars(accChars);
            accChars = [];
        }

        if (contQuoteIdx >= 0) {
            // Start of a multiline string (whether `Caption = 'foo' +` or `'foo' +`)
            for (let c = 0; c < contQuoteIdx; c++) {
                accChars.push({
                    ch: line[c],
                    lineIdx,
                    startCol: c + 1,
                    endCol: c + 1,
                });
            }
            continue;
        }

        evaluateLogicalChars(toProvenanceLine(line, lineIdx));
    }

    if (accChars.length > 0) {
        evaluateLogicalChars(accChars);
    }

    return Array.from(resultsByLine.values());
}

/**
 * Searches a single file and returns a GxGrepFileResult if at least one match is found.
 */
export function searchSingleFile(
    filePath: string,
    searchRoot: string,
    settings: GxGrepSettings,
    matcher: CompiledMatcher
): GxGrepFileResult | undefined {
    let lines: string[];
    try {
        lines = loadFileLines(filePath);
    } catch {
        return undefined;
    }

    const isForm = isFormFilePath(filePath);
    const isPas = isPascalFilePath(filePath);

    let lineResults: GxGrepLineResult[];
    if (isForm) {
        lineResults = searchFormLines(lines, settings, matcher);
    } else if (isPas) {
        lineResults = searchPascalLines(lines, settings, matcher);
    } else {
        lineResults = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            const matches = matcher.findMatches(line, 0);
            if (matches.length > 0) {
                lineResults.push({
                    lineNo: i + 1,
                    lineText: line,
                    matches,
                });
            }
        }
    }

    if (lineResults.length === 0) {
        return undefined;
    }

    const totalMatches = lineResults.reduce((sum, item) => sum + item.matches.length, 0);
    const cleanFile = toCleanFsPath(filePath);
    const rel = searchRoot ? path.relative(searchRoot, cleanFile) : path.basename(cleanFile);
    const relativePath = rel && !rel.startsWith('..') ? rel : cleanFile;

    return {
        filePath: cleanFile,
        relativePath,
        isFormFile: isForm,
        expanded: true,
        totalLines: lines.length,
        totalMatches,
        lines: lineResults,
    };
}

/**
 * Converts a wildcard mask like `*.pas` to a case-insensitive RegExp.
 */
function wildcardToRegExp(mask: string): RegExp {
    const escaped = mask
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Collects files in a directory matching masks and directory exclusions.
 */
function collectDirectoryFiles(
    dirPath: string,
    masks: RegExp[],
    includeSubdirs: boolean,
    excludedDirSet: Set<string>
): string[] {
    const results: string[] = [];
    const walk = (currentDir: string) => {
        let entries: Dirent[];
        try {
            entries = readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (includeSubdirs && !excludedDirSet.has(entry.name.toLowerCase())) {
                    walk(fullPath);
                }
            } else if (entry.isFile()) {
                if (masks.some((rx) => rx.test(entry.name))) {
                    results.push(toCleanFsPath(fullPath));
                }
            }
        }
    };
    walk(dirPath);
    return results;
}

/**
 * Collects all files belonging to the active Delphi project (LSP `.delphilsp.json` or Legacy `.dpr`).
 */
async function collectProjectFiles(): Promise<{ files: string[]; projectName?: string }> {
    const files: string[] = [];
    let projectName: string | undefined;

    const configPath = getConfigFilePath();
    if (configPath && configPath.toLowerCase().endsWith('.delphilsp.json')) {
        const lspConfig = await loadConfigFileJson(configPath);
        if (lspConfig) {
            if (lspConfig.settings.project && existsSync(lspConfig.settings.project)) {
                const projFile = toCleanFsPath(lspConfig.settings.project);
                projectName = path.basename(projFile);
                files.push(projFile);
            }
            for (const pf of lspConfig.settings.projectFiles ?? []) {
                const fsPath = toCleanFsPath(toFsPath(pf.file));
                if (existsSync(fsPath)) {
                    files.push(fsPath);
                }
            }
            if (files.length > 0) {
                return { files, projectName };
            }
        }
    }

    // Legacy / DPR resolution
    const toolchain = resolveDelphiToolchain();
    const binDir = toolchain?.binDir ?? '';
    const dprFromConfig = configPath ? resolveDprFromConfigPath(configPath) : undefined;
    const legacyConfig = resolveLegacyProjectConfig(binDir, dprFromConfig ?? configPath);

    if (existsSync(legacyConfig.projectFile)) {
        const projFile = toCleanFsPath(legacyConfig.projectFile);
        projectName = path.basename(projFile);
        files.push(projFile);
        for (const unitPath of legacyConfig.dprUnitFiles.values()) {
            if (existsSync(unitPath)) {
                files.push(toCleanFsPath(unitPath));
            }
        }
        if (files.length > 1) {
            return { files, projectName };
        }
    }

    // Fallback: all Pascal files in the workspace
    const uris = await workspace.findFiles(
        '**/*.{pas,dpr,dpk,inc}',
        '{**/node_modules/**,**/.git/**,**/dcu/**}'
    );
    for (const uri of uris) {
        files.push(toCleanFsPath(uri.fsPath));
    }
    return { files, projectName };
}

/**
 * Collects all open file paths from VS Code tabs and open text documents.
 */
function collectOpenEditorFiles(fallbackActiveFile?: string): string[] {
    const result: string[] = [];
    for (const group of window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof TabInputText && tab.input.uri.scheme === 'file') {
                result.push(toCleanFsPath(tab.input.uri.fsPath));
            }
        }
    }
    for (const doc of workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && !doc.isClosed) {
            result.push(toCleanFsPath(doc.uri.fsPath));
        }
    }
    if (fallbackActiveFile && existsSync(fallbackActiveFile)) {
        result.push(toCleanFsPath(fallbackActiveFile));
    }
    return result;
}

/**
 * Expands a list of candidate files to include companion `.dfm` (or `.pas`) files when `includeForms` is enabled,
 * deduplicating case-insensitively while preserving search order.
 */
function expandWithCompanionForms(baseFiles: string[], includeForms: boolean): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];

    const addFile = (f: string | undefined) => {
        if (!f) return;
        const clean = toCleanFsPath(f);
        const key = clean.toLowerCase();
        if (!seen.has(key) && existsSync(clean)) {
            seen.add(key);
            ordered.push(clean);
        }
    };

    for (const file of baseFiles) {
        if (isFormFilePath(file)) {
            if (includeForms) {
                addFile(file);
            }
            continue;
        }
        addFile(file);
        if (includeForms && isPascalFilePath(file)) {
            const companionForm = findCompanionFormFile(file);
            addFile(companionForm);
        }
    }

    return ordered;
}

/**
 * Validates a regular expression pattern and returns an error string if invalid.
 */
export function validateRegexPattern(pattern: string): string | undefined {
    try {
        new RegExp(pattern);
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/**
 * Executes a full GX Grep search across the requested scope.
 */
export async function runGxGrepSearch(
    settings: GxGrepSettings,
    activeEditorFile?: string,
    previousResultFiles?: string[]
): Promise<GxGrepSearchResult> {
    const startTime = Date.now();
    const id = `grep-${startTime}-${Math.random().toString(36).slice(2, 7)}`;
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    if (!settings.pattern) {
        return {
            id,
            timestamp: startTime,
            settings,
            scopeDescription: '',
            filesSearched: 0,
            totalMatches: 0,
            durationMs: 0,
            files: [],
        };
    }

    if (settings.isRegex) {
        const regexErr = validateRegexPattern(settings.pattern);
        if (regexErr) {
            return {
                id,
                timestamp: startTime,
                settings,
                scopeDescription: 'Invalid Regular Expression',
                filesSearched: 0,
                totalMatches: 0,
                durationMs: 0,
                files: [],
                error: regexErr,
            };
        }
    }

    let candidateFiles: string[] = [];
    let scopeDescription = '';
    let searchRoot = workspaceRoot;

    switch (settings.scope) {
        case 'current': {
            const targetFile =
                activeEditorFile ??
                (window.activeTextEditor?.document.uri.scheme === 'file'
                    ? window.activeTextEditor.document.uri.fsPath
                    : undefined);

            if (!targetFile) {
                return {
                    id,
                    timestamp: startTime,
                    settings,
                    scopeDescription: 'Current Unit (no active file)',
                    filesSearched: 0,
                    totalMatches: 0,
                    durationMs: 0,
                    files: [],
                    error: 'No active Delphi file in the editor.',
                };
            }

            const pair = resolveUnitAndFormPair(targetFile);
            searchRoot = path.dirname(targetFile);
            if (pair.unitFile) {
                candidateFiles.push(pair.unitFile);
            } else {
                candidateFiles.push(toCleanFsPath(targetFile));
            }
            if (settings.includeForms && pair.formFile) {
                candidateFiles.push(pair.formFile);
                scopeDescription = `${path.basename(pair.unitFile ?? targetFile)} + ${path.basename(pair.formFile)}`;
            } else {
                scopeDescription = path.basename(pair.unitFile ?? targetFile);
            }
            break;
        }

        case 'open': {
            const rawOpen = collectOpenEditorFiles(activeEditorFile).filter((f) =>
                isDelphiRelevantFile(f)
            );
            // If an open editor is a .dfm, also include its .pas unit
            const withUnits: string[] = [];
            for (const f of rawOpen) {
                if (isFormFilePath(f)) {
                    const unit = findCompanionUnitFile(f);
                    if (unit) withUnits.push(unit);
                }
                withUnits.push(f);
            }
            candidateFiles = expandWithCompanionForms(withUnits, settings.includeForms);
            scopeDescription = settings.includeForms ? 'Open Files (+ .dfm)' : 'Open Files';
            break;
        }

        case 'project': {
            const { files, projectName } = await collectProjectFiles();
            candidateFiles = expandWithCompanionForms(files, settings.includeForms);
            const label = projectName ? `Project (${projectName})` : 'Project Files';
            scopeDescription = settings.includeForms ? `${label} (+ .dfm)` : label;
            break;
        }

        case 'directory': {
            const rawDir = settings.directoryPath.trim() || workspaceRoot;
            const dirs = rawDir
                .split(';')
                .map((d) => d.trim())
                .filter((d) => d.length > 0)
                .map((d) =>
                    path.isAbsolute(d) ? d : workspaceRoot ? path.resolve(workspaceRoot, d) : d
                )
                .filter((d) => existsSync(d));

            if (dirs.length === 0) {
                return {
                    id,
                    timestamp: startTime,
                    settings,
                    scopeDescription: 'Directory',
                    filesSearched: 0,
                    totalMatches: 0,
                    durationMs: 0,
                    files: [],
                    error: `Search directory does not exist: ${rawDir}`,
                };
            }

            searchRoot = dirs[0];
            const maskStr = settings.fileMask.trim() || '*.pas;*.dpr;*.dpk;*.inc';
            const masks = maskStr
                .split(/[;,]/)
                .map((m) => m.trim())
                .filter(Boolean)
                .map((m) => wildcardToRegExp(m));

            const excludedSet = new Set(
                settings.excludedDirs
                    .split(/[;,]/)
                    .map((d) => d.trim().toLowerCase())
                    .filter(Boolean)
            );

            const dirFiles: string[] = [];
            for (const d of dirs) {
                dirFiles.push(
                    ...collectDirectoryFiles(d, masks, settings.includeSubdirs, excludedSet)
                );
            }
            candidateFiles = expandWithCompanionForms(dirFiles, settings.includeForms);
            scopeDescription = settings.includeForms
                ? `Directory: ${path.basename(dirs[0]) || dirs[0]} (+ .dfm)`
                : `Directory: ${path.basename(dirs[0]) || dirs[0]}`;
            break;
        }

        case 'results': {
            const base = previousResultFiles ?? [];
            candidateFiles = expandWithCompanionForms(base, settings.includeForms);
            scopeDescription = 'Previous Search Result Files';
            break;
        }
    }

    // Deduplicate final candidate list
    const uniqueFiles: string[] = [];
    const seen = new Set<string>();
    for (const f of candidateFiles) {
        const clean = toCleanFsPath(f);
        const key = clean.toLowerCase();
        if (!seen.has(key) && existsSync(clean)) {
            seen.add(key);
            uniqueFiles.push(clean);
        }
    }

    const matcher = createMatcher(settings);
    const matchedFiles: GxGrepFileResult[] = [];
    let totalMatches = 0;

    for (const filePath of uniqueFiles) {
        const fileRes = searchSingleFile(filePath, searchRoot, settings, matcher);
        if (fileRes) {
            matchedFiles.push(fileRes);
            totalMatches += fileRes.totalMatches;
        }
    }

    const durationMs = Date.now() - startTime;
    return {
        id,
        timestamp: startTime,
        settings: { ...settings },
        scopeDescription,
        filesSearched: uniqueFiles.length,
        totalMatches,
        durationMs,
        files: matchedFiles,
    };
}

/**
 * Toggles between a Pascal unit (.pas/.pp/.dpr) and its companion Form file (.dfm/.fmx/.nfm/.xfm).
 */
export async function toggleFormAndUnit(): Promise<void> {
    if (!isDelphiEnabled()) {
        window.showWarningMessage('Delphi: Extension is disabled in this workspace.');
        return;
    }

    const editor = window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        window.showWarningMessage('Delphi: Open a Pascal unit (.pas) or Form file (.dfm) first.');
        return;
    }

    const currentPath = editor.document.uri.fsPath;
    if (isFormFilePath(currentPath)) {
        const unitFile = findCompanionUnitFile(currentPath);
        if (!unitFile) {
            window.showInformationMessage(
                `Delphi: No companion Pascal unit found for ${path.basename(currentPath)}.`
            );
            return;
        }
        const doc = await workspace.openTextDocument(Uri.file(unitFile));
        await window.showTextDocument(doc, { preview: false });
        return;
    }

    if (isPascalFilePath(currentPath)) {
        const formFile = findCompanionFormFile(currentPath);
        if (!formFile) {
            window.showInformationMessage(
                `Delphi: No companion Form file (.dfm) found for ${path.basename(currentPath)}.`
            );
            return;
        }
        const doc = await workspace.openTextDocument(Uri.file(formFile));
        await window.showTextDocument(doc, { preview: false });
        return;
    }

    window.showWarningMessage('Delphi: Active file is not a Delphi unit or form file.');
}
