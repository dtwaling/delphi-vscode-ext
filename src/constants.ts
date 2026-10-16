import * as path from 'path';
import { findLatestInstallBin } from './utils/fileUtils';

const LSP_BIN = 'DelphiLSP.exe';
const DCC32_BIN = 'dcc32.exe';

let defaultBinPath: string | null | undefined;

/**
 * Bin folder of the newest RAD Studio installation that ships DelphiLSP. Resolved lazily and cached.
 *
 * @returns bin folder path, or undefined if no installation was found
 */
function getDefaultDelphiBinPath(): string | undefined {
    if (defaultBinPath === undefined) {
        const programFilesX86 = process.env['ProgramFiles(x86)'];
        defaultBinPath = programFilesX86
            ? (findLatestInstallBin(path.join(programFilesX86, 'Embarcadero', 'Studio'), LSP_BIN) ??
              null)
            : null;
    }
    return defaultBinPath ?? undefined;
}

export { getDefaultDelphiBinPath, LSP_BIN, DCC32_BIN };
