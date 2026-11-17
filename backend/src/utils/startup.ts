import fs from 'node:fs';
import os from 'node:os';

export interface StartupVariables {
    [key: string]: string | number | undefined;
}

export function renderStartupCommand(template: string, variables: StartupVariables): string {
    return template.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_match, key: string) => {
        const val = variables[key];
        return val === undefined || val === null ? '' : String(val);
    });
}

function isZeroXmxArg(arg: string): boolean {
    return /^-Xmx(?:0+[KMGkmg]?|[KMGkmg]?)$/i.test(arg);
}

function parseJvmMemToMb(arg: string): number | null {
    const m = arg.match(/^-Xm[sx](\d+)([KMGkmg]?)$/);
    if (!m) return null;
    const num = Number(m[1]);
    const unit = (m[2] || '').toUpperCase();
    if (unit === 'G') return num * 1024;
    if (unit === 'M') return num;
    if (unit === 'K') return Math.max(1, Math.floor(num / 1024));
    return Math.max(1, Math.floor(num / (1024 * 1024)));
}

export function detectHostMemoryLimitMb(): number {
    const osMemMb = Math.floor(os.totalmem() / (1024 * 1024));
    for (const cgPath of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
        try {
            if (!fs.existsSync(cgPath)) continue;
            const raw = fs.readFileSync(cgPath, 'utf8').trim();
            if (!raw || raw === 'max') continue;
            const bytes = Number(raw);
            if (Number.isFinite(bytes) && bytes > 0 && bytes < 1e15) {
                const cgMb = Math.floor(bytes / (1024 * 1024));
                return Math.min(osMemMb, cgMb);
            }
        } catch {
            // fallback to os.totalmem
        }
    }
    return osMemMb;
}

export function buildServerStartupCommand(template: string, variables: StartupVariables, memoryMb: number): string {
    const rendered = renderStartupCommand(template, variables);
    const args = parseCommandArgs(rendered);
    if (memoryMb <= 0) {
        return args.filter((arg) => !isZeroXmxArg(arg)).join(' ');
    }
    return rendered;
}

export function buildJavaLaunchArgs(template: string, variables: StartupVariables, memoryMb: number): string[] {
    const renderedCmd = renderStartupCommand(template, variables);
    const parsedArgs = parseCommandArgs(renderedCmd);
    let jvmArgs = parsedArgs[0] === 'java' ? parsedArgs.slice(1) : parsedArgs;

    if (memoryMb <= 0) {
        jvmArgs = jvmArgs.filter((arg) => !isZeroXmxArg(arg));
    } else if (!jvmArgs.some((arg) => arg.startsWith('-Xmx'))) {
        jvmArgs.unshift(`-Xmx${memoryMb}M`);
    }

    return jvmArgs;
}

const CUSTOM_GC_FLAGS = [
    '-XX:+UseG1GC',
    '-XX:+UseZGC',
    '-XX:+UseShenandoahGC',
    '-XX:+UseParallelGC',
    '-XX:+UseConcMarkSweepGC',
    '-XX:+UseSerialGC',
];

function hasCustomGcFlag(args: string[]): boolean {
    return args.some((arg) => CUSTOM_GC_FLAGS.includes(arg));
}

function isJavaServerCommand(args: string[]): boolean {
    return args.some(
        (arg) => arg === '-jar' || arg.startsWith('@') || arg.endsWith('.jar') || arg.startsWith('-X') || arg.startsWith('-D')
    );
}

function appendUniqueJvmFlags(target: string[], flags: string[], insertAt: number): number {
    const existingKeys = new Set(
        target.map((arg) => {
            const eq = arg.indexOf('=');
            return eq > 0 ? arg.slice(0, eq + 1) : arg;
        })
    );
    const toInsert = flags.filter((flag) => {
        const eq = flag.indexOf('=');
        const key = eq > 0 ? flag.slice(0, eq + 1) : flag;
        return !existingKeys.has(key);
    });
    if (toInsert.length > 0) {
        target.splice(insertAt, 0, ...toInsert);
    }
    return toInsert.length;
}

