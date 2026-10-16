import { existsSync } from 'fs';
import * as path from 'path';
import { commands, window, workspace } from 'vscode';
import { DCC32_BIN, getDefaultDelphiBinPath, LSP_BIN } from '../constants';
import { toFsPath } from './fileUtils';

export type DelphiMode = 'lsp' | 'legacy';

export interface DelphiToolchain {
    mode: DelphiMode;
    binDir: string;
}

/**
 * Reads a `delphi.<key>` setting giving explicit priority to Workspace Folder (`.vscode/settings.json`)
 * and Workspace (`.code-workspace`) values before falling back to User (`globalValue`) settings.
 */
export function getDelphiSetting<T>(key: string, defaultValue?: T): T | undefined {
    const folders = workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        for (const folder of folders) {
            const folderInspected = workspace
                .getConfiguration('delphi', folder.uri)
                .inspect<T>(key);
            if (folderInspected?.workspaceFolderValue !== undefined) {
                return folderInspected.workspaceFolderValue;
            }
            if (folderInspected?.workspaceValue !== undefined) {
                return folderInspected.workspaceValue;
            }
        }
    }

    const inspected = workspace.getConfiguration('delphi').inspect<T>(key);
    if (inspected?.workspaceFolderValue !== undefined) {
        return inspected.workspaceFolderValue;
    }
    if (inspected?.workspaceValue !== undefined) {
        return inspected.workspaceValue;
    }
    if (inspected?.globalValue !== undefined) {
        return inspected.globalValue;
    }
    return inspected?.defaultValue ?? defaultValue;
}

/**
 * Checks whether any workspace/folder-scoped Delphi project configuration (`configFile` or `bin`)
 * is explicitly defined in `.vscode/settings.json` or `.code-workspace`.
 */
function hasWorkspaceDelphiConfig(): boolean {
    const checkInspected = (
        inspected:
            | {
                  workspaceFolderValue?: string;
                  workspaceValue?: string;
              }
            | undefined
    ): boolean => {
        const val = (inspected?.workspaceFolderValue ?? inspected?.workspaceValue)?.trim();
        return Boolean(val && val !== 'no_config_available');
    };

    const folders = workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        for (const folder of folders) {
            const cfg = workspace.getConfiguration('delphi', folder.uri);
            if (
                checkInspected(cfg.inspect<string>('configFile')) ||
                checkInspected(cfg.inspect<string>('bin'))
            ) {
                return true;
            }
        }
    }

    const rootCfg = workspace.getConfiguration('delphi');
    return (
        checkInspected(rootCfg.inspect<string>('configFile')) ||
        checkInspected(rootCfg.inspect<string>('bin'))
    );
}

/**
 * Checks whether the Delphi extension is enabled in the current workspace:
 * 1. Explicit workspace/folder `delphi.enabled` (`true` or `false`) in `.vscode/settings.json` or `.code-workspace` always wins.
 * 2. Otherwise, if the workspace explicitly defines `delphi.configFile` or `delphi.bin` in `.vscode/settings.json`,
 *    it is treated as enabled even when User settings has `"delphi.enabled": false`.
 * 3. Otherwise, falls back to User (`globalValue`) and default (`true`).
 */
export function isDelphiEnabled(): boolean {
    const folders = workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        for (const folder of folders) {
            const folderInspected = workspace
                .getConfiguration('delphi', folder.uri)
                .inspect<boolean>('enabled');
            if (folderInspected?.workspaceFolderValue !== undefined) {
                return folderInspected.workspaceFolderValue;
            }
            if (folderInspected?.workspaceValue !== undefined) {
                return folderInspected.workspaceValue;
            }
        }
    }

    const inspected = workspace.getConfiguration('delphi').inspect<boolean>('enabled');
    if (inspected?.workspaceFolderValue !== undefined) {
        return inspected.workspaceFolderValue;
    }
    if (inspected?.workspaceValue !== undefined) {
        return inspected.workspaceValue;
    }

    if (hasWorkspaceDelphiConfig()) {
        return true;
    }

    if (inspected?.globalValue !== undefined) {
        return inspected.globalValue;
    }
    return inspected?.defaultValue ?? true;
}

/**
 * Updates the `delphi.isEnabled` VS Code context key used by views, menus, and keybindings.
 */
export async function updateDelphiEnabledContext(): Promise<boolean> {
    const enabled = isDelphiEnabled();
    await commands.executeCommand('setContext', 'delphi.isEnabled', enabled);
    return enabled;
}

/**
 * Resolves the active Delphi toolchain mode ('lsp' when DelphiLSP.exe is present,
 * 'legacy' when only dcc32.exe is present, such as Delphi 6).
 *
 * @returns resolved toolchain, or undefined if no usable installation was found
 */
export function resolveDelphiToolchain(): DelphiToolchain | undefined {
    const setting = getDelphiSetting<string>('bin')?.trim();
    if (setting) {
        const configured = toFsPath(setting);
        if (existsSync(path.join(configured, LSP_BIN))) {
            return { mode: 'lsp', binDir: configured };
        }
        if (existsSync(path.join(configured, DCC32_BIN))) {
            return { mode: 'legacy', binDir: configured };
        }
        window.showWarningMessage(
            `Delphi: Neither ${LSP_BIN} nor ${DCC32_BIN} was found in the configured "delphi.bin" folder "${configured}". Using the newest installation instead.`
        );
    }
    const defaultBin = getDefaultDelphiBinPath();
    if (defaultBin) {
        return { mode: 'lsp', binDir: defaultBin };
    }
    return undefined;
}

/**
 * Get the Delphi `bin` directory. Uses the delphi.bin setting when it contains DelphiLSP or dcc32,
 * otherwise the newest installation.
 *
 * @returns bin directory, or undefined if no usable installation was found
 */
export function getDelphiBinDirectory(): string | undefined {
    return resolveDelphiToolchain()?.binDir;
}
