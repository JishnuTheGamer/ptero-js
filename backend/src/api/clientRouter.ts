import crypto from 'node:crypto';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import {
    createServerBackup,
    deleteServerBackup,
    resolveBackupArchivePath,
    restoreServerBackup,
    sanitizeBackupDownloadFilename,
} from '../backups/backupManager';
import { SYSTEM_PERMISSIONS } from '../auth/permissions';
import { config } from '../config/index';
import { db } from '../database/connection';
import * as fileManager from '../files/fileManager';
import { PathTraversalError } from '../files/pathSafety';
import { formatApiError, getRequestHost, isHttpsRequest, requireAuth, requireServerAccess, sha256Hex } from '../middleware/auth';
import { processManager } from '../processes/ServerProcessManager';
import { executeSchedule } from '../scheduler/schedulerEngine';
import { logActivity } from '../services/activityService';
import { getNextCronDate, validateCron } from '../utils/cron';
import { validateEggVariableValue } from '../utils/startup';
import { buildTotpUri, generateRecoveryTokens, generateTotpSecret, verifyTotpCode } from '../utils/totp';
import {
    paginateList,
    transformAccount,
    transformActivityLog,
    transformAllocation,
    transformApiKey,
    transformBackup,
    transformDatabase,
    transformEggVariable,
    transformFileObject,
    transformSchedule,
    transformServer,
    transformSshKey,
    transformSubuser,
    transformTask,
} from './transformers';

const router = Router();

router.use(requireAuth);

async function loadServerRelations(serverId: number, eggId: number) {
    const [allocations, variables] = await Promise.all([
        db.query<any>('SELECT * FROM allocations WHERE server_id = ? ORDER BY id ASC', [serverId]),
        db.query<any>(
            `SELECT ev.*, COALESCE(sv.variable_value, ev.default_value) AS server_value
             FROM egg_variables ev
             LEFT JOIN server_variables sv ON sv.variable_id = ev.id AND sv.server_id = ?
             WHERE ev.egg_id = ?
             ORDER BY ev.id ASC`,
            [serverId, eggId]
        ),
    ]);
    return { allocations, variables };
}

async function loadBatchServerRelations(servers: any[]): Promise<Map<number, { allocations: any[]; variables: any[] }>> {
    const result = new Map<number, { allocations: any[]; variables: any[] }>();
    if (servers.length === 0) return result;

    const serverIds = Array.from(new Set(servers.map((s) => Number(s.id))));
    const eggIds = Array.from(new Set(servers.map((s) => Number(s.egg_id))));
    const sPlaceholders = serverIds.map(() => '?').join(', ');
    const ePlaceholders = eggIds.map(() => '?').join(', ');

    const [allocRows, eggVarRows, serverVarRows] = await Promise.all([
        db.query<any>(`SELECT * FROM allocations WHERE server_id IN (${sPlaceholders}) ORDER BY id ASC`, serverIds),
        db.query<any>(`SELECT * FROM egg_variables WHERE egg_id IN (${ePlaceholders}) ORDER BY id ASC`, eggIds),
        db.query<any>(`SELECT * FROM server_variables WHERE server_id IN (${sPlaceholders})`, serverIds),
    ]);

    const allocsByServer = new Map<number, any[]>();
    for (const a of allocRows) {
        const sid = Number(a.server_id);
        const list = allocsByServer.get(sid) || [];
        list.push(a);
        allocsByServer.set(sid, list);
    }

    const varsByEgg = new Map<number, any[]>();
    for (const ev of eggVarRows) {
        const eid = Number(ev.egg_id);
        const list = varsByEgg.get(eid) || [];
        list.push(ev);
        varsByEgg.set(eid, list);
    }

    const overridesByServer = new Map<number, Map<number, string>>();
    for (const sv of serverVarRows) {
        const sid = Number(sv.server_id);
        let map = overridesByServer.get(sid);
        if (!map) {
            map = new Map<number, string>();
            overridesByServer.set(sid, map);
        }
        map.set(Number(sv.variable_id), sv.variable_value);
    }

    for (const s of servers) {
        const sid = Number(s.id);
        const eid = Number(s.egg_id);
        const eggVars = varsByEgg.get(eid) || [];
        const svMap = overridesByServer.get(sid);
        const variables = eggVars.map((ev) => ({
            ...ev,
            server_value: svMap && svMap.has(Number(ev.id)) ? svMap.get(Number(ev.id)) : ev.default_value,
        }));
        result.set(sid, {
            allocations: allocsByServer.get(sid) || [],
            variables,
        });
    }

    return result;
}

function buildBaseUrl(req: Request): string {
    const proto = isHttpsRequest(req) ? 'https' : 'http';
    return `${proto}://${getRequestHost(req)}`;
}

function buildWsBaseUrl(req: Request): string {
    const wsProto = isHttpsRequest(req) ? 'wss' : 'ws';
    return `${wsProto}://${getRequestHost(req)}`;
}

// =========================================================================
// Client Root: List Servers & Permissions
// =========================================================================

router.get('/', async (req: Request, res: Response) => {
    const user = req.user!;
    const type = String(req.query.type || '');
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page || 50)));
    const filterTerm = String((req.query.filter as any)?.['*'] || '').trim().toLowerCase();

    let rows: any[];
    if (user.root_admin && (type === 'admin' || type === 'admin-all')) {
        const sql =
            type === 'admin'
                ? `SELECT s.*, n.name AS node_name, n.fqdn AS node_fqdn, n.daemonSFTP, n.maintenance_mode, e.features AS egg_features
                   FROM servers s JOIN nodes n ON n.id = s.node_id JOIN eggs e ON e.id = s.egg_id
                   WHERE s.owner_id != ? ORDER BY s.id ASC`
                : `SELECT s.*, n.name AS node_name, n.fqdn AS node_fqdn, n.daemonSFTP, n.maintenance_mode, e.features AS egg_features
                   FROM servers s JOIN nodes n ON n.id = s.node_id JOIN eggs e ON e.id = s.egg_id
                   ORDER BY s.id ASC`;
        rows = await db.query<any>(sql, type === 'admin' ? [user.id] : []);
    } else {
        rows = await db.query<any>(
            `SELECT DISTINCT s.*, n.name AS node_name, n.fqdn AS node_fqdn, n.daemonSFTP, n.maintenance_mode, e.features AS egg_features
             FROM servers s
             JOIN nodes n ON n.id = s.node_id
             JOIN eggs e ON e.id = s.egg_id
             LEFT JOIN subusers sub ON sub.server_id = s.id AND sub.user_id = ?
             WHERE s.owner_id = ? OR sub.user_id = ?
             ORDER BY s.id ASC`,
            [user.id, user.id, user.id]
        );
    }

    if (filterTerm) {
        rows = rows.filter(
            (r) =>
                String(r.name || '').toLowerCase().includes(filterTerm) ||
                String(r.uuid || '').toLowerCase().includes(filterTerm) ||
                String(r.uuidShort || '').toLowerCase().includes(filterTerm)
        );
    }

    const total = rows.length;
    const paged = rows.slice((page - 1) * perPage, page * perPage);
    const relationsMap = await loadBatchServerRelations(paged);
    const transformed = paged.map((s) => {
        const rel = relationsMap.get(Number(s.id)) || { allocations: [], variables: [] };
        return transformServer(s, user.id, rel.allocations, rel.variables, true);
    });

    res.json(paginateList(transformed, total, page, perPage));
});

