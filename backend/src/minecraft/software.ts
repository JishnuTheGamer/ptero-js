import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';
import { selectJavaRuntime } from './java';

export type SupportedSoftware = 'paper' | 'purpur' | 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'spigot' | 'folia';

export interface InstallOptions {
    serverDir: string;
    software: SupportedSoftware;
    mcVersion: string;
    jarFile: string;
    buildNumber?: string;
    loaderVersion?: string;
    forgeVersion?: string;
    neoforgeVersion?: string;
    serverPort: number;
    serverName: string;
    acceptEula?: boolean;
    onLog?: (line: string) => void;
}

const USER_AGENT = 'Pterodactyl-Node/1.15.2 (https://pterodactyl.io)';

async function fetchJson<T = any>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return await res.text();
}

async function downloadFileVerified(
    url: string,
    destPath: string,
    expectedHash?: { algorithm: 'sha256' | 'sha1' | 'md5'; digest: string },
    onLog?: (line: string) => void
): Promise<void> {
    onLog?.(`Downloading ${url}`);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`Download failed (${res.status}) from ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());

    if (expectedHash && expectedHash.digest) {
        const actual = crypto.createHash(expectedHash.algorithm).update(buf).digest('hex').toLowerCase();
        if (actual !== expectedHash.digest.toLowerCase()) {
            throw new Error(
                `Checksum mismatch (${expectedHash.algorithm}): expected ${expectedHash.digest}, got ${actual}`
            );
        }
        onLog?.(`Verified ${expectedHash.algorithm.toUpperCase()} checksum: ${actual}`);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(destPath)) {
        fs.copyFileSync(destPath, `${destPath}.old`);
    }
    fs.writeFileSync(destPath, buf);
}

async function runJavaCommand(javaPath: string, args: string[], cwd: string, onLog?: (line: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const proc = spawn(javaPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', (chunk) => {
            for (const line of chunk.toString().split(/\r?\n/)) {
                if (line.trim()) onLog?.(line);
            }
        });
        proc.stderr.on('data', (chunk) => {
            for (const line of chunk.toString().split(/\r?\n/)) {
                if (line.trim()) onLog?.(line);
            }
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Java installer exited with code ${code}`));
        });
    });
}

export function writeServerProperties(serverDir: string, port: number, motd: string): void {
    const propsPath = path.join(serverDir, 'server.properties');
    const defaults: Record<string, string> = {
        'server-ip': '0.0.0.0',
        'server-port': String(port),
        'query.port': String(port),
        motd: motd || 'A Minecraft Server',
        'enable-query': 'false',
        'max-players': '20',
        'online-mode': 'true',
        'view-distance': '10',
    };

    let existingLines: string[] = [];
    if (fs.existsSync(propsPath)) {
        existingLines = fs.readFileSync(propsPath, 'utf8').split(/\r?\n/);
    }

    const updatedKeys = new Set<string>();
    const outLines = existingLines.map((line) => {
        if (!line || line.trim().startsWith('#') || !line.includes('=')) return line;
        const eqIdx = line.indexOf('=');
        const key = line.slice(0, eqIdx).trim();
        if (key === 'server-ip' || key === 'server-port' || key === 'query.port') {
            updatedKeys.add(key);
            return `${key}=${defaults[key]}`;
        }
        updatedKeys.add(key);
        return line;
    });

    for (const [k, v] of Object.entries(defaults)) {
        if (!updatedKeys.has(k)) {
            outLines.push(`${k}=${v}`);
        }
    }

    fs.writeFileSync(propsPath, outLines.filter((l, idx) => idx === 0 || l !== '' || idx < outLines.length - 1).join('\n') + '\n');
}

export function writeEulaFile(serverDir: string, accepted = true): void {
    const eulaPath = path.join(serverDir, 'eula.txt');
    const content = [
        '# By changing the setting below to TRUE you are indicating your agreement to our Mojang EULA (https://aka.ms/MinecraftEULA).',
        `# Generated by Pterodactyl Node.js Panel on ${new Date().toISOString()}`,
        `eula=${accepted ? 'true' : 'false'}`,
        '',
    ].join('\n');
    fs.writeFileSync(eulaPath, content);
}

