import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import {
    Declaration,
    DeclarationProvider,
    Definition,
    DefinitionProvider,
    Disposable,
    DocumentSymbol,
    DocumentSymbolProvider,
    Hover,
    HoverProvider,
    ImplementationProvider,
    languages,
    Location,
    MarkdownString,
    Position,
    Range,
    ReferenceProvider,
    SymbolInformation,
    SymbolKind,
    TextDocument,
    TypeDefinitionProvider,
    Uri,
    WorkspaceSymbolProvider,
} from 'vscode';
import { LegacyProjectConfig } from './projectConfig';

export interface UsesEntry {
    name: string;
    line: number;
    startCol: number;
    endCol: number;
}

export interface PascalSymbol {
    name: string;
    qualifiedName: string;
    containerName?: string;
    symbolType?: string;
    parentType?: string;
    kind: SymbolKind;
    section: 'interface' | 'implementation';
    line: number;
    col: number;
    endLine: number;
    signature: string;
    filePath: string;
}

export interface ParsedPascalUnit {
    filePath: string;
    mtimeMs: number;
    unitName: string;
    interfaceUses: UsesEntry[];
    implementationUses: UsesEntry[];
    symbols: PascalSymbol[];
}

/**
 * Replaces comments ({...}, (*...*), //...) and string literals ('...') with spaces
 * while preserving line breaks and exact character offsets.
 */
export function maskCommentsAndStrings(source: string): string {
    const chars = Array.from(source);
    const len = chars.length;
    let i = 0;

    while (i < len) {
        const ch = chars[i];
        const next = i + 1 < len ? chars[i + 1] : '';

        // Single-line comment //
        if (ch === '/' && next === '/') {
            while (i < len && chars[i] !== '\r' && chars[i] !== '\n') {
                chars[i] = ' ';
                i++;
            }
            continue;
        }

        // Brace comment { ... }
        if (ch === '{') {
            while (i < len && chars[i] !== '}') {
                if (chars[i] !== '\r' && chars[i] !== '\n') {
                    chars[i] = ' ';
                }
                i++;
            }
            if (i < len && chars[i] === '}') {
                chars[i] = ' ';
                i++;
            }
            continue;
        }

        // Paren-star comment (* ... *)
        if (ch === '(' && next === '*') {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 2;
            while (i < len && !(chars[i] === '*' && i + 1 < len && chars[i + 1] === ')')) {
                if (chars[i] !== '\r' && chars[i] !== '\n') {
                    chars[i] = ' ';
                }
                i++;
            }
            if (i + 1 < len) {
                chars[i] = ' ';
                chars[i + 1] = ' ';
                i += 2;
            }
            continue;
        }

        // String literal '...'
        if (ch === "'") {
            chars[i] = ' ';
            i++;
            while (i < len && chars[i] !== '\r' && chars[i] !== '\n') {
                if (chars[i] === "'") {
                    chars[i] = ' ';
                    i++;
                    if (i < len && chars[i] === "'") {
                        chars[i] = ' ';
                        i++;
                        continue;
                    }
                    break;
                }
                chars[i] = ' ';
                i++;
            }
            continue;
        }

        i++;
    }

    return chars.join('');
}

/**
 * Extracts uses entries from a masked Pascal source region.
 */
function parseUsesClauses(maskedLines: string[]): {
    interfaceUses: UsesEntry[];
    implementationUses: UsesEntry[];
} {
    const interfaceUses: UsesEntry[] = [];
    const implementationUses: UsesEntry[] = [];
    let section: 'interface' | 'implementation' = 'interface';
    let inUses = false;

    for (let lineIdx = 0; lineIdx < maskedLines.length; lineIdx++) {
        const line = maskedLines[lineIdx];
        if (/^\s*implementation\b/i.test(line)) {
            section = 'implementation';
            inUses = false;
            continue;
        }
        if (
            inUses &&
            /^\s*(type|const|resourcestring|var|procedure|function|constructor|destructor|begin|exports|threadvar)\b/i.test(
                line
            )
        ) {
            inUses = false;
        }

        let scanLine = line;
        let colOffset = 0;
        const usesMatch = /^\s*uses\b/i.exec(line);
        if (usesMatch) {
            inUses = true;
            colOffset = usesMatch[0].length;
            scanLine = line.slice(colOffset);
        }

        if (!inUses) continue;

        const semiIdx = scanLine.indexOf(';');
        const effectiveSlice = semiIdx >= 0 ? scanLine.slice(0, semiIdx) : scanLine;

        const identRegex = /\b([A-Za-z_][A-Za-z0-9_.]*)\b/g;
        let match: RegExpExecArray | null;
        while ((match = identRegex.exec(effectiveSlice)) !== null) {
            const word = match[1];
            if (word.toLowerCase() === 'in') continue;
            const entry: UsesEntry = {
                name: word,
                line: lineIdx,
                startCol: colOffset + match.index,
                endCol: colOffset + match.index + word.length,
            };
            if (section === 'interface') {
                interfaceUses.push(entry);
            } else {
                implementationUses.push(entry);
            }
        }

        if (semiIdx >= 0) {
            inUses = false;
        }
    }

    return { interfaceUses, implementationUses };
}

