import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index';
import { db } from '../database/connection';
import { selectJavaRuntime } from '../minecraft/java';
import { installMinecraftServer, SupportedSoftware, writeEulaFile, writeServerProperties } from '../minecraft/software';
import { logger } from '../utils/logger';
import { buildJavaLaunchArgs } from '../utils/startup';

export type ServerPowerState = 'offline' | 'starting' | 'running' | 'stopping';

export interface ServerStats {
    memory_bytes: number;
    memory_limit_bytes: number;
    cpu_absolute: number;
    network: { rx_bytes: number; tx_bytes: number };
    uptime: number;
    state: ServerPowerState;
    disk_bytes: number;
}

interface ManagedServer {
    uuid: string;
    serverId: number;
    process: ChildProcess | null;
    state: ServerPowerState;
    startedAt: number | null;
    logs: string[];
    stopRequested: boolean;
    stopTimer: NodeJS.Timeout | null;
    restartTimestamps: number[];
    lastCpuTicks: number | null;
    lastSampleAt: number | null;
    stats: ServerStats;
}

type WsListener = (event: string, data: string) => void;

const MAX_LOG_BUFFER = 500;

function computeDirectorySize(dirPath: string): number {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const stack = [dirPath];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            try {
                if (entry.isDirectory()) {
                    stack.push(full);
                } else if (entry.isFile()) {
                    total += fs.statSync(full).size;
                }
            } catch {
                // ignore transient files
            }
        }
    }
    return total;
}

function readProcessMemoryAndCpu(pid: number): { rssBytes: number; cpuTicks: number } | null {
    try {
        const statusStr = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const vmRssMatch = statusStr.match(/VmRSS:\s+(\d+)\s+kB/);
        const rssBytes = vmRssMatch ? Number(vmRssMatch[1]) * 1024 : 0;

        const statStr = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rparen = statStr.lastIndexOf(')');
        const fields = statStr.slice(rparen + 2).split(/\s+/);
        const utime = Number(fields[11] || 0);
        const stime = Number(fields[12] || 0);
        return { rssBytes, cpuTicks: utime + stime };
    } catch {
        return null;
    }
}

function readHostNetworkBytes(): { rx: number; tx: number } {
    try {
        const netDev = fs.readFileSync('/proc/net/dev', 'utf8');
        let rx = 0;
        let tx = 0;
        for (const line of netDev.split('\n').slice(2)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('lo:')) continue;
            const parts = trimmed.split(/[:\s]+/).filter(Boolean);
            if (parts.length >= 10) {
                rx += Number(parts[1] || 0);
                tx += Number(parts[9] || 0);
            }
        }
        return { rx, tx };
    } catch {
        return { rx: 0, tx: 0 };
    }
}

class ServerProcessManager {
    private servers = new Map<string, ManagedServer>();
    private listeners = new Map<string, Set<WsListener>>();
    private monitorInterval: NodeJS.Timeout | null = null;

    startMonitor(): void {
        if (this.monitorInterval) return;
        this.monitorInterval = setInterval(() => {
            this.sampleAllServers().catch((err) => logger.error('Monitor sample error', { err: String(err) }));
        }, 2000);
    }

    stopMonitor(): void {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }

    getServerDir(uuid: string): string {
        const dir = path.join(config.paths.serversDir, uuid);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    private getOrCreateManaged(serverId: number, uuid: string, memoryMb: number): ManagedServer {
        let managed = this.servers.get(uuid);
        if (!managed) {
            const logFile = path.join(config.paths.logsDir, `server-${uuid}.log`);
            let initialLogs: string[] = [];
            if (fs.existsSync(logFile)) {
                try {
                    initialLogs = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-MAX_LOG_BUFFER);
                } catch {
                    initialLogs = [];
                }
            }
            managed = {
                uuid,
                serverId,
                process: null,
                state: 'offline',
                startedAt: null,
                logs: initialLogs,
                stopRequested: false,
                stopTimer: null,
                restartTimestamps: [],
                lastCpuTicks: null,
                lastSampleAt: null,
                stats: {
                    memory_bytes: 0,
                    memory_limit_bytes: memoryMb * 1024 * 1024,
                    cpu_absolute: 0,
                    network: { rx_bytes: 0, tx_bytes: 0 },
                    uptime: 0,
                    state: 'offline',
                    disk_bytes: computeDirectorySize(this.getServerDir(uuid)),
                },
            };
            this.servers.set(uuid, managed);
        }
        managed.stats.memory_limit_bytes = Math.max(0, Number(memoryMb || 0)) * 1024 * 1024;
        return managed;
    }

