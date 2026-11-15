import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { config } from '../config/index';
import { db } from '../database/connection';
import { getServerRoot } from '../files/fileManager';
import { processManager } from '../processes/ServerProcessManager';
import { logger } from '../utils/logger';

export function getBackupArchivePath(serverUuid: string, backupUuid: string): string {
    const dir = path.join(config.paths.backupsDir, serverUuid);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${backupUuid}.tar.gz`);
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

        const buf = fs.readFileSync(archivePath);
        const checksum = `sha1:${crypto.createHash('sha1').update(buf).digest('hex')}`;
        const bytes = buf.length;

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
