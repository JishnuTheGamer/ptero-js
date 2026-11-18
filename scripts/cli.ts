import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../backend/src/database/connection';
import { backupDatabase, restoreDatabase } from '../backend/src/database/backup';
import { runMigrations } from '../backend/src/database/migrate';
import { runSeeders } from '../backend/src/database/seed';
import { discoverJavaRuntimes, installTemurinJava } from '../backend/src/minecraft/java';
import { resolveInitialAdminCredentials } from '../backend/src/utils/adminBootstrap';

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
                const email = args[0]?.trim();
                const username = args[1]?.trim().toLowerCase();
                const password = args[2];
                if (!email || !username || !password) {
                    throw new Error('Usage: cli.ts create-admin <email> <username> <password>');
                }
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
                break;
            }
            case 'ensure-admin': {
                await runMigrations();
                const countRow = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM users');
                if (countRow && Number(countRow.cnt) > 0) {
                    console.log(`Existing user accounts detected (${countRow.cnt}); skipping initial admin bootstrap.`);
                    break;
                }
                const creds = resolveInitialAdminCredentials(process.env);
                const hash = await bcrypt.hash(creds.password, 10);
                await db.execute(
                    `INSERT INTO users (uuid, username, email, name_first, name_last, password, language, root_admin, gravatar)
                     VALUES (?, ?, ?, 'System', 'Administrator', ?, 'en', 1, 1)`,
                    [crypto.randomUUID(), creds.username, creds.email, hash]
                );
                console.log('============================================================');
                console.log('  ptero-js FIRST-BOOT ADMIN ACCOUNT CREATED');
                console.log(`  Email    : ${creds.email}`);
                console.log(`  Username : ${creds.username}`);
                console.log(
                    `  Password : ${creds.password}${creds.generatedPassword ? '  (auto-generated)' : '  (from ADMIN_PASSWORD)'}`
                );
                console.log('  Tip: Change this password after logging in.');
                console.log('============================================================');
                break;
            }
            default:
                console.error(
                    'Usage: tsx scripts/cli.ts <migrate|seed|db-backup|db-restore|java-check|java-install|create-admin|ensure-admin>'
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
