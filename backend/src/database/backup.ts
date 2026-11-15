import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index';
import { db } from './connection';

export async function backupDatabase(outputDir = path.join(config.paths.backupsDir, 'database')): Promise<string> {
    await db.init();
    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (db.getDriver() === 'sqlite') {
        const dest = path.join(outputDir, `pterodactyl-db-${stamp}.sqlite`);
        fs.copyFileSync(config.db.sqlitePath, dest);
        return dest;
    }

    const dest = path.join(outputDir, `pterodactyl-db-${stamp}.sql`);
    await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        const child = spawn(
            'mysqldump',
            [
                `--host=${config.db.host}`,
                `--port=${config.db.port}`,
                `--user=${config.db.username}`,
                '--single-transaction',
                '--routines',
                '--triggers',
                config.db.database,
            ],
            {
                env: {
                    ...process.env,
                    MYSQL_PWD: config.db.password,
                },
            }
        );
        child.stdout.pipe(out);
        let stderr = '';
        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            out.end();
            if (code === 0) resolve();
            else reject(new Error(`mysqldump failed (${code}): ${stderr}`));
        });
    });

    return dest;
}

export async function restoreDatabase(backupFilePath: string): Promise<void> {
    if (!fs.existsSync(backupFilePath)) {
        throw new Error(`Backup file not found: ${backupFilePath}`);
    }
    await db.init();

    if (db.getDriver() === 'sqlite') {
        await db.close();
        fs.copyFileSync(backupFilePath, config.db.sqlitePath);
        await db.init();
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const inp = fs.createReadStream(backupFilePath);
        const child = spawn(
            'mysql',
            [`--host=${config.db.host}`, `--port=${config.db.port}`, `--user=${config.db.username}`, config.db.database],
            {
                env: {
                    ...process.env,
                    MYSQL_PWD: config.db.password,
                },
            }
        );
        inp.pipe(child.stdin);
        let stderr = '';
        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`mysql restore failed (${code}): ${stderr}`));
        });
    });
}
