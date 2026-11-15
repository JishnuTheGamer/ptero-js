import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const logFilePath = path.join(config.paths.logsDir, 'panel.log');

function writeLine(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...(meta ? { meta } : {}),
    };
    const serialized = JSON.stringify(entry);
    if (level === 'error') {
        console.error(`[${entry.timestamp}] [${level.toUpperCase()}] ${message}`, meta || '');
    } else if (level !== 'debug' || config.nodeEnv !== 'production') {
        console.log(`[${entry.timestamp}] [${level.toUpperCase()}] ${message}`, meta ? JSON.stringify(meta) : '');
    }
    try {
        fs.appendFileSync(logFilePath, serialized + '\n');
    } catch {
        // Ignore log file write errors if storage is read-only
    }
}

export const logger = {
    info: (message: string, meta?: Record<string, unknown>) => writeLine('info', message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => writeLine('warn', message, meta),
    error: (message: string, meta?: Record<string, unknown>) => writeLine('error', message, meta),
    debug: (message: string, meta?: Record<string, unknown>) => writeLine('debug', message, meta),
};
