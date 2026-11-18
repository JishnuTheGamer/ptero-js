#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# ptero-js — Pterodactyl Panel v1.15.2 (Node.js + Java Edition)
# Made by Jishnu (JTG STUDIO 2026)
# GitHub: https://github.com/JishnuTheGamer/ptero-js
# ==============================================================================

GITHUB_REPO_URL="https://github.com/JishnuTheGamer/ptero-js"
GITHUB_GIT_URL="https://github.com/JishnuTheGamer/ptero-js.git"
GITHUB_RAW_BASE="https://raw.githubusercontent.com/JishnuTheGamer/ptero-js"

PANEL_VERSION="1.15.2"
PINNED_NODE_VERSION="22.20.0"
PM2_APP_NAME="ptero-js"
CF_PM2_APP_NAME="ptero-js-cloudflared"
LEGACY_SERVICE_NAME="pterodactyl-panel"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/ptero-js}"
SCRIPT_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${APP_DIR:-}" ]]; then
    APP_DIR="${APP_DIR%/}"
elif [[ -f "${SCRIPT_SOURCE_DIR}/package.json" && -f "${SCRIPT_SOURCE_DIR}/server.ts" ]]; then
    APP_DIR="${SCRIPT_SOURCE_DIR}"
else
    APP_DIR="/opt/ptero-js"
fi

# ------------------------------------------------------------------------------
# Bold, High-Contrast Terminal Styling
# ------------------------------------------------------------------------------
if [[ -t 1 && "${TERM:-dumb}" != "dumb" ]]; then
    C_RESET=$'\033[0m'
    C_BOLD=$'\033[1m'
    C_DIM=$'\033[2m'
    C_CYAN=$'\033[1;36m'
    C_BLUE=$'\033[1;34m'
    C_GREEN=$'\033[1;32m'
    C_YELLOW=$'\033[1;33m'
    C_RED=$'\033[1;31m'
    C_WHITE=$'\033[1;37m'
else
    C_RESET="" C_BOLD="" C_DIM="" C_CYAN="" C_BLUE="" C_GREEN="" C_YELLOW="" C_RED="" C_WHITE=""
fi

log()  { printf "%s[ptero-js]%s %s\n" "${C_CYAN}" "${C_RESET}" "$*"; }
ok()   { printf "%s[  OK  ]%s %s\n" "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf "%s[ WARN ]%s %s\n" "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
err()  { printf "%s[ERROR ]%s %s\n" "${C_RED}" "${C_RESET}" "$*" >&2; }
step() { printf "\n%s==> %s%s\n" "${C_BLUE}" "$*" "${C_RESET}"; }

pause_prompt() {
    if [[ -t 0 ]]; then
        printf "\n%sPress Enter to return to the ptero-js main menu...%s" "${C_DIM}" "${C_RESET}"
        read -r _
    fi
}

confirm_yes_no() {
    local prompt="$1"
    local default="${2:-y}"
    local answer=""
    local hint="[Y/n]"
    [[ "${default,,}" == "n" ]] && hint="[y/N]"
    read -r -p "${C_YELLOW}${prompt} ${hint}: ${C_RESET}" answer
    answer="${answer:-$default}"
    [[ "${answer,,}" =~ ^(y|yes)$ ]]
}

run_priv() {
    if [[ "$(id -u)" -eq 0 ]]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        "$@"
    fi
}

require_priv_notice() {
    if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
        err "Root privileges (or sudo) are required to install system packages or bind privileged ports."
        return 1
    fi
    return 0
}

# ------------------------------------------------------------------------------
# System & Dependency Detection Helpers
# ------------------------------------------------------------------------------
detect_os() {
    OS_ID="linux"
    PRETTY_NAME="Linux"
    if [[ -f /etc/os-release ]]; then
        # shellcheck source=/dev/null
        source /etc/os-release
        OS_ID="${ID:-linux}"
        PRETTY_NAME="${PRETTY_NAME:-$OS_ID}"
    fi
    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64|amd64) NODE_ARCH="x64"; JAVA_ARCH="x64" ;;
        aarch64|arm64) NODE_ARCH="arm64"; JAVA_ARCH="aarch64" ;;
        *)
            err "Unsupported CPU architecture: $ARCH"
            return 1
            ;;
    esac
    return 0
}

