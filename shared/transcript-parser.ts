/**
 * Transcript Parser
 *
 * Parses JSONL transcript lines (Claude Code and Cowork share the same shape:
 * assistant lines with message.model + message.usage) into token usage records,
 * and aggregates them into absolute session totals.
 *
 * Vendored from CNaught's carbonlog (session-parser.ts), decoupled from its
 * project-identifier / data-store and from zod so it runs install-free.
 */

import type { SessionUsage, TokenUsageRecord } from './types.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAgentSessionId(sessionId: string): boolean {
    return sessionId.startsWith('agent-');
}

export function isValidSessionId(sessionId: string): boolean {
    return UUID_PATTERN.test(sessionId);
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Parse JSONL lines and extract one TokenUsageRecord per assistant request,
 * de-duplicated by uuid (streaming can emit a request multiple times).
 */
export function parseTranscriptLines(lines: string[]): TokenUsageRecord[] {
    const records: TokenUsageRecord[] = [];
    const seen = new Set<string>();
    let counter = 0;

    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as Record<string, any>;
            if (entry?.type !== 'assistant') continue;

            const message = entry.message;
            const usage = message?.usage;
            if (!usage || typeof usage !== 'object') continue;

            const requestId =
                (typeof entry.uuid === 'string' && entry.uuid) ||
                (typeof entry.parentMessageId === 'string' && entry.parentMessageId) ||
                `req-${counter++}`;
            if (seen.has(requestId)) continue;
            seen.add(requestId);

            records.push({
                requestId,
                model: typeof message.model === 'string' ? message.model : 'unknown',
                inputTokens: num(usage.input_tokens),
                outputTokens: num(usage.output_tokens),
                cacheCreationTokens: num(usage.cache_creation_input_tokens),
                cacheReadTokens: num(usage.cache_read_input_tokens)
            });
        } catch {
            // skip malformed lines
        }
    }

    return records;
}

/**
 * Aggregate records into absolute session totals + per-model breakdown.
 */
export function aggregate(records: TokenUsageRecord[]): SessionUsage {
    const totals = records.reduce(
        (acc, r) => ({
            inputTokens: acc.inputTokens + r.inputTokens,
            outputTokens: acc.outputTokens + r.outputTokens,
            cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
            cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
            totalTokens:
                acc.totalTokens +
                r.inputTokens +
                r.outputTokens +
                r.cacheCreationTokens +
                r.cacheReadTokens
        }),
        {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 0
        }
    );

    const modelBreakdown: Record<string, number> = {};
    for (const r of records) {
        const t = r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
        if (t === 0) continue;
        modelBreakdown[r.model] = (modelBreakdown[r.model] ?? 0) + t;
    }

    const primaryModel =
        Object.entries(modelBreakdown).sort(([, a], [, b]) => b - a)[0]?.[0] || 'unknown';

    return { records, totals, modelBreakdown, primaryModel };
}

/**
 * Extract an ISO timestamp from a JSONL line's "timestamp" or "_audit_timestamp" field.
 * Claude Code uses `timestamp`; Cowork audit logs use `_audit_timestamp`.
 */
function extractTimestamp(line: string): string | null {
    try {
        const entry = JSON.parse(line);
        const raw = entry.timestamp ?? entry._audit_timestamp ?? entry.snapshot?.timestamp;
        if (typeof raw === 'string' && !Number.isNaN(new Date(raw).getTime())) {
            return new Date(raw).toISOString();
        }
    } catch {
        // skip
    }
    return null;
}

export function getFirstTimestamp(lines: string[]): string | null {
    for (const line of lines) {
        const ts = extractTimestamp(line);
        if (ts) return ts;
    }
    return null;
}

export function getLastTimestamp(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
        const ts = extractTimestamp(lines[i]);
        if (ts) return ts;
    }
    return null;
}

/**
 * Read the parent session UUID referenced inside an agent transcript file's lines.
 */
export function extractParentSessionIdFromLines(lines: string[]): string | null {
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (typeof entry.sessionId === 'string' && UUID_PATTERN.test(entry.sessionId)) {
                return entry.sessionId;
            }
        } catch {
            // skip
        }
    }
    return null;
}
