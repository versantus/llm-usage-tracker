/**
 * Server-side validation of ingest bodies. zod lives here (server only) so the
 * client/hook path stays dependency-free.
 */

import { z } from 'zod';

import type { IngestEvent } from '../shared/types.ts';

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
    modelsUsed: z.record(z.string(), z.number()).default({}),
    inputTokens: z.number().default(0),
    outputTokens: z.number().default(0),
    cacheCreationTokens: z.number().default(0),
    cacheReadTokens: z.number().default(0),
    totalTokens: z.number().default(0),
    energyWh: z.number().default(0),
    co2Grams: z.number().default(0),
    carbonApprox: z.boolean().default(false),
    startedAt: z.string(),
    updatedAt: z.string()
});

export type ValidatedIngest = z.infer<typeof IngestEventSchema>;

// Compile-time guarantee the schema matches the shared IngestEvent shape.
const _typecheck: IngestEvent = {} as ValidatedIngest;
void _typecheck;
