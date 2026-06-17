/**
 * Scan Codex rollouts and report any that changed. Shared by `lut scan-codex`
 * (one-shot / periodic) and `lut watch-codex` (loop). Reports ABSOLUTE totals,
 * so the server upsert dedups — re-reporting a growing session is safe.
 */

import type { ClientConfig } from './config.ts';
import { postEvent } from './post.ts';
import { codexSource, listCodexRollouts } from './sources/codex-source.ts';
import { toIngestEvent } from './sources/source.ts';

export interface ScanResult {
    scanned: number;
    sent: number;
}

function log(msg: string): void {
    console.error(`[usage-tracker:codex] ${msg}`);
}

/**
 * One scan pass. `seen` maps rollout path -> last mtime reported, so unchanged
 * files are skipped across passes (pass a fresh Map for a stateless one-shot).
 */
export async function scanCodex(
    cfg: ClientConfig,
    opts: { sinceHours?: number; seen?: Map<string, number>; quiet?: boolean } = {}
): Promise<ScanResult> {
    const seen = opts.seen ?? new Map<string, number>();
    const rollouts = listCodexRollouts(opts.sinceHours ?? 0);
    let sent = 0;

    for (const r of rollouts) {
        if (seen.get(r.path) === r.mtimeMs) continue;

        const session = codexSource.collectSession({
            sessionId: r.sessionId,
            transcriptPath: r.path
        });
        seen.set(r.path, r.mtimeMs);
        if (!session || session.usage.totals.totalTokens === 0) continue;

        const event = toIngestEvent(cfg, session);
        const ok = await postEvent(cfg.serverUrl, event, cfg.ingestToken);
        if (ok) sent++;
        if (!opts.quiet) {
            log(
                ok
                    ? `sent ${session.sessionId} (${event.totalTokens} tok, ${event.primaryModel ?? ''})`
                    : `server unreachable — spooled ${session.sessionId}`
            );
        }
    }

    return { scanned: rollouts.length, sent };
}
