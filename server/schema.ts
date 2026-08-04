/**
 * Server-side validation of ingest bodies. zod lives here (server only) so the
 * client/hook path stays dependency-free.
 */

import { z } from 'zod';

import type { IngestEvent } from '../shared/types.ts';

// Normalise to ISO-8601 UTC: range filters and time buckets compare these
// LEXICOGRAPHICALLY, so a "2026-08-04 10:00:00" or "+02:00" form would sort
// into the wrong buckets if stored as-is.
const isoTimestamp = z
    .string()
    .refine((s) => Number.isFinite(Date.parse(s)), { message: 'invalid timestamp' })
    .transform((s) => new Date(s).toISOString());

const count = z.number().nonnegative().default(0);

export const IngestEventSchema = z.object({
    userId: z.string().min(1),
    userName: z.string().min(1),
    userEmail: z.string().min(1),
    machineId: z.string().default(''),
    deviceName: z.string().default(''),
    provider: z.enum(['anthropic', 'openai', 'google', 'cursor', 'unknown']).default('anthropic'),
    surface: z
        .enum([
            'claude-code',
            'cowork',
            'codex-cli',
            'gemini-cli',
            'antigravity-cli',
            'copilot',
            'ollama',
            'cursor',
            'unknown'
        ])
        .default('claude-code'),
    sessionId: z.string().min(1),
    cwd: z.string().default(''),
    primaryModel: z.string().default('unknown'),
    modelsUsed: z.record(z.string(), z.number().nonnegative()).default({}),
    inputTokens: count,
    outputTokens: count,
    cacheCreationTokens: count,
    cacheReadTokens: count,
    totalTokens: count,
    energyWh: count,
    co2Grams: count,
    carbonApprox: z.boolean().default(false),
    category: z
        .enum(['coding', 'debugging', 'docs-writing', 'research', 'planning', 'other', 'unknown'])
        .default('unknown'),
    categoryConfidence: z.number().min(0).max(1).default(0),
    categorySource: z.enum(['heuristic', 'llm', 'none']).default('none'),
    startedAt: isoTimestamp,
    updatedAt: isoTimestamp
});

export type ValidatedIngest = z.infer<typeof IngestEventSchema>;

// Compile-time guarantee the schema matches the shared IngestEvent shape.
const _typecheck: IngestEvent = {} as ValidatedIngest;
void _typecheck;
