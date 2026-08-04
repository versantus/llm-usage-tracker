/**
 * Offline spool: when the server is unreachable, append events to an NDJSON
 * outbox and flush them on the next opportunity (hook run or setup).
 *
 * Several processes share the spool (the Stop hook + any watchers), so a flush
 * CLAIMS the file by renaming it aside first — concurrent appends then land in
 * a fresh spool instead of being lost by a whole-file rewrite. Failures are
 * pushed back with append-only `spool()`. Re-sends are safe: the server
 * upserts absolute totals, so a duplicate never double-counts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import type { IngestEvent } from '../shared/types.ts';
import { spoolPath } from './config.ts';

export function spool(event: IngestEvent): void {
    mkdirSync(dirname(spoolPath()), { recursive: true });
    appendFileSync(spoolPath(), JSON.stringify(event) + '\n');
}

function readSpoolFile(path: string): IngestEvent[] {
    let text: string;
    try {
        text = readFileSync(path, 'utf-8');
    } catch {
        return []; // missing or unreadable
    }
    return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
            try {
                return JSON.parse(l) as IngestEvent;
            } catch {
                return null;
            }
        })
        .filter((e): e is IngestEvent => e !== null);
}

export function readSpool(): IngestEvent[] {
    return readSpoolFile(spoolPath());
}

function claimPath(): string {
    return `${spoolPath()}.sending`;
}

/**
 * Claim the spooled events for sending. A leftover claim from a crashed flush
 * is picked up first; otherwise the live spool is renamed aside atomically.
 * Returns [] when another process holds the claim.
 */
export function claimSpool(): IngestEvent[] {
    const work = claimPath();
    if (!existsSync(work)) {
        if (!existsSync(spoolPath())) return [];
        try {
            renameSync(spoolPath(), work);
        } catch {
            return []; // another process claimed it between the check and the rename
        }
    }
    return readSpoolFile(work);
}

/** Release a claim: re-spool events that still need retrying (append-only). */
export function finishClaim(failed: IngestEvent[]): void {
    for (const e of failed) spool(e);
    try {
        rmSync(claimPath());
    } catch {
        // already gone
    }
}
