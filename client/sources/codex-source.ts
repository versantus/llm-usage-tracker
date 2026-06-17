/**
 * Codex CLI source: reads OpenAI Codex session rollouts from
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<session-id>.jsonl
 *
 * Each rollout is JSONL. We extract:
 *   - session id + cwd from the `session_meta` line
 *   - model from the latest `turn_context` line
 *   - ABSOLUTE cumulative token usage from the latest `event_msg` whose
 *     payload.type === 'token_count' (info.total_token_usage)
 *
 * Codex exposes aggregate token counts (not per-request), so carbon is computed
 * from the output-token total and flagged approximate. Codex has no Stop-style
 * hook we can rely on, so the watcher (watch-codex.ts) polls these files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CollectedSession, SessionUsage } from '../../shared/types.ts';
import type { Source } from './source.ts';

export function codexSessionsRoot(): string {
    return join(homedir(), '.codex', 'sessions');
}

export function codexAvailable(): boolean {
    return existsSync(codexSessionsRoot());
}

export interface CodexRollout {
    sessionId: string;
    path: string;
    mtimeMs: number;
}

/**
 * Find rollout JSONL files. By default only those modified within `sinceHours`
 * (so periodic scans stay cheap); pass 0 to list everything.
 */
export function listCodexRollouts(sinceHours = 0, root = codexSessionsRoot()): CodexRollout[] {
    const out: CodexRollout[] = [];
    if (!existsSync(root)) return out;
    const cutoff = sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : 0;

    const walk = (dir: string, depth: number): void => {
        if (depth > 5) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            const p = join(dir, name);
            let st;
            try {
                st = statSync(p);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                walk(p, depth + 1);
            } else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
                if (cutoff && st.mtimeMs < cutoff) continue;
                out.push({ sessionId: sessionIdFromName(name), path: p, mtimeMs: st.mtimeMs });
            }
        }
    };
    walk(root, 0);
    return out;
}

/** rollout-2026-06-16T19-24-26-<uuid>.jsonl -> <uuid> */
function sessionIdFromName(name: string): string {
    const m = name.match(/rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return m ? m[1] : name.replace(/^rollout-|\.jsonl$/g, '');
}

interface CodexTokenUsage {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

export const codexSource: Source = {
    collectSession({ sessionId, transcriptPath }) {
        const path = transcriptPath;
        if (!path || !existsSync(path)) return null;

        let lines: string[];
        try {
            lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim());
        } catch {
            return null;
        }

        let id = sessionId;
        let cwd = '';
        let model = 'unknown';
        let firstTs = '';
        let lastTs = '';
        let usage: CodexTokenUsage | null = null;

        for (const line of lines) {
            let d: any;
            try {
                d = JSON.parse(line);
            } catch {
                continue;
            }
            if (typeof d.timestamp === 'string') {
                if (!firstTs) firstTs = d.timestamp;
                lastTs = d.timestamp;
            }
            const type = d.type;
            const payload = d.payload;
            if (type === 'session_meta' && payload) {
                if (typeof payload.id === 'string') id = payload.id;
                if (typeof payload.cwd === 'string') cwd = payload.cwd;
            } else if (type === 'turn_context' && payload) {
                if (typeof payload.model === 'string') model = payload.model;
                if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
            } else if (type === 'event_msg' && payload?.type === 'token_count') {
                const tu = payload.info?.total_token_usage;
                if (tu && typeof tu === 'object') usage = tu; // keep the latest (cumulative)
            }
        }

        if (!usage) return null;

        const inputTokens = num(usage.input_tokens);
        const outputTokens = num(usage.output_tokens);
        const cacheReadTokens = num(usage.cached_input_tokens);
        const totalTokens = num(usage.total_tokens) || inputTokens + outputTokens;
        if (totalTokens === 0) return null;

        const sessionUsage: SessionUsage = {
            records: [
                {
                    requestId: id,
                    model,
                    inputTokens,
                    outputTokens,
                    cacheCreationTokens: 0,
                    cacheReadTokens
                }
            ],
            totals: {
                inputTokens,
                outputTokens,
                cacheCreationTokens: 0,
                cacheReadTokens,
                totalTokens
            },
            modelBreakdown: { [model]: totalTokens },
            primaryModel: model
        };

        const collected: CollectedSession = {
            provider: 'openai',
            surface: 'codex-cli',
            sessionId: id,
            cwd,
            usage: sessionUsage,
            startedAt: firstTs || new Date().toISOString(),
            updatedAt: lastTs || firstTs || new Date().toISOString()
        };
        return collected;
    }
};