is_systemd_active() {
    [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1
}

find_node_bin() {
    local candidate=""
    if [[ -x "${APP_DIR}/runtime/node/bin/node" ]]; then
        candidate="${APP_DIR}/runtime/node/bin/node"
    elif command -v node >/dev/null 2>&1; then
        candidate="$(command -v node)"
    fi
    if [[ -n "$candidate" ]]; then
        local ver major
        ver="$("$candidate" -v 2>/dev/null || true)"
        major="$(printf '%s' "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
        if [[ "$major" =~ ^[0-9]+$ && "$major" -ge 22 ]]; then
            echo "$candidate"
            return 0
        fi
    fi
    return 1
}

find_java_bin() {
    local candidate=""
    for p in \
        "${APP_DIR}/runtime/java/temurin-21/bin/java" \
        "${APP_DIR}/runtime/java/temurin-25/bin/java" \
        "${APP_DIR}/runtime/java/temurin-17/bin/java" \
        "$(command -v java 2>/dev/null || true)"; do
        if [[ -n "$p" && -x "$p" ]]; then
            candidate="$p"
            break
        fi
    done
    if [[ -n "$candidate" ]]; then
        echo "$candidate"
        return 0
    fi
    return 1
}

find_pm2_bin() {
    if command -v pm2 >/dev/null 2>&1; then
        command -v pm2
        return 0
    fi
    if [[ -x "${APP_DIR}/runtime/node/bin/pm2" ]]; then
        echo "${APP_DIR}/runtime/node/bin/pm2"
        return 0
    fi
    return 1
}

find_tsx_bin() {
    if [[ -x "${APP_DIR}/node_modules/.bin/tsx" ]]; then
        echo "${APP_DIR}/node_modules/.bin/tsx"
        return 0
    fi
    if command -v tsx >/dev/null 2>&1; then
        command -v tsx
        return 0
    fi
    return 1
}

find_cloudflared_bin() {
    if [[ -x "${APP_DIR}/runtime/bin/cloudflared" ]]; then
        echo "${APP_DIR}/runtime/bin/cloudflared"
        return 0
    fi
    if command -v cloudflared >/dev/null 2>&1; then
        command -v cloudflared
        return 0
    fi
    return 1
}

export_runtime_path() {
    if [[ -d "${APP_DIR}/runtime/node/bin" ]]; then
        export PATH="${APP_DIR}/runtime/node/bin:${PATH}"
    fi
    if [[ -d "${APP_DIR}/runtime/bin" ]]; then
        export PATH="${APP_DIR}/runtime/bin:${PATH}"
    fi
    if [[ -d "${APP_DIR}/node_modules/.bin" ]]; then
        export PATH="${APP_DIR}/node_modules/.bin:${PATH}"
    fi
}

get_env_port() {
    local env_file="${APP_DIR}/.env"
    local p=""
    if [[ -f "$env_file" ]]; then
        p="$(grep -E '^PORT=' "$env_file" 2>/dev/null | head -n1 | cut -d= -f2 | tr -d '"' | tr -d "'" || true)"
    fi
    echo "${p:-80}"
}

get_local_version() {
    local ver="$PANEL_VERSION"
    if [[ -f "${APP_DIR}/package.json" ]]; then
        local pkg_ver
        pkg_ver="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "${APP_DIR}/package.json" | head -n1)"
        [[ -n "$pkg_ver" ]] && ver="$pkg_ver"
    fi
    echo "$ver"
}

get_pm2_status_label() {
    local app_name="${1:-$PM2_APP_NAME}"
    local pm2_bin
    pm2_bin="$(find_pm2_bin 2>/dev/null || true)"
    if [[ -z "$pm2_bin" ]]; then
        echo "not running"
        return 0
    fi
    local raw
    raw="$("$pm2_bin" jlist 2>/dev/null || true)"
    local node_bin=""
    node_bin="$(find_node_bin 2>/dev/null || command -v node 2>/dev/null || true)"
    if [[ -n "$node_bin" && -n "$raw" ]]; then
        "$node_bin" -e '
            const raw = process.argv[1] || "";
            const app = process.argv[2] || "";
            const idx = raw.indexOf("[");
            if (idx === -1) { console.log("not registered"); process.exit(0); }
            try {
                const list = JSON.parse(raw.slice(idx));
                const proc = Array.isArray(list) ? list.find((p) => p && p.name === app) : null;
                if (!proc) console.log("not registered");
                else if (proc.pm2_env && proc.pm2_env.status === "online") console.log("online");
                else console.log((proc.pm2_env && proc.pm2_env.status) || "stopped");
            } catch {
                console.log("not registered");
            }
        ' "$raw" "$app_name" 2>/dev/null && return 0
    fi
    if printf '%s' "$raw" | grep -q "\"name\":\"${app_name}\""; then
        if printf '%s' "$raw" | sed -E 's/\},\{"pid"/\n{"pid"/g' | grep -F "\"name\":\"${app_name}\"" | grep -q '"status":"online"'; then
            echo "online"
        else
            echo "stopped"
        fi
    else
        echo "not registered"
    fi
}

# ------------------------------------------------------------------------------
# VPS Requirement Provisioners (Auto-Check & Auto-Install)
# ------------------------------------------------------------------------------
install_system_packages() {
    local missing=()
    command -v curl >/dev/null 2>&1 || missing+=(curl)
    command -v tar >/dev/null 2>&1 || missing+=(tar)
    command -v unzip >/dev/null 2>&1 || missing+=(unzip)
    command -v openssl >/dev/null 2>&1 || missing+=(openssl)
    command -v git >/dev/null 2>&1 || missing+=(git)

    if [[ ${#missing[@]} -eq 0 ]]; then
        ok "Base OS tools present (curl, tar, unzip, openssl, git)."
        return 0
    fi

    log "Installing missing OS tools: ${missing[*]}..."
    require_priv_notice
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        run_priv apt-get update -qq
        run_priv apt-get install -y -qq curl ca-certificates tar xz-utils unzip openssl git procps
    elif command -v dnf >/dev/null 2>&1; then
        run_priv dnf install -y -q curl ca-certificates tar xz unzip openssl git procps-ng
    elif command -v yum >/dev/null 2>&1; then
        run_priv yum install -y -q curl ca-certificates tar xz unzip openssl git procps-ng
    elif command -v apk >/dev/null 2>&1; then
        run_priv apk add --no-cache bash curl ca-certificates tar xz unzip openssl git procps
    else
        err "Unsupported package manager. Please install: ${missing[*]}"
        return 1
    fi
    ok "Base OS tools installed."
}

ensure_node_runtime() {
    local existing_node=""
    existing_node="$(find_node_bin 2>/dev/null || true)"
    if [[ -n "$existing_node" ]]; then
        ok "Node.js requirement satisfied: $("$existing_node" -v) (${existing_node})"
        mkdir -p "${APP_DIR}/runtime/node/bin"
        if [[ "$existing_node" != "${APP_DIR}/runtime/node/bin/node" ]]; then
            ln -sf "$existing_node" "${APP_DIR}/runtime/node/bin/node"
            local npm_path
            npm_path="$(dirname "$existing_node")/npm"
            [[ -x "$npm_path" ]] && ln -sf "$npm_path" "${APP_DIR}/runtime/node/bin/npm"
        fi
        export_runtime_path
        return 0
    fi

    detect_os
    local target_dir="${APP_DIR}/runtime/node"
    local tarball="node-v${PINNED_NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    local url="https://nodejs.org/dist/v${PINNED_NODE_VERSION}/${tarball}"
    local tmp_tar="/tmp/${tarball}"

    log "Node.js >= 22 not found. Installing Node.js v${PINNED_NODE_VERSION} LTS..."
    curl -fsSL "$url" -o "$tmp_tar"
    mkdir -p "$target_dir"
    tar -xJf "$tmp_tar" -C "$target_dir" --strip-components=1
    rm -f "$tmp_tar"

    # Expose globally if /usr/local/bin is writable or sudo is available and system lacks node
    if ! command -v node >/dev/null 2>&1; then
        run_priv ln -sf "${target_dir}/bin/node" /usr/local/bin/node 2>/dev/null || true
        run_priv ln -sf "${target_dir}/bin/npm" /usr/local/bin/npm 2>/dev/null || true
        run_priv ln -sf "${target_dir}/bin/npx" /usr/local/bin/npx 2>/dev/null || true
    fi

    export_runtime_path
    ok "Installed Node.js $("${target_dir}/bin/node" -v) into ${target_dir}"
}

ensure_java_runtime() {
    local existing_java=""
    existing_java="$(find_java_bin 2>/dev/null || true)"
    if [[ -n "$existing_java" ]]; then
        local jver
        jver="$("$existing_java" -version 2>&1 | head -n1 || true)"
        ok "Java requirement satisfied: ${jver} (${existing_java})"
        return 0
    fi

    detect_os
    local java_root="${APP_DIR}/runtime/java"
    local dest="${java_root}/temurin-21"
    local url="https://api.adoptium.net/v3/binary/latest/21/ga/linux/${JAVA_ARCH}/jre/hotspot/normal/eclipse"
    local tmp_tgz="/tmp/temurin-21.tar.gz"

    log "Java runtime not found. Installing Eclipse Temurin JRE 21..."
    mkdir -p "$dest"
    if curl -fsSL -L "$url" -o "$tmp_tgz"; then
        tar -xzf "$tmp_tgz" -C "$dest" --strip-components=1
        rm -f "$tmp_tgz"
        chmod +x "${dest}/bin/java"
        ok "Installed Java 21: $("${dest}/bin/java" -version 2>&1 | head -n1)"
    else
        rm -f "$tmp_tgz"
        err "Failed to download Eclipse Temurin JRE 21 automatically."
        return 1
    fi
}

ensure_pm2() {
    export_runtime_path
    local pm2_bin=""
    pm2_bin="$(find_pm2_bin 2>/dev/null || true)"
    if [[ -n "$pm2_bin" ]]; then
        ok "PM2 requirement satisfied: v$("$pm2_bin" -v 2>/dev/null || echo 'installed') (${pm2_bin})"
        return 0
    fi

    log "PM2 not found. Installing PM2 process manager..."
    if [[ -x "${APP_DIR}/runtime/node/bin/npm" && ! -w /usr/local/lib/node_modules && "$(id -u)" -ne 0 ]]; then
        "${APP_DIR}/runtime/node/bin/npm" install -g pm2
    else
        run_priv npm install -g pm2
    fi

    if [[ -x "${APP_DIR}/runtime/node/bin/pm2" && ! -x /usr/local/bin/pm2 ]] && [[ "$(id -u)" -eq 0 ]]; then
        ln -sf "${APP_DIR}/runtime/node/bin/pm2" /usr/local/bin/pm2 2>/dev/null || true
    fi

    pm2_bin="$(find_pm2_bin 2>/dev/null || true)"
    if [[ -z "$pm2_bin" ]]; then
        err "PM2 installation completed but 'pm2' binary was not found on PATH."
        return 1
    fi
    ok "Installed PM2 v$("$pm2_bin" -v 2>/dev/null || echo 'latest')"
}

ensure_cloudflared_bin() {
    export_runtime_path
    local cf_bin=""
    cf_bin="$(find_cloudflared_bin 2>/dev/null || true)"
    if [[ -n "$cf_bin" ]]; then
        ok "cloudflared ready: $("$cf_bin" --version 2>/dev/null | head -n1 || echo "$cf_bin")"
        return 0
    fi

    local raw_arch cf_arch
    raw_arch="$(uname -m)"
    case "$raw_arch" in
        x86_64|amd64) cf_arch="amd64" ;;
        aarch64|arm64) cf_arch="arm64" ;;
        armv7l|armhf) cf_arch="arm" ;;
        *)
            err "Unsupported architecture for cloudflared: ${raw_arch}"
            return 1
            ;;
    esac

    local dl_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}"
    local tmp_cf="/tmp/cloudflared-${cf_arch}"
    log "Downloading official cloudflared (${cf_arch})..."
    curl -fsSL -L "$dl_url" -o "$tmp_cf"
    chmod +x "$tmp_cf"

    if [[ "$(id -u)" -eq 0 ]] || command -v sudo >/dev/null 2>&1; then
        run_priv mkdir -p /usr/local/bin
        run_priv mv -f "$tmp_cf" /usr/local/bin/cloudflared
        run_priv chmod +x /usr/local/bin/cloudflared
        cf_bin="/usr/local/bin/cloudflared"
    else
        mkdir -p "${APP_DIR}/runtime/bin"
        mv -f "$tmp_cf" "${APP_DIR}/runtime/bin/cloudflared"
        chmod +x "${APP_DIR}/runtime/bin/cloudflared"
        cf_bin="${APP_DIR}/runtime/bin/cloudflared"
    fi

    export_runtime_path
    ok "Installed cloudflared: $("$cf_bin" --version 2>/dev/null | head -n1 || echo "$cf_bin")"
}

