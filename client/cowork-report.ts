/**
 * Scan Cowork audit logs and report any that changed. Shared by `lut scan-cowork`
 * and `lut watch-cowork`. Reports ABSOLUTE totals (server upserts, so re-reporting
 * a growing session is safe).
 */

import type { ClientConfig } from './config.ts';
import { postEvent } from './post.ts';
import { coworkSource, listCoworkAuditFiles } from './sources/cowork-source.ts';
import { toIngestEvent } from './sources/source.ts';

export interface ScanResult {
    scanned: number;
    sent: number;
}

function log(msg: string): void {
    console.error(`[usage-tracker:cowork] ${msg}`);
}

/**
 * One scan pass. `seen` maps audit path -> last mtime reported, so unchanged
 * files are skipped across passes (pass a fresh Map for a stateless one-shot).
 */
export async function scanCowork(
    cfg: ClientConfig,
    opts: { seen?: Map<string, number>; quiet?: boolean } = {}
): Promise<ScanResult> {
    if (!cfg.surfaces.cowork) return { scanned: 0, sent: 0 };
    const seen = opts.seen ?? new Map<string, number>();
    const files = listCoworkAuditFiles();
    let sent = 0;

    for (const f of files) {
        if (seen.get(f.auditPath) === f.mtimeMs) continue;

        const session = coworkSource.collectSession({
            sessionId: f.sessionId,
            transcriptPath: f.auditPath
        });
        seen.set(f.auditPath, f.mtimeMs);
        if (!session || session.usage.totals.totalTokens === 0) continue;

        const event = toIngestEvent(cfg, session);
        const ok = await postEvent(cfg.serverUrl, event, cfg.ingestToken);
        if (ok) sent++;
        if (!opts.quiet) {
            log(
                ok
                    ? `sent ${session.sessionId} (${event.totalTokens} tok)`
                    : `server unreachable — spooled ${session.sessionId}`
            );
        }
    }

    return { scanned: files.length, sent };
}