async function installPaperLike(project: 'paper' | 'folia', opts: InstallOptions): Promise<string> {
    const log = opts.onLog;
    const projData = await fetchJson<{ versions: Record<string, string[]> }>(
        `https://fill.papermc.io/v3/projects/${project}`
    );
    const allVersions = Object.values(projData.versions || {}).flat();
    if (allVersions.length === 0) throw new Error(`No ${project} versions returned from PaperMC Fill v3 API`);

    const stableVersions = allVersions.filter((v) => !/-(rc|pre|snapshot)/i.test(v));
    const latestStable = stableVersions[0] || allVersions[0];

    let mcVersion = opts.mcVersion && opts.mcVersion !== 'latest' ? opts.mcVersion : latestStable;
    if (!allVersions.includes(mcVersion)) {
        log?.(`Requested ${project} version ${mcVersion} not found; using latest ${latestStable}`);
        mcVersion = latestStable;
    }

    const builds = await fetchJson<
        Array<{
            id: number;
            channel?: string;
            downloads?: Record<string, { name: string; url: string; checksums?: { sha256?: string } }>;
        }>
    >(`https://fill.papermc.io/v3/projects/${project}/versions/${encodeURIComponent(mcVersion)}/builds`);
    if (!Array.isArray(builds) || builds.length === 0) {
        throw new Error(`No builds available for ${project} ${mcVersion}`);
    }

    let selectedBuild = builds.find((b) => b.channel === 'STABLE') || builds[0];
    if (opts.buildNumber && opts.buildNumber !== 'latest') {
        const requestedId = Number(opts.buildNumber);
        const match = builds.find((b) => b.id === requestedId);
        if (match) selectedBuild = match;
    }

    const dl = selectedBuild.downloads?.['server:default'] || Object.values(selectedBuild.downloads || {})[0];
    if (!dl || !dl.url) {
        throw new Error(`No server download artifact found for ${project} ${mcVersion} build #${selectedBuild.id}`);
    }

    const destPath = path.join(opts.serverDir, opts.jarFile || 'server.jar');
    await downloadFileVerified(
        dl.url,
        destPath,
        dl.checksums?.sha256 ? { algorithm: 'sha256', digest: dl.checksums.sha256 } : undefined,
        log
    );
    return mcVersion;
}

async function installPurpur(opts: InstallOptions): Promise<string> {
    const log = opts.onLog;
    const projData = await fetchJson<{ versions: string[] }>('https://api.purpurmc.org/v2/purpur');
    const versions = projData.versions || [];
    if (versions.length === 0) throw new Error('No Purpur versions returned from API');

    let mcVersion = opts.mcVersion && opts.mcVersion !== 'latest' ? opts.mcVersion : versions[versions.length - 1];
    if (!versions.includes(mcVersion)) {
        mcVersion = versions[versions.length - 1];
    }

    const verData = await fetchJson<{ builds: { latest: string; all: string[] } }>(
        `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mcVersion)}`
    );
    const buildId =
        opts.buildNumber && opts.buildNumber !== 'latest' && verData.builds.all.includes(opts.buildNumber)
            ? opts.buildNumber
            : verData.builds.latest;

    const buildInfo = await fetchJson<{ md5: string }>(
        `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mcVersion)}/${encodeURIComponent(buildId)}`
    );
    const url = `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mcVersion)}/${encodeURIComponent(buildId)}/download`;
    const destPath = path.join(opts.serverDir, opts.jarFile || 'server.jar');
    await downloadFileVerified(url, destPath, { algorithm: 'md5', digest: buildInfo.md5 }, log);
    return mcVersion;
}

async function installVanilla(opts: InstallOptions): Promise<string> {
    const log = opts.onLog;
    const manifest = await fetchJson<{
        latest: { release: string };
        versions: Array<{ id: string; url: string }>;
    }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');

    const targetId = opts.mcVersion && opts.mcVersion !== 'latest' ? opts.mcVersion : manifest.latest.release;
    const entry = manifest.versions.find((v) => v.id === targetId) || manifest.versions.find((v) => v.id === manifest.latest.release);
    if (!entry) throw new Error(`Vanilla version ${targetId} not found in Mojang manifest`);

    const pkg = await fetchJson<{ downloads: { server?: { url: string; sha1: string } } }>(entry.url);
    if (!pkg.downloads.server) {
        throw new Error(`No server download available for Vanilla ${entry.id}`);
    }
    const destPath = path.join(opts.serverDir, opts.jarFile || 'server.jar');
    await downloadFileVerified(
        pkg.downloads.server.url,
        destPath,
        { algorithm: 'sha1', digest: pkg.downloads.server.sha1 },
        log
    );
    return entry.id;
}

