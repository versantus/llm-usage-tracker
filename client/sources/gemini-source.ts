/**
 * Gemini CLI source. Gemini doesn't persist token usage in its session logs,
 * but it can emit OpenTelemetry to a local file. We parse that file's
 * `gemini_cli.token.usage` metric (falling back to `gen_ai.client.token.usage`),
 * grouping data points by `session.id`.
 *
 * To avoid fighting other tools (e.g. Agent Cat) over the single telemetry
 * `outfile`, we READ whatever outfile is already configured in
 * ~/.gemini/settings.json; `lut gemini enable` only writes config if telemetry
 * isn't on yet (defaulting to our own path).
 *
 * The metric is a cumulative counter, so per (session, token-class) we take the
 * MAX value seen as the absolute total. Carbon is approximate (no validated
 * Gemini energy config). NOTE: needs a live Gemini session to fully verify.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configDir } from '../config.ts';
import type { CollectedSession, SessionUsage } from '../../shared/types.ts';
import type { Source } from './source.ts';

function geminiSettingsPath(): string {
    return join(homedir(), '.gemini', 'settings.json');
}

function defaultOutfile(): string {
    return join(configDir(), 'gemini-telemetry.log');
}

function readGeminiSettings(): any {
    try {
        return JSON.parse(readFileSync(geminiSettingsPath(), 'utf-8'));
    } catch {
        return {};
    }
}

/** The telemetry outfile to read — whatever's configured, else our default. */
export function geminiTelemetryOutfile(): string {
    const t = readGeminiSettings()?.telemetry;
    if (t && typeof t.outfile === 'string' && t.outfile) return t.outfile;
    return defaultOutfile();
}

export function geminiAvailable(): boolean {
    return existsSync(join(homedir(), '.gemini'));
}

/** True once telemetry is enabled to a local file. */
export function geminiTelemetryConfigured(): boolean {
    const t = readGeminiSettings()?.telemetry;
    return !!(t && t.enabled && t.target === 'local' && t.outfile);
}

/** Turn on local-file telemetry in ~/.gemini/settings.json (idempotent). */
export function enableGeminiTelemetry(): string {
    const p = geminiSettingsPath();
    const settings = readGeminiSettings();
    if (settings.telemetry?.enabled && settings.telemetry?.outfile) {
        return `already on (outfile ${settings.telemetry.outfile})`;
    }
    const outfile = defaultOutfile();
    mkdirSync(configDir(), { recursive: true });
    if (!existsSync(outfile)) writeFileSync(outfile, '');
    settings.telemetry = {
        ...(settings.telemetry || {}),
        enabled: true,
        target: 'local',
        logPrompts: false,
        outfile
    };
    mkdirSync(join(homedir(), '.gemini'), { recursive: true });
    writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
    return `enabled telemetry -> ${outfile}`;
}

// --- OTLP parsing ---------------------------------------------------------

/** Extract top-level balanced JSON objects from a concatenated/NDJSON stream. */
function* jsonObjects(text: string): Generator<any> {
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                try {
                    yield JSON.parse(text.slice(start, i + 1));
                } catch {
                    // skip malformed
                }
                start = -1;
            }
        }
    }
}

function tokenKey(raw: unknown): string | null {
    const t = String(raw ?? '').toLowerCase().trim();
    if (['input', 'input_token', 'input_tokens'].includes(t)) return 'inputTokens';
    if (['output', 'output_token', 'output_tokens'].includes(t)) return 'outputTokens';
    if (['cache', 'cached', 'cached_content', 'cache_read'].includes(t)) return 'cacheReadTokens';
    if (['thought', 'thoughts', 'reasoning'].includes(t)) return 'thoughtTokens';
    return null;
}

function metricValue(raw: any): number | null {
    if (typeof raw === 'boolean') return null;
    if (typeof raw === 'number') return Math.max(0, Math.floor(raw));
    if (raw && typeof raw === 'object') {
        for (const k of ['sum', 'value', 'count', 'asInt', 'asDouble']) {
            const v = metricValue(raw[k]);
            if (v !== null) return v;
        }
    }
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
    return null;
}

interface Agg {
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    thought: number;
}