/**
 * Parses a Pascal source file into structural symbols and uses clauses.
 */
export function parsePascalSource(source: string, filePath: string, mtimeMs = 0): ParsedPascalUnit {
    const masked = maskCommentsAndStrings(source);
    const origLines = source.split(/\r?\n/);
    const maskedLines = masked.split(/\r?\n/);

    const { interfaceUses, implementationUses } = parseUsesClauses(maskedLines);
    const symbols: PascalSymbol[] = [];

    let unitName = path.parse(filePath).name;
    let section: 'interface' | 'implementation' = 'interface';
    let currentContainer: { name: string; symbol: PascalSymbol } | undefined;
    let mode: 'none' | 'type' | 'const' | 'var' = 'none';
    let routineDepth = 0;

    for (let i = 0; i < maskedLines.length; i++) {
        const line = maskedLines[i];
        const origLine = origLines[i] ?? line;
        const trimmed = line.trim();
        if (!trimmed) continue;

        const headerMatch = /^\s*(unit|program|library|package)\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(
            line
        );
        if (headerMatch) {
            unitName = headerMatch[2];
            continue;
        }

        if (/^\s*interface\b/i.test(line) && !currentContainer) {
            section = 'interface';
            mode = 'none';
            continue;
        }

        if (/^\s*implementation\b/i.test(line)) {
            section = 'implementation';
            currentContainer = undefined;
            mode = 'none';
            routineDepth = 0;
            continue;
        }

        // Close an open class/record/interface container on `end;`
        if (currentContainer) {
            if (/^\s*end\s*[;.]?/i.test(line)) {
                currentContainer.symbol.endLine = i;
                currentContainer = undefined;
                continue;
            }

            // Inside class/interface/record: match methods, properties, or fields
            const methodMatch =
                /^\s*(?:class\s+)?(procedure|function|constructor|destructor)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
                    line
                );
            if (methodMatch) {
                const kindStr = methodMatch[1].toLowerCase();
                const name = methodMatch[2];
                const col = line.indexOf(name, methodMatch[0].length - name.length);
                symbols.push({
                    name,
                    qualifiedName: `${currentContainer.name}.${name}`,
                    containerName: currentContainer.name,
                    kind:
                        kindStr === 'constructor' || kindStr === 'destructor'
                            ? SymbolKind.Constructor
                            : SymbolKind.Method,
                    section,
                    line: i,
                    col: Math.max(0, col),
                    endLine: i,
                    signature: origLine.trim(),
                    filePath,
                });
                continue;
            }

            const propMatch =
                /^\s*property\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[[^\]]*\])?(?:\s*:\s*([A-Za-z_][A-Za-z0-9_.]*))?/i.exec(
                    line
                );
            if (propMatch) {
                const name = propMatch[1];
                const propType = propMatch[2];
                const col = line.indexOf(name);
                symbols.push({
                    name,
                    qualifiedName: `${currentContainer.name}.${name}`,
                    containerName: currentContainer.name,
                    symbolType: propType,
                    kind: SymbolKind.Property,
                    section,
                    line: i,
                    col: Math.max(0, col),
                    endLine: i,
                    signature: origLine.trim(),
                    filePath,
                });
                continue;
            }

            if (/^\s*(private|protected|public|published|automated|strict)\b/i.test(line)) {
                continue;
            }

            const fieldMatch =
                /^(\s*)([A-Za-z_][A-Za-z0-9_,\s]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)/i.exec(line);
            if (fieldMatch) {
                const leadingLen = fieldMatch[1].length;
                const namesPart = fieldMatch[2];
                const fieldType = fieldMatch[3];
                const fieldRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
                let fm: RegExpExecArray | null;
                while ((fm = fieldRegex.exec(namesPart)) !== null) {
                    const fname = fm[1];
                    symbols.push({
                        name: fname,
                        qualifiedName: `${currentContainer.name}.${fname}`,
                        containerName: currentContainer.name,
                        symbolType: fieldType,
                        kind: SymbolKind.Field,
                        section,
                        line: i,
                        col: leadingLen + fm.index,
                        endLine: i,
                        signature: `${currentContainer.name}.${origLine.trim()}`,
                        filePath,
                    });
                }
            }
            continue;
        }

        // Track begin/end depth in implementation so local variables inside routines aren't indexed as globals
        if (section === 'implementation') {
            const begins = (line.match(/\b(begin|try|case|asm)\b/gi) ?? []).length;
            const ends = (line.match(/\bend\b/gi) ?? []).length;
            if (routineDepth > 0) {
                routineDepth = Math.max(0, routineDepth + begins - ends);
                continue;
            }
            if (begins > ends) {
                routineDepth += begins - ends;
                mode = 'none';
                continue;
            }
        }

        // Top-level section keywords
        if (/^\s*type\b/i.test(line)) {
            mode = 'type';
            const afterType = line.replace(/^\s*type\b/i, '');
            if (!afterType.trim()) continue;
        } else if (/^\s*(const|resourcestring)\b/i.test(line)) {
            mode = 'const';
            continue;
        } else if (/^\s*(var|threadvar)\b/i.test(line)) {
            mode = 'var';
            continue;
        }

        // Top-level or class method procedure/function/constructor/destructor
        const routineMatch =
            /^\s*(?:class\s+)?(procedure|function|constructor|destructor)\s+(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
                line
            );
        if (routineMatch) {
            mode = 'none';
            const kindStr = routineMatch[1].toLowerCase();
            const clsName = routineMatch[2];
            const funcName = routineMatch[3];
            const searchTarget = clsName ? `${clsName}.${funcName}` : funcName;
            const targetIdx = line.indexOf(searchTarget);
            const col =
                targetIdx >= 0
                    ? clsName
                        ? targetIdx + clsName.length + 1
                        : targetIdx
                    : Math.max(0, line.indexOf(funcName));

            symbols.push({
                name: funcName,
                qualifiedName: clsName ? `${clsName}.${funcName}` : funcName,
                containerName: clsName,
                kind:
                    kindStr === 'constructor' || kindStr === 'destructor'
                        ? SymbolKind.Constructor
                        : clsName
                          ? SymbolKind.Method
                          : SymbolKind.Function,
                section,
                line: i,
                col,
                endLine: i,
                signature: origLine.trim(),
                filePath,
            });
            continue;
        }

        if (mode === 'type') {
            const typeMatch =
                /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:packed\s+)?(class|interface|dispinterface|record|object|\(|set\b|array\b|procedure\b|function\b|type\b|[A-Za-z_])/i.exec(
                    line
                );
            if (typeMatch) {
                const tName = typeMatch[1];
                const rhs = typeMatch[2].toLowerCase();
                const col = Math.max(0, line.indexOf(tName));
                const isForwardOrRef =
                    /=\s*class\s*(?:of\b[^;]*|(?:\([^)]*\))?\s*);/i.test(line) ||
                    /=\s*(?:disp)?interface\s*;/i.test(line);

                let kind = SymbolKind.Class;
                if (rhs === 'interface' || rhs === 'dispinterface') {
                    kind = SymbolKind.Interface;
                } else if (rhs === 'record' || rhs === 'object') {
                    kind = SymbolKind.Struct;
                } else if (rhs === '(') {
                    kind = SymbolKind.Enum;
                } else if (rhs !== 'class') {
                    kind = SymbolKind.TypeParameter;
                }

                const parentMatch =
                    /\b(?:class|interface|object)\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)/i.exec(line);

                const sym: PascalSymbol = {
                    name: tName,
                    qualifiedName: tName,
                    parentType: parentMatch?.[1],
                    kind,
                    section,
                    line: i,
                    col,
                    endLine: i,
                    signature: origLine.trim(),
                    filePath,
                };
                symbols.push(sym);

                if (
                    (rhs === 'class' ||
                        rhs === 'interface' ||
                        rhs === 'dispinterface' ||
                        rhs === 'record' ||
                        rhs === 'object') &&
                    !isForwardOrRef &&
                    !/\bend\s*;/i.test(line)
                ) {
                    currentContainer = { name: tName, symbol: sym };
                }
            }
        } else if (mode === 'const') {
            const constMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(.+)/i.exec(line);
            if (constMatch) {
                const cName = constMatch[1];
                symbols.push({
                    name: cName,
                    qualifiedName: cName,
                    kind: SymbolKind.Constant,
                    section,
                    line: i,
                    col: Math.max(0, line.indexOf(cName)),
                    endLine: i,
                    signature: origLine.trim(),
                    filePath,
                });
            }
        } else if (mode === 'var') {
            const varMatch = /^(\s*)([A-Za-z_][A-Za-z0-9_,\s]*)\s*:\s*([^;]+)/i.exec(line);
            if (varMatch) {
                const leadingLen = varMatch[1].length;
                const namesPart = varMatch[2];
                const rawType = varMatch[3].trim();
                const simpleType = /^([A-Za-z_][A-Za-z0-9_.]*)/.exec(rawType)?.[1];
                const vRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
                let vm: RegExpExecArray | null;
                while ((vm = vRegex.exec(namesPart)) !== null) {
                    const vName = vm[1];
                    symbols.push({
                        name: vName,
                        qualifiedName: vName,
                        symbolType: simpleType,
                        kind: SymbolKind.Variable,
                        section,
                        line: i,
                        col: leadingLen + vm.index,
                        endLine: i,
                        signature: origLine.trim(),
                        filePath,
                    });
                }
            }
        }
    }

    return {
        filePath,
        mtimeMs,
        unitName,
        interfaceUses,
        implementationUses,
        symbols,
    };
}

