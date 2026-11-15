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