async function installFabric(opts: InstallOptions): Promise<string> {
    const log = opts.onLog;
    const gameVersions = await fetchJson<Array<{ version: string; stable: boolean }>>('https://meta.fabricmc.net/v2/versions/game');
    const stableGames = gameVersions.filter((g) => g.stable);
    const mcVersion =
        opts.mcVersion && opts.mcVersion !== 'latest' && gameVersions.some((g) => g.version === opts.mcVersion)
            ? opts.mcVersion
            : stableGames[0]?.version || gameVersions[0]?.version;

    const loaders = await fetchJson<Array<{ version: string; stable: boolean }>>('https://meta.fabricmc.net/v2/versions/loader');
    const loaderVer =
        opts.loaderVersion && opts.loaderVersion !== 'latest' && loaders.some((l) => l.version === opts.loaderVersion)
            ? opts.loaderVersion
            : loaders.find((l) => l.stable)?.version || loaders[0]?.version;

    const installers = await fetchJson<Array<{ version: string; stable: boolean }>>('https://meta.fabricmc.net/v2/versions/installer');
    const installerVer = installers.find((i) => i.stable)?.version || installers[0]?.version;

    if (!mcVersion || !loaderVer || !installerVer) {
        throw new Error('Could not resolve Fabric version metadata');
    }

    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(
        loaderVer
    )}/${encodeURIComponent(installerVer)}/server/jar`;
    const destPath = path.join(opts.serverDir, opts.jarFile || 'fabric-server-launch.jar');
    await downloadFileVerified(url, destPath, undefined, log);
    return mcVersion;
}

async function installForge(opts: InstallOptions): Promise<string> {
    const log = opts.onLog;
    const promoData = await fetchJson<{ promos: Record<string, string> }>(
        'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
    );
    let mcVersion = opts.mcVersion && opts.mcVersion !== 'latest' ? opts.mcVersion : '1.20.1';
    let forgeVer = opts.forgeVersion && opts.forgeVersion !== 'recommended' && opts.forgeVersion !== 'latest' ? opts.forgeVersion : '';

    if (!forgeVer) {
        forgeVer = promoData.promos[`${mcVersion}-recommended`] || promoData.promos[`${mcVersion}-latest`] || '';
    }
    if (!forgeVer) {
        // Pick newest recommended version from promotions
        const keys = Object.keys(promoData.promos).filter((k) => k.endsWith('-recommended'));
        const latestKey = keys[keys.length - 1];
        if (!latestKey) throw new Error('Could not resolve Forge version');
        mcVersion = latestKey.replace(/-recommended$/, '');
        forgeVer = promoData.promos[latestKey];
    }

    const fullVer = `${mcVersion}-${forgeVer}`;
    const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
    const installerPath = path.join(opts.serverDir, `forge-${fullVer}-installer.jar`);
    await downloadFileVerified(installerUrl, installerPath, undefined, log);

    const javaSel = await selectJavaRuntime({ mcVersion });
    if (!javaSel.runtime || !javaSel.compatible) {
        throw new Error(javaSel.reason || 'Compatible Java runtime required to run Forge installer');
    }

    log?.(`Running Forge installer with Java ${javaSel.runtime.majorVersion}...`);
    await runJavaCommand(javaSel.runtime.path, ['-jar', installerPath, '--installServer'], opts.serverDir, log);
    fs.rmSync(installerPath, { force: true });

    // Create compatibility shim or note unix_args.txt
    const unixArgs = path.join(opts.serverDir, 'libraries/net/minecraftforge/forge', fullVer, 'unix_args.txt');
    const serverJarDest = path.join(opts.serverDir, opts.jarFile || 'server.jar');
    if (!fs.existsSync(serverJarDest) && !fs.existsSync(unixArgs)) {
        const files = fs.readdirSync(opts.serverDir);
        const foundJar = files.find((f) => f.startsWith(`forge-${fullVer}`) && f.endsWith('.jar') && !f.includes('installer'));
        if (foundJar) {
            fs.copyFileSync(path.join(opts.serverDir, foundJar), serverJarDest);
        }
    }
    return mcVersion;
}

async function installNeoForge(opts: InstallOptions): Promise<string> {
    const log = opts.onLog;
    const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const versions = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g)).map((m) => m[1]);
    if (versions.length === 0) throw new Error('No NeoForge versions found in NeoForged Maven');

    let selected = opts.neoforgeVersion && opts.neoforgeVersion !== 'latest' ? opts.neoforgeVersion : '';
    if (!selected && opts.mcVersion && opts.mcVersion !== 'latest') {
        const prefix = opts.mcVersion.replace(/^1\./, '');
        const matching = versions.filter((v) => v.startsWith(prefix));
        selected = matching[matching.length - 1] || '';
    }
    if (!selected) {
        selected = versions[versions.length - 1];
    }

    const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${selected}/neoforge-${selected}-installer.jar`;
    const installerPath = path.join(opts.serverDir, `neoforge-${selected}-installer.jar`);
    await downloadFileVerified(installerUrl, installerPath, undefined, log);

    const javaSel = await selectJavaRuntime({ mcVersion: opts.mcVersion });
    if (!javaSel.runtime || !javaSel.compatible) {
        throw new Error(javaSel.reason || 'Compatible Java runtime required to run NeoForge installer');
    }

    log?.(`Running NeoForge installer (${selected})...`);
    await runJavaCommand(javaSel.runtime.path, ['-jar', installerPath, '--installServer'], opts.serverDir, log);
    fs.rmSync(installerPath, { force: true });
    return opts.mcVersion || 'latest';
}

