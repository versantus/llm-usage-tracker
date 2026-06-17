/**
 * Shared types used by the client, server and CLI.
 *
 * Intentionally dependency-free (no zod) so the client/hook path runs under
 * `npx -y bun` with no install step. The server validates ingest bodies with
 * zod in server/schema.ts.
 */

/** Which vendor produced the usage. */
export type Provider = 'anthropic' | 'openai' | 'google' | 'cursor' | 'unknown';

/** Which surface/tool the session ran in. */
export type Surface =
    | 'claude-code'
    | 'cowork'
    | 'codex-cli'
    | 'gemini-cli'
    | 'copilot'
    | 'ollama'
    | 'cursor'
    | 'unknown';

/**
 * A single API request's token usage, parsed from a transcript line.
 */
export interface TokenUsageRecord {
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}

/**
 * Aggregated usage for one session (the absolute totals for the whole session).
 */
export interface SessionUsage {
    records: TokenUsageRecord[];
    totals: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        totalTokens: number;
    };
    /** modelId -> total tokens for that model */
    modelBreakdown: Record<string, number>;
    primaryModel: string;
}

/**
 * What a Source returns: a fully-parsed session with absolute totals.
 */
export interface CollectedSession {
    provider: Provider;
    surface: Surface;
    sessionId: string;
    cwd: string;
    usage: SessionUsage;
    startedAt: string; // ISO 8601
    updatedAt: string; // ISO 8601
}

/**
 * The payload the client POSTs to the server's /ingest endpoint.
 * The client always sends ABSOLUTE session totals so the server can
 * upsert by (userId, sessionId) without double-counting.
 */
export interface IngestEvent {
    userId: string;
    userName: string;
    userEmail: string;
    machineId: string;
    /** Human-friendly device / OS label (e.g. "macOS", "Windows laptop"). Set at setup. */
    deviceName: string;
    provider: Provider;
    surface: Surface;
    sessionId: string;
    cwd: string;
    primaryModel: string;
    /** modelId -> total tokens */
    modelsUsed: Record<string, number>;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    energyWh: number;
    co2Grams: number;
    /** True when carbon is a rough estimate (e.g. provider with aggregate-only tokens). */
    carbonApprox: boolean;
    startedAt: string;
    updatedAt: string;
}