router.get('/permissions', (_req: Request, res: Response) => {
    res.json({
        object: 'system_permissions',
        attributes: {
            permissions: SYSTEM_PERMISSIONS,
        },
    });
});

// =========================================================================
// Account Management
// =========================================================================

router.get('/account', (req: Request, res: Response) => {
    res.json(transformAccount(req.user!));
});

router.get('/account/two-factor', async (req: Request, res: Response) => {
    const user = req.user!;
    const secret = generateTotpSecret();
    await db.execute('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, user.id]);
    const appNameSetting = await db.queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE `key` = 'settings:app:name'"
    );
    const issuer = appNameSetting?.value || config.appName;
    const imageUrl = buildTotpUri(issuer, user.email, secret);
    res.json({
        data: {
            image_url_data: imageUrl,
            secret,
        },
    });
});

router.post('/account/two-factor', async (req: Request, res: Response) => {
    const user = await db.queryOne<any>('SELECT * FROM users WHERE id = ?', [req.user!.id]);
    const code = String(req.body?.code || '').trim();
    const password = String(req.body?.password || '');

    if (!user?.totp_secret) {
        res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'Two-factor setup has not been initialized.'));
        return;
    }

    if (password) {
        const norm = user.password.startsWith('$2y$') ? '$2a$' + user.password.slice(4) : user.password;
        if (!(await bcrypt.compare(password, norm))) {
            res.status(400).json(formatApiError(400, 'InvalidPasswordProvidedException', 'The password provided was invalid.'));
            return;
        }
    }

    if (!verifyTotpCode(user.totp_secret, code, 1)) {
        res.status(400).json(formatApiError(400, 'TwoFactorAuthenticationTokenInvalid', 'The token provided is invalid.'));
        return;
    }

    const recoveryTokens = generateRecoveryTokens(8);
    await db.execute('DELETE FROM user_recovery_tokens WHERE user_id = ?', [user.id]);
    for (const t of recoveryTokens) {
        await db.execute('INSERT INTO user_recovery_tokens (user_id, token) VALUES (?, ?)', [user.id, sha256Hex(t)]);
    }
    await db.execute('UPDATE users SET use_totp = 1, totp_authenticated_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    await logActivity({ event: 'user:two-factor.enable', ip: req.ip, actorId: user.id, subjectType: 'user', subjectId: user.id });

    res.json({
        object: 'recovery_tokens',
        attributes: {
            tokens: recoveryTokens,
        },
    });
});

router.post('/account/two-factor/disable', async (req: Request, res: Response) => {
    const user = await db.queryOne<any>('SELECT * FROM users WHERE id = ?', [req.user!.id]);
    const password = String(req.body?.password || '');
    const norm = user.password.startsWith('$2y$') ? '$2a$' + user.password.slice(4) : user.password;
    if (!(await bcrypt.compare(password, norm))) {
        res.status(400).json(formatApiError(400, 'InvalidPasswordProvidedException', 'The password provided was invalid.'));
        return;
    }

    await db.execute('UPDATE users SET use_totp = 0, totp_secret = NULL WHERE id = ?', [user.id]);
    await db.execute('DELETE FROM user_recovery_tokens WHERE user_id = ?', [user.id]);
    await logActivity({ event: 'user:two-factor.disable', ip: req.ip, actorId: user.id, subjectType: 'user', subjectId: user.id });
    res.status(204).end();
});

router.put('/account/email', async (req: Request, res: Response) => {
    const user = await db.queryOne<any>('SELECT * FROM users WHERE id = ?', [req.user!.id]);
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');

    const norm = user.password.startsWith('$2y$') ? '$2a$' + user.password.slice(4) : user.password;
    if (!(await bcrypt.compare(password, norm))) {
        res.status(400).json(formatApiError(400, 'InvalidPasswordProvidedException', 'The password provided was invalid.'));
        return;
    }
    if (!email || !email.includes('@')) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'A valid email address is required.'));
        return;
    }

    const dup = await db.queryOne<{ id: number }>('SELECT id FROM users WHERE email = ? AND id != ?', [email, user.id]);
    if (dup) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'This email address is already in use.'));
        return;
    }

    await db.execute('UPDATE users SET email = ? WHERE id = ?', [email, user.id]);
    await logActivity({
        event: 'user:account.email-changed',
        ip: req.ip,
        actorId: user.id,
        properties: { old: user.email, new: email },
    });
    res.status(204).end();
});

router.put('/account/password', async (req: Request, res: Response) => {
    const user = await db.queryOne<any>('SELECT * FROM users WHERE id = ?', [req.user!.id]);
    const currentPassword = String(req.body?.current_password || '');
    const password = String(req.body?.password || '');
    const confirm = String(req.body?.password_confirmation || '');

    const norm = user.password.startsWith('$2y$') ? '$2a$' + user.password.slice(4) : user.password;
    if (!(await bcrypt.compare(currentPassword, norm))) {
        res.status(400).json(formatApiError(400, 'InvalidPasswordProvidedException', 'The current password is incorrect.'));
        return;
    }
    if (password.length < 8 || password !== confirm) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'New password must be at least 8 characters and match confirmation.'));
        return;
    }

    const hash = await bcrypt.hash(password, 10);
    await db.execute('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);
    await db.execute('DELETE FROM sessions WHERE user_id = ? AND id != ?', [user.id, req.sessionId || '']);
    await logActivity({ event: 'user:account.password-changed', ip: req.ip, actorId: user.id });
    res.status(204).end();
});

router.get('/account/activity', async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page || 25)));
    const offset = (page - 1) * perPage;

    const totalRow = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM activity_logs WHERE actor_id = ?', [
        req.user!.id,
    ]);
    const rows = await db.query<any>(
        'SELECT * FROM activity_logs WHERE actor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
        [req.user!.id, perPage, offset]
    );
    const items = rows.map((r) => transformActivityLog(r, req.user!, true));
    res.json(paginateList(items, totalRow?.cnt || 0, page, perPage));
});

router.get('/account/api-keys', async (req: Request, res: Response) => {
    const keys = await db.query<any>('SELECT * FROM api_keys WHERE user_id = ? AND key_type = 1 ORDER BY id DESC', [
        req.user!.id,
    ]);
    res.json({
        object: 'list',
        data: keys.map(transformApiKey),
    });
});

