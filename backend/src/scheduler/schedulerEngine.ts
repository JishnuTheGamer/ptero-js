import { createServerBackup } from '../backups/backupManager';
import { db } from '../database/connection';
import { processManager } from '../processes/ServerProcessManager';
import { getNextCronDate, matchesCron } from '../utils/cron';
import { logger } from '../utils/logger';

let schedulerTimer: NodeJS.Timeout | null = null;
let lastCheckedMinute = -1;

export async function executeSchedule(scheduleId: number): Promise<void> {
    const schedule = await db.queryOne<any>('SELECT * FROM schedules WHERE id = ?', [scheduleId]);
    if (!schedule) return;

    const server = await db.queryOne<any>('SELECT * FROM servers WHERE id = ?', [schedule.server_id]);
    if (!server || server.status === 'suspended') return;

    if (schedule.only_when_online && processManager.getState(server.uuid) !== 'running') {
        return;
    }

    const tasks = await db.query<any>('SELECT * FROM tasks WHERE schedule_id = ? ORDER BY sequence_id ASC', [
        schedule.id,
    ]);

    await db.execute('UPDATE schedules SET is_processing = 1 WHERE id = ?', [schedule.id]);

    try {
        for (const task of tasks) {
            if (task.time_offset > 0) {
                await new Promise((r) => setTimeout(r, task.time_offset * 1000));
            }
            try {
                if (task.action === 'command') {
                    processManager.sendCommand(server.uuid, task.payload);
                } else if (task.action === 'power') {
                    const sig = task.payload as 'start' | 'stop' | 'restart' | 'kill';
                    await processManager.handlePowerAction(server.id, sig);
                } else if (task.action === 'backup') {
                    await createServerBackup({
                        serverId: server.id,
                        serverUuid: server.uuid,
                        name: `Scheduled Backup (${schedule.name})`,
                        ignoredFiles: task.payload || '',
                        isLocked: false,
                    });
                }
            } catch (err) {
                logger.warn('Scheduled task execution failed', {
                    scheduleId: schedule.id,
                    taskId: task.id,
                    err: String(err),
                });
                if (!task.continue_on_failure) {
                    break;
                }
            }
        }
    } finally {
        let nextRunStr: string | null = null;
        try {
            const nextDate = getNextCronDate({
                minute: schedule.cron_minute,
                hour: schedule.cron_hour,
                dayOfMonth: schedule.cron_day_of_month,
                month: schedule.cron_month,
                dayOfWeek: schedule.cron_day_of_week,
            });
            nextRunStr = nextDate.toISOString().slice(0, 19).replace('T', ' ');
        } catch {
            nextRunStr = null;
        }
        await db.execute(
            'UPDATE schedules SET is_processing = 0, last_run_at = CURRENT_TIMESTAMP, next_run_at = ? WHERE id = ?',
            [nextRunStr, schedule.id]
        );
    }
}

async function tickScheduler(): Promise<void> {
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60000);
    if (minuteKey === lastCheckedMinute) return;
    lastCheckedMinute = minuteKey;

    const schedules = await db.query<any>('SELECT * FROM schedules WHERE is_active = 1 AND is_processing = 0');
    for (const schedule of schedules) {
        try {
            const matches = matchesCron(
                {
                    minute: schedule.cron_minute,
                    hour: schedule.cron_hour,
                    dayOfMonth: schedule.cron_day_of_month,
                    month: schedule.cron_month,
                    dayOfWeek: schedule.cron_day_of_week,
                },
                now
            );
            if (matches) {
                executeSchedule(schedule.id).catch((err) =>
                    logger.error('Schedule execution error', { scheduleId: schedule.id, err: String(err) })
                );
            }
        } catch (err) {
            logger.warn('Invalid cron on schedule', { scheduleId: schedule.id, err: String(err) });
        }
    }
}

export function startScheduler(): void {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => {
        tickScheduler().catch((err) => logger.error('Scheduler tick error', { err: String(err) }));
    }, 15_000);
}

export function stopScheduler(): void {
    if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
    }
}
