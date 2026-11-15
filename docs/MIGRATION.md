# Migration Architecture & Database Guide (Pterodactyl v1.15.2 PHP/Wings -> Node.js/Java)

## 1. Component Mapping

| Original Pterodactyl v1.15.2 | Migrated Node.js + Java Implementation |
|---|---|
| PHP 8 / Laravel HTTP Kernel & Routing | Express.js (`server.ts`, `backend/src/api/*`) |
| Laravel Sanctum / Session + CSRF | Cookie Sessions + `ptlc_`/`ptla_` Bearer Tokens + `XSRF-TOKEN` (`backend/src/middleware/auth.ts`) |
| Wings Daemon (Go) HTTP & WebSocket | Integrated Node.js `ws` WebSocket Server (`backend/src/websocket/wsServer.ts`) & `/api/daemon/*` |
| Docker Container Runtime | Native Java Process Manager (`backend/src/processes/ServerProcessManager.ts`) & `backend/src/minecraft/*` |
| Blade AdminLTE Views (`resources/views/admin/*`) | Express EJS AdminLTE Views (`backend/src/views/admin/*`) preserving identical CSS/HTML |
| React Client SPA (`resources/scripts/*`) | Preserved unmodified v1.15.2 React bundle (`frontend/public/assets/*`) + `/locales/locale.json` |
| Laravel Eloquent / Artisan Migrations | `mysql2` Pool + SQL Migrations (`backend/migrations/001_initial_schema.sql`) |
| Laravel Scheduler (`schedule:run`) | Node.js Cron Scheduler (`backend/src/scheduler/schedulerEngine.ts`) |

## 2. Migrating Data from an Existing Laravel Pterodactyl Database

Existing Pterodactyl v1.15.2 MySQL/MariaDB tables (`users`, `api_keys`, `user_ssh_keys`, `user_recovery_tokens`, `locations`, `nests`, `eggs`, `egg_variables`, `servers`, `server_variables`, `allocations`, `subusers`, `backups`, `schedules`, `tasks`, `database_hosts`, `databases`, `activity_logs`, `settings`) match the column layout in `backend/migrations/001_initial_schema.sql`.

To migrate an existing panel safely without overwriting data:
1. Back up the existing MySQL database (`mysqldump pterodactyl > pterodactyl_legacy.sql`).
2. Import or point `.env` (`DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`) at a restored copy of the database.
3. Run `npx tsx scripts/cli.ts migrate` to add the `software_type`, `java_path`, and `restart_policy` compatibility columns if missing.
4. Existing bcrypt `$2y$` password hashes are automatically normalized and verified by `backend/src/api/authRouter.ts`.
5. Copy server worlds/files from `/var/lib/pterodactyl/volumes/<uuid>` into `./storage/servers/<uuid>`.
