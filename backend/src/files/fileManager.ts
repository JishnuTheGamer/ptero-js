import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { config } from '../config/index';
import { cleanupUploadMetaForPart } from './chunkUpload';
import { formatModeString, normalizePosixPath, resolveServerPath } from './pathSafety';

export interface FileEntry {
    name: string;
    mode: string;
    mode_bits: string;
    size: number;
    is_file: boolean;
    is_symlink: boolean;
    mimetype: string;
    created_at: string;
    modified_at: string;
}

function detectMimeType(filePath: string, isDir: boolean, isSymlink: boolean): string {
    if (isSymlink) return 'inode/symlink';
    if (isDir) return 'inode/directory';
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.txt': 'text/plain',
        '.log': 'text/plain',
        '.properties': 'text/plain',
        '.cfg': 'text/plain',
        '.conf': 'text/plain',
        '.toml': 'text/plain',
        '.yml': 'text/yaml',
        '.yaml': 'text/yaml',
        '.json': 'application/json',
        '.js': 'application/javascript',
        '.ts': 'text/plain',
        '.sh': 'application/x-sh',
        '.md': 'text/markdown',
        '.html': 'text/html',
        '.css': 'text/css',
        '.xml': 'application/xml',
        '.jar': 'application/jar',
        '.zip': 'application/zip',
        '.gz': 'application/gzip',
        '.tgz': 'application/gzip',
        '.tar': 'application/x-tar',
        '.bz2': 'application/x-bzip2',
        '.xz': 'application/x-xz',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.dat': 'application/octet-stream',
        '.mca': 'application/octet-stream',
        '.part': 'application/octet-stream',
    };
    return map[ext] || 'text/plain';
}

export function getServerRoot(uuid: string): string {
    const dir = path.join(config.paths.serversDir, uuid);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function listDirectory(uuid: string, directory = '/'): FileEntry[] {
    const root = getServerRoot(uuid);
    const targetDir = resolveServerPath(root, directory, true);
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
        throw new Error('Target path is not a directory');
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const items: FileEntry[] = [];

    for (const entry of entries) {
        const full = path.join(targetDir, entry.name);
        try {
            const lstat = fs.lstatSync(full);
            const isSymlink = lstat.isSymbolicLink();
            const isDir = entry.isDirectory();
            const isFile = !isDir && !isSymlink;
            const { mode, modeBits } = formatModeString(lstat.mode, isDir);
            items.push({
                name: entry.name,
                mode,
                mode_bits: modeBits,
                size: isDir ? 0 : lstat.size,
                is_file: isFile,
                is_symlink: isSymlink,
                mimetype: detectMimeType(full, isDir, isSymlink),
                created_at: lstat.birthtime.toISOString(),
                modified_at: lstat.mtime.toISOString(),
            });
        } catch {
            // Skip unreadable entry
        }
    }

    items.sort((a, b) => {
        if (a.is_file !== b.is_file) return a.is_file ? 1 : -1;
        return a.name.localeCompare(b.name);
    });

    return items;
}

export async function listDirectoryAsync(uuid: string, directory = '/'): Promise<FileEntry[]> {
    const root = getServerRoot(uuid);
    const targetDir = resolveServerPath(root, directory, true);
    const stat = await fs.promises.stat(targetDir);
    if (!stat.isDirectory()) {
        throw new Error('Target path is not a directory');
    }

    const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
    const items: FileEntry[] = [];

    for (let i = 0; i < entries.length; i += 64) {
        const batch = entries.slice(i, i + 64);
        const resolvedBatch = await Promise.all(
            batch.map(async (entry): Promise<FileEntry | null> => {
                const full = path.join(targetDir, entry.name);
                try {
                    const lstat = await fs.promises.lstat(full);
                    const isSymlink = lstat.isSymbolicLink();
                    const isDir = entry.isDirectory();
                    const isFile = !isDir && !isSymlink;
                    const { mode, modeBits } = formatModeString(lstat.mode, isDir);
                    return {
                        name: entry.name,
                        mode,
                        mode_bits: modeBits,
                        size: isDir ? 0 : lstat.size,
                        is_file: isFile,
                        is_symlink: isSymlink,
                        mimetype: detectMimeType(full, isDir, isSymlink),
                        created_at: lstat.birthtime.toISOString(),
                        modified_at: lstat.mtime.toISOString(),
                    };
                } catch {
                    return null;
                }
            })
        );
        for (const item of resolvedBatch) {
            if (item) items.push(item);
        }
    }

    items.sort((a, b) => {
        if (a.is_file !== b.is_file) return a.is_file ? 1 : -1;
        return a.name.localeCompare(b.name);
    });

    return items;
}

export function getFileContents(uuid: string, filePath: string): string {
    const root = getServerRoot(uuid);
    const resolved = resolveServerPath(root, filePath, true);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
        throw new Error('Requested path is not a file');
    }
    if (stat.size > 10 * 1024 * 1024) {
        throw new Error('File is too large to open in editor (>10MB)');
    }
    return fs.readFileSync(resolved, 'utf8');
}

export function writeFileContents(uuid: string, filePath: string, content: string): void {
    const root = getServerRoot(uuid);
    const resolved = resolveServerPath(root, filePath, false);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
}

