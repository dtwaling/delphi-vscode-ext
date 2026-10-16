import './vscodeMock';
import * as assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    resolveDprFromConfigPath,
    resolveLegacyPath,
    resolveLegacyProjectConfig,
} from '../legacy/projectConfig';
import { isDelphiEnabled } from '../utils/constantUtils';
import { findLatestInstallBin, toCleanFsPath, toFsPath } from '../utils/fileUtils';
import { mockVscodeState, resetMockVscodeState } from './vscodeMock';

describe('Project Configuration & File Utilities', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(path.join(os.tmpdir(), 'delphi-projconfig-test-'));
        resetMockVscodeState();
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        resetMockVscodeState();
    });

    describe('fileUtils', () => {
        it('normalizes file URIs and uppercase Windows drive letters in toCleanFsPath', () => {
            const p = toCleanFsPath('c:\\dev\\project\\..\\project\\Main.pas');
            assert.strictEqual(p, 'C:\\dev\\project\\Main.pas');

            const fromUri = toFsPath('file:///C:/dev/project/Main.pas');
            assert.strictEqual(path.normalize(fromUri).toLowerCase(), 'c:\\dev\\project\\main.pas');
        });

        it('finds the newest Studio installation bin directory containing the required executable', () => {
            const studioDir = path.join(tmpDir, 'Studio');
            const v22Bin = path.join(studioDir, '22.0', 'bin');
            const v23Bin = path.join(studioDir, '23.0', 'bin');
            const v24EmptyBin = path.join(studioDir, '24.0', 'bin');

            mkdirSync(v22Bin, { recursive: true });
            mkdirSync(v23Bin, { recursive: true });
            mkdirSync(v24EmptyBin, { recursive: true });

            writeFileSync(path.join(v22Bin, 'DelphiLSP.exe'), '');
            writeFileSync(path.join(v23Bin, 'DelphiLSP.exe'), '');
            // 24.0 is an empty leftover directory without DelphiLSP.exe

            const found = findLatestInstallBin(studioDir, 'DelphiLSP.exe');
            assert.strictEqual(found, v23Bin);
        });

        it('prioritizes workspace and folder delphi.enabled settings over user (global) settings', () => {
            mockVscodeState.workspaceFolders = [
                {
                    uri: {
                        fsPath: tmpDir,
                        scheme: 'file',
                        path: '/' + tmpDir.replace(/\\/g, '/'),
                    },
                },
            ];

            // User config has delphi.enabled = false, but folder .vscode/settings.json has delphi.enabled = true
            mockVscodeState.globalConfigValues.set('delphi.enabled', false);
            mockVscodeState.folderConfigValues.set('delphi.enabled', true);
            assert.strictEqual(isDelphiEnabled(), true);

            // When folder/workspace does not override, user config (false) applies
            mockVscodeState.folderConfigValues.clear();
            assert.strictEqual(isDelphiEnabled(), false);

            // Workspace (.code-workspace) setting also overrides user config
            mockVscodeState.configValues.set('delphi.enabled', true);
            assert.strictEqual(isDelphiEnabled(), true);

            // When user config has delphi.enabled = false and workspace does not explicitly set delphi.enabled,
            // having workspace delphi.configFile or delphi.bin in .vscode/settings.json enables the workspace
            mockVscodeState.configValues.clear();
            mockVscodeState.configValues.set(
                'delphi.configFile',
                'C:\\Dev\\Source\\Delphi\\WMS\\WMS.dpr'
            );
            assert.strictEqual(isDelphiEnabled(), true);

            // Explicit workspace delphi.enabled = false still disables even if configFile is present
            mockVscodeState.configValues.set('delphi.enabled', false);
            assert.strictEqual(isDelphiEnabled(), false);
        });
    });

    describe('legacy projectConfig', () => {
        it('fixes drive-relative paths and resolves relative paths in resolveLegacyPath', () => {
            const fixed = resolveLegacyPath('C:\\Base', 'c:Dev\\Units');
            assert.strictEqual(fixed.toLowerCase(), 'c:\\dev\\units');

            const rel = resolveLegacyPath('C:\\Base\\Proj', '..\\Shared');
            assert.strictEqual(rel.toLowerCase(), 'c:\\base\\shared');

            // Unexpanded macro strings are ignored
            assert.strictEqual(resolveLegacyPath('C:\\Base', '${unexpanded}'), '');
        });

        it('resolves .dpr, .dof, .cfg, and want.xml project settings', () => {
            const binDir = path.join(tmpDir, 'Borland', 'Delphi6', 'Bin');
            const libDir = path.join(tmpDir, 'Borland', 'Delphi6', 'Lib');
            const projDir = path.join(tmpDir, 'App');
            const sharedDir = path.join(tmpDir, 'Shared');
            const wantUnitDir = path.join(tmpDir, 'WantUnits');

            mkdirSync(binDir, { recursive: true });
            mkdirSync(libDir, { recursive: true });
            mkdirSync(projDir, { recursive: true });
            mkdirSync(sharedDir, { recursive: true });
            mkdirSync(wantUnitDir, { recursive: true });

            const unitFile = path.join(sharedDir, 'uCommon.pas');
            writeFileSync(unitFile, 'unit uCommon;\ninterface\nimplementation\nend.', 'utf8');

            const dprPath = path.join(projDir, 'MyApp.dpr');
            writeFileSync(
                dprPath,
                [
                    'program MyApp;',
                    'uses',
                    "  Forms, uCommon in '..\\Shared\\uCommon.pas';",
                    'begin',
                    'end.',
                ].join('\r\n'),
                'utf8'
            );

            const dofPath = path.join(projDir, 'MyApp.dof');
            writeFileSync(
                dofPath,
                [
                    '[Directories]',
                    'SearchPath=..\\Shared',
                    'Conditionals=USE_DOF_FLAG',
                    '[Compiler]',
                    'UnitAliases=WinTypes=Windows;WinProcs=Windows;',
                ].join('\r\n'),
                'utf8'
            );

            const cfgPath = path.join(projDir, 'MyApp.cfg');
            writeFileSync(cfgPath, ['-$B-', '-DDEBUG_CFG'].join('\r\n'), 'utf8');

            const wantXmlPath = path.join(tmpDir, 'want.xml');
            writeFileSync(
                wantXmlPath,
                [
                    '<project>',
                    '  <property name="sourcedir" value="App" />',
                    '  <property name="source" value="MyApp" />',
                    '  <property name="defines" value="WANT_DEF" />',
                    '  <writeableconst value="true" />',
                    '  <patternset id="unitpath">',
                    '    <include name="${basedir}/WantUnits" />',
                    '  </patternset>',
                    '</project>',
                ].join('\r\n'),
                'utf8'
            );

            mockVscodeState.workspaceFolders = [
                {
                    uri: {
                        fsPath: tmpDir,
                        scheme: 'file',
                        path: '/' + tmpDir.replace(/\\/g, '/'),
                    },
                },
            ];

            assert.strictEqual(
                resolveDprFromConfigPath(dofPath)?.toLowerCase(),
                dprPath.toLowerCase()
            );

            const resolved = resolveLegacyProjectConfig(binDir);
            assert.strictEqual(resolved.projectFile.toLowerCase(), dprPath.toLowerCase());
            assert.strictEqual(
                resolved.dprUnitFiles.get('ucommon')?.toLowerCase(),
                unitFile.toLowerCase()
            );
            assert.ok(
                resolved.unitPaths.some((p) => p.toLowerCase() === wantUnitDir.toLowerCase())
            );
            assert.ok(resolved.unitPaths.some((p) => p.toLowerCase() === sharedDir.toLowerCase()));
            assert.ok(resolved.conditionals.includes('WANT_DEF'));
            assert.ok(resolved.conditionals.includes('USE_DOF_FLAG'));
            assert.ok(resolved.conditionals.includes('DEBUG_CFG'));
            assert.ok(resolved.switches.includes('-$B-'));
            assert.ok(resolved.switches.includes('-$J+'));
        });
    });
});
