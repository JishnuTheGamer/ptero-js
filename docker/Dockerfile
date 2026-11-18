# ==============================================================================
# ptero-js — Pterodactyl Panel v1.15.2 (Node.js + Java Edition)
# Default Port: 80 | Built-in SQLite + Eclipse Temurin Java 21
# Build from repo root:
#   docker build -f docker/Dockerfile -t jishnuyt/ptero-js:latest .
# ==============================================================================

FROM node:22-bookworm-slim

ARG TARGETARCH
ARG TEMURIN_JAVA_MAJOR=21

LABEL org.opencontainers.image.title="ptero-js" \
      org.opencontainers.image.description="Pterodactyl Panel v1.15.2 Node.js + Java Edition by Jishnu (JTG Studio)" \
      org.opencontainers.image.source="https://github.com/JishnuTheGamer/ptero-js" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=80 \
    APP_NAME="Pterodactyl" \
    APP_VERSION="1.15.2-node" \
    SINGLE_NODE_MODE=true \
    DB_CONNECTION=sqlite \
    ALLOW_SQLITE_DEV_FALLBACK=true \
    SQLITE_PATH=/app/storage/database.sqlite \
    STORAGE_DIR=/app/storage \
    SERVERS_DIR=/app/storage/servers \
    BACKUPS_DIR=/app/storage/backups \
    LOGS_DIR=/app/storage/logs \
    JAVA_RUNTIME_DIR=/app/runtime/java \
    DEFAULT_JAVA_PATH=/opt/java/temurin-21/bin/java \
    LOCAL_NODE_NAME="Local Node" \
    LOCAL_NODE_FQDN="127.0.0.1" \
    LOCAL_NODE_MEMORY_MB=8192 \
    LOCAL_NODE_DISK_MB=51200

# System tools + tini (PID 1 reaper for graceful Minecraft server shutdown)
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    iproute2 \
    procps \
    tar \
    tini \
    unzip \
    xz-utils \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Eclipse Temurin JRE 21 in /opt/java so mounted volumes never shadow it
RUN set -eux; \
    arch="${TARGETARCH:-$(uname -m)}"; \
    case "$arch" in \
        amd64|x86_64) java_arch="x64" ;; \
        arm64|aarch64) java_arch="aarch64" ;; \
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/java/temurin-21; \
    curl -fsSL -L "https://api.adoptium.net/v3/binary/latest/${TEMURIN_JAVA_MAJOR}/ga/linux/${java_arch}/jre/hotspot/normal/eclipse" -o /tmp/temurin-21.tar.gz; \
    tar -xzf /tmp/temurin-21.tar.gz -C /opt/java/temurin-21 --strip-components=1; \
    rm -f /tmp/temurin-21.tar.gz; \
    /opt/java/temurin-21/bin/java -version

ENV PATH="/opt/java/temurin-21/bin:/app/node_modules/.bin:${PATH}"

WORKDIR /app

# Install production dependencies (includes tsx runtime + express + mysql2)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source & static frontend
COPY server.ts tsconfig.json .env.example LICENSE README.md ./
COPY backend ./backend
COPY frontend ./frontend
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/ptero-entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/ptero-entrypoint.sh \
    && chmod +x /usr/local/bin/ptero-entrypoint.sh \
    && mkdir -p /app/storage/servers /app/storage/backups /app/storage/logs /app/runtime/java

EXPOSE 80
EXPOSE 25565-25575

VOLUME ["/app/storage", "/app/runtime/java"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-80}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ptero-entrypoint.sh"]
CMD ["./node_modules/.bin/tsx", "server.ts"]
