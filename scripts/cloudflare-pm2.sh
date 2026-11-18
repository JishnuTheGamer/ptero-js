#!/usr/bin/env bash
set -Eeuo pipefail

# Cloudflare Tunnel + PM2 manager for Debian/Ubuntu.
# Manages Cloudflare without invoking systemctl.

APP_NAME="cloudflare"
INSTALL_DIR="/opt/cloudflare-pm2"
RUNNER="${INSTALL_DIR}/cloudflare-runner.sh"
CONFIG_DIR="/etc/cloudflared"
TOKEN_FILE="${CONFIG_DIR}/tunnel-token"
CRON_FILE="/etc/cron.d/cloudflare-pm2-resurrect"
BOOT_LOG="/var/log/cloudflare-pm2-boot.log"
PM2_BIN=""

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[36m%s\033[0m\n' "$*"; }

pause() {
    if [[ -t 0 ]]; then
        echo
        read -r -p "Press Enter to return to the menu..." _ || true
    fi
}

require_root() {
    if [[ ${EUID} -ne 0 ]]; then
        red "Please run this manager as root: sudo bash $0"
        return 1
    fi
}

find_pm2() {
    local candidate=""
    candidate="$(command -v pm2 2>/dev/null || true)"
    if [[ -z "$candidate" ]]; then
        for p in /usr/local/bin/pm2 /usr/bin/pm2 /opt/ptero-js/runtime/node/bin/pm2; do
            if [[ -x "$p" ]]; then
                candidate="$p"
                break
            fi
        done
    fi
    PM2_BIN="$candidate"
    [[ -n "$PM2_BIN" ]]
}

pm2_cmd() {
    local pm2_dir
    pm2_dir="$(dirname "$PM2_BIN")"
    PATH="${pm2_dir}:${PATH}" PM2_HOME="${PM2_HOME:-/root/.pm2}" "$PM2_BIN" "$@"
}

pm2_has_app() {
    local raw
    raw="$(pm2_cmd jlist 2>/dev/null || true)"
    printf '%s' "$raw" | grep -q "\"name\":\"${APP_NAME}\""
}

install_dependencies() {
    echo
    blue "[1/5] Installing prerequisite packages..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl gnupg procps cron

    blue "[2/5] Adding the official Cloudflare APT repository..."
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
        -o /usr/share/keyrings/cloudflare-main.gpg
    chmod 0644 /usr/share/keyrings/cloudflare-main.gpg
    printf '%s\n' \
        'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
        > /etc/apt/sources.list.d/cloudflared.list

    blue "[3/5] Installing Node.js if it is missing or older than 18..."
    export PATH="/usr/local/bin:/opt/ptero-js/runtime/node/bin:${PATH}"
    local node_major=0
    local need_node=0
    if command -v node >/dev/null 2>&1; then
        node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    else
        need_node=1
    fi
    if ! command -v npm >/dev/null 2>&1 || (( node_major < 18 )); then
        need_node=1
    fi
    if (( need_node == 1 )); then
        curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
        bash /tmp/nodesource_setup.sh
        rm -f /tmp/nodesource_setup.sh
        apt-get install -y nodejs
    fi

    blue "[4/5] Installing cloudflared and PM2..."
    apt-get update
    apt-get install -y cloudflared cron

    if ! command -v npm >/dev/null 2>&1; then
        red "npm was not found after installing Node.js."
        return 1
    fi
    if ! find_pm2; then
        npm install --global pm2
    fi

    if ! command -v cloudflared >/dev/null 2>&1; then
        red "cloudflared installation could not be verified."
        return 1
    fi
    if ! find_pm2; then
        red "PM2 installation could not be verified."
        return 1
    fi

    # --token-file keeps the secret out of the cloudflared process argument list.
    if ! cloudflared tunnel run --help 2>&1 | grep -q -- '--token-file'; then
        red "This cloudflared build does not support --token-file. Update cloudflared before continuing."
        cloudflared --version || true
        return 1
    fi

    blue "[5/5] Verifying installed runtimes..."
    green "Dependencies installed and checked."
    cloudflared --version
    pm2_cmd --version
}

read_and_validate_command() {
    local raw_command
    local -a args
    local token

    echo
    blue "Paste the COMPLETE command from Cloudflare."
    echo "Expected format: cloudflared tunnel run --token YOUR_TUNNEL_TOKEN"
    echo "Input is hidden so the token is not echoed on screen."
    read -r -s -p "Cloudflare command: " raw_command
    echo

    # Split into words only; never eval or execute the pasted text.
    read -r -a args <<< "$raw_command"
    unset raw_command

    # Also accept an optional leading sudo.
    if (( ${#args[@]} == 6 )) && [[ "${args[0]}" == "sudo" ]]; then
        args=("${args[@]:1}")
    fi

    if (( ${#args[@]} != 5 )) || \
       [[ "${args[0]}" != "cloudflared" ]] || \
       [[ "${args[1]}" != "tunnel" ]] || \
       [[ "${args[2]}" != "run" ]] || \
       [[ "${args[3]}" != "--token" ]]; then
        red "Command format is not valid. Nothing was saved or executed."
        echo "Use exactly: cloudflared tunnel run --token YOUR_TUNNEL_TOKEN"
        return 1
    fi

    token="${args[4]}"
    # Tolerate a trailing comma copied from sentence punctuation.
    token="${token%,}"
    unset args

    if (( ${#token} < 20 )) || [[ ! "$token" =~ ^[A-Za-z0-9._=-]+$ ]]; then
        red "The token does not look valid. Check that you copied the complete token."
        unset token
        return 1
    fi

    install -d -m 0700 "$CONFIG_DIR"
    umask 077
    printf '%s' "$token" > "${TOKEN_FILE}.tmp"
    chmod 0600 "${TOKEN_FILE}.tmp"
    mv -f "${TOKEN_FILE}.tmp" "$TOKEN_FILE"
    unset token

    green "Command structure and token format look valid."
    yellow "Cloudflare can confirm whether the token is genuine only when the tunnel connects."
}

write_runner_and_boot_hook() {
    local cloudflared_bin
    cloudflared_bin="$(command -v cloudflared 2>/dev/null || echo '/usr/bin/cloudflared')"
    local pm2_dir
    pm2_dir="$(dirname "$PM2_BIN")"

    install -d -m 0755 "$INSTALL_DIR"

    cat > "$RUNNER" <<RUNNER_EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec "${cloudflared_bin}" tunnel run --token-file "${TOKEN_FILE}"
RUNNER_EOF
    chmod 0755 "$RUNNER"

    # PM2 will restore its saved process list through cron's @reboot hook.
    # The distro's normal boot process must start cron; this script starts it now too.
    cat > "$CRON_FILE" <<EOF_CRON
SHELL=/bin/bash
PATH=${pm2_dir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
@reboot root /bin/bash -c 'sleep 15; export PM2_HOME=/root/.pm2; ${PM2_BIN} resurrect' >> ${BOOT_LOG} 2>&1
EOF_CRON
    chmod 0644 "$CRON_FILE"
    touch "$BOOT_LOG"

    if ! pgrep -x cron >/dev/null 2>&1; then
        if command -v cron >/dev/null 2>&1; then
            cron
        elif [[ -x /usr/sbin/cron ]]; then
            /usr/sbin/cron
        else
            yellow "Cron daemon was not found. Reboot auto-start cannot be enabled."
            return 1
        fi
    fi
}

verify_tunnel_connection() {
    local attempts=10
    local log_out=""
    echo
    blue "Checking Cloudflare tunnel connection in PM2 logs..."
    for _ in $(seq 1 "$attempts"); do
        log_out="$(pm2_cmd logs "$APP_NAME" --lines 40 --nostream 2>&1 || true)"
        if printf '%s' "$log_out" | grep -qiE 'Provided Tunnel token is not valid|Unauthorized|failed to parse|ERR.*token'; then
            red "Cloudflare rejected the tunnel token. Update your token and restart."
            return 1
        fi
        if printf '%s' "$log_out" | grep -qiE 'Registered tunnel connection|Connection .* registered'; then
            green "Cloudflare tunnel connected and registered successfully."
            return 0
        fi
        sleep 2
    done
    yellow "Tunnel started in PM2. Check logs if connection is still stabilizing (option 6)."
}

start_cloudflare() {
    if [[ ! -x "$RUNNER" || ! -s "$TOKEN_FILE" ]]; then
        yellow "Cloudflare runner or tunnel token is not configured yet."
        return 1
    fi
    if ! find_pm2; then
        red "PM2 is not installed. Run Install / Setup (option 1) first."
        return 1
    fi

    write_runner_and_boot_hook || true

    if pm2_has_app; then
        pm2_cmd restart "$APP_NAME" --update-env
    else
        pm2_cmd start "$RUNNER" --name "$APP_NAME" --interpreter bash
    fi
    pm2_cmd save
    green "Cloudflare PM2 process '${APP_NAME}' is running and saved."
    verify_tunnel_connection || true
}

stop_cloudflare() {
    if ! find_pm2; then
        red "PM2 is not installed."
        return 1
    fi
    if pm2_has_app; then
        pm2_cmd stop "$APP_NAME"
        pm2_cmd save
        green "Stopped PM2 process '${APP_NAME}'."
    else
        yellow "PM2 process '${APP_NAME}' is not registered."
    fi
}

restart_cloudflare() {
    if ! find_pm2; then
        red "PM2 is not installed."
        return 1
    fi
    if pm2_has_app; then
        pm2_cmd restart "$APP_NAME" --update-env
        pm2_cmd save
        green "Restarted PM2 process '${APP_NAME}'."
        verify_tunnel_connection || true
    else
        start_cloudflare
    fi
}

status_cloudflare() {
    echo
    blue "=== Cloudflare Tunnel + PM2 Status ==="
    if command -v cloudflared >/dev/null 2>&1; then
        echo "cloudflared : $(cloudflared --version 2>/dev/null | head -n1)"
    else
        echo "cloudflared : not installed"
    fi
    echo "Token file  : $( [[ -s "$TOKEN_FILE" ]] && echo "present (${TOKEN_FILE})" || echo "missing" )"
    echo "Runner      : $( [[ -x "$RUNNER" ]] && echo "present (${RUNNER})" || echo "missing" )"
    echo "Boot cron   : $( [[ -f "$CRON_FILE" ]] && echo "enabled (${CRON_FILE})" || echo "not configured" )"
    echo "Cron daemon : $( pgrep -x cron >/dev/null 2>&1 && echo "running" || echo "not running" )"
    echo
    if find_pm2; then
        if pm2_has_app; then
            pm2_cmd status "$APP_NAME"
        else
            yellow "PM2 process '${APP_NAME}' is not registered."
        fi
    else
        yellow "PM2 is not installed."
    fi
}

logs_cloudflare() {
    if ! find_pm2; then
        red "PM2 is not installed."
        return 1
    fi
    if ! pm2_has_app; then
        yellow "PM2 process '${APP_NAME}' is not registered."
        return 1
    fi
    pm2_cmd logs "$APP_NAME" --lines 60 --nostream
}

setup_cloudflare() {
    install_dependencies
    read_and_validate_command
    write_runner_and_boot_hook
    start_cloudflare
}

update_token_cloudflare() {
    if ! find_pm2 || ! command -v cloudflared >/dev/null 2>&1; then
        red "cloudflared or PM2 is not installed yet. Run option 1 first."
        return 1
    fi
    read_and_validate_command
    write_runner_and_boot_hook
    restart_cloudflare
}

uninstall_cloudflare() {
    echo
    yellow "This will remove ONLY the '${APP_NAME}' PM2 app, token file, runner, and boot cron hook."
    echo "Other PM2 applications (such as ptero-js) will NOT be touched."
    local confirm=""
    read -r -p "Continue uninstall? [y/N]: " confirm
    if [[ ! "${confirm,,}" =~ ^(y|yes)$ ]]; then
        yellow "Uninstall cancelled."
        return 0
    fi

    if find_pm2 && pm2_has_app; then
        pm2_cmd delete "$APP_NAME" || true
        pm2_cmd save --force >/dev/null 2>&1 || pm2_cmd save || true
    fi

    rm -rf "$INSTALL_DIR"
    rm -f "$TOKEN_FILE" "${TOKEN_FILE}.tmp"
    rmdir "$CONFIG_DIR" 2>/dev/null || true
    rm -f "$CRON_FILE" "$BOOT_LOG"

    green "Cloudflare Tunnel + PM2 configuration removed."
}

main_menu() {
    require_root
    local choice=""
    while true; do
        echo
        blue "================================================"
        blue "   Cloudflare Tunnel + PM2 Manager (No systemd)"
        blue "================================================"
        echo "  1) Install / Setup Cloudflare Tunnel"
        echo "  2) Start Cloudflare Tunnel"
        echo "  3) Stop Cloudflare Tunnel"
        echo "  4) Restart Cloudflare Tunnel"
        echo "  5) Status"
        echo "  6) View Logs"
        echo "  7) Update Tunnel Token"
        echo "  8) Uninstall Cloudflare Tunnel"
        echo "  0) Exit"
        echo
        read -r -p "Select an option [0-8]: " choice || break
        case "$choice" in
            1) setup_cloudflare || true; pause ;;
            2) start_cloudflare || true; pause ;;
            3) stop_cloudflare || true; pause ;;
            4) restart_cloudflare || true; pause ;;
            5) status_cloudflare || true; pause ;;
            6) logs_cloudflare || true; pause ;;
            7) update_token_cloudflare || true; pause ;;
            8) uninstall_cloudflare || true; pause ;;
            0) green "Exiting Cloudflare Tunnel manager."; exit 0 ;;
            *) red "Invalid choice. Select 0-8." ;;
        esac
    done
}

if [[ $# -eq 0 ]]; then
    main_menu
fi

require_root
case "${1:-}" in
    menu)      main_menu ;;
    install)   setup_cloudflare ;;
    start)     start_cloudflare ;;
    stop)      stop_cloudflare ;;
    restart)   restart_cloudflare ;;
    status)    status_cloudflare ;;
    logs)      logs_cloudflare ;;
    token)     update_token_cloudflare ;;
    uninstall) uninstall_cloudflare ;;
    *)
        echo "Usage: sudo bash $0 [menu|install|start|stop|restart|status|logs|token|uninstall]"
        exit 1
        ;;
esac
