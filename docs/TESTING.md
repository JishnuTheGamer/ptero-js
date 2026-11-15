# Testing & Quality Assurance Guide

## 1. Automated Unit Tests (`node:test`)

Run all unit tests with:

```bash
npx tsx --test backend/src/utils/*.test.ts backend/src/files/*.test.ts backend/src/minecraft/*.test.ts
```

Covered pure logic:
- RFC 6238 TOTP generation, verification window, Base32 encoding/decoding, recovery tokens (`totp.test.ts`).
- 5-field Cron expression validation, matching, and next-run calculation (`cron.test.ts`).
- Startup template rendering, safe argument tokenization (no shell injection), and egg variable validation (`startup.test.ts`).
- Path traversal and symlink escape protection (`pathSafety.test.ts`).
- Java version parsing (`1.8` -> `8`, `17`, `21`) and Minecraft-to-Java compatibility matrix (`java.test.ts`).

## 2. End-to-End Integration & Browser Verification Checklist

1. **Authentication**: Login via `/auth/login`, verify `window.PterodactylUser`, verify logout via `/auth/logout`, verify invalid credentials return 400.
2. **Admin Panel (`/admin`)**:
   - Verify Overview displays Node.js, DB driver, server/user/allocation counts, and Java runtimes.
   - Verify Single-Node Mode: `/admin/nodes/new` returns 403 and multi-node creation is absent from the sidebar.
   - Create a user in `/admin/users/new` and verify it persists.
   - Create a Minecraft server in `/admin/servers/new` (e.g. Paper) and verify it appears in `/` dashboard and `/admin/servers`.
3. **Client Server Console & Operations (`/server/:id`)**:
   - Open Console -> verify WebSocket connects (`auth success`) and streams live logs & stats.
   - Open File Manager -> create folder, create/edit file, save, compress/decompress, download.
   - Open Backups -> create backup, verify SHA-1 checksum & size, lock/unlock, delete.
   - Open Schedules -> create cron schedule and command/power task, execute schedule.
   - Open Network & Startup & Settings -> rename server, update startup variable.
4. **Installer (`install.sh`)**:
   - Syntax check: `bash -n install.sh update.sh uninstall.sh`
   - Command check: `bash install.sh version`