    subscribe(uuid: string, listener: WsListener): () => void {
        if (!this.listeners.has(uuid)) {
            this.listeners.set(uuid, new Set());
        }
        this.listeners.get(uuid)!.add(listener);
        return () => {
            const set = this.listeners.get(uuid);
            if (set) {
                set.delete(listener);
                if (set.size === 0) this.listeners.delete(uuid);
            }
        };
    }

    emit(uuid: string, event: string, data: string): void {
        const set = this.listeners.get(uuid);
        if (!set) return;
        for (const cb of set) {
            try {
                cb(event, data);
            } catch {
                // ignore listener failure
            }
        }
    }

    private appendLog(uuid: string, managed: ManagedServer, line: string, wsEvent = 'console output'): void {
        const clean = line.replace(/\r?\n$/, '');
        managed.logs.push(clean);
        if (managed.logs.length > MAX_LOG_BUFFER) {
            managed.logs.shift();
        }
        try {
            fs.appendFileSync(path.join(config.paths.logsDir, `server-${uuid}.log`), clean + '\n');
        } catch {
            // ignore
        }
        this.emit(uuid, wsEvent, clean);
    }

    getLogs(uuid: string): string[] {
        return this.servers.get(uuid)?.logs || [];
    }

    async getStats(serverId: number, uuid: string, memoryMb: number): Promise<ServerStats> {
        const managed = this.getOrCreateManaged(serverId, uuid, memoryMb);
        managed.stats.disk_bytes = computeDirectorySize(this.getServerDir(uuid));
        managed.stats.uptime = managed.startedAt ? Date.now() - managed.startedAt : 0;
        managed.stats.state = managed.state;
        return { ...managed.stats };
    }

    getState(uuid: string): ServerPowerState {
        return this.servers.get(uuid)?.state || 'offline';
    }

    private async loadServerContext(serverId: number) {
        const server = await db.queryOne<any>(
            `SELECT s.*, e.software_type, e.config_stop, e.config_startup, a.port AS primary_port, a.ip AS primary_ip
             FROM servers s
             JOIN eggs e ON e.id = s.egg_id
             LEFT JOIN allocations a ON a.id = s.allocation_id
             WHERE s.id = ?`,
            [serverId]
        );
        if (!server) throw new Error('Server not found');
        const vars = await db.query<{ env_variable: string; variable_value: string }>(
            `SELECT ev.env_variable, COALESCE(sv.variable_value, ev.default_value) AS variable_value
             FROM egg_variables ev
             LEFT JOIN server_variables sv ON sv.variable_id = ev.id AND sv.server_id = ?
             WHERE ev.egg_id = ?`,
            [serverId, server.egg_id]
        );
        const envMap: Record<string, string> = {};
        for (const v of vars) {
            envMap[v.env_variable] = v.variable_value;
        }
        return { server, envMap };
    }

    async installServer(serverId: number): Promise<void> {
        const { server, envMap } = await this.loadServerContext(serverId);
        const managed = this.getOrCreateManaged(server.id, server.uuid, server.memory);
        const serverDir = this.getServerDir(server.uuid);

        await db.execute("UPDATE servers SET status = 'installing' WHERE id = ?", [server.id]);
        this.emit(server.uuid, 'install started', '');

        try {
            const software = (server.software_type || 'paper') as SupportedSoftware;
            const mcVersion = envMap.MINECRAFT_VERSION || 'latest';
            const jarFile = envMap.SERVER_JARFILE || 'server.jar';

            const { installedMcVersion } = await installMinecraftServer({
                serverDir,
                software,
                mcVersion,
                jarFile,
                buildNumber: envMap.BUILD_NUMBER,
                loaderVersion: envMap.LOADER_VERSION,
                forgeVersion: envMap.FORGE_VERSION,
                neoforgeVersion: envMap.NEOFORGE_VERSION,
                serverPort: server.primary_port || 25565,
                serverName: server.name,
                acceptEula: true,
                onLog: (line) => this.appendLog(server.uuid, managed, line, 'install output'),
            });

            try {
                fs.writeFileSync(path.join(serverDir, '.mc-version'), installedMcVersion + '\n');
            } catch {
                // ignore
            }

            await db.execute('UPDATE servers SET status = NULL, installed_at = CURRENT_TIMESTAMP WHERE id = ?', [
                server.id,
            ]);
            this.emit(server.uuid, 'install completed', '');
        } catch (err) {
            const msg = `Installation failed: ${(err as Error).message}`;
            this.appendLog(server.uuid, managed, msg, 'daemon error');
            await db.execute('UPDATE servers SET status = NULL WHERE id = ?', [server.id]);
            this.emit(server.uuid, 'install completed', '');
            throw err;
        }
    }

