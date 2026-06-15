/**
 * Source abstraction. A Source turns a trigger (a session id / path) into a
 * fully-parsed CollectedSession with ABSOLUTE totals. Two kinds exist:
 *   - transcript/local sources (parse files or a local DB): claude-code, cowork, codex
 *   - api-pull sources (poll a vendor admin API): cursor, openai, google  [future]
 */

import {
    calculateSessionCarbon,
    isCarbonApproximate
} from '../../shared/carbon-calculator.ts';
import type { CollectedSession, IngestEvent } from '../../shared/types.ts';
import type { ClientConfig } from '../config.ts';

export interface Source {
    /** Return the parsed session (absolute totals), or null if not found. */
    collectSession(args: {
        sessionId: string;
        transcriptPath?: string;
        cwd?: string;
    }): CollectedSession | null;
}

/**
 * Build the ingest payload from a collected session + the local identity,
 * computing carbon from per-request records.
 */
export function toIngestEvent(cfg: ClientConfig, s: CollectedSession): IngestEvent {
    const carbon = calculateSessionCarbon(s.usage);
    const approx = isCarbonApproximate(s.usage.primaryModel);

    return {
        userId: cfg.userId,
        userName: cfg.user.name,
        userEmail: cfg.user.email,
        machineId: cfg.machineId,
        provider: s.provider,
        surface: s.surface,
        sessionId: s.sessionId,
        cwd: s.cwd,
        primaryModel: s.usage.primaryModel,
        modelsUsed: s.usage.modelBreakdown,
        inputTokens: s.usage.totals.inputTokens,
        outputTokens: s.usage.totals.outputTokens,
        cacheCreationTokens: s.usage.totals.cacheCreationTokens,
        cacheReadTokens: s.usage.totals.cacheReadTokens,
        totalTokens: s.usage.totals.totalTokens,
        energyWh: carbon.energy.energyWh,
        co2Grams: carbon.co2Grams,
        carbonApprox: approx,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt
    };
}