export class LegacyNavigationProvider
    implements
        DocumentSymbolProvider,
        DefinitionProvider,
        DeclarationProvider,
        ImplementationProvider,
        TypeDefinitionProvider,
        ReferenceProvider,
        HoverProvider,
        WorkspaceSymbolProvider,
        Disposable
{
    private readonly disposables: Disposable[] = [];
    private readonly parsedCache = new Map<string, ParsedPascalUnit>();
    private unitFileMap: Map<string, string> | undefined;
    private aliasMap = new Map<string, string>();
    private getConfig: () => LegacyProjectConfig;

    constructor(getConfig: () => LegacyProjectConfig) {
        this.getConfig = getConfig;
        const selector = { language: 'objectpascal', scheme: 'file' };
        this.disposables.push(
            languages.registerDocumentSymbolProvider(selector, this),
            languages.registerDefinitionProvider(selector, this),
            languages.registerDeclarationProvider(selector, this),
            languages.registerImplementationProvider(selector, this),
            languages.registerTypeDefinitionProvider(selector, this),
            languages.registerReferenceProvider(selector, this),
            languages.registerHoverProvider(selector, this),
            languages.registerWorkspaceSymbolProvider(this)
        );
    }

    public invalidateIndex() {
        this.unitFileMap = undefined;
        this.aliasMap.clear();
    }

    private ensureUnitIndex(): Map<string, string> {
        if (this.unitFileMap) {
            return this.unitFileMap;
        }
        const config = this.getConfig();
        const map = new Map<string, string>();

        // 1. Parse unit aliases (e.g. WinTypes=Windows)
        this.aliasMap.clear();
        for (const pair of config.unitAliases.split(';')) {
            const eq = pair.indexOf('=');
            if (eq > 0) {
                const from = pair.slice(0, eq).trim().toLowerCase();
                const to = pair
                    .slice(eq + 1)
                    .trim()
                    .toLowerCase();
                if (from && to) {
                    this.aliasMap.set(from, to);
                }
            }
        }

        // 2. Explicit .dpr units first
        for (const [unitName, unitPath] of config.dprUnitFiles.entries()) {
            map.set(unitName.toLowerCase(), unitPath);
        }

        // 3. Scan browsingPaths in priority order
        for (const dir of config.browsingPaths) {
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.isFile() && /\.pas$/i.test(entry.name)) {
                    const key = entry.name.slice(0, -4).toLowerCase();
                    if (!map.has(key)) {
                        map.set(key, path.join(dir, entry.name));
                    }
                }
            }
        }

        this.unitFileMap = map;
        return map;
    }

    public resolveUnitFile(unitName: string, currentDir?: string): string | undefined {
        const lower = unitName.toLowerCase();
        const mappedName = this.aliasMap.get(lower) ?? lower;

        if (currentDir) {
            const localCandidate = path.join(currentDir, `${unitName}.pas`);
            if (existsSync(localCandidate)) {
                return localCandidate;
            }
        }

        const index = this.ensureUnitIndex();
        return index.get(lower) ?? index.get(mappedName);
    }

    private getParsedFile(filePath: string): ParsedPascalUnit | undefined {
        if (!existsSync(filePath)) return undefined;
        const key = filePath.toLowerCase();
        try {
            const stat = statSync(filePath);
            const cached = this.parsedCache.get(key);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                return cached;
            }
            const text = readFileSync(filePath, 'latin1');
            const parsed = parsePascalSource(text, filePath, stat.mtimeMs);
            this.parsedCache.set(key, parsed);
            return parsed;
        } catch {
            return undefined;
        }
    }

    private getParsedDocument(document: TextDocument): ParsedPascalUnit {
        return parsePascalSource(document.getText(), document.uri.fsPath, Date.now());
    }

    public provideDocumentSymbols(document: TextDocument): DocumentSymbol[] {
        const parsed = this.getParsedDocument(document);
        const topSymbols: DocumentSymbol[] = [];
        const containerMap = new Map<string, DocumentSymbol>();

        for (const sym of parsed.symbols) {
            const lineIdx = Math.min(sym.line, Math.max(0, document.lineCount - 1));
            const endLineIdx = Math.min(sym.endLine, Math.max(lineIdx, document.lineCount - 1));
            const lineText = document.lineAt(lineIdx).text;
            const startCol = Math.min(sym.col, lineText.length);
            const endCol = Math.min(startCol + sym.name.length, lineText.length);

            const range = new Range(
                new Position(lineIdx, 0),
                new Position(endLineIdx, document.lineAt(endLineIdx).text.length)
            );
            const selectionRange = new Range(
                new Position(lineIdx, startCol),
                new Position(lineIdx, Math.max(startCol, endCol))
            );

            const docSym = new DocumentSymbol(
                sym.containerName && sym.section === 'implementation'
                    ? sym.qualifiedName
                    : sym.name,
                sym.section,
                sym.kind,
                range,
                selectionRange
            );

            if (!sym.containerName && sym.section === 'interface') {
                containerMap.set(sym.name.toLowerCase(), docSym);
                topSymbols.push(docSym);
            } else if (sym.containerName && sym.section === 'interface') {
                const parent = containerMap.get(sym.containerName.toLowerCase());
                if (parent) {
                    parent.children.push(docSym);
                } else {
                    topSymbols.push(docSym);
                }
            } else {
                topSymbols.push(docSym);
            }
        }

        return topSymbols;
    }

    private resolveSymbolAtPosition(
        document: TextDocument,
        position: Position
    ): { targetSym?: PascalSymbol; unitFilePath?: string; unitName?: string } | undefined {
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!wordRange) return undefined;
        const word = document.getText(wordRange);
        const wordLower = word.toLowerCase();

        const parsed = this.getParsedDocument(document);
        const currentDir = path.dirname(document.uri.fsPath);

        // 1. Check if cursor is on a unit in `uses` clause (or if the word itself is a used unit name)
        const allUses = [...parsed.interfaceUses, ...parsed.implementationUses];
        for (const u of allUses) {
            if (
                u.line === position.line &&
                position.character >= u.startCol &&
                position.character <= u.endCol
            ) {
                const resolved = this.resolveUnitFile(u.name, currentDir);
                if (resolved) {
                    return { unitFilePath: resolved, unitName: u.name };
                }
            }
        }

        // 2. Check if cursor is on an interface method declaration -> jump to implementation (or vice-versa)
        const lineSym = parsed.symbols.find(
            (s) => s.line === position.line && s.name.toLowerCase() === wordLower
        );
        if (lineSym) {
            if (
                lineSym.section === 'interface' &&
                (lineSym.kind === SymbolKind.Method ||
                    lineSym.kind === SymbolKind.Constructor ||
                    lineSym.kind === SymbolKind.Function)
            ) {
                const implMatch = parsed.symbols.find(
                    (s) =>
                        s.section === 'implementation' &&
                        s.name.toLowerCase() === wordLower &&
                        (s.containerName ?? '').toLowerCase() ===
                            (lineSym.containerName ?? '').toLowerCase()
                );
                if (implMatch) {
                    return { targetSym: implMatch };
                }
            } else if (lineSym.section === 'implementation') {
                const intfMatch = parsed.symbols.find(
                    (s) =>
                        s.section === 'interface' &&
                        s.name.toLowerCase() === wordLower &&
                        (s.containerName ?? '').toLowerCase() ===
                            (lineSym.containerName ?? '').toLowerCase()
                );
                if (intfMatch) {
                    return { targetSym: intfMatch };
                }
            }
        }

        const searchUnits = [
            ...allUses.map((u) => u.name).reverse(),
            'SysUtils',
            'Classes',
            'Forms',
            'Controls',
            'DB',
            'Windows',
            'System',
        ];

        // 2b. If preceded by `<receiver>.`, resolve the receiver's type and look up member on that class
        const lineText = document.lineAt(position.line).text;
        const beforeWord = lineText.slice(0, wordRange.start.character);
        const dotChainMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(beforeWord);
        if (dotChainMatch && !lineSym) {
            const receiverName = dotChainMatch[1];
            const receiverSym = this.findIdentifierSymbol(
                receiverName,
                parsed,
                position.line,
                searchUnits,
                currentDir
            );
            const receiverType =
                receiverSym?.symbolType ??
                (receiverSym?.kind === SymbolKind.Class ||
                receiverSym?.kind === SymbolKind.Interface ||
                receiverSym?.kind === SymbolKind.Struct
                    ? receiverSym.name
                    : undefined);
            if (receiverType) {
                const memberSym = this.findMemberOnType(
                    receiverType,
                    wordLower,
                    parsed,
                    searchUnits,
                    currentDir
                );
                if (memberSym) {
                    return { targetSym: memberSym };
                }
            }
        }

        // 3. Same-unit symbol lookup (prefer implementation for routines, or enclosing class members)
        const enclosingImplMethod = parsed.symbols
            .filter(
                (s) => s.section === 'implementation' && s.containerName && s.line <= position.line
            )
            .pop();

        if (enclosingImplMethod?.containerName) {
            const clsLower = enclosingImplMethod.containerName.toLowerCase();
            if (wordLower === 'self') {
                const selfClass = parsed.symbols.find((s) => s.name.toLowerCase() === clsLower);
                if (selfClass) {
                    return { targetSym: selfClass };
                }
            }
            const memberImpl = parsed.symbols.find(
                (s) =>
                    s.section === 'implementation' &&
                    s.containerName?.toLowerCase() === clsLower &&
                    s.name.toLowerCase() === wordLower
            );
            if (memberImpl) {
                return { targetSym: memberImpl };
            }
            const memberIntf = parsed.symbols.find(
                (s) =>
                    s.section === 'interface' &&
                    s.containerName?.toLowerCase() === clsLower &&
                    s.name.toLowerCase() === wordLower
            );
            if (memberIntf) {
                return { targetSym: memberIntf };
            }
        }

        const sameUnitImpl = parsed.symbols.find(
            (s) => s.section === 'implementation' && s.name.toLowerCase() === wordLower
        );
        if (sameUnitImpl) {
            return { targetSym: sameUnitImpl };
        }
        const sameUnitIntf = parsed.symbols.find((s) => s.name.toLowerCase() === wordLower);
        if (sameUnitIntf) {
            return { targetSym: sameUnitIntf };
        }

        // 4. If word matches a unit name in `uses` (e.g. SysUtils.Format -> clicking SysUtils)
        const matchingUsedUnit = allUses.find((u) => u.name.toLowerCase() === wordLower);
        if (matchingUsedUnit) {
            const resolved = this.resolveUnitFile(matchingUsedUnit.name, currentDir);
            if (resolved) {
                return { unitFilePath: resolved, unitName: matchingUsedUnit.name };
            }
        }

        // 5. Search interface symbols of used units (in reverse order, matching Delphi scope resolution)
        const visited = new Set<string>();
        for (const uName of searchUnits) {
            const uPath = this.resolveUnitFile(uName, currentDir);
            if (!uPath) continue;
            const key = uPath.toLowerCase();
            if (visited.has(key)) continue;
            visited.add(key);

            const unitParsed = this.getParsedFile(uPath);
            if (!unitParsed) continue;

            const found = unitParsed.symbols.find(
                (s) => s.section === 'interface' && s.name.toLowerCase() === wordLower
            );
            if (found) {
                return { targetSym: found };
            }
        }

        return undefined;
    }

    private findIdentifierSymbol(
        identName: string,
        parsed: ParsedPascalUnit,
        line: number,
        searchUnits: string[],
        currentDir: string
    ): PascalSymbol | undefined {
        const lower = identName.toLowerCase();
        const enclosingMethod = parsed.symbols
            .filter((s) => s.section === 'implementation' && s.containerName && s.line <= line)
            .pop();

        if (lower === 'self' && enclosingMethod?.containerName) {
            return parsed.symbols.find(
                (s) => s.name.toLowerCase() === enclosingMethod.containerName?.toLowerCase()
            );
        }

        if (enclosingMethod?.containerName) {
            const clsLower = enclosingMethod.containerName.toLowerCase();
            const member = parsed.symbols.find(
                (s) => s.containerName?.toLowerCase() === clsLower && s.name.toLowerCase() === lower
            );
            if (member) return member;
        }

        const local = parsed.symbols.find((s) => s.name.toLowerCase() === lower);
        if (local) return local;

        const visited = new Set<string>();
        for (const uName of searchUnits) {
            const uPath = this.resolveUnitFile(uName, currentDir);
            if (!uPath) continue;
            const key = uPath.toLowerCase();
            if (visited.has(key)) continue;
            visited.add(key);
            const unitParsed = this.getParsedFile(uPath);
            const found = unitParsed?.symbols.find(
                (s) => s.section === 'interface' && s.name.toLowerCase() === lower
            );
            if (found) return found;
        }
        return undefined;
    }

    private findMemberOnType(
        typeName: string,
        memberLower: string,
        currentParsed: ParsedPascalUnit,
        searchUnits: string[],
        currentDir: string,
        depth = 0
    ): PascalSymbol | undefined {
        if (depth > 6) return undefined;
        const typeLower = typeName.toLowerCase();

        const checkUnit = (unit: ParsedPascalUnit): { member?: PascalSymbol; parent?: string } => {
            const clsSym = unit.symbols.find(
                (s) => !s.containerName && s.name.toLowerCase() === typeLower
            );
            if (!clsSym) return {};
            const member = unit.symbols.find(
                (s) =>
                    s.section === 'interface' &&
                    s.containerName?.toLowerCase() === typeLower &&
                    s.name.toLowerCase() === memberLower
            );
            return { member, parent: clsSym.parentType };
        };

        const inCurrent = checkUnit(currentParsed);
        if (inCurrent.member) return inCurrent.member;
        let parentType = inCurrent.parent;
        let nextSearchUnits = searchUnits;

        if (!parentType) {
            const visited = new Set<string>();
            for (const uName of searchUnits) {
                const uPath = this.resolveUnitFile(uName, currentDir);
                if (!uPath) continue;
                const key = uPath.toLowerCase();
                if (visited.has(key)) continue;
                visited.add(key);
                const unitParsed = this.getParsedFile(uPath);
                if (!unitParsed) continue;
                const res = checkUnit(unitParsed);
                if (res.member) return res.member;
                if (res.parent) {
                    parentType = res.parent;
                    nextSearchUnits = [
                        ...unitParsed.interfaceUses.map((u) => u.name).reverse(),
                        ...searchUnits,
                    ];
                    break;
                }
            }
        }

        if (parentType) {
            return this.findMemberOnType(
                parentType,
                memberLower,
                currentParsed,
                nextSearchUnits,
                currentDir,
                depth + 1
            );
        }
        return undefined;
    }

    public provideDefinition(document: TextDocument, position: Position): Definition | undefined {
        const resolved = this.resolveSymbolAtPosition(document, position);
        if (!resolved) return undefined;

        if (resolved.unitFilePath) {
            return new Location(Uri.file(resolved.unitFilePath), new Position(0, 0));
        }
        if (resolved.targetSym) {
            const sym = resolved.targetSym;
            return new Location(Uri.file(sym.filePath), new Position(sym.line, sym.col));
        }
        return undefined;
    }

    public provideDeclaration(document: TextDocument, position: Position): Declaration | undefined {
        const resolved = this.resolveSymbolAtPosition(document, position);
        if (!resolved) return undefined;

        if (resolved.unitFilePath) {
            return new Location(Uri.file(resolved.unitFilePath), new Position(0, 0));
        }
        if (resolved.targetSym) {
            const sym = resolved.targetSym;
            if (sym.section === 'implementation') {
                const unitParsed =
                    sym.filePath.toLowerCase() === document.uri.fsPath.toLowerCase()
                        ? this.getParsedDocument(document)
                        : this.getParsedFile(sym.filePath);
                const intfSym = unitParsed?.symbols.find(
                    (s) =>
                        s.section === 'interface' &&
                        s.name.toLowerCase() === sym.name.toLowerCase() &&
                        (s.containerName ?? '').toLowerCase() ===
                            (sym.containerName ?? '').toLowerCase()
                );
                if (intfSym) {
                    return new Location(
                        Uri.file(intfSym.filePath),
                        new Position(intfSym.line, intfSym.col)
                    );
                }
            }
            return new Location(Uri.file(sym.filePath), new Position(sym.line, sym.col));
        }
        return undefined;
    }

    public provideImplementation(
        document: TextDocument,
        position: Position
    ): Definition | undefined {
        const resolved = this.resolveSymbolAtPosition(document, position);
        if (!resolved?.targetSym) return undefined;

        const sym = resolved.targetSym;
        if (sym.section === 'interface') {
            const unitParsed =
                sym.filePath.toLowerCase() === document.uri.fsPath.toLowerCase()
                    ? this.getParsedDocument(document)
                    : this.getParsedFile(sym.filePath);
            const implSym = unitParsed?.symbols.find(
                (s) =>
                    s.section === 'implementation' &&
                    s.name.toLowerCase() === sym.name.toLowerCase() &&
                    (s.containerName ?? '').toLowerCase() ===
                        (sym.containerName ?? '').toLowerCase()
            );
            if (implSym) {
                return new Location(
                    Uri.file(implSym.filePath),
                    new Position(implSym.line, implSym.col)
                );
            }
        }
        return new Location(Uri.file(sym.filePath), new Position(sym.line, sym.col));
    }

    public provideTypeDefinition(
        document: TextDocument,
        position: Position
    ): Definition | undefined {
        const resolved = this.resolveSymbolAtPosition(document, position);
        if (!resolved?.targetSym) return undefined;

        const sym = resolved.targetSym;
        const typeName = sym.symbolType ?? sym.parentType;
        if (!typeName) {
            if (
                sym.kind === SymbolKind.Class ||
                sym.kind === SymbolKind.Interface ||
                sym.kind === SymbolKind.Struct ||
                sym.kind === SymbolKind.Enum
            ) {
                return new Location(Uri.file(sym.filePath), new Position(sym.line, sym.col));
            }
            return undefined;
        }

        const parsed = this.getParsedDocument(document);
        const allUses = [...parsed.interfaceUses, ...parsed.implementationUses];
        const searchUnits = [
            ...allUses.map((u) => u.name).reverse(),
            'SysUtils',
            'Classes',
            'Forms',
            'Controls',
            'DB',
            'Windows',
            'System',
        ];
        const currentDir = path.dirname(document.uri.fsPath);
        const typeSym = this.findIdentifierSymbol(
            typeName,
            parsed,
            position.line,
            searchUnits,
            currentDir
        );
        if (typeSym) {
            return new Location(
                Uri.file(typeSym.filePath),
                new Position(typeSym.line, typeSym.col)
            );
        }
        return undefined;
    }

    public provideReferences(document: TextDocument, position: Position): Location[] {
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!wordRange) return [];
        const word = document.getText(wordRange);
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordRegex = new RegExp(`\\b${escaped}\\b`, 'gi');

        const locations: Location[] = [];
        const scannedFiles = new Set<string>();

        const scanSource = (filePath: string, source: string) => {
            const key = filePath.toLowerCase();
            if (scannedFiles.has(key)) return;
            scannedFiles.add(key);

            const maskedLines = maskCommentsAndStrings(source).split(/\r?\n/);
            const uri = Uri.file(filePath);
            for (let lineIdx = 0; lineIdx < maskedLines.length; lineIdx++) {
                const line = maskedLines[lineIdx];
                wordRegex.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = wordRegex.exec(line)) !== null) {
                    locations.push(
                        new Location(
                            uri,
                            new Range(
                                new Position(lineIdx, m.index),
                                new Position(lineIdx, m.index + m[0].length)
                            )
                        )
                    );
                    if (locations.length >= 500) return;
                }
            }
        };

        scanSource(document.uri.fsPath, document.getText());

        const config = this.getConfig();
        for (const unitPath of config.dprUnitFiles.values()) {
            if (locations.length >= 500) break;
            if (scannedFiles.has(unitPath.toLowerCase())) continue;
            try {
                const text = readFileSync(unitPath, 'latin1');
                if (wordRegex.test(text)) {
                    scanSource(unitPath, text);
                }
            } catch {
                continue;
            }
        }

        return locations;
    }

    public provideHover(document: TextDocument, position: Position): Hover | undefined {
        const resolved = this.resolveSymbolAtPosition(document, position);
        if (!resolved) return undefined;

        const md = new MarkdownString();
        if (resolved.unitFilePath) {
            const fileUri = Uri.file(resolved.unitFilePath).toString();
            const baseName = path.basename(resolved.unitFilePath);
            md.appendMarkdown(`[${baseName}](${fileUri})\n\n`);
            md.appendCodeblock(
                `unit ${resolved.unitName ?? path.parse(baseName).name};`,
                'objectpascal'
            );
            return new Hover(md);
        }

        if (resolved.targetSym) {
            const sym = resolved.targetSym;
            const fileUri = `${Uri.file(sym.filePath).toString()}#${sym.line + 1}`;
            const baseName = path.basename(sym.filePath);
            md.appendMarkdown(`[${baseName}:${sym.line + 1}](${fileUri})\n\n`);
            md.appendCodeblock(sym.signature, 'objectpascal');
            return new Hover(md);
        }

        return undefined;
    }

    public provideWorkspaceSymbols(query: string): SymbolInformation[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];

        const config = this.getConfig();
        const results: SymbolInformation[] = [];

        for (const unitPath of config.dprUnitFiles.values()) {
            const parsed = this.getParsedFile(unitPath);
            if (!parsed) continue;
            for (const sym of parsed.symbols) {
                if (sym.section !== 'interface') continue;
                if (sym.name.toLowerCase().includes(q)) {
                    results.push(
                        new SymbolInformation(
                            sym.name,
                            sym.kind,
                            sym.containerName ?? parsed.unitName,
                            new Location(Uri.file(sym.filePath), new Position(sym.line, sym.col))
                        )
                    );
                    if (results.length >= 200) {
                        return results;
                    }
                }
            }
        }
        return results;
    }

    public dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.parsedCache.clear();
    }
}
