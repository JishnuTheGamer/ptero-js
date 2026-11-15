import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config/index';
import { db } from '../database/connection';
import { ensureCsrfCookie, formatApiError, getCookieOptions, sha256Hex } from '../middleware/auth';
import { logActivity } from '../services/activityService';
import { verifyTotpCode } from '../utils/totp';

const router = Router();

const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json(
            formatApiError(429, 'TooManyRequestsHttpException', 'Too many authentication attempts. Please wait a minute.')
        );
    },
});

function normalizeBcryptHash(hash: string): string {
    // Laravel stores bcrypt hashes as $2y$10$...; bcryptjs supports $2a$/$2b$
    if (hash.startsWith('$2y$')) {
        return '$2a$' + hash.slice(4);
    }
    return hash;
}

async function createSessionForUser(req: Request, res: Response, userId: number): Promise<void> {
    const sid = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
    const expiresSql = expires.toISOString().slice(0, 19).replace('T', ' ');
    await db.execute(
        'INSERT INTO sessions (id, user_id, ip_address, user_agent, payload, last_activity, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
            sid,
            userId,
            req.ip || null,
            (req.headers['user-agent'] || '').slice(0, 500),
            '{}',
            Math.floor(Date.now() / 1000),
            expiresSql,
        ]
    );
    res.cookie(config.sessionCookieName, sid, getCookieOptions(req, true, config.sessionTtlHours * 3600 * 1000));
}

// In-memory short-lived 2FA checkpoint tokens (5 minute TTL)
const checkpointTokens = new Map<string, { userId: number; expiresAt: number }>();

router.get('/sanctum/csrf-cookie', (req: Request, res: Response) => {
    ensureCsrfCookie(req, res, true);
    res.status(204).end();
});

router.post('/auth/login', authLimiter, async (req: Request, res: Response) => {
    const identifier = String(req.body?.user || req.body?.username || req.body?.email || '').trim();
    const password = String(req.body?.password || '');

    if (!identifier || !password) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'A username/email and password are required.'));
        return;
    }

    const user = await db.queryOne<any>('SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?', [
        identifier.toLowerCase(),
        identifier.toLowerCase(),
    ]);

    if (!user || !(await bcrypt.compare(password, normalizeBcryptHash(user.password)))) {
        await logActivity({
            event: 'auth:fail',
            ip: req.ip,
            properties: { identifier },
        });
        res.status(400).json(
            formatApiError(400, 'InvalidCredentialsException', 'These credentials do not match our records.')
        );
        return;
    }

    if (user.use_totp && user.totp_secret) {
        const token = crypto.randomBytes(24).toString('hex');
        checkpointTokens.set(token, { userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000 });
        res.json({
            data: {
                complete: false,
                confirmation_token: token,
            },
        });
        return;
    }

    await createSessionForUser(req, res, user.id);
    await logActivity({
        event: 'auth:success',
        ip: req.ip,
        actorId: user.id,
        subjectType: 'user',
        subjectId: user.id,
    });

    res.json({
        data: {
            complete: true,
            intended: '/',
        },
    });
});