    async handlePowerAction(serverId: number, signal: 'start' | 'stop' | 'restart' | 'kill'): Promise<void> {
        const { server } = await this.loadServerContext(serverId);
        if (server.status === 'suspended') {
            throw new Error('Server is suspended');
        }
        if (server.status === 'installing') {
            throw new Error('Server is currently installing');
        }

        switch (signal) {
            case 'start':
                await this.startServer(serverId);
                break;
            case 'stop':
                await this.stopServer(serverId, false);
                break;
            case 'kill':
                await this.stopServer(serverId, true);
                break;
            case 'restart':
                await this.stopServer(serverId, false);
                await this.waitForOffline(server.uuid, 16000);
                await this.startServer(serverId);
                break;
        }
    }

    private async waitForOffline(uuid: string, timeoutMs: number): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.getState(uuid) === 'offline') return;
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    async startServer(serverId: number): Promise<void> {
        const { server, envMap } = await this.loadServerContext(serverId);
        const managed = this.getOrCreateManaged(server.id, server.uuid, server.memory);
        if (managed.process && managed.state !== 'offline') {
            return;
        }

        const serverDir = this.getServerDir(server.uuid);
        let mcVersion = envMap.MINECRAFT_VERSION || 'latest';
        if (mcVersion === 'latest' && fs.existsSync(path.join(serverDir, '.mc-version'))) {
            const detected = fs.readFileSync(path.join(serverDir, '.mc-version'), 'utf8').trim();
            if (detected) mcVersion = detected;
        }
        const jarFile = envMap.SERVER_JARFILE || 'server.jar';

        const defaultJavaSetting = await db.queryOne<{ value: string }>(
            "SELECT value FROM settings WHERE `key` = 'settings:java:default_path'"
        );

        const javaCheck = await selectJavaRuntime({
            requestedImage: server.image,
            mcVersion,
            overridePath: server.java_path || undefined,
            defaultPath: defaultJavaSetting?.value || config.defaultJavaPath || undefined,
        });

        if (!javaCheck.runtime || !javaCheck.compatible) {
            const errMsg = javaCheck.reason || `Compatible Java (${javaCheck.requiredMajor}+) is required.`;
            this.appendLog(server.uuid, managed, errMsg, 'daemon error');
            throw new Error(errMsg);
        }

        // Ensure server.properties & eula.txt match allocation & EULA
        writeServerProperties(serverDir, server.primary_port || 25565, server.name);
        if (!fs.existsSync(path.join(serverDir, 'eula.txt'))) {
            writeEulaFile(serverDir, true);
        }

        // Auto-install server software if JAR does not exist yet
        const jarPath = path.join(serverDir, jarFile);
        if (!jarFile.startsWith('@') && !fs.existsSync(jarPath)) {
            this.appendLog(
                server.uuid,
                managed,
                `Server JAR "${jarFile}" missing — running automatic ${server.software_type} installer...`,
                'daemon message'
            );
            await this.installServer(serverId);
        }

        // Build safe Java arguments without shell execution; omit -Xmx when memory is 0 (Unlimited)
        const jvmArgs = buildJavaLaunchArgs(
            server.startup,
            {
                ...envMap,
                SERVER_MEMORY: server.memory,
                SERVER_IP: server.primary_ip || '0.0.0.0',
                SERVER_PORT: server.primary_port || 25565,
            },
            Number(server.memory || 0)
        );

        managed.state = 'starting';
        managed.stopRequested = false;
        managed.startedAt = Date.now();
        this.emit(server.uuid, 'status', 'starting');
        this.appendLog(
            server.uuid,
            managed,
            `Starting Minecraft server using ${javaCheck.runtime.path} (Java ${javaCheck.runtime.rawVersion})`,
            'daemon message'
        );

        const child = spawn(javaCheck.runtime.path, jvmArgs, {
            cwd: serverDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                HOME: serverDir,
                TERM: 'xterm-256color',
            },
        });

        managed.process = child;

        let doneToken = ')! For help, type ';
        try {
            const parsedStartup = JSON.parse(server.config_startup || '{}');
            if (parsedStartup.done) doneToken = parsedStartup.done;
        } catch {
            // use default
        }

        const handleData = (chunk: Buffer) => {
            const lines = chunk.toString('utf8').split(/\r?\n/);
            for (const line of lines) {
                if (!line) continue;
                this.appendLog(server.uuid, managed, line, 'console output');
                if (managed.state === 'starting' && line.includes(doneToken)) {
                    managed.state = 'running';
                    this.emit(server.uuid, 'status', 'running');
                }
            }
        };

        child.stdout?.on('data', handleData);
        child.stderr?.on('data', handleData);

        // Fallback: transition starting -> running if process stays alive > 5s and emits logs
        setTimeout(() => {
            if (managed.process === child && managed.state === 'starting') {
                managed.state = 'running';
                this.emit(server.uuid, 'status', 'running');
            }
        }, 5000);

        child.on('error', (err) => {
            this.appendLog(server.uuid, managed, `Process error: ${err.message}`, 'daemon error');
            managed.process = null;
            managed.state = 'offline';
            managed.startedAt = null;
            this.emit(server.uuid, 'status', 'offline');
        });

        child.on('close', (code, signal) => {
            if (managed.stopTimer) {
                clearTimeout(managed.stopTimer);
                managed.stopTimer = null;
            }
            const wasStopRequested = managed.stopRequested;
            managed.process = null;
            managed.state = 'offline';
            managed.startedAt = null;
            managed.stats.cpu_absolute = 0;
            managed.stats.memory_bytes = 0;
            managed.stats.uptime = 0;
            this.emit(server.uuid, 'status', 'offline');
            this.appendLog(
                server.uuid,
                managed,
                `Server process exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`,
                'daemon message'
            );

            // Auto-restart policy
            const policy = server.restart_policy || 'on-failure';
            const shouldRestart = !wasStopRequested && (policy === 'always' || (policy === 'on-failure' && code !== 0));
            if (shouldRestart) {
                const now = Date.now();
                managed.restartTimestamps = managed.restartTimestamps.filter((t) => now - t < 60_000);
                if (managed.restartTimestamps.length < 3) {
                    managed.restartTimestamps.push(now);
                    this.appendLog(server.uuid, managed, 'Auto-restarting server in 3 seconds...', 'daemon message');
                    setTimeout(() => {
                        this.startServer(serverId).catch((e) =>
                            this.appendLog(server.uuid, managed, `Auto-restart failed: ${e.message}`, 'daemon error')
                        );
                    }, 3000);
                } else {
                    this.appendLog(
                        server.uuid,
                        managed,
                        'Crash loop detected (>3 exits in 60s); automatic restart paused.',
                        'daemon error'
                    );
                }
            }
        });
    }

    async stopServer(serverId: number, forceKill = false): Promise<void> {
        const { server } = await this.loadServerContext(serverId);
        const managed = this.servers.get(server.uuid);
        if (!managed || !managed.process) {
            if (managed) {
                managed.state = 'offline';
                this.emit(server.uuid, 'status', 'offline');
            }
            return;
        }

        managed.stopRequested = true;
        managed.state = 'stopping';
        this.emit(server.uuid, 'status', 'stopping');

        if (forceKill) {
            managed.process.kill('SIGKILL');
            return;
        }

        const stopCmd = server.config_stop || 'stop';
        try {
            if (managed.process.stdin?.writable) {
                managed.process.stdin.write(stopCmd + '\n');
            }
        } catch {
            // ignore
        }

        managed.stopTimer = setTimeout(() => {
            if (managed.process) {
                this.appendLog(server.uuid, managed, 'Graceful stop timed out; sending SIGTERM...', 'daemon message');
                managed.process.kill('SIGTERM');
                setTimeout(() => {
                    if (managed.process) {
                        managed.process.kill('SIGKILL');
                    }
                }, 5000);
            }
        }, 15000);
    }

    sendCommand(uuid: string, command: string): void {
        const managed = this.servers.get(uuid);
        if (!managed || !managed.process || !managed.process.stdin?.writable) {
            throw new Error('Server is not running');
        }
        managed.process.stdin.write(command + '\n');
    }

    async stopAllServers(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const managed of this.servers.values()) {
            if (managed.process) {
                promises.push(this.stopServer(managed.serverId, false));
            }
        }
        await Promise.allSettled(promises);
    }

    private async sampleAllServers(): Promise<void> {
        const net = readHostNetworkBytes();
        const now = Date.now();

        for (const managed of this.servers.values()) {
            if (managed.process?.pid && managed.state !== 'offline') {
                const procStats = readProcessMemoryAndCpu(managed.process.pid);
                if (procStats) {
                    managed.stats.memory_bytes = procStats.rssBytes;
                    if (managed.lastCpuTicks !== null && managed.lastSampleAt !== null) {
                        const dtSec = Math.max(0.1, (now - managed.lastSampleAt) / 1000);
                        const dTicks = Math.max(0, procStats.cpuTicks - managed.lastCpuTicks);
                        // Linux USER_HZ is typically 100 ticks/sec
                        managed.stats.cpu_absolute = Number(((dTicks / 100 / dtSec) * 100).toFixed(2));
                    }
                    managed.lastCpuTicks = procStats.cpuTicks;
                    managed.lastSampleAt = now;
                }
                managed.stats.uptime = managed.startedAt ? now - managed.startedAt : 0;
                managed.stats.network = { rx_bytes: net.rx, tx_bytes: net.tx };
                managed.stats.state = managed.state;
                this.emit(managed.uuid, 'stats', JSON.stringify(managed.stats));
            }
        }
    }
}

export const processManager = new ServerProcessManager();
