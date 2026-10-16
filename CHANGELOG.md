# Change Log

All notable changes to the "delphi" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2]

### Changed

- Modified extension name for publishing to VSCode Marketplace: `delphi-vscode` is now `dtdubs-delphi`.

## [1.2.1]

### Added

- Display total file line count `(N lines)` after each filename in GX Grep file header rows
- Repository `AGENTS.md` with build, validation, packaging, and architecture documentation
- GExperts attribution in `README.md`

### Changed

- GX Grep search results and history loads no longer auto-select the first match row, keeping the match context preview pane blank until the user explicitly selects a match

### Fixed

- Fixed GX Grep match context preview pane flexbox sizing so all surrounding context lines (`±1` to `±5`) render without vertical clipping in both VS Code and Cursor

## [1.2.0]

### Added

- **GX Grep Search** dockable panel (inspired by GExperts Grep):
  - Search across the current unit (`.pas + .dfm`), open project files, all files in the active Delphi project, directories, or previous search results
  - Optional per-search **Include Form (`.dfm`)** toggle with support for companion `.dfm`/`.fmx`/`.nfm`/`.xfm` files, DFM multiline string concatenation (`'...' +`), `#NNN`/`#$XX` character code decoding, and binary `TPF0` form streams
  - Delphi code/string/comment and unit-section (`interface`, `implementation`, `initialization`, `finalization`) filtering
  - Expandable file groups (`PAS` / `DFM` badges), bottom match context preview pane with configurable context line radius (`±1` to `±5`, default `±2`), persistent search history, and `Next Match` / `Previous Match` navigation
- `Delphi: Toggle Form/Unit (.pas ↔ .dfm)` (`delphi.toggleFormUnit`) command and editor toolbar buttons
- Mocha unit test suite wired into `npm test`, `npm run check:all`, and `vscode:prepublish`

### Changed

- Scoped `delphi.enabled`, `delphi.bin`, `delphi.configFile`, `delphi.legacyDiagnosticsSeverity`, and `delphi.legacyDiagnosticsTrigger` to `"resource"` and gated the GX Grep view and menus via `delphi.isEnabled` so Workspace/Folder settings and configured Delphi workspaces always take priority over User settings

## [1.1.0]

### Added

- Delphi 12 Athens support
- Legacy Delphi 6 (`dcc32.exe`) support when `delphi.bin` points to a Delphi `Bin` folder without `DelphiLSP.exe`:
  - Automatic project configuration discovery from `.dpr`, `.dof`, `.cfg`, and `want.xml`
  - Background `dcc32.exe` compiler diagnostics using an isolated temporary DCU cache (`delphi.legacyDiagnosticsSeverity` and `delphi.legacyDiagnosticsTrigger`)
  - Built-in Object Pascal code navigation (Document Outline, Go to Definition, Hover, and Workspace Symbols)
  - Direct `.dpr` project building and running with `dcc32.exe`
  - `Delphi: Check current file with compiler` (`delphi.checkCurrentFile`) command
- `delphi.enabled` workspace setting to enable or disable language services per workspace
- Workspace Trust declaration: the extension is disabled in untrusted workspaces

### Changed

- Updated to `vscode-languageclient` 10 and current build tooling; removed the unused `applicationinsights` dependency
- The run command now uses a single static `.vscode/delphi/scripts/run.ps1` with parameters; old `run.bat` and `<project>_run.ps1` files are no longer used and can be deleted
- `delphi.configFile` updates now write to Workspace settings instead of leaking into Global User settings

### Fixed

- Extension failed to activate when no RAD Studio installation was found; it now shows an error instead
- Installation detection skips version folders without `DelphiLSP.exe`
- `delphi.bin` setting was ignored
- Projects outside the `C:` drive could not be loaded
- Building `.dpk` and dotted project names (e.g. `My.App.dpr`) resolved the wrong `.dproj`/executable
- Leaked task listener on every run

### Security

- Project paths from `.delphilsp.json` are no longer interpolated into generated scripts, preventing command injection

## [1.0.1]

### Added

- LSP Support
- Syntax highlighting
- Code building and runnign
- Snippets