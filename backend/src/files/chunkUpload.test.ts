import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { config } from '../config/index';
import {
    assembleUploadedChunks,
    cancelUploadAndCleanup,
    getChunkPartPath,
    getPartFileDestination,
    getUploadMetaPath,
    getUploadPartInfo,
    getUploadStagingDir,
    getUploadStatusForSession,
    HEAD_HASH_BYTES,
    listUploadedChunks,
    recordChunkToPart,
    sanitizeUploadId,
} from './chunkUpload';
import { deleteFiles } from './fileManager';

test('sanitizeUploadId accepts safe IDs and rejects traversal or invalid characters', () => {
    assert.equal(sanitizeUploadId('abc_123-xyz99'), 'abc_123-xyz99');
    assert.throws(() => sanitizeUploadId('../escape'));
    assert.throws(() => sanitizeUploadId('short'));
    assert.throws(() => sanitizeUploadId('bad/id/here'));
});

test('listUploadedChunks and assembleUploadedChunks combine multi-part buffers cleanly', async () => {
    const serverUuid = `test-srv-${crypto.randomBytes(4).toString('hex')}`;
    const uploadId = `up-${crypto.randomBytes(8).toString('hex')}`;
    const serverRoot = path.join(config.paths.serversDir, serverUuid);
    fs.mkdirSync(serverRoot, { recursive: true });

    try {
        const staging = getUploadStagingDir(serverUuid, uploadId);
        fs.mkdirSync(staging, { recursive: true });

        const part0 = Buffer.from('Hello ');
        const part1 = Buffer.from('Chunked ');
        const part2 = Buffer.from('World!');
        fs.writeFileSync(getChunkPartPath(staging, 0), part0);
        fs.writeFileSync(getChunkPartPath(staging, 1), part1);
        fs.writeFileSync(getChunkPartPath(staging, 2), part2);

        assert.deepEqual(listUploadedChunks(staging, 3), [0, 1, 2]);

        const res = await assembleUploadedChunks({
            serverUuid,
            uploadId,
            directory: '/plugins',
            fileName: 'modpack.jar',
            totalChunks: 3,
            expectedSize: part0.length + part1.length + part2.length,
        });

        assert.equal(fs.readFileSync(res.destination, 'utf8'), 'Hello Chunked World!');
        assert.equal(res.size, 20);
        assert.equal(fs.existsSync(staging), false);
    } finally {
        fs.rmSync(serverRoot, { recursive: true, force: true });
        fs.rmSync(path.join(config.paths.storageDir, '.upload-tmp', serverUuid), { recursive: true, force: true });
    }
});

test('recordChunkToPart exposes .part file, verifies headHash on resume, and promotes on complete', async () => {
    const serverUuid = `test-srv-${crypto.randomBytes(4).toString('hex')}`;
    const uploadId = `up-${crypto.randomBytes(8).toString('hex')}`;
    const serverRoot = path.join(config.paths.serversDir, serverUuid);
    const stagingDir = getUploadStagingDir(serverUuid, uploadId);
    fs.mkdirSync(serverRoot, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
        const chunkSize = 100 * 1024; // 100 KiB chunks for test
        const chunk0Buf = crypto.randomBytes(chunkSize);
        const chunk1Buf = crypto.randomBytes(50 * 1024);
        const totalSize = chunk0Buf.length + chunk1Buf.length;

        const tmp0 = path.join(stagingDir, 'incoming-0.tmp');
        fs.writeFileSync(tmp0, chunk0Buf);

        await recordChunkToPart({
            serverUuid,
            uploadId,
            directory: '/mods',
            fileName: 'bigpack.zip',
            chunkIndex: 0,
            totalChunks: 2,
            chunkSize,
            totalSize,
            incomingFilePath: tmp0,
            receivedBytes: chunk0Buf.length,
        });

        const partDest = getPartFileDestination(serverUuid, '/mods', 'bigpack.zip');
        assert.equal(fs.existsSync(partDest), true);
        assert.equal(fs.statSync(partDest).size, chunk0Buf.length);

        const info = getUploadPartInfo(serverUuid, '/mods', 'bigpack.zip.part');
        assert.equal(info.found, true);
        assert.equal(info.uploadId, uploadId);
        assert.equal(info.fileName, 'bigpack.zip');
        assert.equal(info.totalSize, totalSize);
        assert.equal(info.chunkSize, chunkSize);
        assert.equal(info.totalChunks, 2);
        assert.deepEqual(info.uploadedChunks, [0]);
        assert.equal(info.uploadedBytes, chunk0Buf.length);
        const expectedHeadHash = crypto.createHash('sha256').update(chunk0Buf.subarray(0, HEAD_HASH_BYTES)).digest('hex');
        assert.equal(info.headHash, expectedHeadHash);

        assert.deepEqual(
            getUploadStatusForSession({
                serverUuid,
                uploadId,
                directory: '/mods',
                fileName: 'bigpack.zip',
                totalChunks: 2,
            }),
            [0]
        );

        // Resume remaining chunk 1
        const tmp1 = path.join(stagingDir, 'incoming-1.tmp');
        fs.writeFileSync(tmp1, chunk1Buf);
        await recordChunkToPart({
            serverUuid,
            uploadId,
            directory: '/mods',
            fileName: 'bigpack.zip',
            chunkIndex: 1,
            totalChunks: 2,
            chunkSize,
            totalSize,
            incomingFilePath: tmp1,
            receivedBytes: chunk1Buf.length,
        });

        const completed = await assembleUploadedChunks({
            serverUuid,
            uploadId,
            directory: '/mods',
            fileName: 'bigpack.zip',
            totalChunks: 2,
            expectedSize: totalSize,
        });

        assert.equal(completed.size, totalSize);
        assert.equal(fs.existsSync(partDest), false);
        assert.equal(fs.existsSync(getUploadMetaPath(serverUuid, '/mods', 'bigpack.zip')), false);
        assert.equal(Buffer.compare(fs.readFileSync(completed.destination), Buffer.concat([chunk0Buf, chunk1Buf])), 0);
    } finally {
        fs.rmSync(serverRoot, { recursive: true, force: true });
        fs.rmSync(path.join(config.paths.storageDir, '.upload-tmp', serverUuid), { recursive: true, force: true });
    }
});