router.post('/account/api-keys', async (req: Request, res: Response) => {
    const description = String(req.body?.description || '').trim();
    const allowedIps = Array.isArray(req.body?.allowed_ips) ? req.body.allowed_ips : [];
    if (!description) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'A description is required.'));
        return;
    }

    const identifier = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(24).toString('hex');
    await db.execute(
        'INSERT INTO api_keys (user_id, key_type, identifier, token, allowed_ips, memo) VALUES (?, 1, ?, ?, ?, ?)',
        [req.user!.id, identifier, sha256Hex(secret), JSON.stringify(allowedIps), description]
    );
    const created = await db.queryOne<any>('SELECT * FROM api_keys WHERE identifier = ?', [identifier]);
    await logActivity({ event: 'user:api-key.create', ip: req.ip, actorId: req.user!.id, properties: { identifier } });

    res.json({
        ...transformApiKey(created),
        meta: {
            secret_token: `ptlc_${identifier}${secret}`,
        },
    });
});

router.delete('/account/api-keys/:identifier', async (req: Request, res: Response) => {
    await db.execute('DELETE FROM api_keys WHERE user_id = ? AND identifier = ?', [req.user!.id, req.params.identifier]);
    await logActivity({
        event: 'user:api-key.delete',
        ip: req.ip,
        actorId: req.user!.id,
        properties: { identifier: req.params.identifier },
    });
    res.status(204).end();
});

router.get('/account/ssh-keys', async (req: Request, res: Response) => {
    const rows = await db.query<any>('SELECT * FROM user_ssh_keys WHERE user_id = ? ORDER BY id DESC', [req.user!.id]);
    res.json({ object: 'list', data: rows.map(transformSshKey) });
});

router.post('/account/ssh-keys', async (req: Request, res: Response) => {
    const name = String(req.body?.name || '').trim();
    const publicKey = String(req.body?.public_key || '').trim();
    if (!name || !publicKey) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'Key name and public key are required.'));
        return;
    }
    const fingerprint = `SHA256:${crypto.createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '')}`;
    const result = await db.execute(
        'INSERT INTO user_ssh_keys (user_id, name, fingerprint, public_key) VALUES (?, ?, ?, ?)',
        [req.user!.id, name, fingerprint, publicKey]
    );
    const created = await db.queryOne<any>('SELECT * FROM user_ssh_keys WHERE id = ?', [result.insertId]);
    res.json(transformSshKey(created));
});

router.post('/account/ssh-keys/remove', async (req: Request, res: Response) => {
    const fingerprint = String(req.body?.fingerprint || '');
    await db.execute('DELETE FROM user_ssh_keys WHERE user_id = ? AND fingerprint = ?', [req.user!.id, fingerprint]);
    res.status(204).end();
});

// =========================================================================
// Single Server Operations (/api/client/servers/:server)
// =========================================================================

router.get('/servers/:server', requireServerAccess(), async (req: Request, res: Response) => {
    const server = req.server!;
    const { allocations, variables } = await loadServerRelations(server.id, server.egg_id);
    const canStartup = req.serverPermissions!.includes('*') || req.serverPermissions!.includes('startup.read');
    const transformed = transformServer(server, req.user!.id, allocations, variables, canStartup);

    res.json({
        ...transformed,
        meta: {
            is_server_owner: Number(server.owner_id) === Number(req.user!.id),
            user_permissions: req.serverPermissions!,
        },
    });
});

router.get('/servers/:server/websocket', requireServerAccess('websocket.connect'), async (req: Request, res: Response) => {
    const server = req.server!;
    if (server.status === 'suspended') {
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', 'Server is suspended.'));
        return;
    }

    const token = jwt.sign(
        {
            user_id: req.user!.id,
            server_uuid: server.uuid,
            permissions: req.serverPermissions!,
        },
        config.jwtSecret,
        { expiresIn: '15m' }
    );

    res.json({
        data: {
            token,
            socket: `${buildWsBaseUrl(req)}/ws/servers/${server.uuid}`,
        },
    });
});

router.get('/servers/:server/resources', requireServerAccess(), async (req: Request, res: Response) => {
    const server = req.server!;
    const stats = await processManager.getStats(server.id, server.uuid, server.memory);
    res.json({
        object: 'stats',
        attributes: {
            current_state: stats.state,
            is_suspended: server.status === 'suspended',
            resources: {
                memory_bytes: stats.memory_bytes,
                cpu_absolute: stats.cpu_absolute,
                disk_bytes: stats.disk_bytes,
                network_rx_bytes: stats.network.rx_bytes,
                network_tx_bytes: stats.network.tx_bytes,
                uptime: stats.uptime,
            },
        },
    });
});

router.get('/servers/:server/activity', requireServerAccess('activity.read'), async (req: Request, res: Response) => {
    const server = req.server!;
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page || 25)));
    const offset = (page - 1) * perPage;

    const totalRow = await db.queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM activity_logs WHERE subject_type = 'server' AND subject_id = ?",
        [server.id]
    );
    const rows = await db.query<any>(
        "SELECT * FROM activity_logs WHERE subject_type = 'server' AND subject_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        [server.id, perPage, offset]
    );

    const actorIds = Array.from(new Set(rows.map((r) => r.actor_id).filter((id): id is number => Boolean(id))));
    const actorMap = new Map<number, any>();
    if (actorIds.length > 0) {
        const placeholders = actorIds.map(() => '?').join(', ');
        const actors = await db.query<any>(`SELECT * FROM users WHERE id IN (${placeholders})`, actorIds);
        for (const a of actors) {
            actorMap.set(Number(a.id), a);
        }
    }

    const items = rows.map((r) => {
        const actor = r.actor_id ? actorMap.get(Number(r.actor_id)) || null : null;
        const viewerCanSeeIp = Boolean(req.user!.root_admin) || r.actor_id === req.user!.id;
        return transformActivityLog(r, actor, viewerCanSeeIp);
    });
    res.json(paginateList(items, totalRow?.cnt || 0, page, perPage));
});

router.post('/servers/:server/command', requireServerAccess('control.console'), async (req: Request, res: Response) => {
    const server = req.server!;
    const command = String(req.body?.command || '').trim();
    if (!command) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'A command must be provided.'));
        return;
    }
    try {
        processManager.sendCommand(server.uuid, command);
        await logActivity({
            event: 'server:console.command',
            ip: req.ip,
            actorId: req.user!.id,
            subjectType: 'server',
            subjectId: server.id,
            properties: { command },
        });
        res.status(204).end();
    } catch (err) {
        res.status(502).json(formatApiError(502, 'HttpException', (err as Error).message));
    }
});

router.post('/servers/:server/power', requireServerAccess(), async (req: Request, res: Response) => {
    const server = req.server!;
    const signal = String(req.body?.signal || '') as 'start' | 'stop' | 'restart' | 'kill';
    const permMap: Record<string, string> = {
        start: 'control.start',
        stop: 'control.stop',
        kill: 'control.stop',
        restart: 'control.restart',
    };
    const required = permMap[signal];
    if (!required) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'Invalid power signal.'));
        return;
    }
    if (!req.serverPermissions!.includes('*') && !req.serverPermissions!.includes(required)) {
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', 'Insufficient permission for power action.'));
        return;
    }
    try {
        await processManager.handlePowerAction(server.id, signal);
        await logActivity({
            event: `server:power.${signal}`,
            ip: req.ip,
            actorId: req.user!.id,
            subjectType: 'server',
            subjectId: server.id,
        });
        res.status(204).end();
    } catch (err) {
        res.status(400).json(formatApiError(400, 'DaemonConnectionException', (err as Error).message));
    }
});

