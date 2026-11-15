import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config/index';
import { db } from '../database/connection';
import { getUserServerPermissions, hasPermission } from '../auth/permissions';

export interface AuthUser {
    id: number;
    uuid: string;
    username: string;
    email: string;
    name_first: string;
    name_last: string;
    language: string;
    root_admin: number;
    use_totp: number;
    totp_secret: string | null;
    created_at: string;
    updated_at: string;
}

declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
            apiKeyId?: number;
            sessionId?: string;
            server?: any;
            serverPermissions?: string[];
        }
    }
}

export function sha256Hex(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
}

export function formatApiError(status: number, code: string, detail: string) {
    return {
        errors: [
            {
                code,
                status: String(status),
                detail,
            },
        ],
    };
}

export function getRequestHost(req: Request, fallbackPort = config.port): string {
    const xfHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    if (xfHost) return xfHost;
    const host = String(req.headers.host || '').split(',')[0].trim();
    return host || `localhost:${fallbackPort}`;
}

export function isHttpsRequest(req: Request): boolean {
    if (req.secure) return true;
    const xfProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    if (xfProto.split(',').some((p) => p.trim() === 'https')) return true;
    if (String(req.headers['x-forwarded-ssl'] || '').toLowerCase() === 'on') return true;
    const origin = String(req.headers.origin || '').toLowerCase();
    const referer = String(req.headers.referer || '').toLowerCase();
    if (origin.startsWith('https://') || referer.startsWith('https://')) return true;
    const rawHost = getRequestHost(req).toLowerCase().split(':')[0];
    if (rawHost.endsWith('.run.app') || rawHost.endsWith('.aistudio.google.com')) return true;
    return false;
}

export function getCookieOptions(req: Request, httpOnly: boolean, maxAge?: number) {
    const https = isHttpsRequest(req);
    return {
        httpOnly,
        sameSite: (https ? 'none' : 'lax') as 'none' | 'lax',
        secure: https,
        path: '/',
        ...(https ? ({ partitioned: true } as Record<string, unknown>) : {}),
        ...(maxAge !== undefined ? { maxAge } : {}),
    };
}

export function ensureCsrfCookie(req: Request, res: Response, forceSet = false): string {
    let token = req.cookies?.['XSRF-TOKEN'];
    if (!token || typeof token !== 'string' || token.length < 16) {
        token = crypto.randomBytes(24).toString('hex');
        forceSet = true;
    }
    if (forceSet || isHttpsRequest(req)) {
        res.cookie('XSRF-TOKEN', token, getCookieOptions(req, false));
    }
    return token;
}

