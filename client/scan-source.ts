/**
 * Generic "scan a source's sessions and report changed ones" helper, shared by
 * the watcher-based surfaces (copilot, gemini, ollama, …). Reports ABSOLUTE
 * totals so the server upserts (re-reporting a growing session is safe).
 *
 * Dedup is keyed by sessionId (not path) so sources where many sessions share
 * one file — e.g. Gemini's single telemetry log — don't skip siblings.
 */

import type { ClientConfig } from './config.ts';
import { postEvent } from './post.ts';
import type { Source } from './sources/source.ts';
import { toIngestEvent } from './sources/source.ts';

export interface ScanItem {
    sessionId: string;
    path: string;
    mtimeMs: number;
}

export interface ScanResult {
    scanned: number;
    sent: number;
}

export async function scanSource(
    cfg: ClientConfig,
    label: string,
    items: ScanItem[],
    source: Source,
    opts: { seen?: Map<string, number>; quiet?: boolean } = {}
): Promise<ScanResult> {
    const seen = opts.seen ?? new Map<string, number>();
    let sent = 0;

    for (const it of items) {
        if (seen.get(it.sessionId) === it.mtimeMs) continue;
        const session = source.collectSession({ sessionId: it.sessionId, transcriptPath: it.path });
        seen.set(it.sessionId, it.mtimeMs);
        if (!session || session.usage.totals.totalTokens === 0) continue;

        const event = toIngestEvent(cfg, session);
        const ok = await postEvent(cfg.serverUrl, event, cfg.ingestToken);
        if (ok) sent++;
        if (!opts.quiet) {
            console.error(
                `[usage-tracker:${label}] ${ok ? 'sent' : 'spooled'} ${session.sessionId} (${event.totalTokens} tok)`
            );
        }
    }
    return { scanned: items.length, sent };
}
