import fs from 'node:fs';
import path from 'node:path';
import { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { getBackupArchivePath } from '../backups/backupManager';
import { config } from '../config/index';
import { resolveDownloadPath, resolveUploadDestination } from '../files/fileManager';
import { formatApiError } from '../middleware/auth';
import { logActivity } from '../services/activityService';

const router = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 256 * 1024 * 1024 },
});

interface DaemonFileClaims {
    server_uuid: string;
    user_id: number;
    file_path?: string;
    backup_uuid?: string;
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

router.post('/api/daemon/servers/:uuid/upload', upload.array('files', 25), async (req: Request, res: Response) => {
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'upload');
        const directory = String(req.query.directory || '/');
        const files = (req.files as Express.Multer.File[]) || [];

        if (files.length === 0) {
            res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'No files were uploaded.'));
            return;
        }

        const uploadedNames: string[] = [];
        for (const file of files) {
            const dest = resolveUploadDestination(claims.server_uuid, directory, file.originalname);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, file.buffer);
            uploadedNames.push(file.originalname);
        }

        await logActivity({
            event: 'server:file.upload',
            ip: req.ip,
            actorId: claims.user_id,
            properties: { directory, files: uploadedNames },
        });

        res.status(204).end();
    } catch (err) {
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', (err as Error).message));
    }
});

router.get('/api/daemon/servers/:uuid/download', async (req: Request, res: Response) => {
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'download');
        if (!claims.file_path) {
            throw new Error('Missing file path claim');
        }
        const resolved = resolveDownloadPath(claims.server_uuid, claims.file_path);
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'Cannot download a directory.'));
            return;
        }
        res.download(resolved, path.basename(resolved));
    } catch (err) {
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', (err as Error).message));
    }
});

router.get('/api/daemon/servers/:uuid/backup', async (req: Request, res: Response) => {
    try {
        const claims = verifyDaemonToken(req, req.params.uuid, 'backup');
        if (!claims.backup_uuid) {
            throw new Error('Missing backup UUID claim');
        }
        const archivePath = getBackupArchivePath(claims.server_uuid, claims.backup_uuid);
        if (!fs.existsSync(archivePath)) {
            res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup file not found.'));
            return;
        }
        res.download(archivePath, `${claims.backup_uuid}.tar.gz`);
    } catch (err) {
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', (err as Error).message));
    }
});

export default router;
