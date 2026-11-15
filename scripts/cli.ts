import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../backend/src/database/connection';
import { backupDatabase, restoreDatabase } from '../backend/src/database/backup';
import { runMigrations } from '../backend/src/database/migrate';
import { runSeeders } from '../backend/src/database/seed';
import { discoverJavaRuntimes, installTemurinJava } from '../backend/src/minecraft/java';

async function main() {
    const [, , cmd, ...args] = process.argv;

    try {
        switch (cmd) {
            case 'migrate': {
                const ran = await runMigrations();
                console.log('Migrations complete:', ran.length ? ran.join(', ') : 'up to date');
                break;
            }
            case 'seed': {
                await runMigrations();
                await runSeeders();
                console.log('Database seeding complete.');
                break;
            }
            case 'db-backup': {
                const dest = await backupDatabase(args[0]);
                console.log('Database backup created:', dest);
                break;
            }
            case 'db-restore': {
                if (!args[0]) throw new Error('Usage: cli.ts db-restore <backup-file>');
                await restoreDatabase(args[0]);
                console.log('Database restored from:', args[0]);
                break;
            }
            case 'java-check': {
                const runtimes = await discoverJavaRuntimes();
                console.log(JSON.stringify(runtimes, null, 2));
                break;
            }
            case 'java-install': {
                const ver = Number(args[0] || 21) as 8 | 11 | 17 | 21 | 25;
                if (![8, 11, 17, 21, 25].includes(ver)) throw new Error('Supported Java versions: 8, 11, 17, 21, 25');
                const rt = await installTemurinJava(ver, (m) => console.log(m));
                console.log('Installed:', rt);
                break;
            }
            case 'create-admin': {
                const email = args[0] || 'admin@pterodactyl.local';
                const username = (args[1] || 'admin').toLowerCase();
                const password = args[2] || crypto.randomBytes(12).toString('base64url');
                await runMigrations();
                const hash = await bcrypt.hash(password, 10);
                const existing = await db.queryOne<{ id: number }>(
                    'SELECT id FROM users WHERE email = ? OR username = ?',
                    [email, username]
                );
                if (existing) {
                    await db.execute('UPDATE users SET password = ?, root_admin = 1 WHERE id = ?', [hash, existing.id]);
                    console.log(`Updated admin user ${username} (${email})`);
                } else {
                    await db.execute(
                        `INSERT INTO users (uuid, username, email, name_first, name_last, password, language, root_admin, gravatar)
                         VALUES (?, ?, ?, 'System', 'Administrator', ?, 'en', 1, 1)`,
                        [crypto.randomUUID(), username, email, hash]
                    );
                    console.log(`Created admin user ${username} (${email})`);
                }
                if (!args[2]) console.log(`Generated Password: ${password}`);
                break;
            }
            default:
                console.error(
                    'Usage: tsx scripts/cli.ts <migrate|seed|db-backup|db-restore|java-check|java-install|create-admin>'
                );
                process.exitCode = 1;
        }
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error('CLI Error:', err);
    process.exit(1);
});
