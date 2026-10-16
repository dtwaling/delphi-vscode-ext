import './vscodeMock';
import * as assert from 'assert';
import { maskCommentsAndStrings, parsePascalSource } from '../legacy/navigation';

describe('Legacy Pascal Navigation & Parser', () => {
    describe('maskCommentsAndStrings', () => {
        it('masks single-line, brace, and paren-star comments and string literals while preserving offsets and newlines', () => {
            const src = [
                'unit TestUnit; // line comment with identifier FakeId',
                'interface { brace comment',
                '  spanning lines }',
                '(* paren-star',
                '   comment *)',
                "const S = 'Hello ''World'' from Pascal';",
                'var X: Integer;',
            ].join('\r\n');

            const masked = maskCommentsAndStrings(src);
            assert.strictEqual(masked.length, src.length);

            const origLines = src.split('\r\n');
            const maskedLines = masked.split('\r\n');
            assert.strictEqual(maskedLines.length, origLines.length);

            assert.ok(maskedLines[0].startsWith('unit TestUnit;'));
            assert.ok(!masked.includes('FakeId'));
            assert.ok(!masked.includes('spanning lines'));
            assert.ok(!masked.includes('paren-star'));
            assert.ok(!masked.includes('World'));
            assert.strictEqual(
                maskedLines[6].indexOf('X: Integer'),
                origLines[6].indexOf('X: Integer')
            );
        });
    });

    describe('parsePascalSource', () => {
        it('extracts unit name, interface/implementation uses clauses, classes, methods, properties, and routines', () => {
            const source = [
                'unit CustomerService;',
                '',
                'interface',
                '',
                'uses',
                '  SysUtils, Classes,',
                '  DB;',
                '',
                'const',
                '  MAX_CUSTOMERS = 100;',
                '',
                'type',
                '  TCustomerManager = class(TObject)',
                '  private',
                '    FCount: Integer;',
                '  public',
                '    constructor Create;',
                '    destructor Destroy; override;',
                '    function FindById(const AId: Integer): string;',
                '    property Count: Integer read FCount;',
                '  end;',
                '',
                'procedure GlobalHelper;',
                '',
                'implementation',
                '',
                'uses',
                '  Math, StrUtils;',
                '',
                'constructor TCustomerManager.Create;',
                'begin',
                '  FCount := 0;',
                'end;',
                '',
                'destructor TCustomerManager.Destroy;',
                'begin',
                '  inherited;',
                'end;',
                '',
                'function TCustomerManager.FindById(const AId: Integer): string;',
                'begin',
                "  Result := '';",
                'end;',
                '',
                'procedure GlobalHelper;',
                'begin',
                'end;',
                '',
                'end.',
            ].join('\r\n');

            const parsed = parsePascalSource(source, 'C:\\Proj\\CustomerService.pas');
            assert.strictEqual(parsed.unitName, 'CustomerService');

            assert.deepStrictEqual(
                parsed.interfaceUses.map((u) => u.name),
                ['SysUtils', 'Classes', 'DB']
            );
            assert.deepStrictEqual(
                parsed.implementationUses.map((u) => u.name),
                ['Math', 'StrUtils']
            );

            const symNames = parsed.symbols.map((s) => `${s.section}:${s.qualifiedName}`);
            assert.ok(symNames.includes('interface:MAX_CUSTOMERS'));
            assert.ok(symNames.includes('interface:TCustomerManager'));
            assert.ok(symNames.includes('interface:TCustomerManager.Create'));
            assert.ok(symNames.includes('interface:TCustomerManager.FindById'));
            assert.ok(symNames.includes('interface:TCustomerManager.Count'));
            assert.ok(symNames.includes('interface:GlobalHelper'));
            assert.ok(symNames.includes('implementation:TCustomerManager.Create'));
            assert.ok(symNames.includes('implementation:TCustomerManager.FindById'));
            assert.ok(symNames.includes('implementation:GlobalHelper'));
        });
    });
});
