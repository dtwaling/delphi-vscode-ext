# AGENTS.md

## Overview

`delphi-vscode` is a VS Code (and Cursor-compatible) extension providing Embarcadero Delphi language support, project building/running, Legacy Delphi 6 (`dcc32.exe`) diagnostics and navigation, and a GExperts-inspired **GX Grep** search view with companion `.dfm` support.

See [README.md](./README.md) for user-facing features, requirements, and extension settings, and [CHANGELOG.md](./CHANGELOG.md) for release history.

## Build, Validation, and Packaging

Run all commands from the repository root:

1. **Install dependencies**
   ```powershell
   npm install
   ```

2. **Compile TypeScript (`src/` → `lib/`)**
   ```powershell
   npm run compile
   ```
   > Note: `npm run compile` runs `tsc -b`. If incremental build state (`tsconfig.tsbuildinfo`) is stale, remove `tsconfig.tsbuildinfo` before compiling.

3. **Run full validation gate (TypeScript + Prettier + ESLint + Mocha unit tests)**
   ```powershell
   npm run check:all
   ```
   Individual checks:
   - `npm run check:types` — Type-check without emitting (`tsc --noEmit`)
   - `npm run check:format` / `npm run pretty` — Check or apply Prettier formatting on `src/**/*`
   - `npm run lint` — Lint `src/` with ESLint
   - `npm test` — Compile and run Mocha unit tests (`lib/test/**/*.test.js`)

4. **Package VSIX extension bundle**
   ```powershell
   npm run package
   ```
   - Runs `npx @vscode/vsce package -o out/` (which triggers `vscode:prepublish` → `npm run compile && npm test`).
   - Outputs `out/delphi-vscode-<version>.vsix`.
   - Install locally via `Extensions: Install from VSIX...` in the Command Palette, or from the CLI:
     ```powershell
     code --install-extension out/delphi-vscode-<version>.vsix
     cursor --install-extension out/delphi-vscode-<version>.vsix
     ```

5. **Release & Marketplace Publishing (`.github/workflows/release.yml`)**
   - Pushing a version tag matching `v*` (e.g., `git tag v1.2.2 && git push origin main v1.2.2`) or triggering **Release & Publish Extension** via `workflow_dispatch` runs `npm run check:all`, verifies that the tag matches `package.json`, packages `out/delphi-vscode-<version>.vsix`, attaches it to the GitHub Release (using notes from `CHANGELOG.md`), and publishes to:
     - **VS Code Marketplace** (`npx @vscode/vsce publish`) when repository secret `VSCE_PAT` is set (Azure DevOps PAT with `Marketplace -> Manage` scope for publisher `DWaling-eci`).
     - **Open VSX Registry** (`npx ovsx publish`, used by Cursor) when repository secret `OVSX_PAT` is set (Open VSX access token for namespace `DWaling-eci`).
   - Manual CLI publishing is also available via `npm run publish:vsce` and `npm run publish:ovsx`.

## Architecture

- `src/main.ts` — Extension activation/deactivation, mode selection (DelphiLSP vs. Legacy `dcc32.exe`), and command/view registration.
- `src/client/` — `DelphiLSP.exe` language client and `.delphilsp.json` config resolution (`languageClient.ts`, `configFile.ts`).
- `src/legacy/` — Legacy Delphi 6 support: `.dpr`/`.dof`/`.cfg`/`want.xml` project discovery (`projectConfig.ts`), background `dcc32.exe` diagnostics (`diagnostics.ts`), and Pascal parser/navigation providers (`navigation.ts`).
- `src/grep/` — GX Grep search engine, `.pas ↔ .dfm` companion resolution, DFM `#NNN` and multiline decoding (`grepEngine.ts`), and webview UI provider (`gxGrepView.ts`, `commands.ts`).
- `src/runner/` — Build & run task execution and PowerShell script generation (`runManager.ts`, `scripts.ts`, `commands.ts`).
- `src/utils/` — Toolchain discovery, workspace enablement (`constantUtils.ts`), and path/URI normalization (`fileUtils.ts`).
- `src/test/` — Mocha unit test suites and VS Code API mock (`vscodeMock.ts`).

## Conventions & Guardrails

- **TypeScript module resolution**: Keep `"module": "node16"` and `"moduleResolution": "node16"` in `tsconfig.json` (`vscode-languageclient` v10 uses package `exports` that require Node16 resolution).
- **Run script execution**: `src/runner/scripts.ts` generates a static `.vscode/delphi/scripts/run.ps1` and `src/runner/runManager.ts` invokes `powershell.exe -File` via `ProcessExecution` argument arrays—never interpolate raw file paths into shell script strings.
- **Workspace enablement**: `isDelphiEnabled()` prioritizes workspace and workspace-folder `delphi.enabled` settings over global user settings.
