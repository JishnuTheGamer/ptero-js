import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index';
import { resolveUploadDestination } from './fileManager';
import { normalizePosixPath } from './pathSafety';

export const HEAD_HASH_BYTES = 64 * 1024;

export interface UploadPartMetadata {
    uploadId: string;
    directory: string;
    fileName: string;
    partName: string;
    totalSize: number;
    chunkSize: number;
    totalChunks: number;
    uploadedChunks: number[];
    chunkSizes: Record<number, number>;
    headHash?: string;
    updatedAt: string;
}

export interface UploadPartInfo {
    found: boolean;
    uploadId?: string;
    directory: string;
    fileName: string;
    partName: string;
    totalSize: number;
    chunkSize: number;
    totalChunks: number;
    uploadedChunks: number[];
    uploadedBytes: number;
    partFileSize: number;
    headHash?: string;
}

const partWriteLocks = new Map<string, Promise<unknown>>();

async function withPartLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = partWriteLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const chained = prev.catch(() => undefined).then(() => gate);
    partWriteLocks.set(lockKey, chained);
    try {
        await prev.catch(() => undefined);
        return await fn();
    } finally {
        release();
        if (partWriteLocks.get(lockKey) === chained) {
            partWriteLocks.delete(lockKey);
        }
    }
}

export function sanitizeUploadId(raw: unknown): string {
    const id = String(raw || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,96}$/.test(id)) {
        throw new Error('Invalid uploadId format');
    }
    return id;
}

function safeServerUuid(serverUuid: string): string {
    const safeUuid = String(serverUuid || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeUuid) {
        throw new Error('Invalid server UUID');
    }
    return safeUuid;
}

export function getUploadStagingDir(serverUuid: string, uploadId: string): string {
    const safeId = sanitizeUploadId(uploadId);
    const safeUuid = safeServerUuid(serverUuid);
    return path.join(config.paths.storageDir, '.upload-tmp', safeUuid, safeId);
}

export function getUploadMetaPath(serverUuid: string, directory: string, fileName: string): string {
    const safeUuid = safeServerUuid(serverUuid);
    const normDir = normalizePosixPath(directory || '/');
    const cleanName = path.posix.basename(fileName);
    if (!cleanName || cleanName === '.' || cleanName === '..') {
        throw new Error('Invalid fileName');
    }
    const key = crypto.createHash('sha1').update(`${normDir}/${cleanName}`).digest('hex');
    return path.join(config.paths.storageDir, '.upload-tmp', safeUuid, `meta-${key}.json`);
}

export function getPartFileDestination(serverUuid: string, directory: string, fileName: string): string {
    const cleanName = path.posix.basename(fileName);
    if (!cleanName || cleanName === '.' || cleanName === '..') {
        throw new Error('Invalid fileName');
    }
    return resolveUploadDestination(serverUuid, directory, `${cleanName}.part`);
}

export function getChunkPartPath(stagingDir: string, chunkIndex: number): string {
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 1_000_000) {
        throw new Error('Invalid chunkIndex');
    }
    return path.join(stagingDir, `part.${chunkIndex}`);
}

