import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import {
    commands,
    ConfigurationChangeEvent,
    ConfigurationTarget,
    QuickPickItem,
    QuickPickOptions,
    Uri,
    window,
    workspace,
} from 'vscode';
import { DidChangeConfigurationNotification, LanguageClient } from 'vscode-languageclient/node';
import { resolveDprFromConfigPath, resolveLegacyProjectConfig } from '../legacy/projectConfig';
import { initRunScript } from '../runner/scripts';
import {
    DelphiMode,
    isDelphiEnabled,
    resolveDelphiToolchain,
    updateDelphiEnabledContext,
} from '../utils/constantUtils';
import { fileExists, toCleanFsPath, toFsPath } from '../utils/fileUtils';

/**
 * Returns the appropriate ConfigurationTarget so workspace-specific project paths
 * are saved in Workspace settings rather than leaking into Global User settings.
 */
function getConfigUpdateTarget(): ConfigurationTarget {
    return workspace.workspaceFolders?.length
        ? ConfigurationTarget.Workspace
        : ConfigurationTarget.Global;
}

/**
 * Init configuration file. Loads an existing config file or prompts user to pick one.
 */
export async function initConfig(mode?: DelphiMode, binDir?: string) {
    const toolchain = mode && binDir ? { mode, binDir } : resolveDelphiToolchain();
    if (toolchain?.mode === 'legacy') {
        await initLegacyConfig(toolchain.binDir);
        return;
    }

    const configFile = getConfigFilePath();
    // If no config file found (or global config points to a non-lsp file)
    if (configFile.length === 0 || !configFile.toLowerCase().endsWith('.delphilsp.json')) {
        const configFiles = await collectLSPConfigFiles();
        if (configFiles.length === 0) {
            window.showWarningMessage('Delphi: No DelphiLSP project config file were found.');
            updateConfigWithSelectedItem('no_config_available');
        } else if (configFiles.length === 1) {
            updateConfigWithSelectedItem(configFiles[0]);
        } else {
            window
                .showWarningMessage(
                    'Delphi: Multiple DelphiLSP project config files were found. Please select one.',
                    'Select project config'
                )
                .then((selection) => {
                    if (selection === 'Select project config') {
                        commands.executeCommand('delphi.selectConfigFile');
                    }
                });
        }
    } else if (!(await fileExists(Uri.file(toFsPath(configFile))))) {
        updateConfigWithSelectedItem('no_config_available');
        window
            .showWarningMessage(
                'Delphi: The configured DelphiLSP project config file "' +
                    configFile +
                    '" can not be found.',
                'Select project config'
            )
            .then((selection) => {
                if (selection === 'Select project config') {
                    commands.executeCommand('delphi.selectConfigFile');
                }
            });
    } else {
        window.showInformationMessage(
            'Delphi: Loaded configured project ' + path.basename(toFsPath(configFile))
        );
        initRunScript();
    }
}

/**
 * Initializes project configuration in Legacy (Delphi 6 / dcc32.exe) mode.
 */
async function initLegacyConfig(binDir: string) {
    const configFile = getConfigFilePath();
    const existingDpr = resolveDprFromConfigPath(configFile);
    if (existingDpr) {
        const cleanExisting = toCleanFsPath(configFile);
        if (configFile !== cleanExisting) {
            const config = workspace.getConfiguration('delphi');
            await config.update('configFile', cleanExisting, getConfigUpdateTarget());
        }
        window.showInformationMessage(
            `Delphi (Legacy): Loaded project ${path.basename(existingDpr)}`
        );
        await initRunScript(existingDpr);
        return;
    }

    const resolved = resolveLegacyProjectConfig(binDir);
    if (existsSync(resolved.projectFile)) {
        const cleanPath = toCleanFsPath(resolved.projectFile);
        const config = workspace.getConfiguration('delphi');
        await config.update('configFile', cleanPath, getConfigUpdateTarget());
        window.showInformationMessage(
            `Delphi (Legacy): Loaded project ${path.basename(resolved.projectFile)}`
        );
        await initRunScript(cleanPath);
        return;
    }

    const candidates = await collectLegacyProjectFiles();
    if (candidates.length === 1) {
        updateConfigWithSelectedItem(candidates[0]);
    } else if (candidates.length > 1) {
        window
            .showInformationMessage(
                'Delphi (Legacy): Multiple Delphi 6 project files were found. Select the active project if needed.',
                'Select project'
            )
            .then((selection) => {
                if (selection === 'Select project') {
                    commands.executeCommand('delphi.selectConfigFile');
                }
            });
    }
}