export function buildSafeServerJavaArgs(
    template: string,
    variables: StartupVariables,
    memoryMb: number,
    options?: { disableJline?: boolean; hostMemoryMb?: number; optimizeGc?: boolean }
): string[] {
    let jvmArgs = buildJavaLaunchArgs(template, variables, memoryMb);
    let effectiveXmxMb = memoryMb > 0 ? memoryMb : 0;

    if (memoryMb > 0) {
        const hostLimit = options?.hostMemoryMb ?? detectHostMemoryLimitMb();
        const hostCeiling = hostLimit > 0 ? Math.max(256, Math.floor(hostLimit * 0.85)) : memoryMb;
        const serverCeiling = Math.max(128, Math.floor(memoryMb * 0.85));
        const safeXmxMb = Math.min(serverCeiling, hostCeiling);
        effectiveXmxMb = safeXmxMb;

        jvmArgs = jvmArgs.filter((arg) => !arg.startsWith('-XX:MaxRAMPercentage'));

        let replacedXmx = false;
        let hasXms = false;
        jvmArgs = jvmArgs.map((arg) => {
            if (arg.startsWith('-Xmx')) {
                replacedXmx = true;
                const parsed = parseJvmMemToMb(arg);
                const capped = parsed !== null ? Math.min(parsed, safeXmxMb) : safeXmxMb;
                effectiveXmxMb = Math.max(128, capped);
                return `-Xmx${effectiveXmxMb}M`;
            }
            if (arg.startsWith('-Xms')) {
                hasXms = true;
                const parsed = parseJvmMemToMb(arg);
                if (parsed !== null && parsed > safeXmxMb) {
                    const cappedXms = Math.min(safeXmxMb, Math.max(128, Math.floor(safeXmxMb * 0.5)));
                    return `-Xms${cappedXms}M`;
                }
            }
            return arg;
        });
        if (!replacedXmx) {
            jvmArgs.unshift(`-Xmx${safeXmxMb}M`);
        }
        if (!hasXms && isJavaServerCommand(jvmArgs)) {
            const initialXms = Math.min(safeXmxMb, Math.max(128, Math.min(1024, Math.floor(safeXmxMb * 0.5))));
            jvmArgs.unshift(`-Xms${initialXms}M`);
        }
    } else {
        const xmxArg = jvmArgs.find((arg) => arg.startsWith('-Xmx'));
        const parsed = xmxArg ? parseJvmMemToMb(xmxArg) : null;
        effectiveXmxMb = parsed ?? 2048;
    }

    if (options?.optimizeGc !== false && isJavaServerCommand(jvmArgs) && !hasCustomGcFlag(jvmArgs)) {
        const isLargeHeap = effectiveXmxMb >= 12288;
        const regionSizeMb = isLargeHeap ? 16 : effectiveXmxMb < 2048 ? 4 : 8;
        const g1NewSize = isLargeHeap ? 40 : 30;
        const g1MaxNewSize = isLargeHeap ? 50 : 40;
        const g1Reserve = isLargeHeap ? 15 : 20;
        const ihop = isLargeHeap ? 20 : 15;

        const gcFlags = [
            '-XX:+UseG1GC',
            '-XX:+ParallelRefProcEnabled',
            '-XX:MaxGCPauseMillis=200',
            '-XX:+UnlockExperimentalVMOptions',
            '-XX:+DisableExplicitGC',
            `-XX:G1NewSizePercent=${g1NewSize}`,
            `-XX:G1MaxNewSizePercent=${g1MaxNewSize}`,
            `-XX:G1HeapRegionSize=${regionSizeMb}M`,
            `-XX:G1ReservePercent=${g1Reserve}`,
            '-XX:G1HeapWastePercent=5',
            '-XX:G1MixedGCCountTarget=4',
            `-XX:InitiatingHeapOccupancyPercent=${ihop}`,
            '-XX:G1MixedGCLiveThresholdPercent=90',
            '-XX:G1RSetUpdatingPauseTimePercent=5',
            '-XX:SurvivorRatio=32',
            '-XX:+PerfDisableSharedMem',
            '-XX:MaxTenuringThreshold=1',
            '-Dusing.aikars.flags=https://mcflags.emc.gs',
            '-Daikars.new.flags=true',
            '-Djava.net.preferIPv4Stack=true',
            '-Djava.security.egd=file:/dev/./urandom',
            '-Djava.awt.headless=true',
        ];
        const jarIdx = jvmArgs.findIndex((a) => a === '-jar' || a.startsWith('@'));
        const insertAt = jarIdx >= 0 ? jarIdx : 0;
        appendUniqueJvmFlags(jvmArgs, gcFlags, insertAt);
    }

    if (options?.disableJline !== false) {
        jvmArgs = jvmArgs.filter(
            (arg) => !arg.startsWith('-Dterminal.jline=') && !arg.startsWith('-Dterminal.ansi=')
        );
        const jarIdx = jvmArgs.findIndex((a) => a === '-jar' || a.startsWith('@'));
        const insertAt = jarIdx >= 0 ? jarIdx : 0;
        jvmArgs.splice(insertAt, 0, '-Dterminal.jline=false', '-Dterminal.ansi=false');
    }

    return jvmArgs;
}