// =========================================================================
// File Manager
// =========================================================================

function handleFileError(res: Response, err: unknown): void {
    if (err instanceof PathTraversalError) {
        res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', err.message));
        return;
    }
    res.status(400).json(formatApiError(400, 'FileOperationException', (err as Error).message));
}

router.get('/servers/:server/files/list', requireServerAccess('file.read'), async (req: Request, res: Response) => {
    try {
        const dir = String(req.query.directory || '/');
        const entries = await fileManager.listDirectoryAsync(req.server!.uuid, dir);
        res.json({ object: 'list', data: entries.map(transformFileObject) });
    } catch (err) {
        handleFileError(res, err);
    }
});

router.get('/servers/:server/files/contents', requireServerAccess('file.read-content'), (req: Request, res: Response) => {
    try {
        const file = String(req.query.file || '');
        const content = fileManager.getFileContents(req.server!.uuid, file);
        res.type('text/plain').send(content);
    } catch (err) {
        handleFileError(res, err);
    }
});

router.get('/servers/:server/files/download', requireServerAccess('file.read-content'), (req: Request, res: Response) => {
    try {
        const file = String(req.query.file || '');
        fileManager.resolveDownloadPath(req.server!.uuid, file);
        const token = jwt.sign(
            {
                server_uuid: req.server!.uuid,
                user_id: req.user!.id,
                file_path: file,
                purpose: 'download',
            },
            config.jwtSecret,
            { expiresIn: '5m' }
        );
        res.json({
            object: 'signed_url',
            attributes: {
                url: `${buildBaseUrl(req)}/api/daemon/servers/${req.server!.uuid}/download?token=${encodeURIComponent(token)}`,
            },
        });
    } catch (err) {
        handleFileError(res, err);
    }
});

router.get('/servers/:server/files/upload', requireServerAccess('file.create'), (req: Request, res: Response) => {
    const token = jwt.sign(
        {
            server_uuid: req.server!.uuid,
            user_id: req.user!.id,
            purpose: 'upload',
        },
        config.jwtSecret,
        { expiresIn: '6h' }
    );
    res.json({
        object: 'signed_url',
        attributes: {
            url: `${buildBaseUrl(req)}/api/daemon/servers/${req.server!.uuid}/upload?token=${encodeURIComponent(token)}`,
        },
    });
});

router.post('/servers/:server/files/write', requireServerAccess('file.update'), async (req: Request, res: Response) => {
    try {
        const file = String(req.query.file || '');
        const content = typeof req.body === 'string' ? req.body : String(req.body?.content ?? '');
        fileManager.writeFileContents(req.server!.uuid, file, content);
        processManager.invalidateDiskCache(req.server!.uuid);
        await logActivity({
            event: 'server:file.write',
            ip: req.ip,
            actorId: req.user!.id,
            subjectType: 'server',
            subjectId: req.server!.id,
            properties: { file },
        });
        res.status(204).end();
    } catch (err) {
        handleFileError(res, err);
    }
});

router.post('/servers/:server/files/create-folder', requireServerAccess('file.create'), async (req: Request, res: Response) => {
    try {
        const rootDir = String(req.body?.root || '/');
        const name = String(req.body?.name || '');
        fileManager.createDirectory(req.server!.uuid, rootDir, name);
        await logActivity({
            event: 'server:file.create-directory',
            ip: req.ip,
            actorId: req.user!.id,
            subjectType: 'server',
            subjectId: req.server!.id,
            properties: { directory: rootDir, name },
        });
        res.status(204).end();
    } catch (err) {
        handleFileError(res, err);
    }
});

router.put('/servers/:server/files/rename', requireServerAccess('file.update'), async (req: Request, res: Response) => {
    try {
        const rootDir = String(req.body?.root || '/');
        const files = Array.isArray(req.body?.files) ? req.body.files : [];
        fileManager.renameFiles(req.server!.uuid, rootDir, files);
        res.status(204).end();
    } catch (err) {
        handleFileError(res, err);
    }
});

router.post('/servers/:server/files/copy', requireServerAccess('file.create'), (req: Request, res: Response) => {
    try {
        const location = String(req.body?.location || '');
        fileManager.copyFile(req.server!.uuid, location);
        res.status(204).end();
    } catch (err) {
        handleFileError(res, err);
    }
});

router.post('/servers/:server/files/delete', requireServerAccess('file.delete'), async (req: Request, res: Response) => {
    try {
        const rootDir = String(req.body?.root || '/');
        const files = Array.isArray(req.body?.files) ? req.body.files : [];
        fileManager.deleteFiles(req.server!.uuid, rootDir, files);
        processManager.invalidateDiskCache(req.server!.uuid);
        await logActivity({
            event: 'server:file.delete',
            ip: req.ip,
            actorId: req.user!.id,
            subjectType: 'server',
            subjectId: req.server!.id,
            properties: { directory: rootDir, files },
        });
        res.status(204).end();
    } catch (err) {
        handleFileError(res, err);
    }
});

router.post('/servers/:server/files/chmod', requireServerAccess('file.update'), (req: Request, res: Response) => {
    try {
        const rootDir = String(req.body?.root || '/');
        const files = Array.isArray(req.body?.files) ? req.body.files : [];
        fileManager.chmodFiles(req.server!.uuid, rootDir, files);
        res.status(204).end();
    } catch (err) {
        handleFileError(res, err);
    }
});

router.post('/servers/:server/files/compress', requireServerAccess('file.archive'), async (req: Request, res: Response) => {
    try {
        const rootDir = String(req.body?.root || '/');
        const files = Array.isArray(req.body?.files) ? req.body.files : [];
        const entry = await fileManager.compressFiles(req.server!.uuid, rootDir, files);
        processManager.invalidateDiskCache(req.server!.uuid);
        res.json(transformFileObject(entry));
    } catch (err) {
        handleFileError(res, err);
    }
});

router.post('/servers/:server/files/decompress', requireServerAccess('file.archive'), async (req: Request, res: Response) => {
    try {
        const rootDir = String(req.body?.root || '/');
        const file = String(req.body?.file || '');
        await fileManager.decompressArchive(req.server!.uuid, rootDir, file);
        processManager.invalidateDiskCache(req.server!.uuid);
        res.status(204).end();
    } catch (err) {
        handleFileError(res, err);
    }
});

router.post('/servers/:server/files/pull', requireServerAccess('file.create'), async (req: Request, res: Response) => {
    try {
        const url = String(req.body?.url || '');
        const directory = String(req.body?.directory || '/');
        const filename = req.body?.filename ? String(req.body.filename) : undefined;
        await fileManager.pullRemoteFile(req.server!.uuid, directory, url, filename);
        processManager.invalidateDiskCache(req.server!.uuid);
        res.status(204).end();
    } catch (err) {
        handleFileError(res, err);
    }
});

