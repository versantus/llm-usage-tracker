#!/usr/bin/env bun
/**
 * Cowork watcher: polls the Cowork local-agent-mode-sessions directory and POSTs
 * any session whose audit.jsonl changed since we last saw it. Cowork has no user
 * hook, so this long-running process is the trigger.
 *
 *   bun run client/watch-cowork.ts [--interval 15] [--once]
 */

import { loadConfig } from './config.ts';
import { postEvent } from './post.ts';
import {
    coworkAvailable,
    coworkSessionsRoot,
    coworkSource,
    listCoworkAuditFiles
} from './sources/cowork-source.ts';
import { toIngestEvent } from './sources/source.ts';

const args = process.argv.slice(2);
const once = args.includes('--once');
const intervalIdx = args.indexOf('--interval');
const intervalSec = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) || 15 : 15;

const seen = new Map<string, number>(); // auditPath -> last mtimeMs sent

function logLine(msg: string): void {
    console.error(`[usage-tracker:cowork] ${msg}`);
}

async function scanOnce(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg) {
        logLine('not configured — run `cut setup` first.');
        return;
    }
    if (!cfg.surfaces.cowork) return;

    for (const file of listCoworkAuditFiles()) {
        if (seen.get(file.auditPath) === file.mtimeMs) continue;

        const session = coworkSource.collectSession({
            sessionId: file.sessionId,
            transcriptPath: file.auditPath
        });
        if (!session || session.usage.totals.totalTokens === 0) {
            seen.set(file.auditPath, file.mtimeMs);
            continue;
        }

        const event = toIngestEvent(cfg, session);
        const ok = await postEvent(cfg.serverUrl, event, cfg.ingestToken);
        seen.set(file.auditPath, file.mtimeMs);
        logLine(
            ok
                ? `sent ${session.sessionId} (${event.totalTokens} tok)`
                : `server unreachable — spooled ${session.sessionId}`
        );
    }
}

if (!coworkAvailable()) {
    logLine(`Cowork sessions dir not found at ${coworkSessionsRoot()} — nothing to watch.`);
    process.exit(0);
}

await scanOnce();
if (!once) {
    logLine(`watching ${coworkSessionsRoot()} every ${intervalSec}s`);
    setInterval(scanOnce, intervalSec * 1000);
}
