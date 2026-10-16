import * as path from 'path';
import {
    commands,
    Disposable,
    ExtensionContext,
    Position,
    Range,
    Selection,
    TextEditorRevealType,
    Uri,
    Webview,
    WebviewView,
    WebviewViewProvider,
    window,
    workspace,
} from 'vscode';
import { isDelphiEnabled, updateDelphiEnabledContext } from '../utils/constantUtils';
import { toCleanFsPath } from '../utils/fileUtils';
import {
    createDefaultGrepSettings,
    getFileContextLines,
    GxGrepContextLine,
    GxGrepMatchRange,
    GxGrepScope,
    GxGrepSearchResult,
    GxGrepSettings,
    isDelphiRelevantFile,
    loadFileLines,
    resolveUnitAndFormPair,
    runGxGrepSearch,
    toggleFormAndUnit,
} from './grepEngine';

export const GX_GREP_VIEW_ID = 'delphi.gxGrepView';

const STATE_SETTINGS_KEY = 'delphi.gxGrep.settings';
const STATE_HISTORY_KEY = 'delphi.gxGrep.history';
const MAX_HISTORY_ITEMS = 25;

interface FlatMatchLocation {
    fileIndex: number;
    lineIndex: number;
    filePath: string;
    lineNo: number;
    matches: GxGrepMatchRange[];
}

interface WebviewInboundMessage {
    type:
        | 'ready'
        | 'search'
        | 'liveSearch'
        | 'updateSettings'
        | 'selectMatch'
        | 'selectHistory'
        | 'deleteHistory'
        | 'clearHistory'
        | 'toggleFormUnit';
    settings?: GxGrepSettings;
    filePath?: string;
    lineNo?: number;
    matches?: GxGrepMatchRange[];
    focusEditor?: boolean;
    historyId?: string;
}

export class GxGrepViewProvider implements WebviewViewProvider, Disposable {
    private view: WebviewView | undefined;
    private readonly disposables: Disposable[] = [];
    private settings: GxGrepSettings;
    private history: GxGrepSearchResult[];
    private currentResult: GxGrepSearchResult | undefined;
    private previousResultFiles: string[] = [];
    private lastActiveFile: string | undefined;
    private flatMatches: FlatMatchLocation[] = [];
    private activeFlatMatchIndex = -1;
    private pendingFocusPattern: string | undefined;
    private pendingImmediateRun = false;

    constructor(private readonly context: ExtensionContext) {
        const savedSettings =
            context.workspaceState.get<Partial<GxGrepSettings>>(STATE_SETTINGS_KEY);
        this.settings = {
            ...createDefaultGrepSettings(),
            ...savedSettings,
        };
        this.history = context.workspaceState.get<GxGrepSearchResult[]>(STATE_HISTORY_KEY) ?? [];
        if (this.history.length > 0) {
            this.currentResult = this.history[0];
            this.previousResultFiles = this.currentResult.files.map((f) => f.filePath);
            this.rebuildFlatMatches();
        }

        if (window.activeTextEditor?.document.uri.scheme === 'file') {
            this.lastActiveFile = toCleanFsPath(window.activeTextEditor.document.uri.fsPath);
        }

        this.disposables.push(
            window.onDidChangeActiveTextEditor((editor) => {
                if (editor && editor.document.uri.scheme === 'file') {
                    const fsPath = toCleanFsPath(editor.document.uri.fsPath);
                    if (isDelphiRelevantFile(fsPath) || !this.lastActiveFile) {
                        this.lastActiveFile = fsPath;
                        this.postActiveUnitInfo();
                    }
                }
            })
        );
    }

    public dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    public resolveWebviewView(webviewView: WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        this.disposables.push(
            webviewView.webview.onDidReceiveMessage((msg: WebviewInboundMessage) => {
                void this.handleMessage(msg);
            }),
            webviewView.onDidDispose(() => {
                if (this.view === webviewView) {
                    this.view = undefined;
                }
            })
        );
    }

    /**
     * Opens/focuses the GX Grep panel, optionally pre-populating the search input from editor selection
     * and optionally forcing a specific search scope (such as `'current'`).
     */
    public async openAndFocus(forceScope?: GxGrepScope, runImmediately = false): Promise<void> {
        if (!(await updateDelphiEnabledContext())) {
            window.showWarningMessage('Delphi: Extension is disabled in this workspace.');
            return;
        }

        const editor = window.activeTextEditor;
        let selectedText = '';

        if (editor && editor.document.uri.scheme === 'file') {
            this.lastActiveFile = toCleanFsPath(editor.document.uri.fsPath);
            if (!editor.selection.isEmpty) {
                const rawSel = editor.document.getText(editor.selection);
                if (!rawSel.includes('\n') && !rawSel.includes('\r') && rawSel.trim().length > 0) {
                    selectedText = rawSel;
                }
            } else {
                const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
                if (wordRange) {
                    selectedText = editor.document.getText(wordRange);
                }
            }
        }

        if (forceScope) {
            this.settings.scope = forceScope;
        }
        if (selectedText) {
            this.settings.pattern = selectedText;
        }
        await this.saveSettings();

        this.pendingFocusPattern = this.settings.pattern;
        this.pendingImmediateRun = runImmediately;

        if (this.view) {
            this.view.show(false);
            this.postStateToWebview(true);
            this.pendingFocusPattern = undefined;
            if (this.pendingImmediateRun && this.settings.pattern) {
                this.pendingImmediateRun = false;
                await this.executeSearch(this.settings, true);
            }
        } else {
            await commands.executeCommand(`${GX_GREP_VIEW_ID}.focus`);
        }
    }

    /**
     * Jumps to the next match in the current GX Grep result list.
     */
    public async gotoNextMatch(): Promise<void> {
        if (!isDelphiEnabled()) {
            window.showWarningMessage('Delphi: Extension is disabled in this workspace.');
            return;
        }
        if (this.flatMatches.length === 0) {
            window.showInformationMessage('Delphi GX Grep: No active search results.');
            return;
        }
        this.activeFlatMatchIndex = (this.activeFlatMatchIndex + 1) % this.flatMatches.length;
        const item = this.flatMatches[this.activeFlatMatchIndex];
        await this.navigateToMatch(item.filePath, item.lineNo, item.matches, false);
        this.postSelectMatchIndex(this.activeFlatMatchIndex, item);
    }

