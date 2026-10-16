# dtdubs-delphi README

Delphi extension to allow developer tooling for Delphi in VSCode.

If you have a *licensed install* of Embarcadero Delphi, this extension can be very useful should you need the help of a simple IDE to diagnose issues in dedicated build environments (e.g.: a VM used by your build pipelines), which typically do not need a full RAD Studio setup. Embarcadero allows you to copy the required binaries for the CLI utilities, for checking and compiling a project, to a build environment, and the extension configuration allows you to point to a non-standard Delphi bin path.

> [!NOTE]
> You will need a valid licensed Delphi install to copy the build tools from when setting up a dedicated build machine. This use scenario is covered and cited in Embarcadero documentation, however the required binaries are not openly distributed separately.

## Features

- Building and running projects
- Syntax highlighting
- LSP Integration (Delphi 11 / 12)
- Legacy Delphi 6 (`dcc32.exe`) support with compiler diagnostics, code navigation (Outline, Go to Definition, Hover, Workspace Symbols), and project building
- **GX Grep Search** panel (inspired by GExperts Grep): search the current unit, open files, active Delphi project files, or directories with optional **companion `.dfm` form file inclusion**, DFM multiline/`#NNN` string decoding, Delphi code/string/comment & unit-section filtering, expandable file results, match context preview pane, and persistent search history
- **Toggle Form/Unit (`.pas ↔ .dfm`)** command and editor toolbar buttons
- Snippets

## Requirements

- **Delphi 11 Alexandria / Delphi 12 Athens** (LSP mode) **or Legacy Delphi 6** (`dcc32.exe` mode)
  - The newest installation under `Program Files (x86)\Embarcadero\Studio` that contains `DelphiLSP.exe` is used by default, unless `delphi.bin` is set
  - When `delphi.bin` points to a legacy Delphi `Bin` folder containing `dcc32.exe` without `DelphiLSP.exe` (such as Delphi 6), the extension automatically activates Legacy mode (`dcc32.exe` diagnostics + built-in Pascal navigation) instead of launching `DelphiLSP.exe`
- VS Code 1.91 or later
- A trusted workspace (the extension is disabled in Restricted Mode because it starts DelphiLSP / `dcc32.exe` and runs build scripts)
- Project configuration:
  - **Delphi 11 / 12**: In Delphi, open Tools > Options > User Interface > Editor > Language (pick Delphi from the dropdown) > Code Insight and turn on ‘Generate LSP Config’, then close and reopen your project.
  - **Legacy Delphi 6**: Automatically discovers project settings from `.dpr`, `.dof`, `.cfg`, and workspace `want.xml` files.
- For building and running:
  - **Delphi 11 / 12**: the project's `.dproj` next to its `.dpr`, built via MSBuild (`rsvars.bat`)
  - **Legacy Delphi 6**: the project's `.dpr`, built via `dcc32.exe`

## Extension Settings

* `delphi.enabled` Enable or disable the Delphi extension language features and diagnostics in the current workspace (default `true`).
* `delphi.bin` Path to Delphi `bin` folder (containing `DelphiLSP.exe` for Delphi 11+, or `dcc32.exe` for legacy versions such as Delphi 6). Defaults to newest installation.
* `delphi.configFile` File URI or path of current project config (`<delphiProjectName>.delphilsp.json` for Delphi 11+, or `.dpr`/`.dof`/`.cfg` for legacy Delphi)
* `delphi.serverType` Defines the operation mode for `DelphiLSP.exe`
* `delphi.agentCount` Defines the number of sub processes (agents) when serverType is controller. If agentCount > 1 then one process will be dedicated to Error Insight
* `delphi.logModes` Bit mask defining logging modes [1 (RawInputMessage), 2 (RawOutputMessage), 4 (Queue), 8 (Processor), 16 (Server), 32 (AgentFacade), 64 (DCC related), 128 (LSP Inspector traces)]
* `delphi.legacyDiagnosticsSeverity` Controls which compiler message severities from `dcc32.exe` are reported in Legacy mode (`errors` [default], `warnings`, `hints`, or `off`)
* `delphi.legacyDiagnosticsTrigger` Controls when background `dcc32.exe` checks run in Legacy mode (`openAndSave` [default], `saveOnly`, or `manual`)


## Release Notes

Check out [CHANGELOG](./CHANGELOG.md).

## Some credits

- [delphi-vscode](https://github.com/Adventune/delphi-vscode)
  - This is an updated fork of the original extension built by @Adventune.
- [Pascal for VSCode](https://github.com/alefragnani/vscode-language-pascal/blob/master/snippets/pascal.json)
  - Copied syntax & snippets from here.
- [DelphiLSP for VSCode](https://marketplace.visualstudio.com/items?itemName=EmbarcaderoTechnologies.delphilsp)
  - "Reverse engineered" (opened the extension with 7-Zip) some of the code for handling the custom notifications that are needed to be sent to the LSP.
- [GExperts](https://www.gexperts.org/)
  - This has been a **long-time** favorite tool I've always used in the Delphi IDEs - their search tool is the inspiration for my GX Grep feature in dtdubs-delphi.

> [!NOTE]
> From the original author: This extension was only built to meet my own demand, and published on the off-chance that it might help someone else. There is now over 5K installations however, and I assume most needs are not met for Delphi development at the current state of the extension. Thus, **I encourage you to open a PR for any features you might miss**. I will happily review and add any improvements or features.