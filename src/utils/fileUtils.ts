import { Dirent, existsSync, readdirSync } from 'fs';
import * as path from 'path';
import { coerce, rcompare, SemVer } from 'semver';
import { Uri, workspace } from 'vscode';

/**
 * Finds the `bin` folder of the highest versioned installation folder (e.g. `Studio\23.0`) that contains a given file.
 * Leftover version folders without the file (e.g. after an uninstall) are skipped.
 *
 * @param installsDir directory containing versioned installation folders
 * @param requiredFile file that must exist in the `bin` folder
 * @returns path to the `bin` folder, or undefined if none qualifies
 */
export function findLatestInstallBin(
    installsDir: string,
    requiredFile: string
): string | undefined {
    let entries: Dirent[];
    try {
        entries = readdirSync(installsDir, { withFileTypes: true });
    } catch {
        return undefined;
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, version: coerce(entry.name) }))
        .filter((entry): entry is { name: string; version: SemVer } => entry.version !== null)
        .sort((a, b) => rcompare(a.version, b.version))
        .map((entry) => path.join(installsDir, entry.name, 'bin'))
        .find((bin) => existsSync(path.join(bin, requiredFile)));
}

/**
 * Converts a `file:` URI to a filesystem path; any other value is treated as a path already.
 *
 * @param value file URI or filesystem path
 * @returns filesystem path
 */
export function toFsPath(value: string): string {
    return /^file:/i.test(value) ? Uri.parse(value).fsPath : value;
}

/**
 * Converts a file URI or filesystem path into a normalized Windows filesystem path
 * with an uppercase drive letter (e.g. `C:\Dev\Source\...`).
 *
 * @param value file URI or filesystem path
 * @returns clean filesystem path
 */
export function toCleanFsPath(value: string): string {
    const raw = path.normalize(toFsPath(value));
    return raw.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

/**
 * Checks if a file exists in a path
 *
 * @param uri File path as URI
 * @returns boolean of if file exists
 */
export async function fileExists(uri: Uri): Promise<boolean> {
    if (uri.path === '/') return false;
    try {
        await workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
