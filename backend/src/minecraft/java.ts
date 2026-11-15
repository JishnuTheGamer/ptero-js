import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface JavaRuntime {
    path: string;
    majorVersion: number;
    rawVersion: string;
    vendor: string;
}

export function parseJavaVersion(output: string): { major: number; raw: string } | null {
    const m = output.match(/version\s+"([^"]+)"/i);
    if (!m) return null;
    const raw = m[1];
    const parts = raw.split(/[._+-]/);
    const first = Number(parts[0]);
    if (Number.isNaN(first)) return null;
    if (first === 1 && parts.length > 1) {
        const second = Number(parts[1]);
        return Number.isNaN(second) ? null : { major: second, raw };
    }
    return { major: first, raw };
}

export function requiredJavaForMinecraft(mcVersion: string): number {
    const clean = (mcVersion || '').trim().toLowerCase();
    if (!clean || clean === 'latest') return 25;

    const yearMatch = clean.match(/^(\d{2,})\.(\d+)/);
    if (yearMatch) {
        const yearMajor = Number(yearMatch[1]);
        if (yearMajor >= 26) return 25;
    }

    const match = clean.match(/^1\.(\d+)(?:\.(\d+))?/);
    if (!match) return 21;
    const minor = Number(match[1]);
    const patch = Number(match[2] || 0);

    if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
    if (minor >= 18) return 17;
    if (minor === 17) return 16;
    if (minor >= 12) return 8;
    return 8;
}

export function parseRequestedJavaMajor(imageOrSpec?: string): number | null {
    if (!imageOrSpec) return null;
    const m = imageOrSpec.match(/java[:_\s-]*(\d+)/i);
    return m ? Number(m[1]) : null;
}

async function inspectJavaBinary(javaBin: string): Promise<JavaRuntime | null> {
    try {
        if (!fs.existsSync(javaBin)) return null;
        const { stdout, stderr } = await execFileAsync(javaBin, ['-version'], { timeout: 5000 });
        const combined = `${stderr || ''}\n${stdout || ''}`;
        const parsed = parseJavaVersion(combined);
        if (!parsed) return null;
        const lines = combined.split('\n').map((l) => l.trim()).filter(Boolean);
        return {
            path: javaBin,
            majorVersion: parsed.major,
            rawVersion: parsed.raw,
            vendor: lines[1] || 'OpenJDK',
        };
    } catch {
        return null;
    }
}

export async function discoverJavaRuntimes(): Promise<JavaRuntime[]> {
    const candidates = new Set<string>();

    if (config.defaultJavaPath) {
        candidates.add(config.defaultJavaPath);
    }

    // 1. Project-local runtime/java/*
    if (fs.existsSync(config.paths.javaRuntimeDir)) {
        for (const entry of fs.readdirSync(config.paths.javaRuntimeDir)) {
            const bin = path.join(config.paths.javaRuntimeDir, entry, 'bin', 'java');
            candidates.add(bin);
        }
    }

    // 2. Standard Linux JVM paths
    for (const base of ['/usr/lib/jvm', '/opt/java', '/usr/java']) {
        if (fs.existsSync(base)) {
            for (const entry of fs.readdirSync(base)) {
                candidates.add(path.join(base, entry, 'bin', 'java'));
            }
        }
    }

    // 3. System PATH java
    for (const p of (process.env.PATH || '').split(path.delimiter)) {
        if (p) candidates.add(path.join(p, 'java'));
    }

    const found: JavaRuntime[] = [];
    const seenReal = new Set<string>();

    for (const candidate of candidates) {
        const runtime = await inspectJavaBinary(candidate);
        if (!runtime) continue;
        let real = runtime.path;
        try {
            real = fs.realpathSync(runtime.path);
        } catch {
            // keep candidate path
        }
        if (seenReal.has(real)) continue;
        seenReal.add(real);
        found.push(runtime);
    }

    found.sort((a, b) => b.majorVersion - a.majorVersion);
    return found;
}