ensure_project_files() {
    if [[ -f "${APP_DIR}/package.json" && -f "${APP_DIR}/server.ts" ]]; then
        mkdir -p "${APP_DIR}/storage/servers" "${APP_DIR}/storage/backups" "${APP_DIR}/storage/logs" "${APP_DIR}/runtime/java" "${APP_DIR}/runtime/node"
        return 0
    fi

    if [[ -f "${SCRIPT_SOURCE_DIR}/package.json" && -f "${SCRIPT_SOURCE_DIR}/server.ts" && "${SCRIPT_SOURCE_DIR}" != "${APP_DIR}" ]]; then
        log "Copying local cloned project files into ${APP_DIR}..."
        mkdir -p "$APP_DIR"
        tar -cf - \
            --exclude=node_modules \
            --exclude=storage/database.sqlite \
            --exclude=.env \
            -C "$SCRIPT_SOURCE_DIR" . | tar -xf - -C "$APP_DIR"
    else
        log "Cloning ${GITHUB_REPO_URL} into ${APP_DIR}..."
        mkdir -p "$(dirname "$APP_DIR")"
        git clone "$GITHUB_GIT_URL" "$APP_DIR"
    fi
    mkdir -p "${APP_DIR}/storage/servers" "${APP_DIR}/storage/backups" "${APP_DIR}/storage/logs" "${APP_DIR}/runtime/java" "${APP_DIR}/runtime/node"
}

# ------------------------------------------------------------------------------
# Environment, Dependencies, Migration & PM2 Startup
# ------------------------------------------------------------------------------
set_env_var() {
    local file="$1"
    local key="$2"
    local val="$3"
    if grep -qE "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${val}|" "$file"
    else
        printf '%s=%s\n' "$key" "$val" >> "$file"
    fi
}

configure_sqlite_env() {
    local port="$1"
    local env_file="${APP_DIR}/.env"
    local java_bin=""
    java_bin="$(find_java_bin 2>/dev/null || true)"

    if [[ ! -f "$env_file" ]]; then
        cp "${APP_DIR}/.env.example" "$env_file"
        local app_key jwt_secret
        app_key="$(openssl rand -hex 32)"
        jwt_secret="$(openssl rand -hex 32)"
        set_env_var "$env_file" "APP_KEY" "\"${app_key}\""
        set_env_var "$env_file" "JWT_SECRET" "\"${jwt_secret}\""
    fi

    set_env_var "$env_file" "NODE_ENV" "production"
    set_env_var "$env_file" "PORT" "${port}"
    set_env_var "$env_file" "APP_URL" "\"http://localhost:${port}\""
    set_env_var "$env_file" "DB_CONNECTION" "sqlite"
    set_env_var "$env_file" "ALLOW_SQLITE_DEV_FALLBACK" "true"
    set_env_var "$env_file" "SQLITE_PATH" "./storage/database.sqlite"
    if [[ -n "$java_bin" ]]; then
        set_env_var "$env_file" "DEFAULT_JAVA_PATH" "${java_bin}"
    fi
    chmod 600 "$env_file"
    ok "Configured lightweight SQLite .env (Port: ${port})."
}

install_npm_deps() {
    export_runtime_path
    cd "$APP_DIR"
    log "Installing Node.js dependencies..."
    npm install --omit=dev
    ok "Node.js dependencies installed."
}

allow_privileged_port_if_needed() {
    local port="$1"
    if [[ "$port" -lt 1024 && "$(id -u)" -ne 0 ]]; then
        local node_bin
        node_bin="$(readlink -f "$(find_node_bin)")"
        if command -v setcap >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
            log "Granting cap_net_bind_service to Node.js for port ${port}..."
            sudo setcap 'cap_net_bind_service=+ep' "$node_bin" || warn "Could not setcap on ${node_bin}; port ${port} may require root."
        else
            warn "Port ${port} is < 1024 and you are not root. Run as root/sudo if binding port ${port} fails."
        fi
    fi
}