export async function attachSessionUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
        // 1. Check Bearer API Key first (Client or Application API)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const rawToken = authHeader.slice(7).trim();
            if (rawToken.startsWith('ptlc_') || rawToken.startsWith('ptla_')) {
                const body = rawToken.slice(5);
                const identifier = body.slice(0, 16);
                const secret = body.slice(16);
                if (identifier && secret) {
                    const keyRow = await db.queryOne<any>('SELECT * FROM api_keys WHERE identifier = ?', [identifier]);
                    if (keyRow && keyRow.token === sha256Hex(secret)) {
                        if (!keyRow.expires_at || new Date(keyRow.expires_at) > new Date()) {
                            const user = await db.queryOne<AuthUser>('SELECT * FROM users WHERE id = ?', [keyRow.user_id]);
                            if (user) {
                                req.user = user;
                                req.apiKeyId = keyRow.id;
                                await db.execute('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [
                                    keyRow.id,
                                ]);
                                next();
                                return;
                            }
                        }
                    }
                }
            }
        }

        // 2. Check session cookie
        const sid = req.cookies?.[config.sessionCookieName];
        if (sid && typeof sid === 'string') {
            const session = await db.queryOne<{ id: string; user_id: number; expires_at: string }>(
                'SELECT id, user_id, expires_at FROM sessions WHERE id = ?',
                [sid]
            );
            const expStr = session?.expires_at
                ? session.expires_at.includes('T')
                    ? session.expires_at
                    : session.expires_at.replace(' ', 'T') + 'Z'
                : '';
            if (session && new Date(expStr).getTime() > Date.now()) {
                const user = await db.queryOne<AuthUser>('SELECT * FROM users WHERE id = ?', [session.user_id]);
                if (user) {
                    req.user = user;
                    req.sessionId = sid;
                    await db.execute('UPDATE sessions SET last_activity = ? WHERE id = ?', [
                        Math.floor(Date.now() / 1000),
                        sid,
                    ]);
                }
            }
        }
    } catch {
        // Ignore auth lookup errors and proceed unauthenticated
    }
    next();
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method)) {
        next();
        return;
    }
    // Bearer API tokens are exempt from cookie CSRF checks
    if (req.apiKeyId) {
        next();
        return;
    }
    // Signed daemon upload endpoints are authenticated via JWT query token
    if (req.path.startsWith('/api/daemon/')) {
        next();
        return;
    }

    const cookieToken = req.cookies?.['XSRF-TOKEN'];
    const headerToken =
        (req.headers['x-xsrf-token'] as string) ||
        (req.headers['x-csrf-token'] as string) ||
        (req.body?._token as string);

    if (!cookieToken || !headerToken) {
        const msg = !cookieToken
            ? 'Session/CSRF cookie was not sent by your browser. Reload the page or open the app URL in a new tab if cookies are blocked in the preview iframe.'
            : 'CSRF token mismatch. Please refresh the page and try again.';
        res.status(419).json(formatApiError(419, 'TokenMismatchException', msg));
        return;
    }

    try {
        const a = Buffer.from(cookieToken);
        const b = Buffer.from(decodeURIComponent(headerToken));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            res.status(419).json(formatApiError(419, 'TokenMismatchException', 'CSRF token mismatch.'));
            return;
        }
    } catch {
        res.status(419).json(formatApiError(419, 'TokenMismatchException', 'CSRF token mismatch.'));
        return;
    }

    next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
        if (req.originalUrl.startsWith('/api/') || req.xhr || req.headers.accept?.includes('application/json')) {
            res.status(401).json(formatApiError(401, 'AuthenticationException', 'Unauthenticated.'));
        } else {
            res.redirect('/auth/login');
        }
        return;
    }
    next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
        if (req.originalUrl.startsWith('/api/')) {
            res.status(401).json(formatApiError(401, 'AuthenticationException', 'Unauthenticated.'));
        } else {
            res.redirect('/auth/login');
        }
        return;
    }
    if (!req.user.root_admin) {
        if (req.originalUrl.startsWith('/api/')) {
            res.status(403).json(formatApiError(403, 'AccessDeniedHttpException', 'Administrator access required.'));
        } else {
            res.status(403).send('Forbidden: Administrator privileges required.');
        }
        return;
    }
    next();
}

export function requireServerAccess(requiredPermission?: string) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!req.user) {
            res.status(401).json(formatApiError(401, 'AuthenticationException', 'Unauthenticated.'));
            return;
        }

        const param = req.params.server;
        const server = await db.queryOne<any>(
            `SELECT s.*, n.name AS node_name, n.fqdn AS node_fqdn, n.daemonSFTP, n.maintenance_mode,
                    e.features AS egg_features, e.software_type, e.docker_images
             FROM servers s
             JOIN nodes n ON n.id = s.node_id
             JOIN eggs e ON e.id = s.egg_id
             WHERE s.uuid = ? OR s.uuidShort = ?`,
            [param, param]
        );

        if (!server) {
            res.status(404).json(formatApiError(404, 'NotFoundHttpException', 'Server could not be found.'));
            return;
        }

        const perms = await getUserServerPermissions(req.user, server);
        if (!perms || !hasPermission(perms, requiredPermission)) {
            res.status(403).json(
                formatApiError(403, 'AccessDeniedHttpException', 'You do not have permission to access this resource.')
            );
            return;
        }

        req.server = server;
        req.serverPermissions = perms;
        next();
    };
}
