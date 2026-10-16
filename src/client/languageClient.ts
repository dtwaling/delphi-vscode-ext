import * as path from 'path';
import { workspace, ExtensionContext, commands, window, ConfigurationChangeEvent } from 'vscode';

import {
    LanguageClient,
    LanguageClientOptions,
    RevealOutputChannelOn,
    ServerOptions,
} from 'vscode-languageclient/node';
import { DCC32_BIN, LSP_BIN } from '../constants';
import { LegacyDiagnosticsManager } from '../legacy/diagnostics';
import { LegacyNavigationProvider } from '../legacy/navigation';
import { initRunScript } from '../runner/scripts';
import {
    isDelphiEnabled,
    resolveDelphiToolchain,
    updateDelphiEnabledContext,
} from '../utils/constantUtils';
import { initConfig, pickConfig, sendDidChangeConfiguration } from './configFile';

let client: LanguageClient | undefined;
let currentLspBinDir: string | undefined;
let legacyDiagnostics: LegacyDiagnosticsManager | undefined;
let legacyNavigation: LegacyNavigationProvider | undefined;

/**
 * Activate LSP Client or Legacy Delphi 6 mode based on workspace configuration.
 *
 * @param context Extension context
 */
export async function activateLSPClient(context: ExtensionContext) {
    context.subscriptions.push(
        workspace.onDidChangeConfiguration((e) => {
            void handleConfigurationChanged(e);
        }),
        workspace.onDidChangeWorkspaceFolders(() => {
            void syncLanguageServices();
        })
    );

    await syncLanguageServices();
}

/**
 * Synchronizes active language services (LSP vs Legacy mode vs Disabled) with current settings.
 */
async function syncLanguageServices() {
    const enabled = await updateDelphiEnabledContext();
    if (!enabled) {
        await stopLSPClient();
        stopLegacyServices();
        return;
    }

    const toolchain = resolveDelphiToolchain();
    if (!toolchain) {
        await stopLSPClient();
        stopLegacyServices();
        window.showErrorMessage(
            `Delphi: Neither ${LSP_BIN} nor ${DCC32_BIN} was found. Install Delphi or set "delphi.bin" to its bin folder.`
        );
        return;
    }

    if (toolchain.mode === 'legacy') {
        await stopLSPClient();
        startLegacyServices(toolchain.binDir);
        await initConfig('legacy', toolchain.binDir);
        return;
    }

    stopLegacyServices();
    await startLSPServer(toolchain.binDir);
}

/**
 * Starts the DelphiLSP language client if not already running for binDir.
 */
async function startLSPServer(binDir: string) {
    if (client && currentLspBinDir === binDir) {
        sendDidChangeConfiguration(client);
        return;
    }

    await stopLSPClient();
    const config = workspace.getConfiguration('delphi');
    const delphiLSP = path.join(binDir, LSP_BIN);

    let folder = 'nofolderOpened';
    if (workspace.workspaceFolders) {
        folder = workspace.workspaceFolders[0].uri.fsPath;
    }

    const serverOptions: ServerOptions = {
        run: {
            command: delphiLSP,
            args: ['-LogModes', String(config.get<number>('logModes') ?? 0), '-LSPLogging', folder],
        },
        debug: {
            command: delphiLSP,
            args: ['-LogModes', String(config.get<number>('logModes') ?? 0), '-LSPLogging', folder],
        },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ language: 'objectpascal' }],
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        initializationOptions: {
            serverType: config.get<string>('serverType'),
            agentCount: config.get<number>('agentCount'),
        },
    };

    client = new LanguageClient(
        'delphi-lsp',
        'Delphi Language Server',
        serverOptions,
        clientOptions
    );
    currentLspBinDir = binDir;
    await client.start();

    sendDidChangeConfiguration(client);
    await initConfig('lsp', binDir);
}

/**
 * Starts or updates Legacy (Delphi 6 / dcc32.exe) diagnostics and navigation providers.
 */
function startLegacyServices(binDir: string) {
    if (!legacyDiagnostics) {
        legacyDiagnostics = new LegacyDiagnosticsManager(binDir);
    } else {
        legacyDiagnostics.updateBinDir(binDir);
    }

    if (!legacyNavigation) {
        const diagRef = legacyDiagnostics;
        legacyNavigation = new LegacyNavigationProvider(() => diagRef.getProjectConfig());
    } else {
        legacyNavigation.invalidateIndex();
    }
}

/**
 * Stops the DelphiLSP client if running.
 */
async function stopLSPClient(): Promise<void> {
    if (!client) {
        return;
    }
    const active = client;
    client = undefined;
    currentLspBinDir = undefined;
    await active.stop();
}

/**
 * Disposes Legacy (Delphi 6) services and clears diagnostics.
 */
function stopLegacyServices() {
    if (legacyDiagnostics) {
        legacyDiagnostics.dispose();
        legacyDiagnostics = undefined;
    }
    if (legacyNavigation) {
        legacyNavigation.dispose();
        legacyNavigation = undefined;
    }
}

/**
 * Handles configuration changes across enabled state, bin path, and project settings.
 */
async function handleConfigurationChanged(event: ConfigurationChangeEvent) {
    if (!event.affectsConfiguration('delphi')) {
        return;
    }

    if (event.affectsConfiguration('delphi.enabled') || event.affectsConfiguration('delphi.bin')) {
        await syncLanguageServices();
        return;
    }

    if (!(await updateDelphiEnabledContext())) {
        return;
    }

    if (legacyDiagnostics) {
        legacyDiagnostics.invalidateConfig();
        legacyNavigation?.invalidateIndex();
        await initRunScript();
    } else if (client) {
        await initRunScript();
        sendDidChangeConfiguration(client);
    }
}

/**
 * Deactivate the LSP client and legacy services
 *
 * @returns Undefined if no client is set, else stop promise
 */
export function deactivateLSPClient(): Thenable<void> | undefined {
    stopLegacyServices();
    if (!client) {
        return undefined;
    }
    const active = client;
    client = undefined;
    currentLspBinDir = undefined;
    return active.stop();
}

/**
 * Registers all LSP and compiler check commands for the extension
 *
 * @param context Extension context
 */
export function registerLSPCommands(context: ExtensionContext) {
    context.subscriptions.push(
        commands.registerCommand('delphi.selectConfigFile', async () => {
            await pickConfig();
        })
    );

    context.subscriptions.push(
        commands.registerCommand('delphi.checkCurrentFile', () => {
            if (!isDelphiEnabled()) {
                window.showWarningMessage('Delphi: Extension is disabled in this workspace.');
                return;
            }
            const editor = window.activeTextEditor;
            if (!editor) {
                window.showWarningMessage('Delphi: Open a Pascal file to check with the compiler.');
                return;
            }
            if (legacyDiagnostics) {
                legacyDiagnostics.checkDocument(editor.document, true);
            } else if (client) {
                window.showInformationMessage(
                    'Delphi: DelphiLSP automatically checks open files in this workspace.'
                );
            }
        })
    );
}
