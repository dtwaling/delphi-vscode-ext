import './vscodeMock';
import * as assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createDefaultGrepSettings,
    createMatcher,
    findCompanionFormFile,
    findCompanionUnitFile,
    getFileContextLines,
    resolveUnitAndFormPair,
    runGxGrepSearch,
    searchFormLines,
    searchPascalLines,
    validateRegexPattern,
} from '../grep/grepEngine';
import { mockVscodeState, resetMockVscodeState } from './vscodeMock';

describe('GX Grep Engine', () => {
    afterEach(() => {
        resetMockVscodeState();
    });

    describe('DFM search (searchFormLines)', () => {
        it('decodes #NNN and #$XX outside string literals and preserves exact raw column offsets', () => {
            const settings = {
                ...createDefaultGrepSettings(),
                pattern: 'Kurze',
                dfmSpecialChars: true,
                dfmMultiline: true,
            };
            const line = "  Caption = 'Kurze '#220'berschrift'";

            const hitsBefore = searchFormLines([line], settings, createMatcher(settings));
            assert.strictEqual(hitsBefore.length, 1);
            assert.deepStrictEqual(hitsBefore[0].matches, [{ startCol: 14, endCol: 18 }]);

            const umlautSettings = { ...settings, pattern: 'Überschrift' };
            const hitsUmlaut = searchFormLines(
                [line],
                umlautSettings,
                createMatcher(umlautSettings)
            );
            assert.strictEqual(hitsUmlaut.length, 1);
            // #220 starts at col 21, 't' of berschrift is at col 35
            assert.deepStrictEqual(hitsUmlaut[0].matches, [{ startCol: 21, endCol: 35 }]);
        });

        it('does not corrupt literal # strings inside quotes (e.g. #123 or #FFFFFF)', () => {
            const lines = ["  Caption = '#123'", "  Color = '#FFFFFF'"];
            const s1 = { ...createDefaultGrepSettings(), pattern: '#123' };
            const r1 = searchFormLines(lines, s1, createMatcher(s1));
            assert.strictEqual(r1.length, 1);
            assert.strictEqual(r1[0].lineNo, 1);
            assert.deepStrictEqual(r1[0].matches, [{ startCol: 14, endCol: 17 }]);

            const s2 = { ...createDefaultGrepSettings(), pattern: '#FFFFFF' };
            const r2 = searchFormLines(lines, s2, createMatcher(s2));
            assert.strictEqual(r2.length, 1);
            assert.strictEqual(r2[0].lineNo, 2);
        });

        it('handles chained #13#10 and leading #NNN sequences in DFM lines', () => {
            const lines = ["  Hint = 'First'#13#10'Second'", "  Title = #220'ber'"];
            const s1 = { ...createDefaultGrepSettings(), pattern: 'Second' };
            const r1 = searchFormLines(lines, s1, createMatcher(s1));
            assert.strictEqual(r1.length, 1);
            assert.strictEqual(r1[0].lineNo, 1);
            assert.deepStrictEqual(r1[0].matches, [{ startCol: 24, endCol: 29 }]);

            const s2 = { ...createDefaultGrepSettings(), pattern: 'Über' };
            const r2 = searchFormLines(lines, s2, createMatcher(s2));
            assert.strictEqual(r2.length, 1);
            assert.strictEqual(r2[0].lineNo, 2);
        });

        it('concatenates multiline DFM strings and maps matches to their actual line and columns', () => {
            const lines = [
                'object Form1: TForm1',
                "  Caption = 'First line with some wor' +",
                "    'ds and the second line'",
                'end',
            ];

            // Match spanning across the line break from line 2 into line 3
            const spanSettings = {
                ...createDefaultGrepSettings(),
                pattern: 'words and',
                dfmMultiline: true,
            };
            const spanHits = searchFormLines(lines, spanSettings, createMatcher(spanSettings));
            assert.strictEqual(spanHits.length, 1);
            assert.strictEqual(spanHits[0].lineNo, 2);
            // 'wor' is at cols 35..37 on line 2
            assert.deepStrictEqual(spanHits[0].matches, [{ startCol: 35, endCol: 37 }]);

            // Match located entirely on the continuation line (line 3)
            const contSettings = {
                ...createDefaultGrepSettings(),
                pattern: 'second line',
                dfmMultiline: true,
            };
            const contHits = searchFormLines(lines, contSettings, createMatcher(contSettings));
            assert.strictEqual(contHits.length, 1);
            assert.strictEqual(contHits[0].lineNo, 3);
            assert.deepStrictEqual(contHits[0].matches, [{ startCol: 17, endCol: 27 }]);
        });
    });

    describe('Pascal search (searchPascalLines)', () => {
        const sampleUnit = [
            'unit SampleUnit;',
            'interface',
            'type',
            '  TMyObject = class',
            '    procedure Foo; // Foo in interface comment',
            '  end;',
            'implementation',
            'procedure TMyObject.Foo;',
            'var',
            '  Msg: string;',
            'begin',
            "  Msg := 'Foo inside string literal';",
            '  Obj.Finalization;',
            '  { Multiline comment mentioning Foo',
            '    still inside comment Foo }',
            '  Foo();',
            'end;',
            'initialization',
            '  InitFoo;',
            'finalization',
            '  DoneFoo;',
            'end.',
        ];

        it('ignores comments and strings when unchecked and prevents regex bleeding across masked regions', () => {
            const codeOnlySettings = {
                ...createDefaultGrepSettings(),
                pattern: 'Foo',
                wholeWord: true,
                includeCode: true,
                includeStrings: false,
                includeComments: false,
            };
            const results = searchPascalLines(
                sampleUnit,
                codeOnlySettings,
                createMatcher(codeOnlySettings)
            );
            const matchedLines = results.map((r) => r.lineNo);
            // Line 5 (procedure Foo), Line 8 (TMyObject.Foo), Line 16 (Foo())
            // Line 12 (string) and Lines 14-15 (comment) must be excluded
            assert.deepStrictEqual(matchedLines, [5, 8, 16]);

            // Regex should not match across masked comment characters on line 5
            const regexSettings = {
                ...codeOnlySettings,
                pattern: 'Foo.*comment',
                wholeWord: false,
                isRegex: true,
            };
            const regexHits = searchPascalLines(
                sampleUnit,
                regexSettings,
                createMatcher(regexSettings)
            );
            assert.strictEqual(regexHits.length, 0);
        });

        it('filters by unit section and ignores member access like Obj.Finalization', () => {
            const implOnlySettings = {
                ...createDefaultGrepSettings(),
                pattern: 'Foo',
                includeCode: true,
                includeStrings: false,
                includeComments: false,
                sectionInterface: false,
                sectionImplementation: true,
                sectionInitialization: false,
                sectionFinalization: false,
            };
            const results = searchPascalLines(
                sampleUnit,
                implOnlySettings,
                createMatcher(implOnlySettings)
            );
            // Line 8 and Line 16 are in implementation (Line 13 `Obj.Finalization` must not switch section to finalization!)
            assert.deepStrictEqual(
                results.map((r) => r.lineNo),
                [8, 16]
            );
        });

        it('does not blank out .dpr or .inc files lacking unit sections when interface is unchecked', () => {
            const dprLines = [
                'program MyApp;',
                'uses',
                '  Forms;',
                'begin',
                '  Application.Run;',
                'end.',
            ];
            const settings = {
                ...createDefaultGrepSettings(),
                pattern: 'Application',
                sectionInterface: false,
                sectionImplementation: true,
            };
            const hits = searchPascalLines(dprLines, settings, createMatcher(settings));
            assert.strictEqual(hits.length, 1);
            assert.strictEqual(hits[0].lineNo, 5);
        });
    });

    describe('Companion .pas <-> .dfm resolution and workspace search', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(path.join(os.tmpdir(), 'delphi-gxgrep-test-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('resolves companion .pas and .dfm files and executes current/directory/results scoped searches', async () => {
            const pasFile = path.join(tmpDir, 'MainForm.pas');
            const dfmFile = path.join(tmpDir, 'MainForm.dfm');
            writeFileSync(
                pasFile,
                [
                    'unit MainForm;',
                    'interface',
                    'type',
                    '  TfrmMain = class(TForm)',
                    '    btnSave: TButton;',
                    '  end;',
                    'implementation',
                    '{$R *.dfm}',
                    'end.',
                ].join('\r\n'),
                'utf8'
            );
            writeFileSync(
                dfmFile,
                [
                    'object frmMain: TfrmMain',
                    '  object btnSave: TButton',
                    "    Caption = 'Save Record'",
                    '  end',
                    'end',
                ].join('\r\n'),
                'utf8'
            );

            assert.strictEqual(
                findCompanionFormFile(pasFile)?.toLowerCase(),
                dfmFile.toLowerCase()
            );
            assert.strictEqual(
                findCompanionUnitFile(dfmFile)?.toLowerCase(),
                pasFile.toLowerCase()
            );
            const pairFromDfm = resolveUnitAndFormPair(dfmFile);
            assert.strictEqual(pairFromDfm.unitFile?.toLowerCase(), pasFile.toLowerCase());
            assert.strictEqual(pairFromDfm.formFile?.toLowerCase(), dfmFile.toLowerCase());

            // Search Current Unit with includeForms = true
            const withForms = await runGxGrepSearch(
                {
                    ...createDefaultGrepSettings(),
                    pattern: 'btnSave',
                    scope: 'current',
                    includeForms: true,
                },
                pasFile
            );
            assert.strictEqual(withForms.filesSearched, 2);
            assert.strictEqual(withForms.files.length, 2);
            assert.strictEqual(withForms.totalMatches, 2);
            assert.strictEqual(withForms.files[0].totalLines, 9);
            assert.strictEqual(withForms.files[1].totalLines, 5);

            // Search Current Unit with includeForms = false
            const withoutForms = await runGxGrepSearch(
                {
                    ...createDefaultGrepSettings(),
                    pattern: 'btnSave',
                    scope: 'current',
                    includeForms: false,
                },
                pasFile
            );
            assert.strictEqual(withoutForms.filesSearched, 1);
            assert.strictEqual(withoutForms.files.length, 1);
            assert.strictEqual(withoutForms.files[0].isFormFile, false);

            // Search Directory scope using workspace-relative directory path
            const subDir = path.join(tmpDir, 'sub');
            mkdirSync(subDir);
            const subPas = path.join(subDir, 'SubUnit.pas');
            writeFileSync(
                subPas,
                'unit SubUnit;\ninterface\n// btnSave ref\nimplementation\nend.',
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

            const dirSearch = await runGxGrepSearch({
                ...createDefaultGrepSettings(),
                pattern: 'btnSave',
                scope: 'directory',
                directoryPath: 'sub',
            });
            assert.strictEqual(dirSearch.files.length, 1);
            assert.strictEqual(dirSearch.files[0].filePath.toLowerCase(), subPas.toLowerCase());

            // Verify default contextRadius = 2 and configurable 1..5 in getFileContextLines
            assert.strictEqual(createDefaultGrepSettings().contextRadius, 2);
            const defaultCtx = getFileContextLines(pasFile, 5, [{ startCol: 5, endCol: 11 }]);
            assert.deepStrictEqual(
                defaultCtx.map((c) => c.lineNo),
                [3, 4, 5, 6, 7]
            );
            const radius1Ctx = getFileContextLines(pasFile, 5, [{ startCol: 5, endCol: 11 }], 1);
            assert.deepStrictEqual(
                radius1Ctx.map((c) => c.lineNo),
                [4, 5, 6]
            );
            const radius5Ctx = getFileContextLines(pasFile, 5, [{ startCol: 5, endCol: 11 }], 5);
            assert.deepStrictEqual(
                radius5Ctx.map((c) => c.lineNo),
                [1, 2, 3, 4, 5, 6, 7, 8, 9]
            );
        });

        it('validates regular expression syntax cleanly', () => {
            assert.strictEqual(validateRegexPattern('^T[A-Za-z]+$'), undefined);
            assert.ok(validateRegexPattern('[unclosed'));
        });
    });
});
