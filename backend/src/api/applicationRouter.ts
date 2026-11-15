import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Request, Response, Router } from 'express';
import { db } from '../database/connection';
import { formatApiError, requireAdmin } from '../middleware/auth';
import { processManager } from '../processes/ServerProcessManager';
import { paginateList, toIso } from './transformers';

const router = Router();
router.use('/api/application', requireAdmin);

router.get('/api/application/users', async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page || 50)));
    const offset = (page - 1) * perPage;

    const totalRow = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM users');
    const rows = await db.query<any>('SELECT * FROM users ORDER BY id ASC LIMIT ? OFFSET ?', [perPage, offset]);

    const items = rows.map((u) => ({
        object: 'user',
        attributes: {
            id: u.id,
            external_id: u.external_id || null,
            uuid: u.uuid,
            username: u.username,
            email: u.email,
            first_name: u.name_first,
            last_name: u.name_last,
            language: u.language,
            root_admin: Boolean(u.root_admin),
            '2fa': Boolean(u.use_totp),
            created_at: toIso(u.created_at),
            updated_at: toIso(u.updated_at),
        },
    }));

    res.json(paginateList(items, totalRow?.cnt || 0, page, perPage));
});

router.post('/api/application/users', async (req: Request, res: Response) => {
    const { email, username, first_name, last_name, password, root_admin } = req.body || {};
    if (!email || !username || !first_name || !last_name) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'email, username, first_name, and last_name are required.'));
        return;
    }

    const hash = await bcrypt.hash(password || crypto.randomBytes(16).toString('hex'), 10);
    const uuid = crypto.randomUUID();
    const result = await db.execute(
        `INSERT INTO users (uuid, username, email, name_first, name_last, password, language, root_admin, gravatar)
         VALUES (?, ?, ?, ?, ?, ?, 'en', ?, 1)`,
        [uuid, String(username).toLowerCase(), email, first_name, last_name, hash, root_admin ? 1 : 0]
    );
    const u = await db.queryOne<any>('SELECT * FROM users WHERE id = ?', [result.insertId]);
    res.status(201).json({
        object: 'user',
        attributes: {
            id: u.id,
            uuid: u.uuid,
            username: u.username,
            email: u.email,
            first_name: u.name_first,
            last_name: u.name_last,
            root_admin: Boolean(u.root_admin),
            created_at: toIso(u.created_at),
        },
    });
});

router.get('/api/application/servers', async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page || 50)));
    const offset = (page - 1) * perPage;

    const totalRow = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM servers');
    const rows = await db.query<any>('SELECT * FROM servers ORDER BY id ASC LIMIT ? OFFSET ?', [perPage, offset]);

    const items = rows.map((s) => ({
        object: 'server',
        attributes: {
            id: s.id,
            external_id: s.external_id || null,
            uuid: s.uuid,
            identifier: s.uuidShort,
            name: s.name,
            description: s.description || '',
            suspended: s.status === 'suspended',
            limits: { memory: s.memory, swap: s.swap, disk: s.disk, io: s.io, cpu: s.cpu },
            feature_limits: { databases: s.database_limit, allocations: s.allocation_limit, backups: s.backup_limit },
            user: s.owner_id,
            node: s.node_id,
            allocation: s.allocation_id,
            nest: s.nest_id,
            egg: s.egg_id,
            created_at: toIso(s.created_at),
        },
    }));

    res.json(paginateList(items, totalRow?.cnt || 0, page, perPage));
});

router.get('/api/application/nodes', async (_req: Request, res: Response) => {
    const nodes = await db.query<any>('SELECT * FROM nodes WHERE id = 1');
    const items = nodes.map((n) => ({
        object: 'node',
        attributes: {
            id: n.id,
            uuid: n.uuid,
            public: Boolean(n.public),
            name: n.name,
            description: n.description,
            location_id: n.location_id,
            fqdn: n.fqdn,
            scheme: n.scheme,
            memory: n.memory,
            disk: n.disk,
            single_node_mode: true,
        },
    }));
    res.json(paginateList(items, items.length, 1, 50));
});

router.post('/api/application/nodes', (_req: Request, res: Response) => {
    res.status(403).json(
        formatApiError(403, 'SingleNodeModeException', 'Multiple nodes are disabled in Single-Node Mode.')
    );
});

router.post('/api/application/servers/:id/suspend', async (req: Request, res: Response) => {
    const server = await db.queryOne<any>('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    if (!server) {
        res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Server not found.'));
        return;
    }
    await processManager.stopServer(server.id, true);
    await db.execute("UPDATE servers SET status = 'suspended' WHERE id = ?", [server.id]);
    res.status(204).end();
});

router.post('/api/application/servers/:id/unsuspend', async (req: Request, res: Response) => {
    await db.execute('UPDATE servers SET status = NULL WHERE id = ?', [req.params.id]);
    res.status(204).end();
});

export default router;