// =========================================================================
// Backups
// =========================================================================

router.get('/servers/:server/backups', requireServerAccess('backup.read'), async (req: Request, res: Response) => {
    const server = req.server!;
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = 20;
    const rows = await db.query<any>('SELECT * FROM backups WHERE server_id = ? ORDER BY id DESC', [server.id]);
    const paged = rows.slice((page - 1) * perPage, page * perPage);
    res.json({
        ...paginateList(paged.map(transformBackup), rows.length, page, perPage),
        meta: {
            ...paginateList(paged.map(transformBackup), rows.length, page, perPage).meta,
            backup_count: rows.length,
        },
    });
});

router.post('/servers/:server/backups', requireServerAccess('backup.create'), async (req: Request, res: Response) => {
    const server = req.server!;
    const existing = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM backups WHERE server_id = ?', [
        server.id,
    ]);
    if (server.backup_limit > 0 && (existing?.cnt || 0) >= server.backup_limit) {
        res.status(400).json(formatApiError(400, 'TooManyBackupsException', 'Server backup limit reached.'));
        return;
    }

    const name = String(req.body?.name || `Backup at ${new Date().toISOString()}`).trim();
    const ignored = String(req.body?.ignored || '');
    const isLocked = Boolean(req.body?.is_locked);

    const backup = await createServerBackup({
        serverId: server.id,
        serverUuid: server.uuid,
        name,
        ignoredFiles: ignored,
        isLocked,
    });
    await logActivity({
        event: 'server:backup.start',
        ip: req.ip,
        actorId: req.user!.id,
        subjectType: 'server',
        subjectId: server.id,
        properties: { name },
    });
    res.json(transformBackup(backup));
});

router.get('/servers/:server/backups/:backup', requireServerAccess('backup.read'), async (req: Request, res: Response) => {
    const row = await db.queryOne<any>('SELECT * FROM backups WHERE server_id = ? AND uuid = ?', [
        req.server!.id,
        req.params.backup,
    ]);
    if (!row) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup not found.'));
        return;
    }
    res.json(transformBackup(row));
});

router.get('/servers/:server/backups/:backup/download', requireServerAccess('backup.download'), async (req: Request, res: Response) => {
    const row = await db.queryOne<any>('SELECT * FROM backups WHERE server_id = ? AND uuid = ?', [
        req.server!.id,
        req.params.backup,
    ]);
    if (!row) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup not found.'));
        return;
    }
    if (!row.is_successful) {
        res.status(400).json(formatApiError(400, 'BackupNotCompletedException', 'Backup has not completed successfully yet.'));
        return;
    }
    let archivePath: string;
    try {
        archivePath = resolveBackupArchivePath(req.server!.uuid, row.uuid);
    } catch {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup archive path is invalid.'));
        return;
    }
    if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup archive file not found on disk.'));
        return;
    }
    const downloadFilename = sanitizeBackupDownloadFilename(row.name, row.uuid);
    const token = jwt.sign(
        {
            server_uuid: req.server!.uuid,
            user_id: req.user!.id,
            backup_uuid: row.uuid,
            filename: downloadFilename,
            purpose: 'backup',
        },
        config.jwtSecret,
        { expiresIn: '15m' }
    );
    res.json({
        object: 'signed_url',
        attributes: {
            url: `${buildBaseUrl(req)}/api/daemon/servers/${req.server!.uuid}/backup?token=${encodeURIComponent(token)}`,
        },
    });
});

router.post('/servers/:server/backups/:backup/lock', requireServerAccess('backup.create'), async (req: Request, res: Response) => {
    const row = await db.queryOne<any>('SELECT * FROM backups WHERE server_id = ? AND uuid = ?', [
        req.server!.id,
        req.params.backup,
    ]);
    if (!row) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup not found.'));
        return;
    }
    const nextLock = row.is_locked ? 0 : 1;
    await db.execute('UPDATE backups SET is_locked = ? WHERE id = ?', [nextLock, row.id]);
    const updated = await db.queryOne<any>('SELECT * FROM backups WHERE id = ?', [row.id]);
    res.json(transformBackup(updated));
});

router.post('/servers/:server/backups/:backup/restore', requireServerAccess('backup.restore'), async (req: Request, res: Response) => {
    const row = await db.queryOne<any>('SELECT * FROM backups WHERE server_id = ? AND uuid = ?', [
        req.server!.id,
        req.params.backup,
    ]);
    if (!row) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup not found.'));
        return;
    }
    try {
        await restoreServerBackup({
            serverId: req.server!.id,
            serverUuid: req.server!.uuid,
            backupUuid: row.uuid,
            truncate: Boolean(req.body?.truncate),
        });
        await logActivity({
            event: 'server:backup.restore-start',
            ip: req.ip,
            actorId: req.user!.id,
            subjectType: 'server',
            subjectId: req.server!.id,
            properties: { name: row.name },
        });
        res.status(204).end();
    } catch (err) {
        res.status(400).json(formatApiError(400, 'BackupRestoreException', (err as Error).message));
    }
});

router.delete('/servers/:server/backups/:backup', requireServerAccess('backup.delete'), async (req: Request, res: Response) => {
    const row = await db.queryOne<any>('SELECT * FROM backups WHERE server_id = ? AND uuid = ?', [
        req.server!.id,
        req.params.backup,
    ]);
    if (!row) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Backup not found.'));
        return;
    }
    if (row.is_locked) {
        res.status(400).json(formatApiError(400, 'BackupLockedException', 'Cannot delete a locked backup.'));
        return;
    }
    await deleteServerBackup(req.server!.uuid, row.uuid);
    await logActivity({
        event: 'server:backup.delete',
        ip: req.ip,
        actorId: req.user!.id,
        subjectType: 'server',
        subjectId: req.server!.id,
        properties: { name: row.name },
    });
    res.status(204).end();
});

// =========================================================================
// Schedules & Tasks
// =========================================================================

router.get('/servers/:server/schedules', requireServerAccess('schedule.read'), async (req: Request, res: Response) => {
    const rows = await db.query<any>('SELECT * FROM schedules WHERE server_id = ? ORDER BY id ASC', [req.server!.id]);
    const tasksBySchedule = new Map<number, any[]>();
    if (rows.length > 0) {
        const scheduleIds = rows.map((s) => Number(s.id));
        const placeholders = scheduleIds.map(() => '?').join(', ');
        const allTasks = await db.query<any>(
            `SELECT * FROM tasks WHERE schedule_id IN (${placeholders}) ORDER BY sequence_id ASC`,
            scheduleIds
        );
        for (const t of allTasks) {
            const sid = Number(t.schedule_id);
            const list = tasksBySchedule.get(sid) || [];
            list.push(t);
            tasksBySchedule.set(sid, list);
        }
    }
    const items = rows.map((s) => transformSchedule(s, tasksBySchedule.get(Number(s.id)) || []));
    res.json({ object: 'list', data: items });
});