/**
 * Updates the LSP/project config file path in workspace settings and notifies of the loading of the config
 *
 * @param configFile URI or filesystem path of the config file
 */
export function updateConfigWithSelectedItem(configFile: UriItem | string) {
    const config = workspace.getConfiguration('delphi');
    const target = getConfigUpdateTarget();
    if (typeof configFile === 'string') {
        const clean =
            configFile === 'no_config_available' || !configFile
                ? configFile
                : toCleanFsPath(configFile);
        config.update('configFile', clean, target);
    } else {
        const clean = toCleanFsPath(configFile.uri);
        config.update('configFile', clean, target);
        window.showInformationMessage('Loaded project ' + path.basename(configFile.label));
        initRunScript(clean);
    }
}

/**
 * Lists all Delphi LSP config files that are present in the currently open folder
 *
 * @returns List of delphi LSP config files from the folder
 */
export async function collectLSPConfigFiles(): Promise<UriItem[]> {
    const fileUris = await workspace.findFiles('**/*.delphilsp.json');

    return fileUris.map<UriItem>((uri) => {
        const fsPath = toCleanFsPath(uri.fsPath);
        return {
            label: path.basename(fsPath),
            detail: path.dirname(fsPath),
            uri: fsPath,
        };
    });
}

/**
 * Lists candidate project/config files (.dpr, .dpk, .dof, .cfg) in the workspace for Legacy (Delphi 6) mode,
 * excluding compiler/component demo folders.
 */
export async function collectLegacyProjectFiles(): Promise<UriItem[]> {
    const fileUris = await workspace.findFiles(
        '**/*.{dpr,dpk,dof,cfg}',
        '{**/Borland/**,**/Demos/**,**/Components/**,**/Common Files/**}'
    );

    const extOrder: Record<string, number> = {
        '.dpr': 0,
        '.dpk': 1,
        '.dof': 2,
        '.cfg': 3,
    };

    const items = fileUris.map<UriItem>((uri) => {
        const fsPath = toCleanFsPath(uri.fsPath);
        const ext = path.extname(fsPath).toLowerCase();
        const base = fsPath.slice(0, -ext.length);
        const companions = ['.dpr', '.dpk', '.dof', '.cfg'].filter(
            (e) => e !== ext && existsSync(base + e)
        );
        const description = companions.length > 0 ? `(with ${companions.join(', ')})` : undefined;

        return {
            label: path.basename(fsPath),
            description,
            detail: path.dirname(fsPath),
            uri: fsPath,
        };
    });

    items.sort((a, b) => {
        const extA = extOrder[path.extname(a.label).toLowerCase()] ?? 9;
        const extB = extOrder[path.extname(b.label).toLowerCase()] ?? 9;
        if (extA !== extB) return extA - extB;
        return a.label.localeCompare(b.label);
    });

    return items;
}

/**
 * Handle config changes if changed from the workspace settings.
 * Sends the new file to the client and inits a new run script.
 *
 * @param event Configuration change event
 */
export function handleDidChangeConfiguration(
    event: ConfigurationChangeEvent,
    client: LanguageClient
) {
    if (event.affectsConfiguration('delphi')) {
        initRunScript();
        sendDidChangeConfiguration(client);
    }
}

/**
 * Send config change to the client
 */
export async function sendDidChangeConfiguration(client: LanguageClient) {
    const cfgPath = getConfigFilePath();
    const settingsFile =
        cfgPath && cfgPath !== 'no_config_available'
            ? Uri.file(toFsPath(cfgPath)).toString()
            : cfgPath;
    const settings = {
        settings: {
            settingsFile,
        },
    };

    client.sendNotification(DidChangeConfigurationNotification.type, settings);
}

