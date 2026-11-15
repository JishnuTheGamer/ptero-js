import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index';
import { logger } from '../utils/logger';
import { db } from './connection';

export async function runMigrations(): Promise<string[]> {
    await db.init();
    const driver = db.getDriver();
    const suffix = driver === 'mysql' ? '.sql' : '.sqlite.sql';

    const files = fs
        .readdirSync(config.paths.migrationsDir)
        .filter((f) => (driver === 'mysql' ? f.endsWith('.sql') && !f.endsWith('.sqlite.sql') : f.endsWith('.sqlite.sql')))
        .sort();

    // Ensure migrations table exists before checking executed migrations
    if (driver === 'mysql') {
        await db.execRaw(`
            CREATE TABLE IF NOT EXISTS \`migrations\` (
                \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                \`migration\` VARCHAR(255) NOT NULL UNIQUE,
                \`batch\` INT UNSIGNED NOT NULL DEFAULT 1,
                \`executed_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
    } else {
        await db.execRaw(`
            CREATE TABLE IF NOT EXISTS migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                migration TEXT NOT NULL UNIQUE,
                batch INTEGER NOT NULL DEFAULT 1,
                executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);
    }

    const existingRows = await db.query<{ migration: string }>('SELECT migration FROM migrations');
    const executed = new Set(existingRows.map((r) => r.migration));
    const maxBatchRow = await db.queryOne<{ max_batch: number | null }>('SELECT MAX(batch) AS max_batch FROM migrations');
    const nextBatch = (maxBatchRow?.max_batch || 0) + 1;

    const ran: string[] = [];
    for (const file of files) {
        const migrationName = file.replace(suffix, '');
        if (executed.has(migrationName)) {
            continue;
        }
        const sql = fs.readFileSync(path.join(config.paths.migrationsDir, file), 'utf8');
        logger.info('Executing database migration', { migration: migrationName, driver });
        await db.execRaw(sql);
        await db.execute('INSERT INTO migrations (migration, batch) VALUES (?, ?)', [migrationName, nextBatch]);
        ran.push(migrationName);
    }

    return ran;
}
