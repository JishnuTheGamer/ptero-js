#!/usr/bin/env bash
set -euo pipefail

# Allow interactive shells or custom commands to bypass bootstrap
case "${1:-}" in
    bash|sh|/bin/bash|/bin/sh)
        exec "$@"
        ;;
esac

export PORT="${PORT:-80}"

mkdir -p \
    "${STORAGE_DIR:-/app/storage}" \
    "${SERVERS_DIR:-/app/storage/servers}" \
    "${BACKUPS_DIR:-/app/storage/backups}" \
    "${LOGS_DIR:-/app/storage/logs}" \
    "${JAVA_RUNTIME_DIR:-/app/runtime/java}"

TSX_BIN="./node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
    TSX_BIN="$(command -v tsx || true)"
fi
if [[ -z "$TSX_BIN" ]]; then
    echo "[ptero-js] ERROR: tsx runtime not found." >&2
    exit 1
fi

# Wait for MySQL/MariaDB if DB_CONNECTION=mysql is explicitly enabled
if [[ "${DB_CONNECTION:-sqlite}" == "mysql" && -n "${DB_HOST:-}" ]]; then
    db_port="${DB_PORT:-3306}"
    echo "[ptero-js] Waiting for MySQL at ${DB_HOST}:${db_port}..."
    for _ in $(seq 1 30); do
        if node -e "
            const net = require('node:net');
            const s = net.connect(Number(process.argv[2]), process.argv[1]);
            s.setTimeout(1500);
            s.on('connect', () => { s.destroy(); process.exit(0); });
            s.on('error', () => process.exit(1));
            s.on('timeout', () => { s.destroy(); process.exit(1); });
        " "$DB_HOST" "$db_port" 2>/dev/null; then
            echo "[ptero-js] MySQL connection reachable."
            break
        fi
        sleep 1
    done
fi

echo "[ptero-js] Running database migrations & seeders..."
"$TSX_BIN" scripts/cli.ts seed

echo "[ptero-js] Checking initial administrator account..."
"$TSX_BIN" scripts/cli.ts ensure-admin

echo "[ptero-js] Launching Pterodactyl Node.js Panel on port ${PORT}..."
exec "$@"