start_panel_pm2() {
    local port="$1"
    export_runtime_path
    cd "$APP_DIR"
    local pm2_bin tsx_bin node_bin
    pm2_bin="$(find_pm2_bin)"
    tsx_bin="$(find_tsx_bin)"
    node_bin="$(find_node_bin)"

    allow_privileged_port_if_needed "$port"

    "$pm2_bin" delete "$PM2_APP_NAME" >/dev/null 2>&1 || true
    "$pm2_bin" start "$tsx_bin" \
        --interpreter "$node_bin" \
        --name "$PM2_APP_NAME" \
        --cwd "$APP_DIR" \
        -- server.ts
    "$pm2_bin" save >/dev/null 2>&1 || true

    if is_systemd_active; then
        "$pm2_bin" startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1 || true
        "$pm2_bin" save >/dev/null 2>&1 || true
    fi

    ok "Started PM2 process '${PM2_APP_NAME}'."
}

verify_panel() {
    local port="${1:-$(get_env_port)}"
    log "Waiting for panel health check on port ${port}..."
    for _ in $(seq 1 20); do
        if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
            ok "Panel is online and verified at http://127.0.0.1:${port}"
            return 0
        fi
        sleep 1
    done
    warn "Panel did not answer /healthz within 20s. Inspect logs with: pm2 logs ${PM2_APP_NAME}"
    return 1
}

# ------------------------------------------------------------------------------
# Interactive Input Prompts
# ------------------------------------------------------------------------------
prompt_port() {
    local var_name="$1"
    local default_port="${2:-80}"
    local input=""
    while true; do
        read -r -p "${C_WHITE}Panel Port${C_RESET} ${C_DIM}[default: ${default_port}]${C_RESET}: " input
        input="${input:-$default_port}"
        if [[ "$input" =~ ^[0-9]+$ ]] && (( input >= 1 && input <= 65535 )); then
            printf -v "$var_name" '%s' "$input"
            return 0
        fi
        err "Invalid port. Enter a number between 1 and 65535."
    done
}