/**
 * Display the config picker
 */
export async function pickConfig() {
    const config = workspace.getConfiguration('delphi');
    if (!isDelphiEnabled()) {
        const selection = await window.showWarningMessage(
            'Delphi: The extension is currently disabled ("delphi.enabled" is false). Enable it to activate code navigation and diagnostics?',
            'Enable in Workspace',
            'Enable Globally'
        );
        if (selection === 'Enable in Workspace') {
            await config.update('enabled', true, getConfigUpdateTarget());
            await updateDelphiEnabledContext();
        } else if (selection === 'Enable Globally') {
            await config.update('enabled', true, ConfigurationTarget.Global);
            await updateDelphiEnabledContext();
        }
    }

    const toolchain = resolveDelphiToolchain();
    const isLegacy = toolchain?.mode === 'legacy';
    const pickerItems = isLegacy
        ? await collectLegacyProjectFiles()
        : await collectLSPConfigFiles();
    const pickOptions: QuickPickOptions = {
        placeHolder: isLegacy
            ? 'Select the active Delphi 6 project file (.dpr, .dpk, .dof, or .cfg)'
            : "Select the project's .delphilsp.json file",
    };

    window.showQuickPick<UriItem>(pickerItems, pickOptions).then((selectedPickerItem) => {
        if (selectedPickerItem !== undefined) {
            updateConfigWithSelectedItem(selectedPickerItem);
        }
    });
}

/**
 * Get current config file path for the active workspace.
 * Ignores a global User setting if it points outside the currently open workspace folders.
 *
 * @returns current path of the config file from workspace settings
 */
export function getConfigFilePath(): string {
    const folders = workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        for (const folder of folders) {
            const folderInspected = workspace
                .getConfiguration('delphi', folder.uri)
                .inspect<string>('configFile');
            const folderVal =
                folderInspected?.workspaceFolderValue ?? folderInspected?.workspaceValue;
            if (folderVal !== undefined) {
                return folderVal;
            }
        }
    }

    const config = workspace.getConfiguration('delphi');
    const inspected = config.inspect<string>('configFile');
    const workspaceVal = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
    if (workspaceVal !== undefined) {
        return workspaceVal;
    }

    const globalVal = inspected?.globalValue ?? '';
    if (!globalVal || globalVal === 'no_config_available') {
        return '';
    }

    if (folders && folders.length > 0) {
        const fsPath = path.normalize(toFsPath(globalVal)).toLowerCase();
        const insideWorkspace = folders.some((f) => {
            const root = path.normalize(f.uri.fsPath).toLowerCase();
            return fsPath.startsWith(root + path.sep) || fsPath === root;
        });
        if (!insideWorkspace) {
            return '';
        }
    }

    return globalVal;
}

/**
 * Load config file as JSON
 *
 * @returns json containing the config file
 */
export async function loadConfigFileJson(config?: string): Promise<DelphiLSPConfig | false> {
    if (!config) {
        const storedValue = getConfigFilePath();
        if (!storedValue || storedValue === 'no_config_available') {
            return false;
        }
        config = storedValue;
    }
    const configPath = toFsPath(config);
    try {
        const json: DelphiLSPConfig = JSON.parse(readFileSync(configPath, 'utf8'));
        json.settings.project = toFsPath(json.settings.project);
        return json;
    } catch (e) {
        window.showErrorMessage(`Delphi: Could not read LSP config file "${configPath}": ${e}`);
        return false;
    }
}

class UriItem implements QuickPickItem {
    label: string;
    description?: string;
    detail?: string;
    uri: string;
}

export interface DelphiLSPConfig {
    settings: Settings;
}

export interface Settings {
    project: string;
    dllname: string;
    dccOptions: string;
    projectFiles: ProjectFile[];
    includeDCUsInUsesCompletion: boolean;
    browsingPaths: string[];
}

export interface ProjectFile {
    name: string;
    file: string;
}