export function createDirectory(uuid: string, rootDir: string, name: string): void {
    const root = getServerRoot(uuid);
    const cleanName = path.posix.basename(name.trim());
    if (!cleanName || cleanName === '.' || cleanName === '..') {
        throw new Error('Invalid folder name');
    }
    const target = resolveServerPath(root, path.posix.join(normalizePosixPath(rootDir), cleanName), false);
    fs.mkdirSync(target, { recursive: true });
}

export function renameFiles(uuid: string, rootDir: string, files: Array<{ from: string; to: string }>): void {
    const root = getServerRoot(uuid);
    const base = normalizePosixPath(rootDir);
    for (const item of files) {
        const src = resolveServerPath(root, path.posix.join(base, item.from), true);
        const dst = resolveServerPath(root, path.posix.join(base, item.to), false);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
    }
}

export function copyFile(uuid: string, location: string): void {
    const root = getServerRoot(uuid);
    const src = resolveServerPath(root, location, true);
    const dir = path.dirname(src);
    const ext = path.extname(src);
    const base = path.basename(src, ext);
    let candidate = path.join(dir, `${base} copy${ext}`);
    let idx = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${base} copy ${idx}${ext}`);
        idx++;
    }
    fs.cpSync(src, candidate, { recursive: true });
}

export function deleteFiles(uuid: string, rootDir: string, files: string[]): void {
    const root = getServerRoot(uuid);
    const base = normalizePosixPath(rootDir);
    for (const file of files) {
        const target = resolveServerPath(root, path.posix.join(base, file), false);
        if (target === fs.realpathSync(root)) {
            throw new Error('Cannot delete server root directory');
        }
        if (fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
        }
        if (file.endsWith('.part')) {
            cleanupUploadMetaForPart(uuid, base, file);
        }
    }
}

export function chmodFiles(uuid: string, rootDir: string, files: Array<{ file: string; mode: string }>): void {
    const root = getServerRoot(uuid);
    const base = normalizePosixPath(rootDir);
    for (const item of files) {
        const target = resolveServerPath(root, path.posix.join(base, item.file), true);
        const modeInt = parseInt(item.mode, 8);
        if (Number.isNaN(modeInt)) {
            throw new Error(`Invalid file mode: ${item.mode}`);
        }
        fs.chmodSync(target, modeInt);
    }
}

export async function compressFiles(uuid: string, rootDir: string, files: string[]): Promise<FileEntry> {
    const root = getServerRoot(uuid);
    const base = normalizePosixPath(rootDir);
    const baseReal = resolveServerPath(root, base, true);

    const validatedFiles: string[] = [];
    for (const f of files) {
        const resolved = resolveServerPath(root, path.posix.join(base, f), true);
        validatedFiles.push(path.relative(baseReal, resolved));
    }

    const archiveName = `archive-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const archivePath = resolveServerPath(root, path.posix.join(base, archiveName), false);

    await tar.c(
        {
            gzip: true,
            file: archivePath,
            cwd: baseReal,
        },
        validatedFiles
    );

    const stat = fs.statSync(archivePath);
    const { mode, modeBits } = formatModeString(stat.mode, false);
    return {
        name: archiveName,
        mode,
        mode_bits: modeBits,
        size: stat.size,
        is_file: true,
        is_symlink: false,
        mimetype: 'application/gzip',
        created_at: stat.birthtime.toISOString(),
        modified_at: stat.mtime.toISOString(),
    };
}

export async function decompressArchive(uuid: string, rootDir: string, file: string): Promise<void> {
    const root = getServerRoot(uuid);
    const base = normalizePosixPath(rootDir);
    const baseReal = resolveServerPath(root, base, true);
    const archivePath = resolveServerPath(root, path.posix.join(base, file), true);

    if (file.endsWith('.zip')) {
        const zip = new AdmZip(archivePath);
        for (const entry of zip.getEntries()) {
            // Protect against zip-slip
            resolveServerPath(root, path.posix.join(base, entry.entryName), false);
        }
        zip.extractAllTo(baseReal, true);
        return;
    }

    await tar.x({
        file: archivePath,
        cwd: baseReal,
        preservePaths: false,
    });
}

export async function pullRemoteFile(uuid: string, rootDir: string, url: string, filename?: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only HTTP/HTTPS URLs are supported');
    }
    const root = getServerRoot(uuid);
    const base = normalizePosixPath(rootDir);
    const resolvedName = path.posix.basename(filename || path.posix.basename(parsed.pathname) || 'downloaded-file');
    const dest = resolveServerPath(root, path.posix.join(base, resolvedName), false);

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`Failed to download remote file: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
}

export function resolveDownloadPath(uuid: string, filePath: string): string {
    const root = getServerRoot(uuid);
    return resolveServerPath(root, filePath, true);
}

export function resolveUploadDestination(uuid: string, directory: string, filename: string): string {
    const root = getServerRoot(uuid);
    const base = normalizePosixPath(directory || '/');
    const cleanName = path.posix.basename(filename);
    return resolveServerPath(root, path.posix.join(base, cleanName), false);
}
