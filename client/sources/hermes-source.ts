/**
 * Hermes agent source. Hermes (the ~/.hermes gateway agent) records per-session
 * token usage natively in a SQLite db:
 *   ~/.hermes/state.db
 *
 * Two tables matter:
 *   - `sessions`            one row per session (cli / cron / subagent / telegram),
 *                           with aggregate token columns + model + billing_provider
 *                           + started_at/ended_at (REAL epoch seconds) + cwd.
 *   - `session_model_usage` per-(session, model) token breakdown, used to build an
 *                           accurate modelBreakdown and pick the primary model.
 *
 * Unlike Ollama, Hermes stores REAL token counts (no char-estimation), so the
 * totals are exact. Sub-agent runs are their own `sessions` rows with their own
 * token columns (they are NOT rolled into the parent), so reporting every session
 * under its own id is additive — the server upserts by (userId, sessionId).
 *
 * Provider is mapped from each model's `billing_provider` (Hermes is multi-model:
 * Anthropic, plus locally/cloud-served models via an OpenAI-compatible endpoint).
 * Only Anthropic has a validated carbon config; everything else is approximate.
 * Reasoning tokens are folded into output (as the Gemini/Copilot sources do).
 *
 * Hermes does no work-type classification here (it's not a tool-vector transcript
 * source), so sessions report category 'unknown' — same as ollama/gemini.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CollectedSession, Provider, SessionUsage } from '../../shared/types.ts';
import type { Source } from './source.ts';

export function hermesStateDbPath(): string {
    return join(homedir(), '.hermes', 'state.db');
}

export function hermesAvailable(): boolean {
    return existsSync(hermesStateDbPath());
}

const SESSION_PREFIX = 'hermes:';

function openDb(): Database | null {
    const p = hermesStateDbPath();
    if (!existsSync(p)) return null;
    try {
        return new Database(p, { readonly: true });
    } catch {
        return null;
    }
}

/** Hermes epoch timestamps are REAL seconds (may be null); -> ms since epoch. */
function secToMs(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

/** Map a Hermes billing_provider (or model name) to our Provider enum. */
function mapProvider(billingProvider: string, model: string): Provider {
    const p = (billingProvider || '').toLowerCase();
    const m = (model || '').toLowerCase();
    if (p.includes('anthropic') || m.startsWith('claude')) return 'anthropic';
    if (p.includes('openai') || m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
    if (p.includes('google') || p.includes('gemini') || m.startsWith('gemini')) return 'google';
    return 'unknown';
}

export interface HermesSessionItem {
    sessionId: string;
    path: string;
    mtimeMs: number;
}

/**
 * One scan item per session that has any tokens. mtime tracks the latest
 * activity (max last_seen across its model rows, falling back to ended/started),
 * so a still-growing session re-sends when it changes and settles once it ends.
 */
export function listHermesSessions(sinceHours = 0): HermesSessionItem[] {
    const db = openDb();
    if (!db) return [];
    const cutoff = sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : 0;
    const path = hermesStateDbPath();
    try {
        const rows = db
            .query(
                'SELECT s.id AS id, ' +
                    '  COALESCE(MAX(u.last_seen), s.ended_at, s.started_at) AS last ' +
                    'FROM sessions s ' +
                    'LEFT JOIN session_model_usage u ON u.session_id = s.id ' +
                    'GROUP BY s.id ' +
                    'HAVING (s.input_tokens + s.output_tokens + s.cache_read_tokens + ' +
                    '        s.cache_write_tokens + s.reasoning_tokens) > 0'
            )
            .all() as { id: string; last: number | null }[];
        return rows
            .map((r) => ({ sessionId: SESSION_PREFIX + r.id, path, mtimeMs: secToMs(r.last) }))
            .filter((r) => !cutoff || r.mtimeMs >= cutoff);
    } catch {
        return [];
    } finally {
        db.close();
    }
}

interface SessionRow {
    id: string;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    billing_provider: string | null;
    started_at: number | null;
    ended_at: number | null;
    cwd: string | null;
}

interface ModelUsageRow {
    model: string;
    billing_provider: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    last_seen: number | null;
}

export const hermesSource: Source = {
    collectSession({ sessionId }) {
        if (!sessionId.startsWith(SESSION_PREFIX)) return null;
        const id = sessionId.slice(SESSION_PREFIX.length);
        const db = openDb();
        if (!db) return null;
        try {
            const s = db
                .query(
                    'SELECT id, model, input_tokens, output_tokens, cache_read_tokens, ' +
                        'cache_write_tokens, reasoning_tokens, billing_provider, ' +
                        'started_at, ended_at, cwd FROM sessions WHERE id = $id'
                )
                .get({ $id: id }) as SessionRow | null;
            if (!s) return null;

            const usageRows = db
                .query(
                    'SELECT model, billing_provider, input_tokens, output_tokens, ' +
                        'cache_read_tokens, cache_write_tokens, reasoning_tokens, last_seen ' +
                        'FROM session_model_usage WHERE session_id = $id'
                )
                .all({ $id: id }) as ModelUsageRow[];

            // Fold reasoning tokens into output. Prefer the per-model breakdown;
            // fall back to the session's aggregate columns if it has none.
            const records = (usageRows.length
                ? usageRows
                : [
                      {
                          model: s.model || 'hermes-unknown',
                          billing_provider: s.billing_provider,
                          input_tokens: s.input_tokens,
                          output_tokens: s.output_tokens,
                          cache_read_tokens: s.cache_read_tokens,
                          cache_write_tokens: s.cache_write_tokens,
                          reasoning_tokens: s.reasoning_tokens,
                          last_seen: s.ended_at
                      } as ModelUsageRow
                  ]
            ).map((r) => {
                const input = r.input_tokens || 0;
                const output = (r.output_tokens || 0) + (r.reasoning_tokens || 0);
                const cacheCreation = r.cache_write_tokens || 0;
                const cacheRead = r.cache_read_tokens || 0;
                const model = r.model || 'hermes-unknown';
                return {
                    requestId: `${sessionId}:${model}`,
                    model,
                    inputTokens: input,
                    outputTokens: output,
                    cacheCreationTokens: cacheCreation,
                    cacheReadTokens: cacheRead,
                    provider: mapProvider(r.billing_provider || s.billing_provider || '', model)
                };
            });

            const totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
            const modelBreakdown: Record<string, number> = {};
            for (const r of records) {
                totals.inputTokens += r.inputTokens;
                totals.outputTokens += r.outputTokens;
                totals.cacheCreationTokens += r.cacheCreationTokens;
                totals.cacheReadTokens += r.cacheReadTokens;
                const t = r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
                modelBreakdown[r.model] = (modelBreakdown[r.model] || 0) + t;
            }
            totals.totalTokens =
                totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
            if (totals.totalTokens === 0) return null;

            // Primary model = most tokens; its provider drives the session provider.
            const primaryModel = Object.entries(modelBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || 'hermes-unknown';
            const provider =
                records.find((r) => r.model === primaryModel)?.provider ??
                mapProvider(s.billing_provider || '', primaryModel);

            const usage: SessionUsage = {
                records: records.map(({ provider: _p, ...rest }) => rest),
                totals,
                modelBreakdown,
                primaryModel
            };

            const now = new Date().toISOString();
            const startMs = secToMs(s.started_at);
            const lastMs =
                Math.max(0, ...usageRows.map((u) => secToMs(u.last_seen)), secToMs(s.ended_at)) || startMs;
            return {
                provider,
                surface: 'hermes',
                sessionId,
                cwd: s.cwd || '',
                usage,
                startedAt: startMs ? new Date(startMs).toISOString() : now,
                updatedAt: lastMs ? new Date(lastMs).toISOString() : now
            } satisfies CollectedSession;
        } catch {
            return null;
        } finally {
            db.close();
        }
    }
};
