# Docker Deployment — `jishnuyt/ptero-js`

Run **ptero-js (Pterodactyl Panel v1.15.2 Node.js + Java Edition)** on a VPS directly on **Port 80** with zero manual setup.

---

## 1. Quick Run on VPS (Pull from Docker Hub)

```bash
docker run -d \
  --name ptero-js \
  --restart unless-stopped \
  -p 80:80 \
  -p 25565-25575:25565-25575 \
  -e ADMIN_EMAIL="admin@ptero.local" \
  -e ADMIN_USERNAME="admin" \
  -e ADMIN_PASSWORD="YourStrongPassword123" \
  -v ptero_storage:/app/storage \
  -v ptero_java:/app/runtime/java \
  jishnuyt/ptero-js:latest
```

Then open **`http://<YOUR_VPS_IP>`** in your browser.

> If you omit `ADMIN_PASSWORD`, a secure password is automatically generated on first boot and printed in:
> ```bash
> docker logs ptero-js
> ```

---

## 2. Run with Docker Compose

From the `docker/` folder:

```bash
cd docker
docker compose up -d
```

- Uses **Port 80** by default (`http://<YOUR_VPS_IP>`).
- Persists SQLite database, panel secrets, game servers, backups, and downloaded Java runtimes in `ptero_storage` and `ptero_java`.

---

## 3. Build & Push `jishnuyt/ptero-js` to Docker Hub

Run from the **repository root**:

```bash
# Single-architecture build (host arch)
docker build -f docker/Dockerfile -t jishnuyt/ptero-js:latest .
docker push jishnuyt/ptero-js:latest
```

Multi-architecture build (`amd64` + `arm64` VPS support):

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f docker/Dockerfile \
  -t jishnuyt/ptero-js:latest \
  --push .
```

---

## 4. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `80` | HTTP/WebSocket port inside container |
| `DB_CONNECTION` | `sqlite` | `sqlite` (zero-config) or `mysql` |
| `ADMIN_EMAIL` | `admin@ptero.local` | First-boot admin email (when DB has 0 users) |
| `ADMIN_USERNAME` | `admin` | First-boot admin username |
| `ADMIN_PASSWORD` | *(auto-generated)* | First-boot admin password |
| `LOCAL_NODE_FQDN` | `127.0.0.1` | Display IP/hostname for node allocations |
| `LOCAL_NODE_MEMORY_MB` | `8192` | Reported node RAM capacity in MB |
| `LOCAL_NODE_DISK_MB` | `51200` | Reported node disk capacity in MB |