test('manual cancel deletes .part file while deleteFiles cleans orphaned metadata', async () => {
    const serverUuid = `test-srv-${crypto.randomBytes(4).toString('hex')}`;
    const uploadId = `up-${crypto.randomBytes(8).toString('hex')}`;
    const serverRoot = path.join(config.paths.serversDir, serverUuid);
    const stagingDir = getUploadStagingDir(serverUuid, uploadId);
    fs.mkdirSync(serverRoot, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
        const tmp0 = path.join(stagingDir, 'incoming-0.tmp');
        fs.writeFileSync(tmp0, Buffer.from('partial-data'));
        await recordChunkToPart({
            serverUuid,
            uploadId,
            directory: '/',
            fileName: 'cancelme.bin',
            chunkIndex: 0,
            totalChunks: 2,
            chunkSize: 12,
            totalSize: 24,
            incomingFilePath: tmp0,
            receivedBytes: 12,
        });

        const partDest = getPartFileDestination(serverUuid, '/', 'cancelme.bin');
        const metaPath = getUploadMetaPath(serverUuid, '/', 'cancelme.bin');
        assert.equal(fs.existsSync(partDest), true);
        assert.equal(fs.existsSync(metaPath), true);

        // Manual cancel deletes both staging and .part
        cancelUploadAndCleanup({
            serverUuid,
            uploadId,
            directory: '/',
            fileName: 'cancelme.bin',
            deletePart: true,
        });
        assert.equal(fs.existsSync(partDest), false);
        assert.equal(fs.existsSync(metaPath), false);

        // Deleting a .part file via File Manager deleteFiles cleans metadata too
        const uploadId2 = `up-${crypto.randomBytes(8).toString('hex')}`;
        fs.mkdirSync(getUploadStagingDir(serverUuid, uploadId2), { recursive: true });
        const tmp2 = path.join(getUploadStagingDir(serverUuid, uploadId2), 'incoming-0.tmp');
        fs.writeFileSync(tmp2, Buffer.from('another-part'));
        await recordChunkToPart({
            serverUuid,
            uploadId: uploadId2,
            directory: '/',
            fileName: 'delme.bin',
            chunkIndex: 0,
            totalChunks: 2,
            chunkSize: 12,
            totalSize: 24,
            incomingFilePath: tmp2,
            receivedBytes: 12,
        });

        assert.equal(fs.existsSync(getUploadMetaPath(serverUuid, '/', 'delme.bin')), true);
        deleteFiles(serverUuid, '/', ['delme.bin.part']);
        assert.equal(fs.existsSync(getPartFileDestination(serverUuid, '/', 'delme.bin')), false);
        assert.equal(fs.existsSync(getUploadMetaPath(serverUuid, '/', 'delme.bin')), false);
    } finally {
        fs.rmSync(serverRoot, { recursive: true, force: true });
        fs.rmSync(path.join(config.paths.storageDir, '.upload-tmp', serverUuid), { recursive: true, force: true });
    }
});
