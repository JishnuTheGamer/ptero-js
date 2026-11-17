import fs from 'node:fs';
import path from 'node:path';
import mysql, { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { config } from '../config/index';
import { logger } from '../utils/logger';

export interface ExecResult {
    insertId: number;
    affectedRows: number;
}

export type SqlParam = string | number | boolean | null | undefined;

function normalizeParams(params: SqlParam[]): (string | number | null)[] {
    return params.map((p) => {
        if (p === undefined || p === null) return null;
        if (typeof p === 'boolean') return p ? 1 : 0;
        return p;
    });
}

const MAX_PREPARED_CACHE = 256;

class DatabaseManager {
    private driver: 'mysql' | 'sqlite' = 'mysql';
    private pool: Pool | null = null;
    private sqliteDb: DatabaseSync | null = null;
    private stmtCache = new Map<string, StatementSync>();
    private initialized = false;

    async init(): Promise<void> {
        if (this.initialized) return;

        if (config.db.connection === 'mysql') {
            try {
                const pool = mysql.createPool({
                    host: config.db.host,
                    port: config.db.port,
                    user: config.db.username,
                    password: config.db.password,
                    database: config.db.database,
                    waitForConnections: true,
                    connectionLimit: config.db.poolLimit,
                    queueLimit: 0,
                    multipleStatements: true,
                    dateStrings: true,
                });
                await pool.query('SELECT 1');
                this.pool = pool;
                this.driver = 'mysql';
                this.initialized = true;
                logger.info('Connected to MySQL/MariaDB database pool', {
                    host: config.db.host,
                    database: config.db.database,
                });
                return;
            } catch (err) {
                if (!config.db.allowSqliteDevFallback) {
                    throw err;
                }
                logger.warn('MySQL unavailable; using SQLite development database fallback', {
                    sqlitePath: config.db.sqlitePath,
                    reason: (err as Error).message,
                });
            }
        }

        fs.mkdirSync(path.dirname(config.db.sqlitePath), { recursive: true });
        this.sqliteDb = new DatabaseSync(config.db.sqlitePath);
        try {
            this.sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        } catch {
            // Ignore if not currently in WAL mode
        }
        this.sqliteDb.exec(
            'PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000; PRAGMA mmap_size = 67108864;'
        );
        try {
            this.sqliteDb.exec(`
                CREATE INDEX IF NOT EXISTS idx_egg_variables_egg ON egg_variables(egg_id);
                CREATE INDEX IF NOT EXISTS idx_subusers_server ON subusers(server_id);
                CREATE INDEX IF NOT EXISTS idx_databases_server ON databases(server_id);
                CREATE INDEX IF NOT EXISTS idx_ssh_keys_user ON user_ssh_keys(user_id);
            `);
        } catch {
            // Schema tables may not exist yet prior to first migration
        }
        this.driver = 'sqlite';
        this.initialized = true;
        logger.info('Connected to SQLite database', { path: config.db.sqlitePath });
    }

    private prepareSqlite(sql: string): StatementSync {
        const cached = this.stmtCache.get(sql);
        if (cached) return cached;
        if (this.stmtCache.size >= MAX_PREPARED_CACHE) {
            this.stmtCache.clear();
        }
        const stmt = this.sqliteDb!.prepare(sql);
        this.stmtCache.set(sql, stmt);
        return stmt;
    }

    getDriver(): 'mysql' | 'sqlite' {
        return this.driver;
    }

    async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
        await this.init();
        const bound = normalizeParams(params);
        if (this.driver === 'mysql' && this.pool) {
            const [rows] = await this.pool.execute<RowDataPacket[]>(sql, bound);
            return rows as unknown as T[];
        }
        const stmt = this.prepareSqlite(sql);
        return stmt.all(...bound) as unknown as T[];
    }

    async queryOne<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | null> {
        const rows = await this.query<T>(sql, params);
        return rows.length > 0 ? rows[0] : null;
    }

    async execute(sql: string, params: SqlParam[] = []): Promise<ExecResult> {
        await this.init();
        const bound = normalizeParams(params);
        if (this.driver === 'mysql' && this.pool) {
            const [res] = await this.pool.execute<ResultSetHeader>(sql, bound);
            return { insertId: Number(res.insertId || 0), affectedRows: Number(res.affectedRows || 0) };
        }
        const stmt = this.prepareSqlite(sql);
        const info = stmt.run(...bound);
        return {
            insertId: Number(info.lastInsertRowid || 0),
            affectedRows: Number(info.changes || 0),
        };
    }

    async execRaw(sql: string): Promise<void> {
        await this.init();
        if (this.driver === 'mysql' && this.pool) {
            await this.pool.query(sql);
            return;
        }
        this.sqliteDb!.exec(sql);
    }

    async close(): Promise<void> {
        this.stmtCache.clear();
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
        if (this.sqliteDb) {
            this.sqliteDb.close();
            this.sqliteDb = null;
        }
        this.initialized = false;
    }
}

export const db = new DatabaseManager();