    /**
     * Jumps to the previous match in the current GX Grep result list.
     */
    public async gotoPrevMatch(): Promise<void> {
        if (!isDelphiEnabled()) {
            window.showWarningMessage('Delphi: Extension is disabled in this workspace.');
            return;
        }
        if (this.flatMatches.length === 0) {
            window.showInformationMessage('Delphi GX Grep: No active search results.');
            return;
        }
        this.activeFlatMatchIndex =
            this.activeFlatMatchIndex <= 0
                ? this.flatMatches.length - 1
                : this.activeFlatMatchIndex - 1;
        const item = this.flatMatches[this.activeFlatMatchIndex];
        await this.navigateToMatch(item.filePath, item.lineNo, item.matches, false);
        this.postSelectMatchIndex(this.activeFlatMatchIndex, item);
    }

    private async handleMessage(msg: WebviewInboundMessage): Promise<void> {
        switch (msg.type) {
            case 'ready': {
                this.postStateToWebview(Boolean(this.pendingFocusPattern !== undefined));
                if (this.pendingImmediateRun && this.settings.pattern) {
                    this.pendingImmediateRun = false;
                    await this.executeSearch(this.settings, true);
                }
                this.pendingFocusPattern = undefined;
                break;
            }

            case 'updateSettings': {
                if (msg.settings) {
                    const prevRadius = this.getContextRadius();
                    this.settings = { ...this.settings, ...msg.settings };
                    await this.saveSettings();
                    if (
                        prevRadius !== this.getContextRadius() &&
                        this.activeFlatMatchIndex >= 0 &&
                        this.flatMatches[this.activeFlatMatchIndex]
                    ) {
                        const activeItem = this.flatMatches[this.activeFlatMatchIndex];
                        const contextLines = getFileContextLines(
                            activeItem.filePath,
                            activeItem.lineNo,
                            activeItem.matches,
                            this.getContextRadius()
                        );
                        this.postMessage({
                            type: 'contextPreview',
                            filePath: activeItem.filePath,
                            lineNo: activeItem.lineNo,
                            contextLines,
                        });
                    }
                }
                break;
            }

            case 'liveSearch': {
                if (msg.settings) {
                    this.settings = { ...this.settings, ...msg.settings };
                    await this.saveSettings();
                    await this.executeSearch(this.settings, false);
                }
                break;
            }

            case 'search': {
                if (msg.settings) {
                    this.settings = { ...this.settings, ...msg.settings };
                    await this.saveSettings();
                }
                await this.executeSearch(this.settings, true);
                break;
            }

            case 'selectMatch': {
                if (msg.filePath && msg.lineNo !== undefined) {
                    const matches = msg.matches ?? [];
                    const idx = this.flatMatches.findIndex(
                        (m) =>
                            m.filePath.toLowerCase() === msg.filePath?.toLowerCase() &&
                            m.lineNo === msg.lineNo
                    );
                    if (idx >= 0) {
                        this.activeFlatMatchIndex = idx;
                    }
                    if (msg.focusEditor) {
                        await this.navigateToMatch(msg.filePath, msg.lineNo, matches, true);
                    }
                    const contextLines = getFileContextLines(
                        msg.filePath,
                        msg.lineNo,
                        matches,
                        this.getContextRadius()
                    );
                    this.postMessage({
                        type: 'contextPreview',
                        filePath: msg.filePath,
                        lineNo: msg.lineNo,
                        contextLines,
                    });
                }
                break;
            }

            case 'selectHistory': {
                if (msg.historyId) {
                    const found = this.history.find((h) => h.id === msg.historyId);
                    if (found) {
                        this.currentResult = found;
                        if (found.files.length > 0) {
                            this.previousResultFiles = found.files.map((f) => f.filePath);
                        }
                        this.settings = { ...found.settings };
                        await this.saveSettings();
                        this.rebuildFlatMatches();
                        this.postStateToWebview(false);
                    }
                }
                break;
            }

            case 'deleteHistory': {
                if (msg.historyId) {
                    this.history = this.history.filter((h) => h.id !== msg.historyId);
                    if (this.currentResult?.id === msg.historyId) {
                        this.currentResult = this.history[0];
                        this.previousResultFiles =
                            this.currentResult?.files.map((f) => f.filePath) ?? [];
                        this.rebuildFlatMatches();
                    }
                    await this.saveHistory();
                    this.postStateToWebview(false);
                }
                break;
            }

            case 'clearHistory': {
                this.history = [];
                this.currentResult = undefined;
                this.previousResultFiles = [];
                this.flatMatches = [];
                this.activeFlatMatchIndex = -1;
                await this.saveHistory();
                this.postStateToWebview(false);
                break;
            }

            case 'toggleFormUnit': {
                await toggleFormAndUnit();
                break;
            }
        }
    }

    private async executeSearch(settings: GxGrepSettings, recordInHistory: boolean): Promise<void> {
        const result = await runGxGrepSearch(
            settings,
            this.lastActiveFile,
            this.previousResultFiles
        );
        this.currentResult = result;
        if (settings.pattern.trim().length > 0 && !result.error) {
            if (settings.scope !== 'results' || result.files.length > 0) {
                this.previousResultFiles = result.files.map((f) => f.filePath);
            }
        }
        this.rebuildFlatMatches();

        if (recordInHistory && settings.pattern.trim().length > 0 && !result.error) {
            // Replace existing top history item if identical pattern & scope, otherwise prepend
            const existingIdx = this.history.findIndex(
                (h) =>
                    h.settings.pattern === settings.pattern &&
                    h.settings.scope === settings.scope &&
                    h.settings.includeForms === settings.includeForms
            );
            if (existingIdx >= 0) {
                this.history.splice(existingIdx, 1);
            }
            this.history.unshift(result);
            if (this.history.length > MAX_HISTORY_ITEMS) {
                this.history.length = MAX_HISTORY_ITEMS;
            }
            await this.saveHistory();
        }

        this.postMessage({
            type: 'searchResult',
            result,
            history: this.getHistorySummaries(),
        });
    }

    private rebuildFlatMatches(): void {
        this.flatMatches = [];
        this.activeFlatMatchIndex = -1;
        if (!this.currentResult) {
            return;
        }
        this.currentResult.files.forEach((file, fileIndex) => {
            if (typeof file.totalLines !== 'number' || file.totalLines <= 0) {
                try {
                    file.totalLines = loadFileLines(file.filePath).length;
                } catch {
                    file.totalLines = 0;
                }
            }
            file.lines.forEach((line, lineIndex) => {
                this.flatMatches.push({
                    fileIndex,
                    lineIndex,
                    filePath: file.filePath,
                    lineNo: line.lineNo,
                    matches: line.matches,
                });
            });
        });
    }

