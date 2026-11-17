import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { resolveBackupArchivePath } from '../backups/backupManager';
import { config } from '../config/index';
import {
    assembleUploadedChunks,
    cancelUploadAndCleanup,
    cleanupStaleUploadStaging,
    getUploadPartInfo,
    getUploadStagingDir,
    getUploadStatusForSession,
    recordChunkToPart,
    sanitizeUploadId,
} from '../files/chunkUpload';
import { resolveDownloadPath, resolveUploadDestination } from '../files/fileManager';
import { formatApiError } from '../middleware/auth';
import { processManager } from '../processes/ServerProcessManager';
import { logActivity } from '../services/activityService';

const router = Router();
const directTempDir = path.join(config.paths.storageDir, '.upload-tmp', '_direct');
fs.mkdirSync(directTempDir, { recursive: true });

const unlimitedMulterLimits = {
    fileSize: Infinity,
    fieldSize: 50 * 1024 * 1024,
    fields: 1000,
    files: 1000,
};

const directUpload = multer({
    limits: unlimitedMulterLimits,
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => {
            fs.mkdirSync(directTempDir, { recursive: true });
            cb(null, directTempDir);
        },
        filename: (_req, _file, cb) => {
            cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`);
        },
    }),
});

const chunkUpload = multer({
    limits: unlimitedMulterLimits,
    storage: multer.diskStorage({
        destination: (req, _file, cb) => {
            try {
                const claims = verifyDaemonToken(req, req.params.uuid, 'upload');
                const uploadId = String(req.query.uploadId || req.body?.uploadId || '');
                const stagingDir = getUploadStagingDir(claims.server_uuid, uploadId);
                fs.mkdirSync(stagingDir, { recursive: true });
                cb(null, stagingDir);
            } catch (err) {
                cb(err as Error, directTempDir);
            }
        },
        filename: (_req, _file, cb) => {
            cb(null, `incoming-${crypto.randomBytes(6).toString('hex')}.tmp`);
        },
    }),
});

interface DaemonFileClaims {
    server_uuid: string;
    user_id: number;
    file_path?: string;
    backup_uuid?: string;
    filename?: string;
    purpose: 'upload' | 'download' | 'backup';
}

function verifyDaemonToken(req: Request, expectedUuid: string, expectedPurpose: DaemonFileClaims['purpose']): DaemonFileClaims {
    const token = String(req.query.token || '');
    if (!token) {
        throw new Error('Missing signed token');
    }
    const claims = jwt.verify(token, config.jwtSecret) as DaemonFileClaims;
    if (claims.server_uuid !== expectedUuid || claims.purpose !== expectedPurpose) {
        throw new Error('Invalid token scope');
    }
    return claims;
}

router.post('/api/daemon/servers/:uuid/upload', (req, _res, next) => { req.setTimeout(0); next(); }, directUpload.array('files', 100), async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) || [];
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'upload');
        const directory = String(req.query.directory || '/');

        if (files.length === 0) {
            res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'No files were uploaded.'));
            return;
        }

        const uploadedNames: string[] = [];
        for (const file of files) {
            const dest = resolveUploadDestination(claims.server_uuid, directory, file.originalname);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            try {
                fs.renameSync(file.path, dest);
            } catch {
                fs.copyFileSync(file.path, dest);
                fs.rmSync(file.path, { force: true });
            }
            uploadedNames.push(file.originalname);
        }

        processManager.invalidateDiskCache(claims.server_uuid);

        await logActivity({
            event: 'server:file.upload',
            ip: req.ip,
            actorId: claims.user_id,
            properties: { directory, files: uploadedNames },
        });

        res.status(204).end();
    } catch (err) {
        for (const f of files) {
            if (f.path) fs.rmSync(f.path, { force: true });
        }
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', (err as Error).message));
    }
});

router.get('/api/daemon/servers/:uuid/upload/status', (req: Request, res: Response) => {
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'upload');
        const uploadId = sanitizeUploadId(req.query.uploadId);
        const totalChunks = req.query.totalChunks !== undefined ? Number(req.query.totalChunks) : undefined;
        const directory = req.query.directory ? String(req.query.directory) : undefined;
        const fileName = req.query.fileName ? String(req.query.fileName) : undefined;
        const uploadedChunks = getUploadStatusForSession({
            serverUuid: claims.server_uuid,
            uploadId,
            directory,
            fileName,
            totalChunks: Number.isInteger(totalChunks) ? totalChunks : undefined,
        });
        res.json({ ok: true, uploadId, uploadedChunks });
    } catch (err) {
        res.status(400).json(formatApiError(400, 'BadRequestHttpException', (err as Error).message));
    }
});

router.get('/api/daemon/servers/:uuid/upload/part-info', (req: Request, res: Response) => {
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'upload');
        const directory = String(req.query.directory || '/');
        const partName = String(req.query.partName || '');
        if (!partName) {
            throw new Error('Missing partName');
        }
        const info = getUploadPartInfo(claims.server_uuid, directory, partName);
        res.json({ ok: true, ...info });
    } catch (err) {
        res.status(400).json(formatApiError(400, 'BadRequestHttpException', (err as Error).message));
    }
});

router.post('/api/daemon/servers/:uuid/upload/chunk', (req, _res, next) => { req.setTimeout(0); next(); }, chunkUpload.single('chunk'), async (req: Request, res: Response) => {
    const file = req.file;
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'upload');
        const uploadId = sanitizeUploadId(req.query.uploadId || req.body?.uploadId);
        const chunkIndex = Number(req.query.chunkIndex ?? req.body?.chunkIndex);
        const totalChunks = Number(req.query.totalChunks ?? req.body?.totalChunks ?? 1);
        const chunkSize = Number(req.query.chunkSize ?? req.body?.chunkSize ?? 10 * 1024 * 1024);
        const totalSize = Number(req.query.totalSize ?? req.body?.totalSize ?? 0);
        const directory = String(req.query.directory || req.body?.directory || '/');
        const fileName = String(req.query.fileName || req.body?.fileName || '');

        if (!fileName) {
            throw new Error('Missing fileName');
        }
        resolveUploadDestination(claims.server_uuid, directory, fileName);

        if (!file) {
            throw new Error('Missing chunk payload');
        }

        const result = await recordChunkToPart({
            serverUuid: claims.server_uuid,
            uploadId,
            directory,
            fileName,
            chunkIndex,
            totalChunks,
            chunkSize,
            totalSize,
            incomingFilePath: file.path,
            receivedBytes: file.size,
        });

        res.json({
            ok: true,
            uploadId,
            chunkIndex: result.chunkIndex,
            receivedBytes: result.receivedBytes,
            partFileSize: result.partFileSize,
        });
    } catch (err) {
        if (file?.path) fs.rmSync(file.path, { force: true });
        res.status(400).json(formatApiError(400, 'BadRequestHttpException', (err as Error).message));
    }
});

router.post('/api/daemon/servers/:uuid/upload/complete', async (req: Request, res: Response) => {
    req.setTimeout(0);
    res.setTimeout(0);
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'upload');
        const uploadId = sanitizeUploadId(req.body?.uploadId || req.query.uploadId);
        const directory = String(req.body?.directory || req.query.directory || '/');
        const fileName = String(req.body?.fileName || req.query.fileName || '');
        const totalChunks = Number(req.body?.totalChunks ?? req.query.totalChunks);
        const totalSize = req.body?.totalSize !== undefined ? Number(req.body.totalSize) : undefined;

        if (!fileName) {
            throw new Error('Missing fileName');
        }

        await assembleUploadedChunks({
            serverUuid: claims.server_uuid,
            uploadId,
            directory,
            fileName,
            totalChunks,
            expectedSize: totalSize,
        });

        processManager.invalidateDiskCache(claims.server_uuid);
        cleanupStaleUploadStaging();

        await logActivity({
            event: 'server:file.upload',
            ip: req.ip,
            actorId: claims.user_id,
            properties: { directory, files: [fileName] },
        });

        res.status(204).end();
    } catch (err) {
        res.status(400).json(formatApiError(400, 'BadRequestHttpException', (err as Error).message));
    }
});

router.delete('/api/daemon/servers/:uuid/upload/chunk', (req: Request, res: Response) => {
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'upload');
        const uploadId = sanitizeUploadId(req.query.uploadId || req.body?.uploadId);
        const directory = req.query.directory ? String(req.query.directory) : undefined;
        const fileName = req.query.fileName ? String(req.query.fileName) : undefined;
        const deletePart = String(req.query.deletePart || req.body?.deletePart || '') === 'true';
        cancelUploadAndCleanup({
            serverUuid: claims.server_uuid,
            uploadId,
            directory,
            fileName,
            deletePart,
        });
        res.status(204).end();
    } catch (err) {
        res.status(400).json(formatApiError(400, 'BadRequestHttpException', (err as Error).message));
    }
});

function streamAttachment(
    req: Request,
    res: Response,
    filePath: string,
    downloadName: string,
    contentType?: string
): void {
    req.setTimeout(0);
    res.setTimeout(0);
    const stat = fs.statSync(filePath);
    const safeName = path.basename(downloadName).replace(/["\r\n]/g, '_');

    // For large files (>20 MiB) without a byte Range header, stream via chunked transfer
    // encoding so reverse proxies with 32 MiB non-streaming HTTP/1 limits do not buffer/reject.
    if (!req.headers.range && stat.size > 20 * 1024 * 1024) {
        res.status(200);
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        const stream = fs.createReadStream(filePath);
        stream.on('error', (err) => {
            if (!res.headersSent) {
                res.status(500).json(formatApiError(500, 'FileStreamException', err.message));
            } else {
                res.destroy(err);
            }
        });
        req.on('close', () => {
            if (!stream.destroyed) stream.destroy();
        });
        stream.pipe(res);
        return;
    }

    res.download(filePath, safeName, { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) {
            const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
            res.status(status).json(
                formatApiError(status, status === 404 ? 'NotFoundHttpException' : 'DownloadException', err.message)
            );
        }
    });
}

router.get('/api/daemon/servers/:uuid/download', async (req: Request, res: Response) => {
    let claims: DaemonFileClaims;
    try {
        claims = verifyDaemonToken(req, req.params.uuid, 'download');
    } catch (err) {
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', (err as Error).message));
        return;
    }

    try {
        if (!claims.file_path) {
            res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'Missing file path claim.'));
            return;
        }
        const resolved = resolveDownloadPath(claims.server_uuid, claims.file_path);
        if (!fs.existsSync(resolved)) {
            res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Requested file not found.'));
            return;
        }
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'Cannot download a directory.'));
            return;
        }
        streamAttachment(req, res, resolved, path.basename(resolved));
    } catch (err) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', (err as Error).message));
    }
});

router.get('/api/daemon/servers/:uuid/backup', async (req: Request, res: Response) => {
    let claims: DaemonFileClaims;
    try {
        claims = verifyDaemonToken(req, req.params.uuid, 'backup');
    } catch (err) {
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', (err as Error).message));
        return;
    }

    try {
        if (!claims.backup_uuid) {
            res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'Missing backup UUID claim.'));
            return;
        }
        const archivePath = resolveBackupArchivePath(claims.server_uuid, claims.backup_uuid);
        if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
            res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup file not found.'));
            return;
        }
        const downloadName = claims.filename || `${claims.backup_uuid}.tar.gz`;
        streamAttachment(req, res, archivePath, downloadName, 'application/gzip');
    } catch (err) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', (err as Error).message));
    }
});

export default router;