prompt_admin_credentials() {
    local email="" username="" pass1="" pass2=""
    while true; do
        read -r -p "${C_WHITE}Admin Email${C_RESET}: " email
        if [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
            break
        fi
        err "Enter a valid email address (example: admin@example.com)."
    done

    while true; do
        read -r -p "${C_WHITE}Admin Username${C_RESET}: " username
        if [[ "$username" =~ ^[a-zA-Z0-9_.-]{2,32}$ ]]; then
            break
        fi
        err "Username must be 2-32 characters (letters, numbers, _, ., -)."
    done

    while true; do
        read -r -s -p "${C_WHITE}Admin Password${C_RESET} ${C_DIM}(min 8 chars)${C_RESET}: " pass1
        printf "\n"
        if [[ ${#pass1} -lt 8 ]]; then
            err "Password must be at least 8 characters."
            continue
        fi
        read -r -s -p "${C_WHITE}Confirm Password${C_RESET}: " pass2
        printf "\n"
        if [[ "$pass1" != "$pass2" ]]; then
            err "Passwords do not match. Please try again."
            continue
        fi
        break
    done

    INPUT_ADMIN_EMAIL="$email"
    INPUT_ADMIN_USERNAME="$username"
    INPUT_ADMIN_PASSWORD="$pass1"
}

# ------------------------------------------------------------------------------
# Menu Option 1: Panel Install
# ------------------------------------------------------------------------------
action_install() {
    clear_screen_safe
    print_section_header "1) PANEL INSTALL — ptero-js Setup Wizard"

    local panel_port=""
    prompt_port panel_port 80
    prompt_admin_credentials

    printf "\n%s╔══════════════════════════════════════════════════════════════╗%s\n" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  %sInstallation Summary%s                                        %s║%s\n" "${C_CYAN}" "${C_RESET}" "${C_WHITE}" "${C_RESET}" "${C_CYAN}" "${C_RESET}"
    printf "%s╠══════════════════════════════════════════════════════════════╣%s\n" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  Directory    : %-44s %s║%s\n" "${C_CYAN}" "${C_RESET}" "$APP_DIR" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  Panel Port   : %-44s %s║%s\n" "${C_CYAN}" "${C_RESET}" "$panel_port" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  Database     : %-44s %s║%s\n" "${C_CYAN}" "${C_RESET}" "SQLite (Lightweight, Zero DB Setup)" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  Process Mgr  : %-44s %s║%s\n" "${C_CYAN}" "${C_RESET}" "PM2 (${PM2_APP_NAME})" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  Admin User   : %-44s %s║%s\n" "${C_CYAN}" "${C_RESET}" "${INPUT_ADMIN_USERNAME} (${INPUT_ADMIN_EMAIL})" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  Auto-Check   : %-44s %s║%s\n" "${C_CYAN}" "${C_RESET}" "OS Tools, Node.js >=22, Java 21, PM2" "${C_CYAN}" "${C_RESET}"
    printf "%s╚══════════════════════════════════════════════════════════════╝%s\n\n" "${C_CYAN}" "${C_RESET}"

    if ! confirm_yes_no "Do you want to continue?" "y"; then
        warn "Installation cancelled by user."
        return 0
    fi

    step "[1/7] Detecting OS & Installing Base Requirements"
    detect_os
    install_system_packages

    step "[2/7] Checking Project Directory"
    ensure_project_files

    step "[3/7] Checking & Installing Node.js (>= 22 LTS)"
    ensure_node_runtime

    step "[4/7] Checking & Installing Java Runtime (Temurin 21)"
    ensure_java_runtime

    step "[5/7] Checking & Installing PM2"
    ensure_pm2

    step "[6/7] Configuring SQLite, Installing Dependencies & Creating Admin"
    configure_sqlite_env "$panel_port"
    install_npm_deps
    local tsx_bin
    tsx_bin="$(find_tsx_bin)"
    cd "$APP_DIR"
    "$tsx_bin" scripts/cli.ts seed
    "$tsx_bin" scripts/cli.ts create-admin "$INPUT_ADMIN_EMAIL" "$INPUT_ADMIN_USERNAME" "$INPUT_ADMIN_PASSWORD"
    ok "Administrator account '${INPUT_ADMIN_USERNAME}' is ready."

    step "[7/7] Starting Panel with PM2 & Verifying"
    start_panel_pm2 "$panel_port"
    verify_panel "$panel_port" || true

    local ip_addr
    ip_addr="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
    printf "\n%s╔══════════════════════════════════════════════════════════════╗%s\n" "${C_GREEN}" "${C_RESET}"
    printf "%s║%s  %sptero-js Installation Complete!%s                              %s║%s\n" "${C_GREEN}" "${C_RESET}" "${C_WHITE}" "${C_RESET}" "${C_GREEN}" "${C_RESET}"
    printf "%s╠══════════════════════════════════════════════════════════════╣%s\n" "${C_GREEN}" "${C_RESET}"
    printf "%s║%s  Panel URL    : http://%-37s %s║%s\n" "${C_GREEN}" "${C_RESET}" "${ip_addr}:${panel_port}" "${C_GREEN}" "${C_RESET}"
    printf "%s║%s  Admin Login  : %-44s %s║%s\n" "${C_GREEN}" "${C_RESET}" "${INPUT_ADMIN_USERNAME} / ${INPUT_ADMIN_EMAIL}" "${C_GREEN}" "${C_RESET}"
    printf "%s║%s  PM2 Logs     : pm2 logs %-35s %s║%s\n" "${C_GREEN}" "${C_RESET}" "${PM2_APP_NAME}" "${C_GREEN}" "${C_RESET}"
    printf "%s╚══════════════════════════════════════════════════════════════╝%s\n" "${C_GREEN}" "${C_RESET}"
}

# ------------------------------------------------------------------------------
# Menu Option 2: Update Panel from GitHub
# ------------------------------------------------------------------------------
action_update() {
    clear_screen_safe
    print_section_header "2) UPDATE PANEL — GitHub (${GITHUB_REPO_URL})"

    if [[ ! -d "$APP_DIR" || ! -f "${APP_DIR}/package.json" ]]; then
        err "No installation found at ${APP_DIR}. Run Option 1 (Panel Install) first."
        return 1
    fi

    cd "$APP_DIR"
    export_runtime_path
    install_system_packages

    local local_ver remote_ver branch="main" local_sha="N/A" remote_sha="N/A"
    local_ver="$(get_local_version)"

    if [[ -d "${APP_DIR}/.git" ]]; then
        local detected_branch
        detected_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
        [[ -n "$detected_branch" && "$detected_branch" != "HEAD" ]] && branch="$detected_branch"
        local_sha="$(git rev-parse --short HEAD 2>/dev/null || echo 'N/A')"
        if ! git remote get-url origin >/dev/null 2>&1; then
            git remote add origin "$GITHUB_GIT_URL"
        fi
        log "Checking GitHub (${GITHUB_REPO_URL}) branch '${branch}'..."
        git fetch origin "$branch" --quiet 2>/dev/null || true
        remote_sha="$(git rev-parse --short "origin/${branch}" 2>/dev/null || echo 'N/A')"
    fi

    remote_ver="$(curl -fsSL --max-time 6 "${GITHUB_RAW_BASE}/${branch}/package.json" 2>/dev/null | sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' | head -n1 || true)"
    if [[ -z "$remote_ver" && "$branch" != "main" ]]; then
        branch="main"
        remote_ver="$(curl -fsSL --max-time 6 "${GITHUB_RAW_BASE}/main/package.json" 2>/dev/null | sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' | head -n1 || true)"
    fi
    remote_ver="${remote_ver:-unknown}"

    printf "\n%s╔══════════════════════════════════════════════════════════════╗%s\n" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  %sGitHub Update Check%s                                         %s║%s\n" "${C_CYAN}" "${C_RESET}" "${C_WHITE}" "${C_RESET}" "${C_CYAN}" "${C_RESET}"
    printf "%s╠══════════════════════════════════════════════════════════════╣%s\n" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  Repository     : %-42s %s║%s\n" "${C_CYAN}" "${C_RESET}" "$GITHUB_REPO_URL" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  Local Version  : %-42s %s║%s\n" "${C_CYAN}" "${C_RESET}" "${local_ver} (${local_sha})" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  GitHub Version : %-42s %s║%s\n" "${C_CYAN}" "${C_RESET}" "${remote_ver} (${remote_sha})" "${C_CYAN}" "${C_RESET}"
    printf "%s╚══════════════════════════════════════════════════════════════╝%s\n\n" "${C_CYAN}" "${C_RESET}"

    if [[ "$local_sha" != "N/A" && "$remote_sha" != "N/A" && "$local_sha" == "$remote_sha" ]]; then
        ok "You are already on the latest commit (${local_sha})."
        if ! confirm_yes_no "Re-sync and verify Node.js, Java, and PM2 anyway?" "n"; then
            return 0
        fi
    else
        if ! confirm_yes_no "Do you want to update now?" "y"; then
            warn "Update cancelled by user."
            return 0
        fi
    fi

    step "[1/5] Backing Up Database & .env Configuration"
    mkdir -p "$BACKUP_ROOT"
    local stamp dest tsx_bin
    stamp="$(date +%Y%m%d-%H%M%S)"
    dest="${BACKUP_ROOT}/backup-${stamp}"
    mkdir -p "$dest"
    tsx_bin="$(find_tsx_bin 2>/dev/null || true)"
    if [[ -n "$tsx_bin" ]]; then
        "$tsx_bin" scripts/cli.ts db-backup "$dest" || warn "Database backup skipped."
    fi
    [[ -f "${APP_DIR}/.env" ]] && cp "${APP_DIR}/.env" "${dest}/.env.bak"
    [[ -f "${APP_DIR}/storage/.panel-secrets.json" ]] && cp "${APP_DIR}/storage/.panel-secrets.json" "${dest}/panel-secrets.json.bak"
    ok "Backup saved to ${dest}"

    step "[2/5] Stopping PM2 & Pulling Latest Code from GitHub"
    local pm2_bin=""
    pm2_bin="$(find_pm2_bin 2>/dev/null || true)"
    [[ -n "$pm2_bin" ]] && "$pm2_bin" stop "$PM2_APP_NAME" >/dev/null 2>&1 || true

    if [[ -d "${APP_DIR}/.git" ]]; then
        git fetch "$GITHUB_GIT_URL" "$branch"
        if ! git pull --ff-only "$GITHUB_GIT_URL" "$branch"; then
            warn "Local tracked modifications detected; resetting tracked files to origin/${branch} (preserving .env, storage, runtime)..."
            git reset --hard FETCH_HEAD
        fi
    else
        local tmp_tgz="/tmp/ptero-js-update.tar.gz"
        local tmp_dir="/tmp/ptero-js-extract-${stamp}"
        curl -fsSL "${GITHUB_REPO_URL}/archive/refs/heads/${branch}.tar.gz" -o "$tmp_tgz"
        mkdir -p "$tmp_dir"
        tar -xzf "$tmp_tgz" -C "$tmp_dir" --strip-components=1
        tar -cf - --exclude=.env --exclude=storage --exclude=runtime --exclude=node_modules -C "$tmp_dir" . | tar -xf - -C "$APP_DIR"
        rm -rf "$tmp_tgz" "$tmp_dir"
    fi
    ok "Latest code pulled from GitHub."

    step "[3/5] Auto-Checking VPS Requirements (Node.js, Java, PM2)"
    ensure_node_runtime
    ensure_java_runtime
    ensure_pm2

    step "[4/5] Updating Dependencies & Running Database Migrations"
    install_npm_deps
    tsx_bin="$(find_tsx_bin)"
    "$tsx_bin" scripts/cli.ts migrate

    step "[5/5] Restarting PM2 & Verifying Health"
    local port
    port="$(get_env_port)"
    start_panel_pm2 "$port"
    verify_panel "$port" || true
    ok "Panel updated successfully to $(get_local_version)!"
}

# ------------------------------------------------------------------------------
# Menu Option 3: Create Admin User
# ------------------------------------------------------------------------------
action_create_admin() {
    clear_screen_safe
    print_section_header "3) CREATE ADMIN USER — ptero-js"

    if [[ ! -d "$APP_DIR" || ! -f "${APP_DIR}/scripts/cli.ts" ]]; then
        err "Panel installation not found at ${APP_DIR}. Run Option 1 (Panel Install) first."
        return 1
    fi

    ensure_node_runtime
    if ! find_tsx_bin >/dev/null 2>&1; then
        install_npm_deps
    fi

    prompt_admin_credentials

    local tsx_bin
    tsx_bin="$(find_tsx_bin)"
    cd "$APP_DIR"
    "$tsx_bin" scripts/cli.ts create-admin "$INPUT_ADMIN_EMAIL" "$INPUT_ADMIN_USERNAME" "$INPUT_ADMIN_PASSWORD"
    ok "Admin user '${INPUT_ADMIN_USERNAME}' (${INPUT_ADMIN_EMAIL}) created/updated successfully!"
}

# ------------------------------------------------------------------------------
# Menu Option 4: Full Uninstall
# ------------------------------------------------------------------------------
action_uninstall() {
    local force_purge="${1:-false}"
    if [[ "$force_purge" != "true" ]]; then
        clear_screen_safe
        print_section_header "4) UNINSTALL — Full VPS Removal"
        printf "%sThis will permanently remove:%s\n" "${C_RED}" "${C_RESET}"
        printf "  • PM2 process '%s' and saved PM2 entry\n" "${PM2_APP_NAME}"
        printf "  • Entire project directory: %s\n" "${APP_DIR}"
        printf "  • All local databases, backups, runtimes, and server files inside it\n\n"

        local confirm_word=""
        read -r -p "${C_RED}Type YES to permanently remove ptero-js from this VPS: ${C_RESET}" confirm_word
        if [[ "$confirm_word" != "YES" ]]; then
            warn "Uninstall cancelled."
            return 0
        fi
    fi

    step "Stopping and Removing PM2 Process..."
    local pm2_bin=""
    pm2_bin="$(find_pm2_bin 2>/dev/null || true)"
    if [[ -n "$pm2_bin" ]]; then
        "$pm2_bin" stop "$PM2_APP_NAME" >/dev/null 2>&1 || true
        "$pm2_bin" delete "$PM2_APP_NAME" >/dev/null 2>&1 || true
        "$pm2_bin" stop "$CF_PM2_APP_NAME" >/dev/null 2>&1 || true
        "$pm2_bin" delete "$CF_PM2_APP_NAME" >/dev/null 2>&1 || true
        "$pm2_bin" save --force >/dev/null 2>&1 || "$pm2_bin" save >/dev/null 2>&1 || true
        ok "Removed PM2 process '${PM2_APP_NAME}'."
    fi

    if is_systemd_active && [[ -f "/etc/systemd/system/${LEGACY_SERVICE_NAME}.service" ]]; then
        run_priv systemctl stop "$LEGACY_SERVICE_NAME" >/dev/null 2>&1 || true
        run_priv systemctl disable "$LEGACY_SERVICE_NAME" >/dev/null 2>&1 || true
        run_priv rm -f "/etc/systemd/system/${LEGACY_SERVICE_NAME}.service"
        run_priv systemctl daemon-reload >/dev/null 2>&1 || true
    fi

    step "Removing Project Directory (${APP_DIR})..."
    cd /tmp
    if [[ -n "$APP_DIR" && "$APP_DIR" != "/" && "$APP_DIR" != "/root" && "$APP_DIR" != "/home" ]]; then
        rm -rf "$APP_DIR"
        ok "Fully removed ${APP_DIR} from this VPS."
    else
        err "Refusing unsafe directory deletion path: '${APP_DIR}'"
        return 1
    fi

    ok "ptero-js has been completely uninstalled."
    exit 0
}

# ------------------------------------------------------------------------------
# Menu Option 5: Cloudflare Tunnel via PM2
# ------------------------------------------------------------------------------
extract_trycloudflare_url() {
    local pm2_home="${PM2_HOME:-${HOME}/.pm2}"
    local log_files=("${pm2_home}/logs/${CF_PM2_APP_NAME}-out.log" "${pm2_home}/logs/${CF_PM2_APP_NAME}-error.log")
    local url=""
    for lf in "${log_files[@]}"; do
        if [[ -f "$lf" ]]; then
            local found
            found="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$lf" 2>/dev/null | tail -n1 || true)"
            [[ -n "$found" ]] && url="$found"
        fi
    done
    echo "$url"
}

start_cloudflare_pm2_quick() {
    local panel_port="$1"
    local target_url=""
    read -r -p "${C_WHITE}Local Panel URL${C_RESET} ${C_DIM}[default: http://127.0.0.1:${panel_port}]${C_RESET}: " target_url
    target_url="${target_url:-http://127.0.0.1:${panel_port}}"

    local pm2_bin cf_bin
    pm2_bin="$(find_pm2_bin)"
    cf_bin="$(find_cloudflared_bin)"

    step "Starting Cloudflare Quick Tunnel under PM2 (${CF_PM2_APP_NAME})..."
    "$pm2_bin" delete "$CF_PM2_APP_NAME" >/dev/null 2>&1 || true
    rm -f "${PM2_HOME:-${HOME}/.pm2}/logs/${CF_PM2_APP_NAME}-"*.log 2>/dev/null || true

    "$pm2_bin" start "$cf_bin" \
        --interpreter none \
        --name "$CF_PM2_APP_NAME" \
        -- tunnel --no-autoupdate --url "$target_url"
    "$pm2_bin" save >/dev/null 2>&1 || true

    if is_systemd_active; then
        "$pm2_bin" startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1 || true
        "$pm2_bin" save >/dev/null 2>&1 || true
    fi

    log "Waiting for TryCloudflare public URL..."
    local cf_url=""
    for _ in $(seq 1 15); do
        cf_url="$(extract_trycloudflare_url)"
        [[ -n "$cf_url" ]] && break
        sleep 1
    done

    printf "\n%s╔══════════════════════════════════════════════════════════════╗%s\n" "${C_GREEN}" "${C_RESET}"
    printf "%s║%s  %sCloudflare Quick Tunnel Running via PM2%s                      %s║%s\n" "${C_GREEN}" "${C_RESET}" "${C_WHITE}" "${C_RESET}" "${C_GREEN}" "${C_RESET}"
    printf "%s╠══════════════════════════════════════════════════════════════╣%s\n" "${C_GREEN}" "${C_RESET}"
    printf "%s║%s  PM2 App      : %-44s %s║%s\n" "${C_GREEN}" "${C_RESET}" "$CF_PM2_APP_NAME" "${C_GREEN}" "${C_RESET}"
    printf "%s║%s  Target       : %-44s %s║%s\n" "${C_GREEN}" "${C_RESET}" "$target_url" "${C_GREEN}" "${C_RESET}"
    if [[ -n "$cf_url" ]]; then
        printf "%s║%s  Public URL   : %-44s %s║%s\n" "${C_GREEN}" "${C_RESET}" "$cf_url" "${C_GREEN}" "${C_RESET}"
    else
        printf "%s║%s  Public URL   : Check -> pm2 logs %-28s %s║%s\n" "${C_GREEN}" "${C_RESET}" "$CF_PM2_APP_NAME" "${C_GREEN}" "${C_RESET}"
    fi
    printf "%s╚══════════════════════════════════════════════════════════════╝%s\n" "${C_GREEN}" "${C_RESET}"
}

start_cloudflare_pm2_token() {
    local panel_port="$1"
    local raw_token=""
    while true; do
        read -r -s -p "${C_WHITE}Cloudflare Tunnel Token${C_RESET} ${C_DIM}(from Zero Trust -> Tunnels)${C_RESET}: " raw_token
        printf "\n"
        # Strip optional 'cloudflared service install ' prefix and whitespace
        raw_token="$(printf '%s' "$raw_token" | sed -E 's/^[[:space:]]*(sudo[[:space:]]+)?(cloudflared[[:space:]]+service[[:space:]]+install[[:space:]]+)?//; s/[[:space:]]+$//')"
        if [[ -n "$raw_token" && ${#raw_token} -ge 20 ]]; then
            break
        fi
        err "Invalid token. Paste the Cloudflare Tunnel token (or full install command)."
    done

    local pm2_bin cf_bin
    pm2_bin="$(find_pm2_bin)"
    cf_bin="$(find_cloudflared_bin)"

    step "Starting Named Cloudflare Tunnel under PM2 (${CF_PM2_APP_NAME})..."
    "$pm2_bin" delete "$CF_PM2_APP_NAME" >/dev/null 2>&1 || true

    "$pm2_bin" start "$cf_bin" \
        --interpreter none \
        --name "$CF_PM2_APP_NAME" \
        -- tunnel --no-autoupdate run --token "$raw_token"
    "$pm2_bin" save >/dev/null 2>&1 || true

    if is_systemd_active; then
        "$pm2_bin" startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1 || true
        "$pm2_bin" save >/dev/null 2>&1 || true
    fi

    ok "Cloudflare Token Tunnel '${CF_PM2_APP_NAME}' is running under PM2!"
    log "In Cloudflare Zero Trust -> Public Hostname, point service URL to: http://127.0.0.1:${panel_port}"
}

action_cloudflare_pm2() {
    clear_screen_safe
    print_section_header "5) CLOUDFLARE PM2 — Tunnel Manager"

    install_system_packages
    ensure_node_runtime
    ensure_pm2
    ensure_cloudflared_bin

    local panel_port pm2_bin cf_state cf_url
    panel_port="$(get_env_port)"
    pm2_bin="$(find_pm2_bin)"
    cf_state="$(get_pm2_status_label "$CF_PM2_APP_NAME")"
    cf_url="$(extract_trycloudflare_url)"

    printf "  %sTunnel Status :%s %s\n" "${C_BOLD}" "${C_RESET}" "$cf_state"
    [[ -n "$cf_url" ]] && printf "  %sLast URL      :%s %s\n" "${C_BOLD}" "${C_RESET}" "$cf_url"
    printf "  %sPanel Target  :%s http://127.0.0.1:%s\n\n" "${C_BOLD}" "${C_RESET}" "$panel_port"

    printf "   %s[1]%s Start Quick Tunnel (Free *.trycloudflare.com URL, No Token)\n" "${C_GREEN}" "${C_RESET}"
    printf "   %s[2]%s Start Named Tunnel (Cloudflare Zero Trust Token)\n" "${C_CYAN}" "${C_RESET}"
    printf "   %s[3]%s Tunnel Status & Recent Logs\n" "${C_BLUE}" "${C_RESET}"
    printf "   %s[4]%s Stop & Remove Cloudflare PM2 Process\n" "${C_RED}" "${C_RESET}"
    printf "   %s[0]%s Back to Main Menu\n\n" "${C_DIM}" "${C_RESET}"

    local cf_choice=""
    read -r -p "${C_BOLD}${C_YELLOW}Choose Cloudflare action [0-4]: ${C_RESET}" cf_choice
    case "$cf_choice" in
        1) start_cloudflare_pm2_quick "$panel_port" ;;
        2) start_cloudflare_pm2_token "$panel_port" ;;
        3)
            "$pm2_bin" status "$CF_PM2_APP_NAME" || true
            local live_url
            live_url="$(extract_trycloudflare_url)"
            [[ -n "$live_url" ]] && ok "Active TryCloudflare URL: ${live_url}"
            "$pm2_bin" logs "$CF_PM2_APP_NAME" --lines 20 --nostream || true
            ;;
        4)
            "$pm2_bin" stop "$CF_PM2_APP_NAME" >/dev/null 2>&1 || true
            "$pm2_bin" delete "$CF_PM2_APP_NAME" >/dev/null 2>&1 || true
            "$pm2_bin" save >/dev/null 2>&1 || true
            ok "Stopped and removed Cloudflare PM2 tunnel '${CF_PM2_APP_NAME}'."
            ;;
        0|q|Q|"")
            return 0
            ;;
        *)
            err "Invalid choice '${cf_choice}'."
            ;;
    esac
}

