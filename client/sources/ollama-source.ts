/**
 * Ollama (desktop app) source. The desktop app stores chats in a SQLite db:
 *   macOS:   ~/Library/Application Support/Ollama/db.sqlite
 *   Linux:   ~/.config/Ollama/db.sqlite
 *   Windows: %APPDATA%/Ollama/db.sqlite
 *
 * Each chat = one session. The db stores message content + model_name but NOT
 * token counts, so tokens are char/4 estimates (user/tool -> input,
 * assistant+thinking -> output). One model per chat (the dominant assistant
 * model_name).
 *
 * NOTE: Ollama runs on LOCAL hardware, so the datacenter carbon model is a poor
 * fit — carbon here is doubly approximate. The Ollama *CLI* is NOT covered: it
 * doesn't persist token/model usage anywhere locally (only the desktop app does).
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CollectedSession, SessionUsage } from '../../shared/types.ts';
import type { Source } from './source.ts';

export function ollamaDesktopDbPath(): string {
    const h = homedir();
    if (process.platform === 'darwin') {
        return join(h, 'Library', 'Application Support', 'Ollama', 'db.sqlite');
    }
    if (process.platform === 'win32') {
        return join(process.env.APPDATA || join(h, 'AppData', 'Roaming'), 'Ollama', 'db.sqlite');
    }
    return join(h, '.config', 'Ollama', 'db.sqlite');
}

export function ollamaAvailable(): boolean {
    return existsSync(ollamaDesktopDbPath());
}

const SESSION_PREFIX = 'ollama-desktop:';
const charTokens = (text: unknown): number =>
    typeof text === 'string' && text ? Math.max(1, Math.floor((text.length + 3) / 4)) : 0;

function openDb(): Database | null {
    const p = ollamaDesktopDbPath();
    if (!existsSync(p)) return null;
    try {
        return new Database(p, { readonly: true });
    } catch {
        return null;
    }
}

function tsMs(raw: unknown): number {
    if (typeof raw !== 'string' || !raw) return 0;
    const ms = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) ? ms : 0;
}

export interface OllamaChat {
    sessionId: string;
    path: string;
    mtimeMs: number;
}

/** One scan item per chat; mtime = latest message time (so growing chats re-send). */
export function listOllamaChats(sinceHours = 0): OllamaChat[] {
    const db = openDb();
    if (!db) return [];
    const cutoff = sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : 0;
    const path = ollamaDesktopDbPath();
    try {
        const rows = db
            .query('SELECT chat_id AS id, MAX(updated_at) AS last FROM messages GROUP BY chat_id')
            .all() as { id: string; last: string }[];
        return rows
            .map((r) => ({ sessionId: SESSION_PREFIX + r.id, path, mtimeMs: tsMs(r.last) }))
            .filter((r) => !cutoff || r.mtimeMs >= cutoff);
    } catch {
        return [];
    } finally {
        db.close();
    }
}

export const ollamaSource: Source = {
    collectSession({ sessionId }) {
        if (!sessionId.startsWith(SESSION_PREFIX)) return null;
        const chatId = sessionId.slice(SESSION_PREFIX.length);
        const db = openDb();
        if (!db) return null;
        try {
            const msgs = db
                .query(
                    'SELECT role, content, thinking, model_name AS model, created_at, updated_at ' +
                        'FROM messages WHERE chat_id = $id ORDER BY created_at ASC'
                )
                .all({ $id: chatId }) as {
                role: string;
                content: string;
                thinking: string;
                model: string | null;
                created_at: string;
                updated_at: string;
            }[];
            if (!msgs.length) return null;

            let inputTokens = 0;
            let outputTokens = 0;
            const modelCounts: Record<string, number> = {};
            let firstTs = '';
            let lastTs = '';

            for (const m of msgs) {
                if (!firstTs) firstTs = m.created_at;
                lastTs = m.updated_at || m.created_at;
                if (m.role === 'assistant') {
                    outputTokens += charTokens(m.content) + charTokens(m.thinking);
                    if (m.model) modelCounts[m.model] = (modelCounts[m.model] || 0) + 1;
                } else {
                    // user + tool messages are context fed to the model
                    inputTokens += charTokens(m.content);
                }
            }

            const totalTokens = inputTokens + outputTokens;
            if (totalTokens === 0) return null;
            const model = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'ollama-unknown';

            const usage: SessionUsage = {
                records: [{ requestId: sessionId, model, inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 }],
                totals: { inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens },
                modelBreakdown: { [model]: totalTokens },
                primaryModel: model
            };
            const now = new Date().toISOString();
            return {
                provider: 'unknown',
                surface: 'ollama',
                sessionId,
                cwd: '',
                usage,
                startedAt: tsMs(firstTs) ? new Date(tsMs(firstTs)).toISOString() : now,
                updatedAt: tsMs(lastTs) ? new Date(tsMs(lastTs)).toISOString() : now
            } satisfies CollectedSession;
        } catch {
            return null;
        } finally {
            db.close();
        }
    }
};
