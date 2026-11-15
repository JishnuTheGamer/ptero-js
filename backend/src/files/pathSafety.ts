import fs from 'node:fs';
import path from 'node:path';

export class PathTraversalError extends Error {
    constructor(message = 'Access denied: path escapes server root directory') {
        super(message);
        this.name = 'PathTraversalError';
    }
}

export function normalizePosixPath(input: string): string {
    const trimmed = (input || '/').replace(/\\/g, '/');
    const resolved = path.posix.resolve('/', trimmed);
    return resolved;
}

export function isPathInsideRoot(rootDir: string, candidatePath: string): boolean {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedCandidate = path.resolve(candidatePath);
    if (resolvedCandidate === resolvedRoot) return true;
    return resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

/**
 * Resolves a user-supplied relative path safely inside a server's root directory.
 * Protects against `..`, null bytes, and symlink escapes.
 */
export function resolveServerPath(serverRoot: string, userPath: string, mustExist = false): string {
    if (userPath.includes('\0')) {
        throw new PathTraversalError('Null byte in file path');
    }

    const rootReal = fs.existsSync(serverRoot) ? fs.realpathSync(serverRoot) : path.resolve(serverRoot);
    const cleanRel = normalizePosixPath(userPath).replace(/^\/+/, '');
    const joined = path.resolve(rootReal, cleanRel);

    if (!isPathInsideRoot(rootReal, joined)) {
        throw new PathTraversalError();
    }

    if (fs.existsSync(joined)) {
        const realTarget = fs.realpathSync(joined);
        if (!isPathInsideRoot(rootReal, realTarget)) {
            throw new PathTraversalError('Symlink target escapes server root directory');
        }
        return realTarget;
    }

    if (mustExist) {
        throw new Error(`ENOENT: no such file or directory: ${userPath}`);
    }

    // Check closest existing ancestor for symlink escape
    let ancestor = path.dirname(joined);
    while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
        ancestor = path.dirname(ancestor);
    }
    if (fs.existsSync(ancestor)) {
        const realAncestor = fs.realpathSync(ancestor);
        if (!isPathInsideRoot(rootReal, realAncestor)) {
            throw new PathTraversalError('Parent symlink escapes server root directory');
        }
    }

    return joined;
}

export function formatModeString(mode: number, isDir: boolean): { mode: string; modeBits: string } {
    const perms = mode & 0o777;
    const octal = perms.toString(8).padStart(3, '0');
    const chars = ['r', 'w', 'x'];
    let rwx = isDir ? 'd' : '-';
    for (let i = 2; i >= 0; i--) {
        const triad = (perms >> (i * 3)) & 7;
        for (let b = 2; b >= 0; b--) {
            rwx += triad & (1 << b) ? chars[2 - b] : '-';
        }
    }
    return { mode: rwx, modeBits: octal };
}