# ------------------------------------------------------------------------------
# Bold ptero-js Main Menu UI
# ------------------------------------------------------------------------------
clear_screen_safe() {
    if [[ -t 1 ]]; then
        clear 2>/dev/null || printf "\033[2J\033[H"
    fi
}

print_section_header() {
    local title="$1"
    printf "%s╔══════════════════════════════════════════════════════════════╗%s\n" "${C_CYAN}" "${C_RESET}"
    printf "%s║%s  %-60s%s║%s\n" "${C_CYAN}" "${C_RESET}" "${C_BOLD}${C_WHITE}${title}${C_RESET}" "${C_CYAN}" "${C_RESET}"
    printf "%s╚══════════════════════════════════════════════════════════════╝%s\n\n" "${C_CYAN}" "${C_RESET}"
}

print_ansi_box_line() {
    local content="$1"
    local plain
    plain="$(printf '%b' "$content" | sed -r 's/\x1B\[[0-9;]*[mK]//g')"
    local width=62
    local len=${#plain}
    local pad=$(( width - len ))
    (( pad < 0 )) && pad=0
    printf "%s║%s%b%*s%s║%s\n" "${C_CYAN}" "${C_RESET}" "$content" "$pad" "" "${C_CYAN}" "${C_RESET}"
}

render_main_menu() {
    clear_screen_safe
    export_runtime_path

    local node_badge java_badge pm2_badge panel_badge
    local nbin jbin pbin pm2_state port_num

    nbin="$(find_node_bin 2>/dev/null || true)"
    if [[ -n "$nbin" ]]; then
        node_badge="${C_GREEN}[OK] $("$nbin" -v 2>/dev/null)${C_RESET}"
    else
        node_badge="${C_RED}[MISSING]${C_RESET}"
    fi

    jbin="$(find_java_bin 2>/dev/null || true)"
    if [[ -n "$jbin" ]]; then
        local jshort
        jshort="$("$jbin" -version 2>&1 | head -n1 | sed -E 's/.*"([^"]+)".*/\1/' || echo 'ready')"
        java_badge="${C_GREEN}[OK] ${jshort}${C_RESET}"
    else
        java_badge="${C_RED}[MISSING]${C_RESET}"
    fi

    pbin="$(find_pm2_bin 2>/dev/null || true)"
    if [[ -n "$pbin" ]]; then
        pm2_state="$(get_pm2_status_label)"
        pm2_badge="${C_GREEN}[OK] (${pm2_state})${C_RESET}"
    else
        pm2_badge="${C_RED}[MISSING]${C_RESET}"
    fi

    port_num="$(get_env_port)"
    if [[ -f "${APP_DIR}/.env" && -f "${APP_DIR}/storage/database.sqlite" ]]; then
        panel_badge="${C_GREEN}Installed (Port ${port_num}, SQLite)${C_RESET}"
    else
        panel_badge="${C_YELLOW}Not Installed${C_RESET}"
    fi

    printf "%s╔══════════════════════════════════════════════════════════════╗%s\n" "${C_CYAN}" "${C_RESET}"
    print_ansi_box_line "    ${C_WHITE}PTERO-JS${C_RESET}  ${C_DIM}•  Pterodactyl v${PANEL_VERSION} (Node.js + Java)${C_RESET}"
    print_ansi_box_line "    ${C_DIM}Made by Jishnu (JTG STUDIO 2026) • Docker/Lightweight VPS${C_RESET}"
    printf "%s╠══════════════════════════════════════════════════════════════╣%s\n" "${C_CYAN}" "${C_RESET}"
    print_ansi_box_line "  ${C_BOLD}Panel :${C_RESET} ${panel_badge}"
    print_ansi_box_line "  ${C_BOLD}Node  :${C_RESET} ${node_badge}  ${C_BOLD}Java:${C_RESET} ${java_badge}  ${C_BOLD}PM2:${C_RESET} ${pm2_badge}"
    print_ansi_box_line "  ${C_BOLD}Path  :${C_RESET} ${APP_DIR}"
    printf "%s╠══════════════════════════════════════════════════════════════╣%s\n" "${C_CYAN}" "${C_RESET}"
    print_ansi_box_line ""
    print_ansi_box_line "   ${C_GREEN}[1]${C_RESET}  ${C_WHITE}Panel Install${C_RESET}"
    print_ansi_box_line "        ${C_DIM}Check/auto-install Node, Java, PM2 • Port 80 • Admin${C_RESET}"
    print_ansi_box_line ""
    print_ansi_box_line "   ${C_BLUE}[2]${C_RESET}  ${C_WHITE}Update Panel${C_RESET}"
    print_ansi_box_line "        ${C_DIM}Check GitHub version, pull update & verify runtimes${C_RESET}"
    print_ansi_box_line ""
    print_ansi_box_line "   ${C_YELLOW}[3]${C_RESET}  ${C_WHITE}Create Admin User${C_RESET}"
    print_ansi_box_line "        ${C_DIM}Create or update an Administrator login account${C_RESET}"
    print_ansi_box_line ""
    print_ansi_box_line "   ${C_RED}[4]${C_RESET}  ${C_WHITE}Uninstall${C_RESET}"
    print_ansi_box_line "        ${C_DIM}Stop PM2 and completely remove ptero-js from VPS${C_RESET}"
    print_ansi_box_line ""
    print_ansi_box_line "   ${C_CYAN}[5]${C_RESET}  ${C_WHITE}Cloudflare PM2${C_RESET}"
    print_ansi_box_line "        ${C_DIM}Setup cloudflared tunnel under PM2 (Quick or Token)${C_RESET}"
    print_ansi_box_line ""
    print_ansi_box_line "   ${C_DIM}[0]${C_RESET}  Exit"
    printf "%s╚══════════════════════════════════════════════════════════════╝%s\n\n" "${C_CYAN}" "${C_RESET}"
}

main_menu_loop() {
    local choice=""
    while true; do
        render_main_menu
        read -r -p "${C_BOLD}${C_YELLOW}Select an option [0-5]: ${C_RESET}" choice
        case "$choice" in
            1) action_install || true; pause_prompt ;;
            2) action_update || true; pause_prompt ;;
            3) action_create_admin || true; pause_prompt ;;
            4) action_uninstall "false" || true; pause_prompt ;;
            5) action_cloudflare_pm2 || true; pause_prompt ;;
            0|q|Q|exit)
                printf "%sGoodbye!%s\n" "${C_CYAN}" "${C_RESET}"
                exit 0
                ;;
            *)
                err "Invalid choice '${choice}'. Enter 1, 2, 3, 4, 5, or 0."
                sleep 1
                ;;
        esac
    done
}

