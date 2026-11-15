import http from 'node:http';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import adminRouter from './backend/src/api/adminRouter';
import applicationRouter from './backend/src/api/applicationRouter';
import authRouter from './backend/src/api/authRouter';
import clientRouter from './backend/src/api/clientRouter';
import daemonRouter from './backend/src/api/daemonRouter';
import spaRouter from './backend/src/api/spaRouter';
import { config } from './backend/src/config/index';
import { db } from './backend/src/database/connection';
import { runMigrations } from './backend/src/database/migrate';
import { runSeeders } from './backend/src/database/seed';
import { attachSessionUser, csrfProtection } from './backend/src/middleware/auth';
import { processManager } from './backend/src/processes/ServerProcessManager';
import { startScheduler, stopScheduler } from './backend/src/scheduler/schedulerEngine';
import { logger } from './backend/src/utils/logger';
import { attachWebSocketServer } from './backend/src/websocket/wsServer';

async function bootstrap() {
    await db.init();
    await runMigrations();
    await runSeeders();

    const app = express();
    app.set('trust proxy', 1);
    app.set('view engine', 'ejs');
    app.set('views', config.paths.viewsDir);

    app.use(
        helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false,
            frameguard: false,
        })
    );

    app.use(cookieParser());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.text({ type: 'text/plain', limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Serve original Pterodactyl static assets (React webpack bundle, AdminLTE, favicons, vendor JS/CSS)
    app.use(
        express.static(config.paths.frontendPublicDir, {
            maxAge: '1h',
            index: false,
        })
    );

    app.get('/healthz', async (_req, res) => {
        try {
            await db.query('SELECT 1');
            res.json({ ok: true, mode: 'single-node', db: db.getDriver(), version: config.appVersion });
        } catch (err) {
            res.status(500).json({ ok: false, error: (err as Error).message });
        }
    });

    app.use(attachSessionUser);
    app.use(csrfProtection);

    app.use(authRouter);
    app.use('/api/client', clientRouter);
    app.use(applicationRouter);
    app.use(daemonRouter);
    app.use('/admin', adminRouter);
    app.use(spaRouter);

    const httpServer = http.createServer(app);
    attachWebSocketServer(httpServer);

    processManager.startMonitor();
    startScheduler();

    httpServer.listen(config.port, '0.0.0.0', () => {
        logger.info(`Pterodactyl Node.js Panel listening on http://0.0.0.0:${config.port}`, {
            db: db.getDriver(),
            singleNodeMode: config.singleNodeMode,
        });
    });

    const shutdown = async () => {
        logger.info('Graceful shutdown initiated...');
        stopScheduler();
        processManager.stopMonitor();
        await processManager.stopAllServers();
        httpServer.close();
        await db.close();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
    logger.error('Fatal startup error', { err: (err as Error).stack || String(err) });
    process.exit(1);
});