    private async navigateToMatch(
        filePath: string,
        lineNo: number,
        matches: GxGrepMatchRange[],
        focusEditor: boolean
    ): Promise<void> {
        try {
            const doc = await workspace.openTextDocument(Uri.file(filePath));
            const lineZero = Math.max(0, Math.min(doc.lineCount - 1, lineNo - 1));
            const firstMatch = matches[0];
            const startChar = firstMatch ? Math.max(0, firstMatch.startCol - 1) : 0;
            const endChar = firstMatch ? Math.max(startChar, firstMatch.endCol) : startChar;

            const startPos = new Position(lineZero, startChar);
            const endPos = new Position(lineZero, endChar);
            const selection = new Selection(startPos, endPos);

            const editor = await window.showTextDocument(doc, {
                preserveFocus: !focusEditor,
                preview: !focusEditor,
                selection,
            });
            editor.revealRange(new Range(startPos, endPos), TextEditorRevealType.InCenter);
        } catch (err) {
            window.showErrorMessage(`Delphi GX Grep: Could not open "${filePath}": ${err}`);
        }
    }

    private getActiveUnitSummary(): {
        unitName: string;
        formName?: string;
        hasForm: boolean;
    } {
        if (!this.lastActiveFile) {
            return { unitName: 'None', hasForm: false };
        }
        const pair = resolveUnitAndFormPair(this.lastActiveFile);
        const unitName = path.basename(pair.unitFile ?? this.lastActiveFile);
        const formName = pair.formFile ? path.basename(pair.formFile) : undefined;
        return {
            unitName,
            formName,
            hasForm: Boolean(pair.formFile),
        };
    }

    private getHistorySummaries() {
        return this.history.map((h) => ({
            id: h.id,
            pattern: h.settings.pattern,
            scope: h.settings.scope,
            includeForms: h.settings.includeForms,
            totalMatches: h.totalMatches,
            fileCount: h.files.length,
            timestamp: h.timestamp,
        }));
    }

    private postActiveUnitInfo(): void {
        this.postMessage({
            type: 'activeUnitChanged',
            activeUnit: this.getActiveUnitSummary(),
        });
    }

    private getContextRadius(): number {
        return Math.min(5, Math.max(1, Math.trunc(this.settings.contextRadius ?? 2)));
    }

    private postSelectMatchIndex(index: number, item: FlatMatchLocation): void {
        const contextLines = getFileContextLines(
            item.filePath,
            item.lineNo,
            item.matches,
            this.getContextRadius()
        );
        this.postMessage({
            type: 'selectMatchIndex',
            index,
            filePath: item.filePath,
            lineNo: item.lineNo,
            contextLines,
        });
    }

    private postStateToWebview(focusInput: boolean): void {
        let initialContext:
            | {
                  filePath: string;
                  lineNo: number;
                  contextLines: GxGrepContextLine[];
              }
            | undefined;

        if (this.activeFlatMatchIndex >= 0 && this.activeFlatMatchIndex < this.flatMatches.length) {
            const target = this.flatMatches[this.activeFlatMatchIndex];
            if (target) {
                initialContext = {
                    filePath: target.filePath,
                    lineNo: target.lineNo,
                    contextLines: getFileContextLines(
                        target.filePath,
                        target.lineNo,
                        target.matches,
                        this.getContextRadius()
                    ),
                };
            }
        }

        this.postMessage({
            type: 'initState',
            settings: this.settings,
            activeUnit: this.getActiveUnitSummary(),
            currentResult: this.currentResult,
            history: this.getHistorySummaries(),
            selectedMatchIndex: this.activeFlatMatchIndex,
            initialContext,
            focusInput,
        });
    }

    private postMessage(message: unknown): void {
        if (this.view) {
            void this.view.webview.postMessage(message);
        }
    }

    private async saveSettings(): Promise<void> {
        await this.context.workspaceState.update(STATE_SETTINGS_KEY, this.settings);
    }

    private async saveHistory(): Promise<void> {
        await this.context.workspaceState.update(STATE_HISTORY_KEY, this.history);
    }