# ------------------------------------------------------------------------------
# Entry Point (Interactive Main Menu OR Subcommand Automation)
# ------------------------------------------------------------------------------
if [[ $# -eq 0 ]]; then
    main_menu_loop
fi

case "${1:-}" in
    menu)       main_menu_loop ;;
    install)    action_install ;;
    update)     action_update ;;
    admin)      action_create_admin ;;
    cloudflare) action_cloudflare_pm2 ;;
    uninstall)
        if [[ "${2:-}" == "--purge" ]]; then
            action_uninstall "true"
        else
            action_uninstall "false"
        fi
        ;;
    status)
        export_runtime_path
        echo "=== ptero-js Panel Status ==="
        echo "Version : $(get_local_version)"
        echo "App Dir : ${APP_DIR}"
        echo "Port    : $(get_env_port)"
        echo "Node.js : $(find_node_bin >/dev/null 2>&1 && "$(find_node_bin)" -v || echo 'missing')"
        echo "Java    : $(find_java_bin >/dev/null 2>&1 && "$(find_java_bin)" -version 2>&1 | head -n1 || echo 'missing')"
        pm2_bin="$(find_pm2_bin 2>/dev/null || true)"
        if [[ -n "$pm2_bin" ]]; then
            "$pm2_bin" status "$PM2_APP_NAME" || true
            "$pm2_bin" status "$CF_PM2_APP_NAME" 2>/dev/null || true
        else
            echo "PM2     : missing"
        fi
        ;;
    start)     export_runtime_path; start_panel_pm2 "$(get_env_port)" ;;
    stop)      export_runtime_path; "$(find_pm2_bin)" stop "$PM2_APP_NAME" && ok "Stopped." ;;
    restart)   export_runtime_path; "$(find_pm2_bin)" restart "$PM2_APP_NAME" && ok "Restarted." ;;
    version)   get_local_version ;;
    *)
        echo "Usage: bash install.sh [menu|install|update|admin|cloudflare|uninstall [--purge]|status|start|stop|restart|version]"
        exit 1
        ;;
esac