router.post('/auth/login/checkpoint', authLimiter, async (req: Request, res: Response) => {
    const token = String(req.body?.confirmation_token || '');
    const authCode = String(req.body?.authentication_code || '').trim();
    const recoveryToken = String(req.body?.recovery_token || '').trim();

    const pending = checkpointTokens.get(token);
    if (!pending || pending.expiresAt < Date.now()) {
        checkpointTokens.delete(token);
        res.status(400).json(
            formatApiError(400, 'InvalidTwoFactorTokenException', 'The authentication token has expired. Please log in again.')
        );
        return;
    }

    const user = await db.queryOne<any>('SELECT * FROM users WHERE id = ?', [pending.userId]);
    if (!user) {
        res.status(400).json(formatApiError(400, 'InvalidCredentialsException', 'Account not found.'));
        return;
    }

    let valid = false;
    if (recoveryToken) {
        const rec = await db.queryOne<{ id: number; token: string }>(
            'SELECT id, token FROM user_recovery_tokens WHERE user_id = ?',
            [user.id]
        );
        const allRecs = await db.query<{ id: number; token: string }>(
            'SELECT id, token FROM user_recovery_tokens WHERE user_id = ?',
            [user.id]
        );
        const hashed = sha256Hex(recoveryToken);
        const matched = allRecs.find((r) => r.token === hashed || r.token === recoveryToken);
        if (matched) {
            valid = true;
            await db.execute('DELETE FROM user_recovery_tokens WHERE id = ?', [matched.id]);
        } else if (rec && rec.token === hashed) {
            valid = true;
        }
    } else if (authCode && user.totp_secret) {
        valid = verifyTotpCode(user.totp_secret, authCode, 1);
    }

    if (!valid) {
        res.status(400).json(
            formatApiError(400, 'TwoFactorAuthenticationTokenInvalid', 'The two-factor authentication token is invalid.')
        );
        return;
    }

    checkpointTokens.delete(token);
    await createSessionForUser(req, res, user.id);
    await db.execute('UPDATE users SET totp_authenticated_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    await logActivity({
        event: 'auth:checkpoint',
        ip: req.ip,
        actorId: user.id,
        subjectType: 'user',
        subjectId: user.id,
    });

    res.json({
        data: {
            complete: true,
            intended: '/',
        },
    });
});

router.post('/auth/password', authLimiter, async (req: Request, res: Response) => {
    const email = String(req.body?.email || '').trim();
    if (!email) {
        res.status(422).json(formatApiError(422, 'ValidationException', 'Email address is required.'));
        return;
    }

    const user = await db.queryOne<any>('SELECT id, email FROM users WHERE email = ?', [email]);
    if (user) {
        const rawToken = crypto.randomBytes(24).toString('hex');
        await db.execute('DELETE FROM password_resets WHERE email = ?', [user.email]);
        await db.execute('INSERT INTO password_resets (email, token) VALUES (?, ?)', [
            user.email,
            sha256Hex(rawToken),
        ]);
        await logActivity({
            event: 'auth:reset-password',
            ip: req.ip,
            actorId: user.id,
            subjectType: 'user',
            subjectId: user.id,
        });
    }

    res.json({
        status: 'We have e-mailed your password reset link!',
    });
});

router.post('/auth/password/reset', authLimiter, async (req: Request, res: Response) => {
    const email = String(req.body?.email || '').trim();
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    const passwordConfirmation = String(req.body?.password_confirmation || '');

    if (!email || !token || password.length < 8 || password !== passwordConfirmation) {
        res.status(422).json(
            formatApiError(422, 'ValidationException', 'Valid email, reset token, and matching password (min 8 chars) are required.')
        );
        return;
    }

    const resetRow = await db.queryOne<{ id: number; token: string }>(
        'SELECT id, token FROM password_resets WHERE email = ?',
        [email]
    );
    if (!resetRow || resetRow.token !== sha256Hex(token)) {
        res.status(400).json(formatApiError(400, 'InvalidTokenException', 'This password reset token is invalid.'));
        return;
    }

    const user = await db.queryOne<any>('SELECT id FROM users WHERE email = ?', [email]);
    if (!user) {
        res.status(400).json(formatApiError(400, 'NotFoundHttpException', 'User account not found.'));
        return;
    }

    const hash = await bcrypt.hash(password, 10);
    await db.execute('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);
    await db.execute('DELETE FROM password_resets WHERE email = ?', [email]);
    await createSessionForUser(req, res, user.id);

    res.json({
        redirect_to: '/',
        send_to_login: false,
    });
});

router.post('/auth/logout', async (req: Request, res: Response) => {
    const sid = req.cookies?.[config.sessionCookieName];
    if (sid) {
        await db.execute('DELETE FROM sessions WHERE id = ?', [sid]);
    }
    res.clearCookie(config.sessionCookieName, getCookieOptions(req, true));
    res.status(204).end();
});

export default router;
