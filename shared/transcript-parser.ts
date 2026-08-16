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
 * de-duplicated by message.id: one API response is written as SEVERAL
 * assistant lines (one per content block), each with a unique uuid but the
 * same message.id and the same full usage — deduping by uuid double-counts.
 */
export function parseTranscriptLines(lines: Iterable<string>): TokenUsageRecord[] {
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
                (typeof message.id === 'string' && message.id) ||
                (typeof entry.requestId === 'string' && entry.requestId) ||
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
/** Normalised timestamp from an already-parsed entry, or null. */
function timestampFromEntry(entry: any): string | null {
    const raw = entry?.timestamp ?? entry?._audit_timestamp ?? entry?.snapshot?.timestamp;
    if (typeof raw === 'string' && !Number.isNaN(new Date(raw).getTime())) {
        return new Date(raw).toISOString();
    }
    return null;
}

function extractTimestamp(line: string): string | null {
    try {
        return timestampFromEntry(JSON.parse(line));
    } catch {
        return null; // skip malformed
    }
}

export function getFirstTimestamp(lines: Iterable<string>): string | null {
    for (const line of lines) {
        const ts = extractTimestamp(line);
        if (ts) return ts;
    }
    return null;
}

/**
 * Last timestamp in the transcript. Scans forward and keeps the most recent
 * hit rather than walking backwards from the end: the input is an iterable so
 * it can be a streaming reader, which has no index and no length.
 */
export function getLastTimestamp(lines: Iterable<string>): string | null {
    let last: string | null = null;
    for (const line of lines) {
        const ts = extractTimestamp(line);
        if (ts) last = ts;
    }
    return last;
}

/**
 * Read the parent session UUID referenced inside an agent transcript file's lines.
 */
export function extractParentSessionIdFromLines(lines: Iterable<string>): string | null {
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

export interface TranscriptScan {
    records: TokenUsageRecord[];
    /** Earliest timestamp seen, or null if the transcript has none. */
    firstTimestamp: string | null;
    /** Latest timestamp seen, or null if the transcript has none. */
    lastTimestamp: string | null;
}

/**
 * Everything the collectors need from a transcript, in ONE pass.
 *
 * Callers used to run parseTranscriptLines + getFirstTimestamp +
 * getLastTimestamp over the same in-memory array. With a streaming reader the
 * input can only be consumed once, and re-reading the file three times would
 * be wasteful, so the three walks are fused here.
 */
export function scanTranscript(
    lines: Iterable<string>,
    /**
     * Called with every successfully parsed entry, so a caller that needs its
     * own derived data (the work-type feature vector) can share this walk's
     * single JSON.parse instead of re-reading and re-parsing the transcript.
     */
    onEntry?: (entry: any) => void
): TranscriptScan {
    const records: TokenUsageRecord[] = [];
    const seen = new Set<string>();
    let counter = 0;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;

    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as Record<string, any>;
            if (onEntry) onEntry(entry);

            const ts = timestampFromEntry(entry);
            if (ts) {
                if (!firstTimestamp) firstTimestamp = ts;
                lastTimestamp = ts;
            }

            if (entry?.type !== 'assistant') continue;

            const message = entry.message;
            const usage = message?.usage;
            if (!usage || typeof usage !== 'object') continue;

            const requestId =
                (typeof message.id === 'string' && message.id) ||
                (typeof entry.requestId === 'string' && entry.requestId) ||
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

    return { records, firstTimestamp, lastTimestamp };
}
