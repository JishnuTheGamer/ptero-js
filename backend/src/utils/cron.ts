export interface CronExpression {
    minute: string;
    hour: string;
    dayOfMonth: string;
    month: string;
    dayOfWeek: string;
}

function parseField(expr: string, min: number, max: number): Set<number> {
    const result = new Set<number>();
    const parts = expr.split(',');

    for (const rawPart of parts) {
        const part = rawPart.trim();
        if (!part) throw new Error(`Invalid cron field: "${expr}"`);

        const [rangeStr, stepStr] = part.split('/');
        const step = stepStr ? Number(stepStr) : 1;
        if (!Number.isInteger(step) || step <= 0) {
            throw new Error(`Invalid cron step in "${part}"`);
        }

        let start = min;
        let end = max;
        if (rangeStr !== '*') {
            if (rangeStr.includes('-')) {
                const [a, b] = rangeStr.split('-').map(Number);
                if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) {
                    throw new Error(`Invalid cron range "${rangeStr}" (${min}-${max})`);
                }
                start = a;
                end = b;
            } else {
                const single = Number(rangeStr);
                if (!Number.isInteger(single) || single < min || single > max) {
                    throw new Error(`Invalid cron value "${rangeStr}" (${min}-${max})`);
                }
                start = single;
                end = stepStr ? max : single;
            }
        }

        for (let v = start; v <= end; v += step) {
            result.add(v);
        }
    }

    if (result.size === 0) {
        throw new Error(`Empty cron field: "${expr}"`);
    }
    return result;
}

export function validateCron(cron: CronExpression): void {
    parseField(cron.minute, 0, 59);
    parseField(cron.hour, 0, 23);
    parseField(cron.dayOfMonth, 1, 31);
    parseField(cron.month, 1, 12);
    parseField(cron.dayOfWeek, 0, 7);
}

export function matchesCron(cron: CronExpression, date: Date): boolean {
    const minutes = parseField(cron.minute, 0, 59);
    const hours = parseField(cron.hour, 0, 23);
    const daysOfMonth = parseField(cron.dayOfMonth, 1, 31);
    const months = parseField(cron.month, 1, 12);
    const rawDaysOfWeek = parseField(cron.dayOfWeek, 0, 7);
    const daysOfWeek = new Set<number>();
    for (const d of rawDaysOfWeek) {
        daysOfWeek.add(d === 7 ? 0 : d);
    }

    const m = date.getMinutes();
    const h = date.getHours();
    const dom = date.getDate();
    const mon = date.getMonth() + 1;
    const dow = date.getDay();

    const domWild = cron.dayOfMonth.trim() === '*';
    const dowWild = cron.dayOfWeek.trim() === '*';
    const dayMatches =
        domWild && dowWild
            ? true
            : domWild
              ? daysOfWeek.has(dow)
              : dowWild
                ? daysOfMonth.has(dom)
                : daysOfMonth.has(dom) || daysOfWeek.has(dow);

    return minutes.has(m) && hours.has(h) && months.has(mon) && dayMatches;
}

export function getNextCronDate(cron: CronExpression, fromDate = new Date()): Date {
    validateCron(cron);
    const candidate = new Date(fromDate.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Search up to 366 days ahead (527040 minutes)
    for (let i = 0; i < 527040; i++) {
        if (matchesCron(cron, candidate)) {
            return candidate;
        }
        candidate.setMinutes(candidate.getMinutes() + 1);
    }
    throw new Error('Could not compute next run date for cron expression within 1 year');
}
