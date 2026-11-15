import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    getBackupArchivePath,
    resolveBackupArchivePath,
    sanitizeBackupDownloadFilename,
} from './backupManager';
import { config } from '../config/index';

test('resolveBackupArchivePath resolves inside configured backupsDir without traversal', () => {
    const serverUuid = '46817200-1659-4416-8ed3-7c1a1b920d0b';
    const backupUuid = '2be40f95-483a-4d1f-a5d0-dedbd3731364';
    const resolved = resolveBackupArchivePath(serverUuid, backupUuid);
    assert.equal(
        resolved,
        path.join(config.paths.backupsDir, serverUuid, `${backupUuid}.tar.gz`)
    );
});

test('resolveBackupArchivePath rejects invalid or traversal UUID segments', () => {
    assert.throws(() => resolveBackupArchivePath('../etc', '2be40f95-483a-4d1f-a5d0-dedbd3731364'));
    assert.throws(() => resolveBackupArchivePath('46817200-1659-4416-8ed3-7c1a1b920d0b', '..'));
    assert.throws(() => resolveBackupArchivePath('', '2be40f95-483a-4d1f-a5d0-dedbd3731364'));
});

test('getBackupArchivePath creates parent directory when requested', () => {
    const serverUuid = `test-server-${Date.now()}`;
    const backupUuid = `test-backup-${Date.now()}`;
    const p = getBackupArchivePath(serverUuid, backupUuid);
    try {
        assert.equal(fs.existsSync(path.dirname(p)), true);
        assert.equal(path.basename(p), `${backupUuid}.tar.gz`);
    } finally {
        fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
});

test('sanitizeBackupDownloadFilename formats safe .tar.gz filenames', () => {
    const uuid = '2be40f95-483a-4d1f-a5d0-dedbd3731364';
    assert.equal(sanitizeBackupDownloadFilename('Daily World Backup!', uuid), 'Daily-World-Backup.tar.gz');
    assert.equal(sanitizeBackupDownloadFilename('already.tar.gz', uuid), 'already.tar.gz');
    assert.equal(sanitizeBackupDownloadFilename('///', uuid), `${uuid}.tar.gz`);
});
