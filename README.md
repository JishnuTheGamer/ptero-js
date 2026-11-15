# Pterodactyl Panel v1.15.2 — Node.js + Java Edition

A lightweight, single-process **Node.js + TypeScript + Java** edition of **Pterodactyl Panel v1.15.2**, crafted specifically for **non-systemd Linux systems**, **Docker / container VPS hosts**, and **lightweight low-spec servers** — while preserving the classic Pterodactyl v1.15.2 Client and Admin UI.

> **Official Credit**: Based on and preserves the UI & API conventions of **[Pterodactyl Panel v1.15.2](https://pterodactyl.io)** ([github.com/pterodactyl/panel](https://github.com/pterodactyl/panel)).
>
> **Made by Jishnu (JTG STUDIO 2026)**
> - **YouTube**: https://www.youtube.com/@JishnuTech69
> - **Discord**: https://discord.gg/VMFTDc3jDQ

---

## Why This Node.js Edition?

Standard Pterodactyl requires PHP, Composer, Nginx, Redis, MySQL, systemd, and Go Wings with nested Docker containers. This edition is built to run anywhere cleanly with minimal overhead:

- **Non-Systemd & Docker VPS Ready**: Runs as a single Node.js process (`npm run dev` / `npm start`) inside containers, LXC, or minimal VPS instances without requiring `systemd` or Docker-in-Docker.
- **Lightweight Resource Footprint**: Uses an integrated Express + WebSocket engine and direct `child_process.spawn` Java management instead of separate daemons and container layers.
- **Flexible Storage**: Supports MySQL 8+ / MariaDB 10.6+ for production, or built-in SQLite (`ALLOW_SQLITE_DEV_FALLBACK=true`) for ultra-lightweight single-file deployments.
- **Unlimited (`0`) Resource Mode**: Supports setting **Memory**, **Disk**, **CPU**, **Databases**, **Allocations**, or **Backups** to `0` for `Unlimited` — automatically omitting `-Xmx` on Java launch so Minecraft servers can use full available system RAM without exposing host VPS specs in the client panel.

---

## Architecture Overview

- **Preserved v1.15.2 Frontend**:
  - Client React SPA, Console, File Manager, Backups, Schedules, and Account views (`frontend/public/` + `frontend/locales/en/`).
  - AdminLTE v2 Control Panel (`backend/src/views/admin/` + `frontend/public/themes/pterodactyl/`).
- **Integrated Node.js Backend (`server.ts`, `backend/src/`)**:
  - **Express.js API**: Implements `/auth/*`, `/api/client/*`, `/api/application/*`, `/api/daemon/*`, and `/admin/*`.
  - **WebSocket Console (`ws`)**: Streams live server logs, command input, power controls, and CPU/RAM/Disk/Network stats at `/ws/servers/:uuid` (proxy/HTTPS `wss://` aware).
  - **Java Process Manager**: Spawns Minecraft servers safely using argument arrays, `/proc` utilization sampling, graceful stop, and crash auto-restart policies.
  - **Single-Node Mode**: Streamlined local node management without multi-node Wings overhead.

---

## Supported Minecraft Software & Java Runtimes

| Software | Upstream Source & Verification |
|----------|-------------------------------|
| **Paper** | `api.papermc.io` (SHA-256 verified) |
| **Purpur** | `api.purpurmc.org` (MD5 verified) |
| **Vanilla** | `piston-meta.mojang.com` (SHA-1 verified) |
| **Fabric** | `meta.fabricmc.net` |
| **Forge** | `files.minecraftforge.net` (`--installServer`) |
| **NeoForge** | `maven.neoforged.net` (`--installServer`) |
| **Spigot** | Built via official `BuildTools.jar` |
| **Folia** | `api.papermc.io` (SHA-256 verified) |

| Minecraft Version | Recommended Java |
|-------------------|------------------|
| 1.20.5 – 1.21+ | Java 21 / 25 |
| 1.18 – 1.20.4 | Java 17 |
| 1.17.x | Java 16+ |
| 1.8 – 1.16.5 | Java 8 / 11 |

---

## Quick Start (`ptero-js` Interactive Installer)

Recommended for **Docker VPS**, **non-systemd Linux**, and **lightweight VPS** hosts:

```bash
git clone https://github.com/JishnuTheGamer/ptero-js
cd ptero-js
bash install.sh
```

Running `bash install.sh` opens the **`ptero-js` Main Menu** with 4 options:

1. **Panel Install** — Checks and auto-installs **Node.js >= 22**, **Eclipse Temurin Java 21**, and **PM2**, configures lightweight **SQLite** (`.env`), prompts for **Port** (default `80`) and **Admin credentials** (with password confirmation), and starts the panel via **PM2**.
2. **Update Panel** — Checks `https://github.com/JishnuTheGamer/ptero-js` for newer versions/commits, backs up your database & `.env`, pulls updates, re-checks Node.js/Java/PM2, runs migrations, and restarts PM2.
3. **Create Admin User** — Creates or updates an Administrator account interactively.
4. **Uninstall** — Stops PM2 and completely removes `ptero-js` from the VPS.

### Non-Interactive / Manual Commands

```bash
bash install.sh status      # Check panel, Node.js, Java, and PM2 status
bash install.sh start       # Start panel under PM2
bash install.sh stop        # Stop PM2 process
bash install.sh restart     # Restart PM2 process
bash install.sh version     # Show installed version
```

For manual development without PM2:

```bash
npm install
cp .env.example .env
npx tsx scripts/cli.ts seed
npm run dev
```

---

## CLI Utilities

```bash
npx tsx scripts/cli.ts migrate
npx tsx scripts/cli.ts seed
npx tsx scripts/cli.ts db-backup
npx tsx scripts/cli.ts db-restore <path-to-sql>
npx tsx scripts/cli.ts java-check
npx tsx scripts/cli.ts java-install <8|17|21|25>
npx tsx scripts/cli.ts create-admin <email> <username> <password>
```

---

## Project Organization

```text
├── .jtgstudio/     # JTG Studio edition metadata
├── backend/        # Express APIs, SQL migrations, seeders, EJS Admin views, Java & WS engine
├── docs/           # Migration & testing guides (MIGRATION.md, TESTING.md)
├── frontend/       # Preserved Pterodactyl v1.15.2 SPA assets & AdminLTE themes
├── scripts/        # CLI utilities & optional systemd unit template
├── server.ts       # Main Express + WebSocket entry point
├── install.sh      # Automated Linux installer (with update.sh / uninstall.sh wrappers)
├── LICENSE         # MIT License with official Pterodactyl & Jishnu credits
└── README.md       # Project documentation
```

Additional guides:
- [Migration & Database Guide](docs/MIGRATION.md)
- [Testing & QA Checklist](docs/TESTING.md)

---

## Security

- Passwords hashed with `bcryptjs` (compatible with migrated Laravel `$2y$` hashes).
- Prepared/parameterized SQL queries throughout.
- Canonicalized file manager paths (`fs.realpathSync`) blocking symlink escapes and path traversal.
- Java servers spawned via argument arrays (`spawn(javaBin, args)`) without shell interpolation.
- Session CSRF protection (`XSRF-TOKEN`), authentication rate limiting, and JWT-scoped WebSocket/file tokens.

---

## License & Credits

- Released under the **[MIT License](LICENSE)**.
- Official **Pterodactyl Panel v1.15.2** credit: [https://pterodactyl.io](https://pterodactyl.io) (Copyright © 2015–2021 Dane Everitt and contributors).
- **Node.js + Java Edition** made by **Jishnu (JTG STUDIO 2026)** for non-systemd systems, Docker VPS environments, and lightweight specs:
  - YouTube: [https://www.youtube.com/@JishnuTech69](https://www.youtube.com/@JishnuTech69)
  - Discord: [https://discord.gg/VMFTDc3jDQ](https://discord.gg/VMFTDc3jDQ)

