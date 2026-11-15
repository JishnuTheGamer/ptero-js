import { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config/index';
import { db } from '../database/connection';
import { processManager } from '../processes/ServerProcessManager';
import { logger } from '../utils/logger';

interface WsJwtClaims {
    user_id: number;
    server_uuid: string;
    permissions: string[];
    exp: number;
}

function sendWs(ws: WebSocket, event: string, args: string[] = []): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event, args }));
}

export function attachWebSocketServer(httpServer: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
        let pathname = '/';
        try {
            pathname = new URL(request.url || '/', 'http://localhost').pathname;
        } catch {
            socket.destroy();
            return;
        }
        const match = pathname.match(/^\/ws\/servers\/([a-f0-9-]+)\/?$/i);
        if (!match) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, match[1]);
        });
    });

    wss.on('connection', (ws: WebSocket, _req: unknown, serverUuid: string) => {
        let claims: WsJwtClaims | null = null;
        let unsubscribe: (() => void) | null = null;
        let expiryTimer: NodeJS.Timeout | null = null;
        const pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 25_000);

        const clearTimers = () => {
            clearInterval(pingTimer);
            if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
            }
            if (expiryTimer) {
                clearTimeout(expiryTimer);
                expiryTimer = null;
            }
        };

        ws.on('close', clearTimers);
        ws.on('error', clearTimers);

        ws.on('message', async (raw) => {
            let msg: { event?: string; args?: unknown[] };
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }

            const event = msg.event;
            const arg0 = Array.isArray(msg.args) && msg.args.length > 0 ? String(msg.args[0]) : '';

            if (event === 'auth') {
                try {
                    const decoded = jwt.verify(arg0, config.jwtSecret) as WsJwtClaims;
                    if (decoded.server_uuid !== serverUuid) {
                        sendWs(ws, 'jwt error', ['jwt: server mismatch']);
                        return;
                    }
                    const server = await db.queryOne<{ id: number; status: string | null; memory: number }>(
                        'SELECT id, status, memory FROM servers WHERE uuid = ?',
                        [serverUuid]
                    );
                    if (!server) {
                        sendWs(ws, 'jwt error', ['jwt: server not found']);
                        ws.close(4404);
                        return;
                    }
                    if (server.status === 'suspended') {
                        ws.close(4409, 'Server suspended');
                        return;
                    }

                    claims = decoded;
                    sendWs(ws, 'auth success');

                    // Subscribe to live server events
                    if (unsubscribe) unsubscribe();
                    unsubscribe = processManager.subscribe(serverUuid, (ev, data) => {
                        sendWs(ws, ev, data ? [data] : []);
                    });

                    // Send current power state immediately
                    sendWs(ws, 'status', [processManager.getState(serverUuid)]);

                    // Schedule token expiring / expired alerts
                    if (expiryTimer) clearTimeout(expiryTimer);
                    const msLeft = decoded.exp * 1000 - Date.now();
                    if (msLeft > 180_000) {
                        expiryTimer = setTimeout(() => sendWs(ws, 'token expiring'), msLeft - 180_000);
                    }
                } catch (err) {
                    sendWs(ws, 'jwt error', [`jwt: ${(err as Error).message}`]);
                }
                return;
            }

            if (!claims) {
                sendWs(ws, 'jwt error', ['jwt: not authenticated']);
                return;
            }

            const hasPerm = (perm: string) =>
                claims!.permissions.includes('*') || claims!.permissions.includes(perm);

            const server = await db.queryOne<{ id: number; memory: number }>(
                'SELECT id, memory FROM servers WHERE uuid = ?',
                [serverUuid]
            );
            if (!server) return;

            if (event === 'send logs') {
                const logs = processManager.getLogs(serverUuid);
                for (const line of logs) {
                    sendWs(ws, 'console output', [line]);
                }
                return;
            }

            if (event === 'send stats') {
                const stats = await processManager.getStats(server.id, serverUuid, server.memory);
                sendWs(ws, 'stats', [JSON.stringify(stats)]);
                return;
            }

            if (event === 'set state') {
                const signal = arg0 as 'start' | 'stop' | 'restart' | 'kill';
                const permMap: Record<string, string> = {
                    start: 'control.start',
                    stop: 'control.stop',
                    kill: 'control.stop',
                    restart: 'control.restart',
                };
                const required = permMap[signal];
                if (!required || !hasPerm(required)) {
                    sendWs(ws, 'daemon error', ['You do not have permission to perform this power action.']);
                    return;
                }
                try {
                    await processManager.handlePowerAction(server.id, signal);
                } catch (err) {
                    sendWs(ws, 'daemon error', [(err as Error).message]);
                }
                return;
            }

            if (event === 'send command') {
                if (!hasPerm('control.console')) {
                    sendWs(ws, 'daemon error', ['You do not have permission to send console commands.']);
                    return;
                }
                try {
                    processManager.sendCommand(serverUuid, arg0);
                } catch (err) {
                    sendWs(ws, 'daemon error', [(err as Error).message]);
                }
            }
        });
    });

    logger.info('WebSocket console/stats server attached at /ws/servers/:uuid');
    return wss;
}
