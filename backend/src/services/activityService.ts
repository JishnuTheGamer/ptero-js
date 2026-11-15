import crypto from 'node:crypto';
import { db } from '../database/connection';

export async function logActivity(opts: {
    event: string;
    ip?: string | null;
    actorId?: number | null;
    subjectType?: 'server' | 'user' | null;
    subjectId?: number | null;
    apiKeyId?: number | null;
    properties?: Record<string, unknown>;
    description?: string | null;
}): Promise<void> {
    try {
        await db.execute(
            `INSERT INTO activity_logs (
                batch, event, ip, description, actor_type, actor_id, subject_type, subject_id, api_key_id, properties
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                crypto.randomUUID(),
                opts.event,
                opts.ip || null,
                opts.description || null,
                opts.actorId ? 'user' : null,
                opts.actorId || null,
                opts.subjectType || null,
                opts.subjectId || null,
                opts.apiKeyId || null,
                JSON.stringify(opts.properties || {}),
            ]
        );
    } catch {
        // Activity logging should never break primary operations
    }
}