export async function selectJavaRuntime(opts: {
    requestedImage?: string;
    mcVersion?: string;
    overridePath?: string;
    defaultPath?: string;
}): Promise<{
    runtime: JavaRuntime | null;
    requiredMajor: number;
    compatible: boolean;
    reason?: string;
}> {
    const mcReq = requiredJavaForMinecraft(opts.mcVersion || 'latest');
    const explicitMajor = parseRequestedJavaMajor(opts.requestedImage);
    const requiredMajor = explicitMajor || mcReq;

    if (opts.overridePath) {
        const custom = await inspectJavaBinary(opts.overridePath);
        if (!custom) {
            return {
                runtime: null,
                requiredMajor,
                compatible: false,
                reason: `Configured Java executable not found or invalid: ${opts.overridePath}`,
            };
        }
        if (custom.majorVersion < mcReq) {
            return {
                runtime: custom,
                requiredMajor: mcReq,
                compatible: false,
                reason: `Minecraft ${opts.mcVersion || 'latest'} requires Java ${mcReq}+, but configured runtime is Java ${custom.majorVersion}.`,
            };
        }
        return { runtime: custom, requiredMajor, compatible: true };
    }

    const runtimes = await discoverJavaRuntimes();
    if (runtimes.length === 0) {
        return {
            runtime: null,
            requiredMajor,
            compatible: false,
            reason: `No Java runtime found on this machine. Install Java ${requiredMajor} (or run install.sh repair).`,
        };
    }

    // Prefer exact match to explicit requested major if compatible with MC version
    if (explicitMajor) {
        const exact = runtimes.find((r) => r.majorVersion === explicitMajor);
        if (exact) {
            if (exact.majorVersion < mcReq) {
                return {
                    runtime: exact,
                    requiredMajor: mcReq,
                    compatible: false,
                    reason: `Selected Java ${exact.majorVersion} is too old for Minecraft ${opts.mcVersion || 'latest'} (requires Java ${mcReq}+).`,
                };
            }
            return { runtime: exact, requiredMajor, compatible: true };
        }
    }

    // Prefer configured default Java if compatible
    if (opts.defaultPath) {
        const def = runtimes.find((r) => r.path === opts.defaultPath);
        if (def && def.majorVersion >= mcReq) {
            return { runtime: def, requiredMajor: mcReq, compatible: true };
        }
    }

    // Pick lowest compatible version >= mcReq (or highest available >= mcReq)
    const compatibleRuntimes = runtimes.filter((r) => r.majorVersion >= mcReq).sort((a, b) => a.majorVersion - b.majorVersion);
    if (compatibleRuntimes.length > 0) {
        return { runtime: compatibleRuntimes[0], requiredMajor: mcReq, compatible: true };
    }

    return {
        runtime: runtimes[0],
        requiredMajor: mcReq,
        compatible: false,
        reason: `Minecraft ${opts.mcVersion || 'latest'} requires Java ${mcReq}+, but highest installed version is Java ${runtimes[0].majorVersion}.`,
    };
}

export async function installTemurinJava(
    majorVersion: 8 | 11 | 17 | 21 | 25,
    onProgress?: (msg: string) => void
): Promise<JavaRuntime> {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const url = `https://api.adoptium.net/v3/binary/latest/${majorVersion}/ga/linux/${arch}/jre/hotspot/normal/eclipse`;
    const targetDir = path.join(config.paths.javaRuntimeDir, `temurin-${majorVersion}`);
    const archivePath = path.join(config.paths.javaRuntimeDir, `temurin-${majorVersion}.tar.gz`);

    fs.mkdirSync(targetDir, { recursive: true });
    onProgress?.(`Downloading Eclipse Temurin JRE ${majorVersion} (${arch})...`);
    logger.info('Downloading Temurin Java runtime', { majorVersion, arch, url });

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`Failed to download Temurin Java ${majorVersion}: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archivePath, buf);

    onProgress?.(`Extracting Temurin JRE ${majorVersion}...`);
    await new Promise<void>((resolve, reject) => {
        const tarProc = spawn('tar', ['-xzf', archivePath, '-C', targetDir, '--strip-components=1']);
        let stderr = '';
        tarProc.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        tarProc.on('error', reject);
        tarProc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar extraction failed (${code}): ${stderr}`));
        });
    });
    fs.rmSync(archivePath, { force: true });

    const javaBin = path.join(targetDir, 'bin', 'java');
    const runtime = await inspectJavaBinary(javaBin);
    if (!runtime) {
        throw new Error(`Installed Java ${majorVersion} binary verification failed at ${javaBin}`);
    }
    onProgress?.(`Installed Java ${runtime.rawVersion} at ${runtime.path}`);
    return runtime;
}