/**
 * Splits a command string into an argv array without invoking a shell.
 * Supports single quotes, double quotes, and backslash escaping.
 */
export function parseCommandArgs(command: string): string[] {
    const args: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escape = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        if (escape) {
            current += ch;
            escape = false;
            continue;
        }

        if (ch === '\\' && !inSingle) {
            escape = true;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }

        if (/\s/.test(ch) && !inSingle && !inDouble) {
            if (current.length > 0) {
                args.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (inSingle || inDouble) {
        throw new Error('Unterminated quote in startup command');
    }

    if (current.length > 0) {
        args.push(current);
    }

    return args;
}

export function validateEggVariableValue(value: string, rulesStr: string): string | null {
    const rules = rulesStr
        .split('|')
        .map((r) => r.trim())
        .filter(Boolean);
    const isNullable = rules.includes('nullable');
    const isRequired = rules.includes('required');

    if (value === '' || value === undefined || value === null) {
        if (isRequired && !isNullable) {
            return 'This field is required.';
        }
        return null;
    }

    for (const rule of rules) {
        if (rule === 'required' || rule === 'nullable' || rule === 'string') {
            continue;
        }
        if (rule === 'numeric' || rule === 'integer') {
            const n = Number(value);
            if (Number.isNaN(n) || (rule === 'integer' && !Number.isInteger(n))) {
                return `Value must be a valid ${rule}.`;
            }
            continue;
        }
        if (rule === 'boolean') {
            if (!['true', 'false', '0', '1'].includes(value.toLowerCase())) {
                return 'Value must be a boolean.';
            }
            continue;
        }
        if (rule.startsWith('max:')) {
            const max = Number(rule.slice(4));
            if (rules.includes('numeric') || rules.includes('integer')) {
                if (Number(value) > max) return `Value may not be greater than ${max}.`;
            } else if (value.length > max) {
                return `Value may not be longer than ${max} characters.`;
            }
            continue;
        }
        if (rule.startsWith('min:')) {
            const min = Number(rule.slice(4));
            if (rules.includes('numeric') || rules.includes('integer')) {
                if (Number(value) < min) return `Value must be at least ${min}.`;
            } else if (value.length < min) {
                return `Value must be at least ${min} characters.`;
            }
            continue;
        }
        if (rule.startsWith('in:')) {
            const allowed = rule.slice(3).split(',');
            if (!allowed.includes(value)) {
                return `Value must be one of: ${allowed.join(', ')}.`;
            }
            continue;
        }
        if (rule.startsWith('regex:')) {
            let pattern = rule.slice(6);
            let flags = '';
            if (pattern.startsWith('/')) {
                const lastSlash = pattern.lastIndexOf('/');
                if (lastSlash > 0) {
                    flags = pattern.slice(lastSlash + 1);
                    pattern = pattern.slice(1, lastSlash);
                }
            }
            const re = new RegExp(pattern, flags);
            if (!re.test(value)) {
                return 'Value format is invalid.';
            }
        }
    }

    return null;
}
