import crypto from 'node:crypto';
import { FileEntry } from '../files/fileManager';
import { buildServerStartupCommand } from '../utils/startup';

export function toIso(val: string | Date | null | undefined): string | null {
    if (!val) return null;
    const d = val instanceof Date ? val : new Date(val.includes('T') ? val : val.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function gravatarUrl(email: string): string {
    const hash = crypto.createHash('md5').update((email || '').trim().toLowerCase()).digest('hex');
    return `https://gravatar.com/avatar/${hash}`;
}

export function transformAccount(user: any) {
    return {
        object: 'user',
        attributes: {
            id: user.id,
            admin: Boolean(user.root_admin),
            username: user.username,
            email: user.email,
            first_name: user.name_first,
            last_name: user.name_last,
            language: user.language || 'en',
        },
    };
}

export function transformUser(user: any) {
    return {
        object: 'user',
        attributes: {
            uuid: user.uuid,
            identifier: user.uuid,
            username: user.username,
            email: user.email,
            image: gravatarUrl(user.email),
            '2fa_enabled': Boolean(user.use_totp),
            created_at: toIso(user.created_at),
        },
    };
}

export function transformApiKey(key: any) {
    let allowedIps: string[] = [];
    try {
        allowedIps = key.allowed_ips ? JSON.parse(key.allowed_ips) : [];
    } catch {
        allowedIps = [];
    }
    return {
        object: 'api_key',
        attributes: {
            identifier: key.identifier,
            description: key.memo || '',
            allowed_ips: allowedIps,
            last_used_at: toIso(key.last_used_at),
            created_at: toIso(key.created_at),
        },
    };
}

export function transformSshKey(ssh: any) {
    return {
        object: 'ssh_key',
        attributes: {
            name: ssh.name,
            fingerprint: ssh.fingerprint,
            public_key: ssh.public_key,
            created_at: toIso(ssh.created_at),
        },
    };
}

export function transformAllocation(alloc: any, primaryAllocationId: number | null) {
    return {
        object: 'allocation',
        attributes: {
            id: alloc.id,
            ip: alloc.ip,
            ip_alias: alloc.ip_alias || null,
            port: Number(alloc.port),
            notes: alloc.notes || null,
            is_default: Number(alloc.id) === Number(primaryAllocationId),
        },
    };
}

export function transformEggVariable(v: any) {
    return {
        object: 'egg_variable',
        attributes: {
            name: v.name,
            description: v.description,
            env_variable: v.env_variable,
            default_value: v.default_value,
            server_value: v.server_value ?? v.default_value,
            is_editable: Boolean(v.user_editable),
            rules: v.rules || 'string',
        },
    };
}

export function transformServer(
    server: any,
    userId: number,
    allocations: any[],
    variables: any[],
    canReadStartup = true
) {
    let eggFeatures: string[] = [];
    try {
        eggFeatures = server.egg_features ? JSON.parse(server.egg_features) : [];
    } catch {
        eggFeatures = [];
    }

    const envMap: Record<string, string> = {};
    for (const v of variables) {
        envMap[v.env_variable] = v.server_value ?? v.default_value;
    }

    const primaryAlloc = allocations.find((a) => Number(a.id) === Number(server.allocation_id)) || allocations[0];
    const invocation = canReadStartup
        ? buildServerStartupCommand(
              server.startup || '',
              {
                  ...envMap,
                  SERVER_MEMORY: server.memory,
                  SERVER_IP: primaryAlloc?.ip || '0.0.0.0',
                  SERVER_PORT: primaryAlloc?.port || 25565,
              },
              Number(server.memory || 0)
          )
        : '';

    return {
        object: 'server',
        attributes: {
            server_owner: Number(server.owner_id) === Number(userId),
            identifier: server.uuidShort,
            internal_id: server.id,
            uuid: server.uuid,
            name: server.name,
            node: server.node_name || 'Local Node',
            is_node_under_maintenance: Boolean(server.maintenance_mode),
            sftp_details: {
                ip: server.node_fqdn || '127.0.0.1',
                port: Number(server.daemonSFTP || 2022),
            },
            description: server.description || '',
            limits: {
                memory: Number(server.memory),
                swap: Number(server.swap),
                disk: Number(server.disk),
                io: Number(server.io),
                cpu: Number(server.cpu),
                threads: server.threads || null,
                oom_disabled: Boolean(server.oom_disabled),
            },
            invocation,
            docker_image: server.image,
            egg_features: eggFeatures,
            feature_limits: {
                databases: Number(server.database_limit || 0),
                allocations: Number(server.allocation_limit || 0),
                backups: Number(server.backup_limit || 0),
            },
            status: server.status || null,
            is_suspended: server.status === 'suspended',
            is_installing: server.status === 'installing',
            is_transferring: false,
            skip_scripts: Boolean(server.skip_scripts),
            relationships: {
                allocations: {
                    object: 'list',
                    data: allocations.map((a) => transformAllocation(a, server.allocation_id)),
                },
                variables: {
                    object: 'list',
                    data: variables.filter((v) => Boolean(v.user_viewable)).map(transformEggVariable),
                },
            },
        },
    };
}

export function transformFileObject(entry: FileEntry) {
    return {
        object: 'file_object',
        attributes: entry,
    };
}

export function transformBackup(backup: any) {
    let ignored: string[] = [];
    if (backup.ignored_files) {
        ignored = String(backup.ignored_files)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return {
        object: 'backup',
        attributes: {
            uuid: backup.uuid,
            is_successful: Boolean(backup.is_successful),
            is_locked: Boolean(backup.is_locked),
            name: backup.name,
            ignored_files: ignored,
            checksum: backup.checksum || null,
            bytes: Number(backup.bytes || 0),
            created_at: toIso(backup.created_at),
            completed_at: toIso(backup.completed_at),
        },
    };
}

export function transformTask(task: any) {
    return {
        object: 'schedule_task',
        attributes: {
            id: task.id,
            sequence_id: Number(task.sequence_id),
            action: task.action,
            payload: task.payload,
            time_offset: Number(task.time_offset),
            is_queued: Boolean(task.is_queued),
            continue_on_failure: Boolean(task.continue_on_failure),
            created_at: toIso(task.created_at),
            updated_at: toIso(task.updated_at),
        },
    };
}

export function transformSchedule(schedule: any, tasks: any[]) {
    return {
        object: 'server_schedule',
        attributes: {
            id: schedule.id,
            name: schedule.name,
            cron: {
                day_of_week: schedule.cron_day_of_week,
                day_of_month: schedule.cron_day_of_month,
                month: schedule.cron_month,
                hour: schedule.cron_hour,
                minute: schedule.cron_minute,
            },
            is_active: Boolean(schedule.is_active),
            is_processing: Boolean(schedule.is_processing),
            only_when_online: Boolean(schedule.only_when_online),
            last_run_at: toIso(schedule.last_run_at),
            next_run_at: toIso(schedule.next_run_at),
            created_at: toIso(schedule.created_at),
            updated_at: toIso(schedule.updated_at),
            relationships: {
                tasks: {
                    object: 'list',
                    data: tasks.map(transformTask),
                },
            },
        },
    };
}

export function transformSubuser(subuser: any, user: any) {
    let perms: string[] = [];
    try {
        perms = JSON.parse(subuser.permissions || '[]');
    } catch {
        perms = [];
    }
    return {
        object: 'server_subuser',
        attributes: {
            ...transformUser(user).attributes,
            permissions: perms,
        },
    };
}

export function transformDatabase(dbRow: any, includePassword = false) {
    const out: any = {
        object: 'server_database',
        attributes: {
            id: dbRow.id,
            host: {
                address: dbRow.host_address || '127.0.0.1',
                port: Number(dbRow.host_port || 3306),
            },
            name: dbRow.database,
            username: dbRow.username,
            connections_from: dbRow.remote || '%',
            max_connections: Number(dbRow.max_connections || 0),
        },
    };
    if (includePassword) {
        out.attributes.relationships = {
            password: {
                object: 'database_password',
                attributes: { password: dbRow.password },
            },
        };
    }
    return out;
}

export function transformActivityLog(row: any, actor?: any, viewerIsActorOrAdmin = false) {
    let props: Record<string, unknown> = {};
    try {
        props = row.properties ? JSON.parse(row.properties) : {};
    } catch {
        props = {};
    }
    return {
        object: 'activity_log',
        attributes: {
            id: crypto.createHash('sha1').update(String(row.id)).digest('hex'),
            batch: row.batch || null,
            event: row.event,
            is_api: Boolean(row.api_key_id),
            ip: viewerIsActorOrAdmin ? row.ip : null,
            description: row.description || null,
            properties: props,
            has_additional_metadata: Object.keys(props).length > 0,
            timestamp: toIso(row.timestamp),
            ...(actor
                ? {
                      relationships: {
                          actor: transformUser(actor),
                      },
                  }
                : {}),
        },
    };
}

export function paginateList<T>(items: T[], total: number, page: number, perPage: number) {
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    return {
        object: 'list' as const,
        data: items,
        meta: {
            pagination: {
                total,
                count: items.length,
                per_page: perPage,
                current_page: page,
                total_pages: totalPages,
            },
        },
    };
}