    private getHtmlForWebview(webview: Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>GX Grep</title>
<style>
    :root {
        --border-color: var(--vscode-panel-border, var(--vscode-widget-border, #444));
        --header-bg: var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.14));
        --hover-bg: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
        --file-header-bg: #000;
        --file-header-hover-bg: #435e70;
        --match-row-bg: var(--vscode-list-ItemBackground, #222);
        --match-row-border: var(--vscode-listItem-border, #555);
        --selected-bg: var(--vscode-list-activeSelectionBackground, #094771);
        --selected-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
        --match-bg: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.35));
        --match-border: var(--vscode-editor-findMatchHighlightBorder, rgba(255, 165, 0, 0.7));
        --badge-pas-bg: rgba(55, 148, 255, 0.2);
        --badge-pas-fg: var(--vscode-textLink-foreground, #3794ff);
        --badge-dfm-bg: rgba(204, 132, 0, 0.24);
        --badge-dfm-fg: var(--vscode-editorWarning-foreground, #cca700);
    }
    * {
        box-sizing: border-box;
    }
    body {
        margin: 0;
        padding: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background-color: var(--vscode-panel-background, var(--vscode-editor-background));
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
    }
    .toolbar {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border-color);
        background: var(--vscode-sideBar-background, var(--vscode-panel-background));
        flex-shrink: 0;
    }
    .search-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }
    .search-input-wrap {
        display: flex;
        flex: 1;
        min-width: 180px;
        position: relative;
    }
    input[type="text"], select {
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, var(--border-color));
        border-radius: 3px;
        padding: 4px 8px;
        font-size: inherit;
        font-family: inherit;
        outline: none;
    }
    input[type="text"]:focus, select:focus {
        border-color: var(--vscode-focusBorder);
    }
    #patternInput {
        width: 100%;
        font-family: var(--vscode-editor-font-family, monospace);
    }
    button {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: 1px solid transparent;
        border-radius: 3px;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
    }
    button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
    }
    button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        font-weight: 600;
    }
    button.primary:hover {
        background: var(--vscode-button-hoverBackground);
    }
    button.active-toggle {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.25));
    }
    .options-row {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        font-size: 12px;
    }
    .scope-group {
        display: inline-flex;
        align-items: center;
        gap: 5px;
    }
    label.chk {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
    }
    label.chk.dfm-highlight {
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--badge-dfm-bg);
        color: var(--vscode-foreground);
        border: 1px solid rgba(204, 132, 0, 0.4);
    }
    .unit-pill {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        opacity: 0.9;
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--header-bg);
    }
    .advanced-panel {
        display: none;
        flex-direction: column;
        gap: 6px;
        padding-top: 6px;
        border-top: 1px dashed var(--border-color);
        font-size: 12px;
    }
    .advanced-panel.open {
        display: flex;
    }
    .filter-group {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    }
    .filter-title {
        font-weight: 600;
        opacity: 0.85;
        min-width: 105px;
    }
    .dir-controls {
        display: none;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .dir-controls.visible {
        display: flex;
    }
    .dir-controls input[type="text"] {
        min-width: 180px;
    }
    .workspace-body {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }
    .history-pane {
        width: 220px;
        border-right: 1px solid var(--border-color);
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex-shrink: 0;
        background: var(--vscode-sideBar-background, transparent);
    }
    .history-pane.hidden {
        display: none;
    }
    .pane-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        background: var(--file-header-bg);
        border-bottom: 1px solid var(--border-color);
    }
    .history-list {
        flex: 1;
        overflow-y: auto;
        padding: 2px 0;
    }
    .history-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 12px;
        border-bottom: 1px solid rgba(128, 128, 128, 0.08);
    }
    .history-item:hover {
        background: var(--hover-bg);
    }
    .history-item.active {
        background: var(--selected-bg);
        color: var(--selected-fg);
    }
    .history-item-main {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
    }
    .history-pattern {
        font-family: var(--vscode-editor-font-family, monospace);
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .history-meta {
        font-size: 10px;
        opacity: 0.78;
    }
    .history-del {
        background: transparent;
        border: none;
        color: inherit;
        opacity: 0.6;
        padding: 2px 5px;
        font-size: 12px;
    }
    .history-del:hover {
        opacity: 1;
        background: rgba(255, 0, 0, 0.2);
    }
    .main-pane {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
    }
    .status-strip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 3px 10px;
        font-size: 11px;
        background: var(--header-bg);
        border-bottom: 1px solid var(--border-color);
        flex-shrink: 0;
    }
    .error-banner {
        display: none;
        padding: 6px 10px;
        background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
        color: var(--vscode-inputValidation-errorForeground, #fff);
        border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
        font-size: 12px;
    }
    .error-banner.visible {
        display: block;
    }
    .results-list {
        flex: 1;
        overflow-y: auto;
        outline: none;
        font-family: var(--vscode-editor-font-family, Consolas, monospace);
        font-size: var(--vscode-editor-font-size, 12px);
    }
    .empty-state {
        padding: 20px;
        text-align: center;
        opacity: 0.7;
        font-family: var(--vscode-font-family);
    }
    .file-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 3px 8px;
        background: var(--file-header-bg);
        border-top: 1px solid var(--border-color);
        border-bottom: 2px solid var(--border-color);
        cursor: pointer;
        user-select: none;
        font-weight: 600;
    }
    .file-header:hover {
        background: var(--file-header-hover-bg);
    }
    .file-header-left {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        overflow: hidden;
    }
    .exp-icon {
        display: inline-block;
        width: 14px;
        text-align: center;
        font-weight: bold;
    }
    .badge {
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 3px;
        font-weight: 700;
        font-family: var(--vscode-font-family);
    }
    .badge.pas {
        background: var(--badge-pas-bg);
        color: var(--badge-pas-fg);
    }
    .badge.dfm {
        background: var(--badge-dfm-bg);
        color: var(--badge-dfm-fg);
    }
    .file-path-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .file-line-count {
        font-size: 11px;
        font-weight: normal;
        opacity: 0.75;
        white-space: nowrap;
        flex-shrink: 0;
        font-family: var(--vscode-font-family);
    }
    .file-match-count {
        font-size: 11px;
        opacity: 0.85;
        margin-left: 8px;
        white-space: nowrap;
        font-family: var(--vscode-font-family);
    }
    .match-row {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 3px 8px 3px 2px;
        background: var(--match-row-bg);
        border-bottom: 1px dotted var(--match-row-border);
        cursor: pointer;
        white-space: pre;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .match-row:hover {
        background: var(--hover-bg);
    }
    .match-row.selected {
        background: var(--selected-bg);
        color: var(--selected-fg);
    }
    .line-no {
        display: inline-block;
        min-width: 48px;
        text-align: right;
        padding-right: 10px;
        opacity: 0.6;
        user-select: none;
        flex-shrink: 0;
    }
    .match-row.selected .line-no {
        opacity: 0.95;
    }
    .line-code {
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .hit {
        background: var(--match-bg);
        border: 1px solid var(--match-border);
        border-radius: 2px;
        font-weight: bold;
    }
    .match-row.selected .hit {
        background: rgba(255, 215, 0, 0.35);
        color: inherit;
        text-decoration: underline;
    }
    .context-pane {
        min-height: 65px;
        max-height: 45%;
        border-top: 2px solid var(--border-color);
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
        background: var(--vscode-editor-background);
    }
    .context-pane.hidden {
        display: none;
    }
    .context-code {
        flex: 0 1 auto;
        min-height: 0;
        overflow-x: auto;
        overflow-y: auto;
        font-family: var(--vscode-editor-font-family, Consolas, monospace);
        font-size: var(--vscode-editor-font-size, 12px);
        padding: 2px 0;
    }
    .ctx-line {
        display: flex;
        white-space: pre;
        padding: 1px 8px;
    }
    .ctx-line.active-line {
        background: var(--vscode-editor-lineHighlightBackground, rgba(128, 128, 128, 0.18));
        font-weight: 600;
    }
</style>
</head>
<body>
    <div class="toolbar">
        <div class="search-row">
            <div class="search-input-wrap">
                <input id="patternInput" type="text" placeholder="GX Grep: Text or Regular Expression to find... (Enter to search)" />
            </div>
            <button id="btnSearch" class="primary" title="Run GX Grep Search (Enter)">Search</button>
            <button id="btnRefresh" title="Refresh current search">Refresh</button>
            <button id="btnExpandAll" title="Expand all files">+</button>
            <button id="btnCollapseAll" title="Collapse all files">−</button>
            <button id="btnFullFile" title="Toggle full file paths">Full Path</button>
            <button id="btnToggleFilters" title="Show/hide Delphi code &amp; section filters">Filters ▾</button>
            <button id="btnToggleContext" class="active-toggle" title="Show/hide match context preview pane">Context</button>
            <button id="btnToggleHistory" class="active-toggle" title="Show/hide search history list">History</button>
        </div>

        <div class="options-row">
            <div class="scope-group">
                <label for="scopeSelect"><strong>Where:</strong></label>
                <select id="scopeSelect">
                    <option value="current">Current Unit (.pas + .dfm)</option>
                    <option value="open">Open Project Files</option>
                    <option value="project">All Files in Project</option>
                    <option value="directory">Directories / Workspace</option>
                    <option value="results">Previous Search Result Files</option>
                </select>
            </div>

            <label class="chk dfm-highlight" title="Include companion Delphi Form files (.dfm / .fmx / .nfm / .xfm) in the search">
                <input type="checkbox" id="chkIncludeForms" checked />
                Include Form (.dfm)
            </label>
            <label class="chk" title="Case sensitive search">
                <input type="checkbox" id="chkCaseSensitive" />
                Case sensitive
            </label>
            <label class="chk" title="Match whole words only">
                <input type="checkbox" id="chkWholeWord" />
                Whole word
            </label>
            <label class="chk" title="Treat search pattern as a Regular Expression">
                <input type="checkbox" id="chkIsRegex" />
                Regular expression
            </label>

            <div class="unit-pill" id="activeUnitPill" title="Currently tracked Delphi unit &amp; companion form">
                <span id="activeUnitLabel">Unit: None</span>
                <button id="btnSwapUnitForm" title="Toggle between .pas and .dfm file in editor" style="padding:1px 5px;font-size:11px;">.pas ↔ .dfm</button>
            </div>
        </div>

        <div class="dir-controls" id="dirControls">
            <label>Dir: <input type="text" id="txtDirPath" placeholder="(Workspace root)" /></label>
            <label>Mask: <input type="text" id="txtFileMask" value="*.pas;*.dpr;*.dpk;*.inc" /></label>
            <label class="chk"><input type="checkbox" id="chkSubdirs" checked /> Include subdirs</label>
            <label>Exclude: <input type="text" id="txtExcludedDirs" /></label>
        </div>

        <div class="advanced-panel" id="advancedPanel">
            <div class="filter-group">
                <span class="filter-title">DFM Options:</span>
                <label class="chk" title="Concatenate continued multiline DFM strings ('...' + '...') before matching">
                    <input type="checkbox" id="chkDfmMultiline" checked /> Multiline strings
                </label>
                <label class="chk" title="Convert #NNN character sequences in DFM strings before matching">
                    <input type="checkbox" id="chkDfmSpecialChars" checked /> Special chars (#NNN)
                </label>
            </div>
            <div class="filter-group">
                <span class="filter-title">Delphi Content:</span>
                <label class="chk"><input type="checkbox" id="chkCode" checked /> Code</label>
                <label class="chk"><input type="checkbox" id="chkStrings" checked /> Strings</label>
                <label class="chk"><input type="checkbox" id="chkComments" checked /> Comments</label>
            </div>
            <div class="filter-group">
                <span class="filter-title">Unit Sections:</span>
                <label class="chk"><input type="checkbox" id="chkSecInterface" checked /> interface</label>
                <label class="chk"><input type="checkbox" id="chkSecImplementation" checked /> implementation</label>
                <label class="chk"><input type="checkbox" id="chkSecInitialization" checked /> initialization</label>
                <label class="chk"><input type="checkbox" id="chkSecFinalization" checked /> finalization</label>
            </div>
        </div>
    </div>

    <div class="error-banner" id="errorBanner"></div>

    <div class="workspace-body">
        <div class="history-pane" id="historyPane">
            <div class="pane-header">
                <span>Search History</span>
                <button id="btnClearHistory" title="Clear all search history" style="padding:1px 5px;font-size:10px;">Clear</button>
            </div>
            <div class="history-list" id="historyList"></div>
        </div>

        <div class="main-pane">
            <div class="status-strip">
                <span id="statusSummary">Ready — type a search term to grep current unit &amp; form (.dfm)</span>
                <span id="statusTiming"></span>
            </div>

            <div class="results-list" id="resultsList" tabindex="0">
                <div class="empty-state">Enter a search pattern above to run GX Grep.</div>
            </div>

            <div class="context-pane" id="contextPane">
                <div class="pane-header">
                    <span id="contextHeaderLabel">Match Context Preview</span>
                    <label style="display:inline-flex;align-items:center;gap:4px;text-transform:none;font-weight:normal;" title="Number of surrounding lines to show above and below the match (1–5)">
                        <span>Lines (±):</span>
                        <select id="contextRadiusSelect" style="padding:1px 4px;font-size:11px;">
                            <option value="1">1</option>
                            <option value="2" selected>2</option>
                            <option value="3">3</option>
                            <option value="4">4</option>
                            <option value="5">5</option>
                        </select>
                    </label>
                </div>
                <div class="context-code" id="contextCode"></div>
            </div>
        </div>
    </div>

<script nonce="${nonce}">
(function() {
    const vscode = acquireVsCodeApi();

    const patternInput = document.getElementById('patternInput');
    const scopeSelect = document.getElementById('scopeSelect');
    const chkIncludeForms = document.getElementById('chkIncludeForms');
    const chkCaseSensitive = document.getElementById('chkCaseSensitive');
    const chkWholeWord = document.getElementById('chkWholeWord');
    const chkIsRegex = document.getElementById('chkIsRegex');
    const chkDfmMultiline = document.getElementById('chkDfmMultiline');
    const chkDfmSpecialChars = document.getElementById('chkDfmSpecialChars');
    const chkCode = document.getElementById('chkCode');
    const chkStrings = document.getElementById('chkStrings');
    const chkComments = document.getElementById('chkComments');
    const chkSecInterface = document.getElementById('chkSecInterface');
    const chkSecImplementation = document.getElementById('chkSecImplementation');
    const chkSecInitialization = document.getElementById('chkSecInitialization');
    const chkSecFinalization = document.getElementById('chkSecFinalization');
    const txtDirPath = document.getElementById('txtDirPath');
    const txtFileMask = document.getElementById('txtFileMask');
    const chkSubdirs = document.getElementById('chkSubdirs');
    const txtExcludedDirs = document.getElementById('txtExcludedDirs');
    const contextRadiusSelect = document.getElementById('contextRadiusSelect');

    const dirControls = document.getElementById('dirControls');
    const advancedPanel = document.getElementById('advancedPanel');
    const historyPane = document.getElementById('historyPane');
    const historyList = document.getElementById('historyList');
    const contextPane = document.getElementById('contextPane');
    const contextHeaderLabel = document.getElementById('contextHeaderLabel');
    const contextCode = document.getElementById('contextCode');
    const resultsList = document.getElementById('resultsList');
    const statusSummary = document.getElementById('statusSummary');
    const statusTiming = document.getElementById('statusTiming');
    const errorBanner = document.getElementById('errorBanner');
    const activeUnitLabel = document.getElementById('activeUnitLabel');

    const btnSearch = document.getElementById('btnSearch');
    const btnRefresh = document.getElementById('btnRefresh');
    const btnExpandAll = document.getElementById('btnExpandAll');
    const btnCollapseAll = document.getElementById('btnCollapseAll');
    const btnFullFile = document.getElementById('btnFullFile');
    const btnToggleFilters = document.getElementById('btnToggleFilters');
    const btnToggleContext = document.getElementById('btnToggleContext');
    const btnToggleHistory = document.getElementById('btnToggleHistory');
    const btnClearHistory = document.getElementById('btnClearHistory');
    const btnSwapUnitForm = document.getElementById('btnSwapUnitForm');

    let currentResult = null;
    let historyItems = [];
    let showFullPath = false;
    let selectedGlobalIndex = -1;
    let flatRows = [];

    function readSettingsFromUI() {
        if (!chkCode.checked && !chkStrings.checked && !chkComments.checked) {
            chkCode.checked = true;
        }
        if (
            !chkSecInterface.checked &&
            !chkSecImplementation.checked &&
            !chkSecInitialization.checked &&
            !chkSecFinalization.checked
        ) {
            chkSecInterface.checked = true;
            chkSecImplementation.checked = true;
        }
        return {
            pattern: patternInput.value,
            scope: scopeSelect.value,
            caseSensitive: chkCaseSensitive.checked,
            wholeWord: chkWholeWord.checked,
            isRegex: chkIsRegex.checked,
            includeForms: chkIncludeForms.checked,
            dfmMultiline: chkDfmMultiline.checked,
            dfmSpecialChars: chkDfmSpecialChars.checked,
            includeCode: chkCode.checked,
            includeStrings: chkStrings.checked,
            includeComments: chkComments.checked,
            sectionInterface: chkSecInterface.checked,
            sectionImplementation: chkSecImplementation.checked,
            sectionInitialization: chkSecInitialization.checked,
            sectionFinalization: chkSecFinalization.checked,
            directoryPath: txtDirPath.value,
            fileMask: txtFileMask.value,
            includeSubdirs: chkSubdirs.checked,
            excludedDirs: txtExcludedDirs.value,
            contextRadius: Number(contextRadiusSelect.value) || 2,
        };
    }

    function applySettingsToUI(s) {
        if (!s) return;
        patternInput.value = s.pattern || '';
        scopeSelect.value = s.scope || 'current';
        chkCaseSensitive.checked = Boolean(s.caseSensitive);
        chkWholeWord.checked = Boolean(s.wholeWord);
        chkIsRegex.checked = Boolean(s.isRegex);
        chkIncludeForms.checked = s.includeForms !== false;
        chkDfmMultiline.checked = s.dfmMultiline !== false;
        chkDfmSpecialChars.checked = s.dfmSpecialChars !== false;
        chkCode.checked = s.includeCode !== false;
        chkStrings.checked = s.includeStrings !== false;
        chkComments.checked = s.includeComments !== false;
        chkSecInterface.checked = s.sectionInterface !== false;
        chkSecImplementation.checked = s.sectionImplementation !== false;
        chkSecInitialization.checked = s.sectionInitialization !== false;
        chkSecFinalization.checked = s.sectionFinalization !== false;
        txtDirPath.value = s.directoryPath || '';
        txtFileMask.value = s.fileMask || '*.pas;*.dpr;*.dpk;*.inc';
        chkSubdirs.checked = s.includeSubdirs !== false;
        txtExcludedDirs.value = s.excludedDirs || '';
        const radiusVal = Number(s.contextRadius);
        contextRadiusSelect.value =
            radiusVal >= 1 && radiusVal <= 5 ? String(Math.trunc(radiusVal)) : '2';
        dirControls.classList.toggle('visible', s.scope === 'directory');
    }

    function updateActiveUnitUI(info) {
        if (!info) return;
        if (info.hasForm && info.formName) {
            activeUnitLabel.textContent = info.unitName + ' + ' + info.formName;
            btnSwapUnitForm.style.display = 'inline-flex';
        } else {
            activeUnitLabel.textContent = info.unitName;
            btnSwapUnitForm.style.display = 'none';
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function highlightLineHtml(lineText, matches) {
        if (!matches || matches.length === 0) {
            return escapeHtml(lineText);
        }
        const sorted = [...matches].sort((a, b) => a.startCol - b.startCol);
        let out = '';
        let cursor = 0; // 0-based index in lineText
        for (const m of sorted) {
            const s = Math.max(cursor, m.startCol - 1);
            const e = Math.min(lineText.length, m.endCol);
            if (s > cursor) {
                out += escapeHtml(lineText.slice(cursor, s));
            }
            if (e > s) {
                out += '<span class="hit">' + escapeHtml(lineText.slice(s, e)) + '</span>';
                cursor = e;
            }
        }
        if (cursor < lineText.length) {
            out += escapeHtml(lineText.slice(cursor));
        }
        return out;
    }

    function renderHistory() {
        historyList.innerHTML = '';
        if (!historyItems || historyItems.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.style.padding = '10px';
            empty.textContent = 'No history yet';
            historyList.appendChild(empty);
            return;
        }
        for (const item of historyItems) {
            const row = document.createElement('div');
            row.className = 'history-item' + (currentResult && currentResult.id === item.id ? ' active' : '');
            const main = document.createElement('div');
            main.className = 'history-item-main';

            const pat = document.createElement('div');
            pat.className = 'history-pattern';
            pat.textContent = item.pattern;

            const meta = document.createElement('div');
            meta.className = 'history-meta';
            const dfmTag = item.includeForms ? '+dfm' : 'pas';
            meta.textContent = item.totalMatches + ' hits · ' + item.fileCount + ' files [' + item.scope + ' ' + dfmTag + ']';

            main.appendChild(pat);
            main.appendChild(meta);

            const delBtn = document.createElement('button');
            delBtn.className = 'history-del';
            delBtn.textContent = '×';
            delBtn.title = 'Remove from history';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'deleteHistory', historyId: item.id });
            });

            row.appendChild(main);
            row.appendChild(delBtn);
            row.addEventListener('click', () => {
                vscode.postMessage({ type: 'selectHistory', historyId: item.id });
            });
            historyList.appendChild(row);
        }
    }

    function renderContextPreview(filePath, lineNo, contextLines) {
        contextCode.innerHTML = '';
        if (!contextLines || contextLines.length === 0) {
            contextHeaderLabel.textContent = 'Match Context Preview';
            return;
        }
        const shortName = filePath ? filePath.split(/[\\\\/]/).pop() : '';
        contextHeaderLabel.textContent = 'Match Context — ' + shortName + ' : Line ' + lineNo;
        let activeLineEl = null;
        for (const cl of contextLines) {
            const div = document.createElement('div');
            div.className = 'ctx-line' + (cl.isMatchLine ? ' active-line' : '');
            const ln = document.createElement('span');
            ln.className = 'line-no';
            ln.textContent = String(cl.lineNo);
            const code = document.createElement('span');
            code.className = 'line-code';
            code.innerHTML = highlightLineHtml(cl.text, cl.matches);
            div.appendChild(ln);
            div.appendChild(code);
            contextCode.appendChild(div);
            if (cl.isMatchLine) {
                activeLineEl = div;
            }
        }
        if (activeLineEl) {
            activeLineEl.scrollIntoView({ block: 'nearest' });
        }
    }

    function renderResults() {
        resultsList.innerHTML = '';
        flatRows = [];

        if (!currentResult) {
            errorBanner.classList.remove('visible');
            statusSummary.textContent = 'Ready — type a search term to grep current unit & form (.dfm)';
            statusTiming.textContent = '';
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'Enter a search pattern above to run GX Grep.';
            resultsList.appendChild(empty);
            return;
        }

        if (currentResult.error) {
            errorBanner.textContent = currentResult.error;
            errorBanner.classList.add('visible');
        } else {
            errorBanner.classList.remove('visible');
        }

        statusSummary.textContent =
            currentResult.totalMatches +
            ' match' +
            (currentResult.totalMatches === 1 ? '' : 'es') +
            ' in ' +
            currentResult.files.length +
            ' file' +
            (currentResult.files.length === 1 ? '' : 's') +
            ' (' +
            currentResult.filesSearched +
            ' searched — ' +
            (currentResult.scopeDescription || currentResult.settings.scope) +
            ')';
        statusTiming.textContent = currentResult.durationMs + ' ms';

        if (currentResult.files.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = currentResult.settings.pattern
                ? 'No matches found for "' + currentResult.settings.pattern + '".'
                : 'Enter a search pattern above to run GX Grep.';
            resultsList.appendChild(empty);
            return;
        }

        let globalCounter = 0;

        currentResult.files.forEach((fileObj) => {
            const header = document.createElement('div');
            header.className = 'file-header';

            const left = document.createElement('div');
            left.className = 'file-header-left';

            const exp = document.createElement('span');
            exp.className = 'exp-icon';
            exp.textContent = fileObj.expanded ? '−' : '+';

            const badge = document.createElement('span');
            badge.className = 'badge ' + (fileObj.isFormFile ? 'dfm' : 'pas');
            badge.textContent = fileObj.isFormFile ? 'DFM' : 'PAS';

            const pathSpan = document.createElement('span');
            pathSpan.className = 'file-path-text';
            pathSpan.textContent = showFullPath ? fileObj.filePath : fileObj.relativePath;
            pathSpan.title = fileObj.filePath;

            left.appendChild(exp);
            left.appendChild(badge);
            left.appendChild(pathSpan);

            if (typeof fileObj.totalLines === 'number' && fileObj.totalLines > 0) {
                const linesSpan = document.createElement('span');
                linesSpan.className = 'file-line-count';
                linesSpan.textContent =
                    '(' +
                    fileObj.totalLines +
                    (fileObj.totalLines === 1 ? ' line' : ' lines') +
                    ')';
                left.appendChild(linesSpan);
            }

            const countSpan = document.createElement('span');
            countSpan.className = 'file-match-count';
            countSpan.textContent =
                fileObj.totalMatches + (fileObj.totalMatches === 1 ? ' match' : ' matches');

            header.appendChild(left);
            header.appendChild(countSpan);

            header.addEventListener('click', () => {
                fileObj.expanded = !fileObj.expanded;
                renderResults();
            });

            resultsList.appendChild(header);

            if (fileObj.expanded) {
                fileObj.lines.forEach((lineObj) => {
                    const globalIdx = globalCounter++;
                    const row = document.createElement('div');
                    row.className =
                        'match-row' + (globalIdx === selectedGlobalIndex ? ' selected' : '');

                    const ln = document.createElement('span');
                    ln.className = 'line-no';
                    ln.textContent = String(lineObj.lineNo);

                    const code = document.createElement('span');
                    code.className = 'line-code';
                    code.innerHTML = highlightLineHtml(lineObj.lineText, lineObj.matches);

                    row.appendChild(ln);
                    row.appendChild(code);

                    const rowData = {
                        globalIdx,
                        element: row,
                        filePath: fileObj.filePath,
                        lineNo: lineObj.lineNo,
                        matches: lineObj.matches,
                    };
                    flatRows.push(rowData);

                    row.addEventListener('click', () => {
                        selectByGlobalIndex(globalIdx, false);
                    });
                    row.addEventListener('dblclick', () => {
                        selectByGlobalIndex(globalIdx, true);
                    });

                    resultsList.appendChild(row);
                });
            } else {
                globalCounter += fileObj.lines.length;
            }
        });
    }

    function selectByGlobalIndex(globalIdx, focusEditor) {
        const target = flatRows.find((r) => r.globalIdx === globalIdx);
        if (!target) return;
        for (const r of flatRows) {
            if (r.globalIdx === selectedGlobalIndex) {
                r.element.classList.remove('selected');
            }
        }
        selectedGlobalIndex = globalIdx;
        target.element.classList.add('selected');
        target.element.scrollIntoView({ block: 'nearest' });

        vscode.postMessage({
            type: 'selectMatch',
            filePath: target.filePath,
            lineNo: target.lineNo,
            matches: target.matches,
            focusEditor: Boolean(focusEditor),
        });
    }

    function triggerSearch(recordHistory) {
        const settings = readSettingsFromUI();
        vscode.postMessage({
            type: recordHistory ? 'search' : 'liveSearch',
            settings,
        });
    }

    patternInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            triggerSearch(true);
        } else if (e.key === 'ArrowDown' && flatRows.length > 0) {
            e.preventDefault();
            resultsList.focus();
            const target =
                flatRows.find((r) => r.globalIdx === selectedGlobalIndex) || flatRows[0];
            if (target) {
                selectByGlobalIndex(target.globalIdx, false);
            }
        }
    });

    resultsList.addEventListener('keydown', (e) => {
        const currentVisibleIdx = flatRows.findIndex((r) => r.globalIdx === selectedGlobalIndex);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const nextIdx = currentVisibleIdx + 1;
            if (nextIdx >= 0 && nextIdx < flatRows.length) {
                selectByGlobalIndex(flatRows[nextIdx].globalIdx, false);
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prevIdx = currentVisibleIdx - 1;
            if (prevIdx >= 0 && prevIdx < flatRows.length) {
                selectByGlobalIndex(flatRows[prevIdx].globalIdx, false);
            } else {
                patternInput.focus();
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (currentVisibleIdx >= 0 && currentVisibleIdx < flatRows.length) {
                selectByGlobalIndex(flatRows[currentVisibleIdx].globalIdx, true);
            }
        }
    });

    btnSearch.addEventListener('click', () => triggerSearch(true));
    btnRefresh.addEventListener('click', () => triggerSearch(true));

    btnExpandAll.addEventListener('click', () => {
        if (!currentResult) return;
        currentResult.files.forEach((f) => (f.expanded = true));
        renderResults();
    });

    btnCollapseAll.addEventListener('click', () => {
        if (!currentResult) return;
        currentResult.files.forEach((f) => (f.expanded = false));
        renderResults();
    });

    btnFullFile.addEventListener('click', () => {
        showFullPath = !showFullPath;
        btnFullFile.classList.toggle('active-toggle', showFullPath);
        renderResults();
    });

    btnToggleFilters.addEventListener('click', () => {
        const isOpen = advancedPanel.classList.toggle('open');
        btnToggleFilters.classList.toggle('active-toggle', isOpen);
    });

    btnToggleContext.addEventListener('click', () => {
        const hidden = contextPane.classList.toggle('hidden');
        btnToggleContext.classList.toggle('active-toggle', !hidden);
    });

    btnToggleHistory.addEventListener('click', () => {
        const hidden = historyPane.classList.toggle('hidden');
        btnToggleHistory.classList.toggle('active-toggle', !hidden);
    });

    btnClearHistory.addEventListener('click', () => {
        vscode.postMessage({ type: 'clearHistory' });
    });

    btnSwapUnitForm.addEventListener('click', () => {
        vscode.postMessage({ type: 'toggleFormUnit' });
    });

    const immediateFilterControls = [
        scopeSelect,
        chkIncludeForms,
        chkCaseSensitive,
        chkWholeWord,
        chkIsRegex,
        chkDfmMultiline,
        chkDfmSpecialChars,
        chkCode,
        chkStrings,
        chkComments,
        chkSecInterface,
        chkSecImplementation,
        chkSecInitialization,
        chkSecFinalization,
        chkSubdirs,
    ];

    for (const ctrl of immediateFilterControls) {
        ctrl.addEventListener('change', () => {
            const s = readSettingsFromUI();
            dirControls.classList.toggle('visible', s.scope === 'directory');
            vscode.postMessage({ type: 'updateSettings', settings: s });
            if (
                s.pattern &&
                (s.scope === 'current' ||
                    s.scope === 'open' ||
                    ctrl === chkIncludeForms ||
                    ctrl === scopeSelect)
            ) {
                triggerSearch(false);
            }
        });
    }

    contextRadiusSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'updateSettings', settings: readSettingsFromUI() });
    });

    for (const dirInput of [txtDirPath, txtFileMask, txtExcludedDirs]) {
        dirInput.addEventListener('change', () => {
            vscode.postMessage({ type: 'updateSettings', settings: readSettingsFromUI() });
        });
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'initState': {
                applySettingsToUI(msg.settings);
                updateActiveUnitUI(msg.activeUnit);
                currentResult = msg.currentResult || null;
                historyItems = msg.history || [];
                selectedGlobalIndex =
                    typeof msg.selectedMatchIndex === 'number' ? msg.selectedMatchIndex : -1;
                renderHistory();
                renderResults();
                if (msg.initialContext) {
                    renderContextPreview(
                        msg.initialContext.filePath,
                        msg.initialContext.lineNo,
                        msg.initialContext.contextLines
                    );
                } else {
                    renderContextPreview('', 0, []);
                }
                if (msg.focusInput) {
                    patternInput.focus();
                    patternInput.select();
                }
                break;
            }
            case 'searchResult': {
                currentResult = msg.result;
                historyItems = msg.history || historyItems;
                selectedGlobalIndex = -1;
                renderHistory();
                renderResults();
                renderContextPreview('', 0, []);
                break;
            }
            case 'contextPreview': {
                renderContextPreview(msg.filePath, msg.lineNo, msg.contextLines);
                break;
            }
            case 'activeUnitChanged': {
                updateActiveUnitUI(msg.activeUnit);
                break;
            }
            case 'selectMatchIndex': {
                selectedGlobalIndex = msg.index;
                if (currentResult && currentResult.files) {
                    let count = 0;
                    for (const fileObj of currentResult.files) {
                        const nextCount = count + fileObj.lines.length;
                        if (msg.index >= count && msg.index < nextCount) {
                            fileObj.expanded = true;
                            break;
                        }
                        count = nextCount;
                    }
                }
                renderResults();
                const selectedRow = flatRows.find((r) => r.globalIdx === selectedGlobalIndex);
                if (selectedRow) {
                    selectedRow.element.scrollIntoView({ block: 'nearest' });
                }
                renderContextPreview(msg.filePath, msg.lineNo, msg.contextLines);
                break;
            }
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