async function installSpigot(opts: InstallOptions): Promise<string> {
    const log = opts.onLog;
    const buildDir = path.join(opts.serverDir, '.spigot-buildtools');
    fs.mkdirSync(buildDir, { recursive: true });
    const btJar = path.join(buildDir, 'BuildTools.jar');
    await downloadFileVerified(
        'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar',
        btJar,
        undefined,
        log
    );

    const mcVersion = opts.mcVersion && opts.mcVersion !== 'latest' ? opts.mcVersion : 'latest';
    const javaSel = await selectJavaRuntime({ mcVersion });
    if (!javaSel.runtime || !javaSel.compatible) {
        throw new Error(javaSel.reason || 'Compatible Java runtime required for Spigot BuildTools');
    }

    log?.(`Compiling Spigot (${mcVersion}) via official BuildTools...`);
    await runJavaCommand(javaSel.runtime.path, ['-Xmx1024M', '-jar', btJar, '--rev', mcVersion], buildDir, log);

    const builtFiles = fs.readdirSync(buildDir).filter((f) => /^spigot-.*\.jar$/.test(f));
    if (builtFiles.length === 0) {
        throw new Error('BuildTools completed but no spigot-*.jar artifact was produced');
    }
    fs.copyFileSync(path.join(buildDir, builtFiles[0]), path.join(opts.serverDir, opts.jarFile || 'spigot.jar'));
    fs.rmSync(buildDir, { recursive: true, force: true });
    return mcVersion;
}

export async function installMinecraftServer(opts: InstallOptions): Promise<{ installedMcVersion: string }> {
    fs.mkdirSync(opts.serverDir, { recursive: true });
    const log = opts.onLog;
    log?.(`Starting Minecraft (${opts.software}) installation in ${opts.serverDir}`);

    let installedMcVersion = opts.mcVersion || 'latest';

    switch (opts.software) {
        case 'paper':
            installedMcVersion = await installPaperLike('paper', opts);
            break;
        case 'folia':
            installedMcVersion = await installPaperLike('folia', opts);
            break;
        case 'purpur':
            installedMcVersion = await installPurpur(opts);
            break;
        case 'vanilla':
            installedMcVersion = await installVanilla(opts);
            break;
        case 'fabric':
            installedMcVersion = await installFabric(opts);
            break;
        case 'forge':
            installedMcVersion = await installForge(opts);
            break;
        case 'neoforge':
            installedMcVersion = await installNeoForge(opts);
            break;
        case 'spigot':
            installedMcVersion = await installSpigot(opts);
            break;
        default:
            throw new Error(`Unsupported Minecraft software type: ${opts.software}`);
    }

    writeServerProperties(opts.serverDir, opts.serverPort, opts.serverName);
    writeEulaFile(opts.serverDir, opts.acceptEula !== false);
    log?.(`Minecraft (${opts.software} ${installedMcVersion}) installation complete.`);
    logger.info('Minecraft server installed', { software: opts.software, mcVersion: installedMcVersion, dir: opts.serverDir });

    return { installedMcVersion };
}