router.post('/servers/:server/schedules', requireServerAccess('schedule.create'), async (req: Request, res: Response) => {
    const { name, minute, hour, day_of_month, month, day_of_week, is_active, only_when_online } = req.body || {};
    const cron = {
        minute: String(minute || '0'),
        hour: String(hour || '*'),
        dayOfMonth: String(day_of_month || '*'),
        month: String(month || '*'),
        dayOfWeek: String(day_of_week || '*'),
    };
    try {
        validateCron(cron);
    } catch (err) {
        res.status(422).json(formatApiError(422, 'ValidationException', (err as Error).message));
        return;
    }

    const nextDate = getNextCronDate(cron).toISOString().slice(0, 19).replace('T', ' ');
    const result = await db.execute(
        `INSERT INTO schedules (server_id, name, cron_day_of_week, cron_month, cron_day_of_month, cron_hour, cron_minute, is_active, only_when_online, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            req.server!.id,
            String(name || 'Scheduled Task'),
            cron.dayOfWeek,
            cron.month,
            cron.dayOfMonth,
            cron.hour,
            cron.minute,
            is_active === false ? 0 : 1,
            only_when_online ? 1 : 0,
            nextDate,
        ]
    );
    const created = await db.queryOne<any>('SELECT * FROM schedules WHERE id = ?', [result.insertId]);
    res.json(transformSchedule(created, []));
});

router.get('/servers/:server/schedules/:schedule', requireServerAccess('schedule.read'), async (req: Request, res: Response) => {
    const row = await db.queryOne<any>('SELECT * FROM schedules WHERE server_id = ? AND id = ?', [
        req.server!.id,
        req.params.schedule,
    ]);
    if (!row) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Schedule not found.'));
        return;
    }
    const tasks = await db.query<any>('SELECT * FROM tasks WHERE schedule_id = ? ORDER BY sequence_id ASC', [row.id]);
    res.json(transformSchedule(row, tasks));
});

router.post('/servers/:server/schedules/:schedule', requireServerAccess('schedule.update'), async (req: Request, res: Response) => {
    const existing = await db.queryOne<any>('SELECT * FROM schedules WHERE server_id = ? AND id = ?', [
        req.server!.id,
        req.params.schedule,
    ]);
    if (!existing) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Schedule not found.'));
        return;
    }
    const { name, minute, hour, day_of_month, month, day_of_week, is_active, only_when_online } = req.body || {};
    const cron = {
        minute: String(minute ?? existing.cron_minute),
        hour: String(hour ?? existing.cron_hour),
        dayOfMonth: String(day_of_month ?? existing.cron_day_of_month),
        month: String(month ?? existing.cron_month),
        dayOfWeek: String(day_of_week ?? existing.cron_day_of_week),
    };
    try {
        validateCron(cron);
    } catch (err) {
        res.status(422).json(formatApiError(422, 'ValidationException', (err as Error).message));
        return;
    }
    const nextDate = getNextCronDate(cron).toISOString().slice(0, 19).replace('T', ' ');
    await db.execute(
        `UPDATE schedules SET name = ?, cron_day_of_week = ?, cron_month = ?, cron_day_of_month = ?, cron_hour = ?, cron_minute = ?, is_active = ?, only_when_online = ?, next_run_at = ? WHERE id = ?`,
        [
            String(name ?? existing.name),
            cron.dayOfWeek,
            cron.month,
            cron.dayOfMonth,
            cron.hour,
            cron.minute,
            is_active === undefined ? existing.is_active : is_active ? 1 : 0,
            only_when_online === undefined ? existing.only_when_online : only_when_online ? 1 : 0,
            nextDate,
            existing.id,
        ]
    );
    const updated = await db.queryOne<any>('SELECT * FROM schedules WHERE id = ?', [existing.id]);
    const tasks = await db.query<any>('SELECT * FROM tasks WHERE schedule_id = ? ORDER BY sequence_id ASC', [existing.id]);
    res.json(transformSchedule(updated, tasks));
});

router.post('/servers/:server/schedules/:schedule/execute', requireServerAccess('schedule.update'), async (req: Request, res: Response) => {
    const existing = await db.queryOne<any>('SELECT * FROM schedules WHERE server_id = ? AND id = ?', [
        req.server!.id,
        req.params.schedule,
    ]);
    if (!existing) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Schedule not found.'));
        return;
    }
    executeSchedule(existing.id).catch(() => {});
    res.status(202).end();
});

router.delete('/servers/:server/schedules/:schedule', requireServerAccess('schedule.delete'), async (req: Request, res: Response) => {
    await db.execute('DELETE FROM schedules WHERE server_id = ? AND id = ?', [req.server!.id, req.params.schedule]);
    res.status(204).end();
});

router.post('/servers/:server/schedules/:schedule/tasks', requireServerAccess('schedule.update'), async (req: Request, res: Response) => {
    const schedule = await db.queryOne<any>('SELECT * FROM schedules WHERE server_id = ? AND id = ?', [
        req.server!.id,
        req.params.schedule,
    ]);
    if (!schedule) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Schedule not found.'));
        return;
    }
    const maxSeq = await db.queryOne<{ m: number | null }>('SELECT MAX(sequence_id) AS m FROM tasks WHERE schedule_id = ?', [
        schedule.id,
    ]);
    const seq = (maxSeq?.m || 0) + 1;
    const { action, payload, time_offset, continue_on_failure } = req.body || {};
    const resIns = await db.execute(
        'INSERT INTO tasks (schedule_id, sequence_id, action, payload, time_offset, continue_on_failure) VALUES (?, ?, ?, ?, ?, ?)',
        [
            schedule.id,
            seq,
            String(action || 'command'),
            String(payload || ''),
            Math.max(0, Number(time_offset || 0)),
            continue_on_failure ? 1 : 0,
        ]
    );
    const created = await db.queryOne<any>('SELECT * FROM tasks WHERE id = ?', [resIns.insertId]);
    res.json(transformTask(created));
});

router.post('/servers/:server/schedules/:schedule/tasks/:task', requireServerAccess('schedule.update'), async (req: Request, res: Response) => {
    const task = await db.queryOne<any>(
        'SELECT t.* FROM tasks t JOIN schedules s ON s.id = t.schedule_id WHERE s.server_id = ? AND s.id = ? AND t.id = ?',
        [req.server!.id, req.params.schedule, req.params.task]
    );
    if (!task) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Task not found.'));
        return;
    }
    const { action, payload, time_offset, continue_on_failure } = req.body || {};
    await db.execute(
        'UPDATE tasks SET action = ?, payload = ?, time_offset = ?, continue_on_failure = ? WHERE id = ?',
        [
            String(action ?? task.action),
            String(payload ?? task.payload),
            time_offset === undefined ? task.time_offset : Math.max(0, Number(time_offset)),
            continue_on_failure === undefined ? task.continue_on_failure : continue_on_failure ? 1 : 0,
            task.id,
        ]
    );
    const updated = await db.queryOne<any>('SELECT * FROM tasks WHERE id = ?', [task.id]);
    res.json(transformTask(updated));
});

router.delete('/servers/:server/schedules/:schedule/tasks/:task', requireServerAccess('schedule.update'), async (req: Request, res: Response) => {
    await db.execute(
        'DELETE FROM tasks WHERE id = ? AND schedule_id IN (SELECT id FROM schedules WHERE server_id = ? AND id = ?)',
        [req.params.task, req.server!.id, req.params.schedule]
    );
    res.status(204).end();
});

// =========================================================================
// Network Allocations
// =========================================================================

router.get('/servers/:server/network/allocations', requireServerAccess('allocation.read'), async (req: Request, res: Response) => {
    const allocs = await db.query<any>('SELECT * FROM allocations WHERE server_id = ? ORDER BY id ASC', [req.server!.id]);
    res.json({
        object: 'list',
        data: allocs.map((a) => transformAllocation(a, req.server!.allocation_id)),
    });
});

router.post('/servers/:server/network/allocations', requireServerAccess('allocation.create'), async (req: Request, res: Response) => {
    const server = req.server!;
    const current = await db.query<any>('SELECT * FROM allocations WHERE server_id = ?', [server.id]);
    if (server.allocation_limit > 0 && current.length >= server.allocation_limit) {
        res.status(400).json(formatApiError(400, 'AllocationLimitException', 'Allocation limit reached.'));
        return;
    }
    const free = await db.queryOne<any>(
        'SELECT * FROM allocations WHERE node_id = ? AND server_id IS NULL ORDER BY port ASC LIMIT 1',
        [server.node_id]
    );
    if (!free) {
        res.status(400).json(formatApiError(400, 'NoAvailableAllocationsException', 'No free port allocations available on local node.'));
        return;
    }
    await db.execute('UPDATE allocations SET server_id = ? WHERE id = ?', [server.id, free.id]);
    const updated = await db.queryOne<any>('SELECT * FROM allocations WHERE id = ?', [free.id]);
    res.json(transformAllocation(updated, server.allocation_id));
});

router.post('/servers/:server/network/allocations/:allocation', requireServerAccess('allocation.update'), async (req: Request, res: Response) => {
    const alloc = await db.queryOne<any>('SELECT * FROM allocations WHERE id = ? AND server_id = ?', [
        req.params.allocation,
        req.server!.id,
    ]);
    if (!alloc) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Allocation not found.'));
        return;
    }
    await db.execute('UPDATE allocations SET notes = ? WHERE id = ?', [String(req.body?.notes || ''), alloc.id]);
    const updated = await db.queryOne<any>('SELECT * FROM allocations WHERE id = ?', [alloc.id]);
    res.json(transformAllocation(updated, req.server!.allocation_id));
});

router.post('/servers/:server/network/allocations/:allocation/primary', requireServerAccess('allocation.update'), async (req: Request, res: Response) => {
    const alloc = await db.queryOne<any>('SELECT * FROM allocations WHERE id = ? AND server_id = ?', [
        req.params.allocation,
        req.server!.id,
    ]);
    if (!alloc) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Allocation not found.'));
        return;
    }
    await db.execute('UPDATE servers SET allocation_id = ? WHERE id = ?', [alloc.id, req.server!.id]);
    res.json(transformAllocation(alloc, alloc.id));
});

router.delete('/servers/:server/network/allocations/:allocation', requireServerAccess('allocation.delete'), async (req: Request, res: Response) => {
    if (Number(req.params.allocation) === Number(req.server!.allocation_id)) {
        res.status(400).json(formatApiError(400, 'CannotDeletePrimaryAllocation', 'Cannot delete the primary allocation.'));
        return;
    }
    await db.execute('UPDATE allocations SET server_id = NULL, notes = NULL WHERE id = ? AND server_id = ?', [
        req.params.allocation,
        req.server!.id,
    ]);
    res.status(204).end();
});

// =========================================================================
// Subusers
// =========================================================================

router.get('/servers/:server/users', requireServerAccess('user.read'), async (req: Request, res: Response) => {
    const subs = await db.query<any>('SELECT * FROM subusers WHERE server_id = ?', [req.server!.id]);
    const userMap = new Map<number, any>();
    if (subs.length > 0) {
        const userIds = Array.from(new Set(subs.map((s) => Number(s.user_id))));
        const placeholders = userIds.map(() => '?').join(', ');
        const users = await db.query<any>(`SELECT * FROM users WHERE id IN (${placeholders})`, userIds);
        for (const u of users) {
            userMap.set(Number(u.id), u);
        }
    }
    const items = subs.map((sub) => transformSubuser(sub, userMap.get(Number(sub.user_id)) || null));
    res.json({ object: 'list', data: items });
});

router.post('/servers/:server/users', requireServerAccess('user.create'), async (req: Request, res: Response) => {
    const email = String(req.body?.email || '').trim();
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    const targetUser = await db.queryOne<any>('SELECT * FROM users WHERE email = ?', [email]);
    if (!targetUser) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'No user with that email address was found.'));
        return;
    }
    if (targetUser.id === req.server!.owner_id) {
        res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'Cannot add the server owner as a subuser.'));
        return;
    }
    const existing = await db.queryOne<any>('SELECT * FROM subusers WHERE server_id = ? AND user_id = ?', [
        req.server!.id,
        targetUser.id,
    ]);
    if (existing) {
        res.status(400).json(formatApiError(400, 'ServerSubuserExistsException', 'User is already a subuser on this server.'));
        return;
    }
    const resIns = await db.execute('INSERT INTO subusers (user_id, server_id, permissions) VALUES (?, ?, ?)', [
        targetUser.id,
        req.server!.id,
        JSON.stringify(permissions),
    ]);
    const created = await db.queryOne<any>('SELECT * FROM subusers WHERE id = ?', [resIns.insertId]);
    res.json(transformSubuser(created, targetUser));
});

router.post('/servers/:server/users/:user', requireServerAccess('user.update'), async (req: Request, res: Response) => {
    const targetUser = await db.queryOne<any>('SELECT * FROM users WHERE uuid = ?', [req.params.user]);
    if (!targetUser) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'User not found.'));
        return;
    }
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    await db.execute('UPDATE subusers SET permissions = ? WHERE server_id = ? AND user_id = ?', [
        JSON.stringify(permissions),
        req.server!.id,
        targetUser.id,
    ]);
    const updated = await db.queryOne<any>('SELECT * FROM subusers WHERE server_id = ? AND user_id = ?', [
        req.server!.id,
        targetUser.id,
    ]);
    res.json(transformSubuser(updated, targetUser));
});

router.delete('/servers/:server/users/:user', requireServerAccess('user.delete'), async (req: Request, res: Response) => {
    const targetUser = await db.queryOne<any>('SELECT * FROM users WHERE uuid = ?', [req.params.user]);
    if (targetUser) {
        await db.execute('DELETE FROM subusers WHERE server_id = ? AND user_id = ?', [req.server!.id, targetUser.id]);
    }
    res.status(204).end();
});

// =========================================================================
// Databases
// =========================================================================

router.get('/servers/:server/databases', requireServerAccess('database.read'), async (req: Request, res: Response) => {
    const rows = await db.query<any>(
        `SELECT d.*, dh.host AS host_address, dh.port AS host_port
         FROM databases d JOIN database_hosts dh ON dh.id = d.database_host_id
         WHERE d.server_id = ?`,
        [req.server!.id]
    );
    const includePwd =
        req.serverPermissions!.includes('*') || req.serverPermissions!.includes('database.view_password');
    res.json({ object: 'list', data: rows.map((r) => transformDatabase(r, includePwd)) });
});

router.post('/servers/:server/databases', requireServerAccess('database.create'), async (req: Request, res: Response) => {
    const server = req.server!;
    const countRow = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM databases WHERE server_id = ?', [
        server.id,
    ]);
    if (server.database_limit > 0 && (countRow?.cnt || 0) >= server.database_limit) {
        res.status(400).json(formatApiError(400, 'DatabaseLimitException', 'Database limit reached.'));
        return;
    }
    const host = await db.queryOne<any>('SELECT * FROM database_hosts ORDER BY id ASC LIMIT 1');
    if (!host) {
        res.status(400).json(formatApiError(400, 'NoDatabaseHostException', 'No database host is configured in Admin -> Databases.'));
        return;
    }
    const dbName = `s${server.id}_${String(req.body?.database || 'db').replace(/[^a-zA-Z0-9_]/g, '')}`;
    const username = `u${server.id}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(12).toString('base64url');
    const remote = String(req.body?.remote || '%');

    const resIns = await db.execute(
        'INSERT INTO databases (server_id, database_host_id, `database`, username, remote, password) VALUES (?, ?, ?, ?, ?, ?)',
        [server.id, host.id, dbName, username, remote, password]
    );
    const created = await db.queryOne<any>(
        'SELECT d.*, dh.host AS host_address, dh.port AS host_port FROM databases d JOIN database_hosts dh ON dh.id = d.database_host_id WHERE d.id = ?',
        [resIns.insertId]
    );
    res.json(transformDatabase(created, true));
});

router.post('/servers/:server/databases/:database/rotate-password', requireServerAccess('database.update'), async (req: Request, res: Response) => {
    const newPwd = crypto.randomBytes(12).toString('base64url');
    await db.execute('UPDATE databases SET password = ? WHERE id = ? AND server_id = ?', [
        newPwd,
        req.params.database,
        req.server!.id,
    ]);
    const updated = await db.queryOne<any>(
        'SELECT d.*, dh.host AS host_address, dh.port AS host_port FROM databases d JOIN database_hosts dh ON dh.id = d.database_host_id WHERE d.id = ?',
        [req.params.database]
    );
    res.json(transformDatabase(updated, true));
});

router.delete('/servers/:server/databases/:database', requireServerAccess('database.delete'), async (req: Request, res: Response) => {
    await db.execute('DELETE FROM databases WHERE id = ? AND server_id = ?', [req.params.database, req.server!.id]);
    res.status(204).end();
});

// =========================================================================
// Startup & Settings
// =========================================================================

router.get('/servers/:server/startup', requireServerAccess('startup.read'), async (req: Request, res: Response) => {
    const server = req.server!;
    const { allocations, variables } = await loadServerRelations(server.id, server.egg_id);
    const transformed = transformServer(server, req.user!.id, allocations, variables, true);
    let dockerImages: Record<string, string> = {};
    try {
        dockerImages = JSON.parse(server.docker_images || '{}');
    } catch {
        dockerImages = {};
    }

    res.json({
        object: 'list',
        data: variables.filter((v) => Boolean(v.user_viewable)).map(transformEggVariable),
        meta: {
            startup_command: transformed.attributes.invocation,
            raw_startup_command: server.startup,
            docker_images: dockerImages,
        },
    });
});

router.put('/servers/:server/startup/variable', requireServerAccess('startup.update'), async (req: Request, res: Response) => {
    const server = req.server!;
    const key = String(req.body?.key || '');
    const value = String(req.body?.value ?? '');

    const eggVar = await db.queryOne<any>('SELECT * FROM egg_variables WHERE egg_id = ? AND env_variable = ?', [
        server.egg_id,
        key,
    ]);
    if (!eggVar || !eggVar.user_editable) {
        res.status(400).json(formatApiError(400, 'BadRequestHttpException', 'Variable does not exist or is not editable.'));
        return;
    }

    const validationError = validateEggVariableValue(value, eggVar.rules || '');
    if (validationError) {
        res.status(422).json(formatApiError(422, 'ValidationException', validationError));
        return;
    }

    const existing = await db.queryOne<any>(
        'SELECT id FROM server_variables WHERE server_id = ? AND variable_id = ?',
        [server.id, eggVar.id]
    );
    if (existing) {
        await db.execute('UPDATE server_variables SET variable_value = ? WHERE id = ?', [value, existing.id]);
    } else {
        await db.execute('INSERT INTO server_variables (server_id, variable_id, variable_value) VALUES (?, ?, ?)', [
            server.id,
            eggVar.id,
            value,
        ]);
    }

    const { allocations, variables } = await loadServerRelations(server.id, server.egg_id);
    const transformed = transformServer(server, req.user!.id, allocations, variables, true);

    res.json({
        ...transformEggVariable({ ...eggVar, server_value: value }),
        meta: {
            startup_command: transformed.attributes.invocation,
            raw_startup_command: server.startup,
        },
    });
});

router.post('/servers/:server/settings/rename', requireServerAccess('settings.rename'), async (req: Request, res: Response) => {
    const name = String(req.body?.name || '').trim();
    const description = req.body?.description !== undefined ? String(req.body.description) : req.server!.description;
    if (!name) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'Server name is required.'));
        return;
    }
    await db.execute('UPDATE servers SET name = ?, description = ? WHERE id = ?', [name, description, req.server!.id]);
    await logActivity({
        event: 'server:settings.rename',
        ip: req.ip,
        actorId: req.user!.id,
        subjectType: 'server',
        subjectId: req.server!.id,
        properties: { name },
    });
    res.status(204).end();
});

router.post('/servers/:server/settings/reinstall', requireServerAccess('settings.reinstall'), async (req: Request, res: Response) => {
    const server = req.server!;
    processManager.installServer(server.id).catch(() => {});
    await logActivity({
        event: 'server:settings.reinstall',
        ip: req.ip,
        actorId: req.user!.id,
        subjectType: 'server',
        subjectId: server.id,
    });
    res.status(204).end();
});

router.put('/servers/:server/settings/docker-image', requireServerAccess('startup.docker-image'), async (req: Request, res: Response) => {
    const dockerImage = String(req.body?.docker_image || '').trim();
    if (!dockerImage) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'Java/Runtime image is required.'));
        return;
    }
    await db.execute('UPDATE servers SET image = ? WHERE id = ?', [dockerImage, req.server!.id]);
    res.status(204).end();
});

export default router;
