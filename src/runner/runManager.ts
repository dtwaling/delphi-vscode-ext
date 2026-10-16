import { existsSync } from 'fs';
import * as path from 'path';
import { getConfigFilePath, loadConfigFileJson } from '../client/configFile';
import { ProcessExecution, Task, tasks, TaskScope, window } from 'vscode';
import { resolveLegacyProjectConfig } from '../legacy/projectConfig';
import { isDelphiEnabled, resolveDelphiToolchain } from '../utils/constantUtils';
import { getRunScriptUri, initRunScript, resolveProjectPaths } from './scripts';

export class RunManager {
    /**
     * Runs the current project if config file has been set.
     *
     * @returns undefined
     */
    public async run() {
        if (!isDelphiEnabled()) {
            window.showWarningMessage('Delphi: Extension is disabled in this workspace.');
            return;
        }
        const scriptUri = getRunScriptUri();
        if (!scriptUri) {
            window.showWarningMessage('Delphi: Open a folder to run a project');
            return;
        }
        const toolchain = resolveDelphiToolchain();
        if (!toolchain) {
            window.showErrorMessage('Delphi: No Delphi installation found to build the project');
            return;
        }

        if (toolchain.mode === 'legacy') {
            await this.runLegacy(toolchain.binDir, scriptUri.fsPath);
            return;
        }

        const json = await loadConfigFileJson();
        if (json === false) {
            window.showWarningMessage('Delphi: No config file have been set');
            return;
        }
        if (!(await initRunScript())) return; // Always run the current script version

        const { projectDir, dproj, exePath } = resolveProjectPaths(json.settings);
        await this.executeBuildTask(
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                scriptUri.fsPath,
                '-BinDir',
                toolchain.binDir,
                '-Project',
                dproj,
                '-ExePath',
                exePath,
                '-Run',
            ],
            projectDir
        );
    }

    private async runLegacy(binDir: string, scriptPath: string) {
        const legacyCfg = resolveLegacyProjectConfig(binDir, getConfigFilePath());
        if (!existsSync(legacyCfg.projectFile)) {
            window.showWarningMessage(
                'Delphi (Legacy): No .dpr project file has been configured. Use "Delphi: Select LSP config file" to pick a project.'
            );
            return;
        }
        if (!(await initRunScript(legacyCfg.projectFile))) return;

        const projectName = path.parse(legacyCfg.projectFile).name;
        const exePath = path.join(legacyCfg.exeOutputDir, `${projectName}.exe`);

        const uPaths = legacyCfg.unitPaths.join(';');
        const iPaths = legacyCfg.includePaths.join(';');
        const rPaths = legacyCfg.resourcePaths.join(';');
        const oPaths = legacyCfg.objectPaths.join(';');

        const dccArgs: string[] = [
            '-M',
            '-Q',
            ...legacyCfg.switches,
            `-E${legacyCfg.exeOutputDir}`,
            `-N${legacyCfg.dcuOutputDir}`,
            `-U${uPaths}`,
            `-I${iPaths}`,
            `-R${rPaths}`,
            `-O${oPaths}`,
        ];
        if (legacyCfg.unitAliases) {
            dccArgs.push(`-A${legacyCfg.unitAliases}`);
        }
        if (legacyCfg.conditionals) {
            dccArgs.push(`-D${legacyCfg.conditionals}`);
        }

        await this.executeBuildTask(
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                scriptPath,
                '-BinDir',
                binDir,
                '-Project',
                legacyCfg.projectFile,
                '-ExePath',
                exePath,
                '-DccArgs',
                ...dccArgs,
                '-Run',
            ],
            legacyCfg.projectDir
        );
    }

    private async executeBuildTask(psArgs: string[], cwd: string) {
        // Values are passed as separate arguments (no shell) so paths can't inject commands.
        const compileProcess = new ProcessExecution('powershell.exe', psArgs, { cwd });

        const task = new Task(
            {
                type: 'Run',
            },
            TaskScope.Workspace,
            'Delphi: Run',
            'Delphi',
            compileProcess
        );

        const execution = await tasks.executeTask(task);

        const listener = tasks.onDidEndTaskProcess((e) => {
            if (e.execution === execution) {
                listener.dispose();
                if (e.exitCode === 0) {
                    window.showInformationMessage('Delphi: Exited successfully!');
                } else {
                    window.showErrorMessage('Delphi: Error running!');
                }
            }
        });
    }
}