/** Parse the telemetry file into per-session aggregates (cumulative -> max). */
export function parseGeminiTelemetry(text: string): Map<string, Agg> {
    const sessions = new Map<string, Agg>();
    // Vendor metric uses `type`/`model` attributes; gemini-cli and its successor
    // Antigravity CLI share the same OTEL telemetry. The GenAI standard metric
    // uses `gen_ai.*` attributes. We accept all of them.
    const VENDOR_METRICS = ['gemini_cli.token.usage', 'antigravity_cli.token.usage'];
    const STD = 'gen_ai.client.token.usage';

    for (const payload of jsonObjects(text)) {
        const resources = Array.isArray(payload?.resourceMetrics)
            ? payload.resourceMetrics
            : [payload];
        for (const rm of resources) {
            for (const scope of rm?.scopeMetrics || []) {
                for (const metric of scope?.metrics || []) {
                    const name = metric?.descriptor?.name ?? metric?.name;
                    const isPref = VENDOR_METRICS.includes(name);
                    if (!isPref && name !== STD) continue;
                    const points = metric?.dataPoints || metric?.sum?.dataPoints || [];
                    for (const pt of points) {
                        const attrs = (pt?.attributes && typeof pt.attributes === 'object') ? pt.attributes : {};
                        const key = tokenKey(isPref ? attrs.type : attrs['gen_ai.token.type']);
                        const amount = metricValue(pt?.value ?? pt?.asInt ?? pt?.asDouble);
                        if (key === null || amount === null) continue;
                        const sid = String(attrs['session.id'] ?? attrs['session_id'] ?? 'gemini-session');
                        const model = String(
                            (isPref ? attrs.model : attrs['gen_ai.response.model'] || attrs['gen_ai.request.model']) || 'unknown'
                        );
                        const agg = sessions.get(sid) || { model, input: 0, output: 0, cacheRead: 0, thought: 0 };
                        if (model !== 'unknown') agg.model = model;
                        // each token class is its own cumulative counter: keep the max
                        if (key === 'inputTokens') agg.input = Math.max(agg.input, amount);
                        else if (key === 'outputTokens') agg.output = Math.max(agg.output, amount);
                        else if (key === 'cacheReadTokens') agg.cacheRead = Math.max(agg.cacheRead, amount);
                        else if (key === 'thoughtTokens') agg.thought = Math.max(agg.thought, amount);
                        sessions.set(sid, agg);
                    }
                }
            }
        }
    }
    return sessions;
}

export interface GeminiSession {
    sessionId: string;
    agg: Agg;
}

/** All Gemini sessions found in the telemetry outfile. */
export function listGeminiSessions(): GeminiSession[] {
    const file = geminiTelemetryOutfile();
    if (!existsSync(file)) return [];
    let text: string;
    try {
        text = readFileSync(file, 'utf-8');
    } catch {
        return [];
    }
    return [...parseGeminiTelemetry(text)].map(([sessionId, agg]) => ({ sessionId, agg }));
}

/** mtime of the telemetry file (so watchers can skip when unchanged). */
export function geminiTelemetryMtime(): number {
    try {
        return statSync(geminiTelemetryOutfile()).mtimeMs;
    } catch {
        return 0;
    }
}

export const geminiSource: Source = {
    collectSession({ sessionId }) {
        const found = listGeminiSessions().find((s) => s.sessionId === sessionId);
        if (!found) return null;
        const { agg } = found;
        const outputTokens = agg.output + agg.thought; // reasoning counts as output for carbon
        const totalTokens = agg.input + outputTokens;
        if (totalTokens === 0) return null;

        const usage: SessionUsage = {
            records: [{ requestId: sessionId, model: agg.model, inputTokens: agg.input, outputTokens, cacheCreationTokens: 0, cacheReadTokens: agg.cacheRead }],
            totals: { inputTokens: agg.input, outputTokens, cacheCreationTokens: 0, cacheReadTokens: agg.cacheRead, totalTokens },
            modelBreakdown: { [agg.model]: totalTokens },
            primaryModel: agg.model
        };
        const now = new Date().toISOString();
        return {
            provider: 'google',
            surface: 'gemini-cli',
            sessionId,
            cwd: '',
            usage,
            startedAt: now,
            updatedAt: now
        } satisfies CollectedSession;
    }
};