function readMetaFile(metaPath: string): UploadPartMetadata | null {
    if (!fs.existsSync(metaPath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as UploadPartMetadata;
        if (!parsed || typeof parsed !== 'object' || !parsed.uploadId) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeMetaFile(metaPath: string, meta: UploadPartMetadata): void {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    const tmp = `${metaPath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, metaPath);
}

export async function recordChunkToPart(params: {
    serverUuid: string;
    uploadId: string;
    directory: string;
    fileName: string;
    chunkIndex: number;
    totalChunks: number;
    chunkSize: number;
    totalSize: number;
    incomingFilePath: string;
    receivedBytes: number;
}): Promise<{ chunkIndex: number; receivedBytes: number; partFileSize: number; headHash?: string }> {
    const {
        serverUuid,
        uploadId,
        directory,
        fileName,
        chunkIndex,
        totalChunks,
        chunkSize,
        totalSize,
        incomingFilePath,
        receivedBytes,
    } = params;

    const safeId = sanitizeUploadId(uploadId);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 1_000_000) {
        throw new Error('Invalid chunkIndex');
    }
    if (!Number.isInteger(totalChunks) || totalChunks < 1) {
        throw new Error('Invalid totalChunks');
    }
    if (!Number.isFinite(chunkSize) || chunkSize < 1) {
        throw new Error('Invalid chunkSize');
    }

    const normDir = normalizePosixPath(directory || '/');
    const cleanName = path.posix.basename(fileName);
    const destPart = getPartFileDestination(serverUuid, normDir, cleanName);
    const metaPath = getUploadMetaPath(serverUuid, normDir, cleanName);

    return withPartLock(metaPath, async () => {
        fs.mkdirSync(path.dirname(destPart), { recursive: true });
        fs.mkdirSync(path.dirname(metaPath), { recursive: true });

        let meta = readMetaFile(metaPath);
        const isSameUpload =
            meta &&
            meta.uploadId === safeId &&
            meta.chunkSize === chunkSize &&
            meta.totalSize === totalSize &&
            meta.totalChunks === totalChunks;

        if (!isSameUpload) {
            meta = {
                uploadId: safeId,
                directory: normDir,
                fileName: cleanName,
                partName: `${cleanName}.part`,
                totalSize,
                chunkSize,
                totalChunks,
                uploadedChunks: [],
                chunkSizes: {},
                headHash: undefined,
                updatedAt: new Date().toISOString(),
            };
            if (fs.existsSync(destPart)) {
                fs.writeFileSync(destPart, Buffer.alloc(0));
            }
        }

        const partExists = fs.existsSync(destPart);
        const fh = await fs.promises.open(destPart, partExists ? 'r+' : 'w+');
        const inFh = await fs.promises.open(incomingFilePath, 'r');
        const headChunks: Buffer[] = [];
        let headCollected = 0;

        try {
            const copyBufSize = 1024 * 1024; // 1 MiB streaming buffer
            const buf = Buffer.allocUnsafe(copyBufSize);
            let readOffset = 0;
            let writeOffset = chunkIndex * chunkSize;

            for (;;) {
                const { bytesRead } = await inFh.read(buf, 0, copyBufSize, readOffset);
                if (bytesRead <= 0) break;

                if (chunkIndex === 0 && headCollected < HEAD_HASH_BYTES) {
                    const take = Math.min(bytesRead, HEAD_HASH_BYTES - headCollected);
                    headChunks.push(Buffer.from(buf.subarray(0, take)));
                    headCollected += take;
                }

                await fh.write(buf, 0, bytesRead, writeOffset);
                readOffset += bytesRead;
                writeOffset += bytesRead;
            }
        } finally {
            await inFh.close().catch(() => undefined);
            await fh.close().catch(() => undefined);
        }

        fs.rmSync(incomingFilePath, { force: true });

        if (chunkIndex === 0 && headChunks.length > 0) {
            const headBuf = Buffer.concat(headChunks);
            meta!.headHash = crypto.createHash('sha256').update(headBuf).digest('hex');
        }

        const set = new Set<number>(meta!.uploadedChunks || []);
        set.add(chunkIndex);
        meta!.uploadedChunks = Array.from(set).sort((a, b) => a - b);
        meta!.chunkSizes = meta!.chunkSizes || {};
        meta!.chunkSizes[chunkIndex] = receivedBytes;
        meta!.updatedAt = new Date().toISOString();
        writeMetaFile(metaPath, meta!);

        const stat = fs.statSync(destPart);
        return {
            chunkIndex,
            receivedBytes,
            partFileSize: stat.size,
            headHash: meta!.headHash,
        };
    });
}

export function listUploadedChunks(stagingDir: string, totalChunks?: number): number[] {
    if (!fs.existsSync(stagingDir)) {
        return [];
    }
    const entries = fs.readdirSync(stagingDir);
    const indices: number[] = [];
    for (const entry of entries) {
        const match = /^part\.(\d+)$/.exec(entry);
        if (!match) continue;
        const idx = Number(match[1]);
        if (totalChunks !== undefined && idx >= totalChunks) continue;
        const full = path.join(stagingDir, entry);
        if (fs.statSync(full).isFile()) {
            indices.push(idx);
        }
    }
    indices.sort((a, b) => a - b);
    return indices;
}

export function getUploadStatusForSession(params: {
    serverUuid: string;
    uploadId: string;
    directory?: string;
    fileName?: string;
    totalChunks?: number;
}): number[] {
    const { serverUuid, uploadId, directory, fileName, totalChunks } = params;
    const safeId = sanitizeUploadId(uploadId);

    if (directory && fileName) {
        try {
            const normDir = normalizePosixPath(directory);
            const metaPath = getUploadMetaPath(serverUuid, normDir, fileName);
            const destPart = getPartFileDestination(serverUuid, normDir, fileName);
            const meta = readMetaFile(metaPath);
            if (meta && meta.uploadId === safeId && fs.existsSync(destPart)) {
                return (meta.uploadedChunks || []).filter(
                    (idx) => totalChunks === undefined || idx < totalChunks
                );
            }
        } catch {
            // fallback to staging dir
        }
    }

    const stagingDir = getUploadStagingDir(serverUuid, safeId);
    return listUploadedChunks(stagingDir, totalChunks);
}

export function getUploadPartInfo(serverUuid: string, directory: string, partName: string): UploadPartInfo {
    const normDir = normalizePosixPath(directory || '/');
    const cleanPart = path.posix.basename(partName || '');
    if (!cleanPart.endsWith('.part') || cleanPart.length <= 5) {
        throw new Error('Selected file is not a .part upload file');
    }

    const fileName = cleanPart.slice(0, -5);
    const destPart = resolveUploadDestination(serverUuid, normDir, cleanPart);
    if (!fs.existsSync(destPart)) {
        return {
            found: false,
            directory: normDir,
            fileName,
            partName: cleanPart,
            totalSize: 0,
            chunkSize: 10 * 1024 * 1024,
            totalChunks: 0,
            uploadedChunks: [],
            uploadedBytes: 0,
            partFileSize: 0,
        };
    }

    const stat = fs.statSync(destPart);
    const metaPath = getUploadMetaPath(serverUuid, normDir, fileName);
    const meta = readMetaFile(metaPath);

    if (meta && meta.partName === cleanPart) {
        let uploadedBytes = 0;
        for (const idx of meta.uploadedChunks || []) {
            if (meta.chunkSizes && typeof meta.chunkSizes[idx] === 'number') {
                uploadedBytes += meta.chunkSizes[idx];
            } else if (meta.totalSize > 0 && meta.chunkSize > 0) {
                const start = idx * meta.chunkSize;
                uploadedBytes += Math.max(0, Math.min(meta.chunkSize, meta.totalSize - start));
            }
        }
        if (uploadedBytes === 0 && stat.size > 0 && (meta.uploadedChunks?.length || 0) > 0) {
            uploadedBytes = stat.size;
        }
        return {
            found: true,
            uploadId: meta.uploadId,
            directory: normDir,
            fileName: meta.fileName,
            partName: cleanPart,
            totalSize: meta.totalSize || 0,
            chunkSize: meta.chunkSize || 10 * 1024 * 1024,
            totalChunks: meta.totalChunks || 0,
            uploadedChunks: meta.uploadedChunks || [],
            uploadedBytes,
            partFileSize: stat.size,
            headHash: meta.headHash,
        };
    }

    // Fallback if .part exists without meta.json
    const defaultChunkSize = 10 * 1024 * 1024;
    let headHash: string | undefined;
    if (stat.size > 0) {
        const readLen = Math.min(HEAD_HASH_BYTES, stat.size);
        const buf = Buffer.allocUnsafe(readLen);
        const fd = fs.openSync(destPart, 'r');
        try {
            fs.readSync(fd, buf, 0, readLen, 0);
            headHash = crypto.createHash('sha256').update(buf).digest('hex');
        } finally {
            fs.closeSync(fd);
        }
    }
    const fullChunks = Math.floor(stat.size / defaultChunkSize);
    const uploadedChunks = Array.from({ length: fullChunks }, (_, i) => i);
    const uploadedBytes = fullChunks * defaultChunkSize;

    return {
        found: true,
        uploadId: `up_resume_${crypto.randomBytes(8).toString('hex')}`,
        directory: normDir,
        fileName,
        partName: cleanPart,
        totalSize: 0,
        chunkSize: defaultChunkSize,
        totalChunks: 0,
        uploadedChunks,
        uploadedBytes,
        partFileSize: stat.size,
        headHash,
    };
}

export async function assembleUploadedChunks(params: {
    serverUuid: string;
    uploadId: string;
    directory: string;
    fileName: string;
    totalChunks: number;
    expectedSize?: number;
}): Promise<{ destination: string; size: number }> {
    const { serverUuid, uploadId, directory, fileName, totalChunks, expectedSize } = params;
    const safeId = sanitizeUploadId(uploadId);
    if (!Number.isInteger(totalChunks) || totalChunks < 1) {
        throw new Error('Invalid totalChunks count');
    }

    const normDir = normalizePosixPath(directory || '/');
    const cleanName = path.posix.basename(fileName);
    const stagingDir = getUploadStagingDir(serverUuid, safeId);
    const dest = resolveUploadDestination(serverUuid, normDir, cleanName);
    const destPart = getPartFileDestination(serverUuid, normDir, cleanName);
    const metaPath = getUploadMetaPath(serverUuid, normDir, cleanName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    // Fast path: assemble directly by promoting the active .part file when all chunks were recorded in it
    const meta = readMetaFile(metaPath);
    if (meta && meta.uploadId === safeId && fs.existsSync(destPart)) {
        const doneSet = new Set(meta.uploadedChunks || []);
        let allPresent = true;
        for (let i = 0; i < totalChunks; i++) {
            if (!doneSet.has(i)) {
                allPresent = false;
                break;
            }
        }
        if (!allPresent) {
            const missingIdx = Array.from({ length: totalChunks }, (_, i) => i).find((i) => !doneSet.has(i)) ?? 0;
            throw new Error(`Missing upload part ${missingIdx + 1} of ${totalChunks}`);
        }

        const stat = fs.statSync(destPart);
        if (expectedSize !== undefined && Number.isFinite(expectedSize) && expectedSize >= 0 && stat.size !== expectedSize) {
            throw new Error(`Assembled file size mismatch (expected ${expectedSize}, got ${stat.size})`);
        }

        try {
            fs.renameSync(destPart, dest);
        } catch {
            fs.copyFileSync(destPart, dest);
            fs.rmSync(destPart, { force: true });
        }
        fs.rmSync(metaPath, { force: true });
        fs.rmSync(stagingDir, { recursive: true, force: true });
        return { destination: dest, size: stat.size };
    }

    // Fallback path: assemble from staged part.N files
    for (let i = 0; i < totalChunks; i++) {
        const partPath = getChunkPartPath(stagingDir, i);
        if (!fs.existsSync(partPath)) {
            throw new Error(`Missing upload part ${i + 1} of ${totalChunks}`);
        }
    }

    const assembledTmp = `${dest}.uploading-${crypto.randomBytes(6).toString('hex')}`;
    let totalWritten = 0;

    try {
        const out = fs.createWriteStream(assembledTmp);
        for (let i = 0; i < totalChunks; i++) {
            const partPath = getChunkPartPath(stagingDir, i);
            await new Promise<void>((resolve, reject) => {
                const inp = fs.createReadStream(partPath);
                inp.on('data', (chunk) => {
                    totalWritten += chunk.length;
                });
                inp.on('error', reject);
                out.on('error', reject);
                inp.on('end', resolve);
                inp.pipe(out, { end: false });
            });
        }
        await new Promise<void>((resolve, reject) => {
            out.on('error', reject);
            out.end(resolve);
        });

        if (expectedSize !== undefined && Number.isFinite(expectedSize) && expectedSize >= 0 && totalWritten !== expectedSize) {
            throw new Error(`Assembled file size mismatch (expected ${expectedSize}, got ${totalWritten})`);
        }

        fs.renameSync(assembledTmp, dest);
        fs.rmSync(destPart, { force: true });
        fs.rmSync(metaPath, { force: true });
        fs.rmSync(stagingDir, { recursive: true, force: true });
        return { destination: dest, size: totalWritten };
    } catch (err) {
        fs.rmSync(assembledTmp, { force: true });
        throw err;
    }
}

export function cancelUploadAndCleanup(params: {
    serverUuid: string;
    uploadId: string;
    directory?: string;
    fileName?: string;
    deletePart?: boolean;
}): void {
    const { serverUuid, uploadId, directory, fileName, deletePart } = params;
    const safeId = sanitizeUploadId(uploadId);
    const safeUuid = safeServerUuid(serverUuid);
    const stagingDir = getUploadStagingDir(safeUuid, safeId);
    fs.rmSync(stagingDir, { recursive: true, force: true });

    if (!deletePart) {
        return;
    }

    if (directory && fileName) {
        try {
            const normDir = normalizePosixPath(directory);
            const destPart = getPartFileDestination(safeUuid, normDir, fileName);
            const metaPath = getUploadMetaPath(safeUuid, normDir, fileName);
            fs.rmSync(destPart, { force: true });
            fs.rmSync(metaPath, { force: true });
        } catch {
            // best effort
        }
    }

    // Also clean any meta-*.json referencing this uploadId
    const serverTmpRoot = path.join(config.paths.storageDir, '.upload-tmp', safeUuid);
    if (!fs.existsSync(serverTmpRoot)) return;
    for (const entry of fs.readdirSync(serverTmpRoot)) {
        if (!entry.startsWith('meta-') || !entry.endsWith('.json')) continue;
        const metaPath = path.join(serverTmpRoot, entry);
        const meta = readMetaFile(metaPath);
        if (meta && meta.uploadId === safeId) {
            try {
                const destPart = getPartFileDestination(safeUuid, meta.directory, meta.fileName);
                fs.rmSync(destPart, { force: true });
            } catch {
                // ignore
            }
            fs.rmSync(metaPath, { force: true });
        }
    }
}

export function cleanupUploadMetaForPart(serverUuid: string, directory: string, partName: string): void {
    const cleanPart = path.posix.basename(partName || '');
    if (!cleanPart.endsWith('.part') || cleanPart.length <= 5) return;
    const fileName = cleanPart.slice(0, -5);
    try {
        const normDir = normalizePosixPath(directory || '/');
        const metaPath = getUploadMetaPath(serverUuid, normDir, fileName);
        const meta = readMetaFile(metaPath);
        if (meta?.uploadId) {
            const stagingDir = getUploadStagingDir(serverUuid, meta.uploadId);
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }
        fs.rmSync(metaPath, { force: true });
    } catch {
        // best effort
    }
}

export function cleanupStaleUploadStaging(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
    const root = path.join(config.paths.storageDir, '.upload-tmp');
    if (!fs.existsSync(root)) return;
    const now = Date.now();
    for (const serverDir of fs.readdirSync(root)) {
        if (serverDir === '_direct') continue;
        const serverPath = path.join(root, serverDir);
        try {
            if (!fs.statSync(serverPath).isDirectory()) continue;
            for (const entry of fs.readdirSync(serverPath)) {
                const fullPath = path.join(serverPath, entry);
                const st = fs.statSync(fullPath);
                if (now - st.mtimeMs > maxAgeMs) {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                }
            }
        } catch {
            // Best-effort cleanup
        }
    }
}
