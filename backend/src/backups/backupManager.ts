import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { config } from '../config/index';
import { db } from '../database/connection';
import { getServerRoot } from '../files/fileManager';
import { processManager } from '../processes/ServerProcessManager';
import { logger } from '../utils/logger';

function sanitizeUuidSegment(value: string, label: string): string {
    const clean = String(value || '').trim();
    if (!clean || clean === '.' || clean === '..' || !/^[a-zA-Z0-9_-]+$/.test(clean)) {
        throw new Error(`Invalid ${label}`);
    }
    return clean;
}

export function resolveBackupArchivePath(serverUuid: string, backupUuid: string): string {
    const safeServer = sanitizeUuidSegment(serverUuid, 'server UUID');
    const safeBackup = sanitizeUuidSegment(backupUuid, 'backup UUID');
    return path.join(config.paths.backupsDir, safeServer, `${safeBackup}.tar.gz`);
}

export function getBackupArchivePath(serverUuid: string, backupUuid: string): string {
    const archivePath = resolveBackupArchivePath(serverUuid, backupUuid);
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    return archivePath;
}

export function sanitizeBackupDownloadFilename(name: string, backupUuid: string): string {
    const base = String(name || '')
        .replace(/[^a-zA-Z0-9._ -]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 80);
    if (!base) {
        return `${sanitizeUuidSegment(backupUuid, 'backup UUID')}.tar.gz`;
    }
    return base.endsWith('.tar.gz') ? base : `${base}.tar.gz`;
}

async function computeFileSha1(filePath: string): Promise<{ checksum: string; bytes: number }> {
    const stat = fs.statSync(filePath);
    const hash = crypto.createHash('sha1');
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return {
        checksum: `sha1:${hash.digest('hex')}`,
        bytes: stat.size,
    };
}

function parseIgnoredPatterns(ignoredText: string): string[] {
    return (ignoredText || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
}

export async function createServerBackup(opts: {
    serverId: number;
    serverUuid: string;
    name: string;
    ignoredFiles: string;
    isLocked: boolean;
}): Promise<any> {
    const backupUuid = crypto.randomUUID();
    const archivePath = getBackupArchivePath(opts.serverUuid, backupUuid);

    await db.execute(
        `INSERT INTO backups (server_id, uuid, is_successful, is_locked, name, ignored_files, disk, bytes)
         VALUES (?, ?, 0, ?, ?, ?, 'wings', 0)`,
        [opts.serverId, backupUuid, opts.isLocked ? 1 : 0, opts.name, opts.ignoredFiles || '']
    );

    const serverDir = getServerRoot(opts.serverUuid);
    const ignoreList = parseIgnoredPatterns(opts.ignoredFiles);

    try {
        const entries = fs.readdirSync(serverDir).filter((entry) => {
            return !ignoreList.some((pattern) => {
                const clean = pattern.replace(/^\/+|\/+$/g, '');
                return entry === clean || (clean.endsWith('*') && entry.startsWith(clean.slice(0, -1)));
            });
        });

        await tar.c(
            {
                gzip: true,
                file: archivePath,
                cwd: serverDir,
            },
            entries.length > 0 ? entries : ['.']
        );

        const { checksum, bytes } = await computeFileSha1(archivePath);

        await db.execute(
            `UPDATE backups SET is_successful = 1, checksum = ?, bytes = ?, completed_at = CURRENT_TIMESTAMP WHERE uuid = ?`,
            [checksum, bytes, backupUuid]
        );
        processManager.emit(opts.serverUuid, 'backup completed', JSON.stringify({ uuid: backupUuid, is_successful: true, checksum, file_size: bytes }));
    } catch (err) {
        logger.error('Backup creation failed', { serverUuid: opts.serverUuid, err: String(err) });
        await db.execute('UPDATE backups SET is_successful = 0, completed_at = CURRENT_TIMESTAMP WHERE uuid = ?', [
            backupUuid,
        ]);
        processManager.emit(opts.serverUuid, 'backup completed', JSON.stringify({ uuid: backupUuid, is_successful: false }));
    }

    return await db.queryOne('SELECT * FROM backups WHERE uuid = ?', [backupUuid]);
}

export async function restoreServerBackup(opts: {
    serverId: number;
    serverUuid: string;
    backupUuid: string;
    truncate: boolean;
}): Promise<void> {
    const archivePath = getBackupArchivePath(opts.serverUuid, opts.backupUuid);
    if (!fs.existsSync(archivePath)) {
        throw new Error('Backup archive file does not exist on disk');
    }

    const state = processManager.getState(opts.serverUuid);
    if (state !== 'offline') {
        await processManager.stopServer(opts.serverId, true);
    }

    await db.execute("UPDATE servers SET status = 'restoring_backup' WHERE id = ?", [opts.serverId]);
    const serverDir = getServerRoot(opts.serverUuid);

    try {
        if (opts.truncate) {
            for (const entry of fs.readdirSync(serverDir)) {
                fs.rmSync(path.join(serverDir, entry), { recursive: true, force: true });
            }
        }

        await tar.x({
            file: archivePath,
            cwd: serverDir,
            preservePaths: false,
        });

        await db.execute('UPDATE servers SET status = NULL WHERE id = ?', [opts.serverId]);
        processManager.emit(opts.serverUuid, 'backup restore completed', '');
    } catch (err) {
        await db.execute('UPDATE servers SET status = NULL WHERE id = ?', [opts.serverId]);
        processManager.emit(opts.serverUuid, 'backup restore completed', '');
        throw err;
    }
}

export async function deleteServerBackup(serverUuid: string, backupUuid: string): Promise<void> {
    const archivePath = getBackupArchivePath(serverUuid, backupUuid);
    if (fs.existsSync(archivePath)) {
        fs.rmSync(archivePath, { force: true });
    }
    await db.execute('DELETE FROM backups WHERE uuid = ?', [backupUuid]);
}
