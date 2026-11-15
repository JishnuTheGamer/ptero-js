import fs from 'node:fs';
import path from 'node:path';
import { Request, Response, Router } from 'express';
import { config } from '../config/index';
import { db } from '../database/connection';
import { ensureCsrfCookie } from '../middleware/auth';
import { toIso } from './transformers';

const router = Router();

let cachedMainBundle = '/assets/bundle.52ba5fa3.js';
try {
    const manifestPath = path.join(config.paths.frontendPublicDir, 'assets/manifest.json');
    if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest['main.js']?.src) {
            cachedMainBundle = manifest['main.js'].src;
        }
    }
} catch {
    // use default
}

router.get('/locales/locale.json', (req: Request, res: Response) => {
    const locales = String(req.query.locale || 'en')
        .split(/[\s,+]+/)
        .filter(Boolean);
    const namespaces = String(req.query.namespace || 'strings')
        .split(/[\s,+]+/)
        .filter(Boolean);

    const response: Record<string, Record<string, unknown>> = {};
    for (const loc of locales) {
        const safeLoc = path.basename(loc);
        response[loc] = {};
        for (const ns of namespaces) {
            const safeNs = ns.replace(/\.\./g, '').replace(/^\/+/, '');
            const filePath = path.join(config.paths.frontendLocalesDir, safeLoc, `${safeNs}.json`);
            if (fs.existsSync(filePath)) {
                try {
                    response[loc][ns] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                } catch {
                    response[loc][ns] = {};
                }
            } else {
                response[loc][ns] = {};
            }
        }
    }

    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.json(response);
});

async function renderSpa(req: Request, res: Response) {
    const csrfToken = ensureCsrfCookie(req, res);
    const isAuthRoute = req.path.startsWith('/auth');

    if (!req.user && !isAuthRoute) {
        res.redirect('/auth/login');
        return;
    }

    if (req.user && isAuthRoute && req.path !== '/auth/logout') {
        res.redirect('/');
        return;
    }

    const appNameSetting = await db.queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE `key` = 'settings:app:name'"
    );
    const localeSetting = await db.queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE `key` = 'settings:app:locale'"
    );

    const pterodactylUser = req.user
        ? {
              uuid: req.user.uuid,
              identifier: req.user.uuid,
              username: req.user.username,
              email: req.user.email,
              name_first: req.user.name_first,
              name_last: req.user.name_last,
              language: req.user.language || 'en',
              root_admin: Boolean(req.user.root_admin),
              use_totp: Boolean(req.user.use_totp),
              created_at: toIso(req.user.created_at),
              updated_at: toIso(req.user.updated_at),
          }
        : null;

    const siteConfiguration = {
        name: appNameSetting?.value || config.appName,
        locale: localeSetting?.value || 'en',
        recaptcha: {
            enabled: false,
            siteKey: '',
        },
    };

    res.render('wrapper', {
        csrfToken,
        pterodactylUser,
        siteConfiguration,
        isAuthRoute,
        bodyClass: isAuthRoute ? 'bg-neutral-900' : 'bg-neutral-800',
        mainBundleSrc: cachedMainBundle,
    });
}

router.get('/auth*', renderSpa);
router.get('/account*', renderSpa);
router.get('/server*', renderSpa);
router.get('/', renderSpa);

export default router;
