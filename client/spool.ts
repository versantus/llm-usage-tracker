/**
 * Offline spool: when the server is unreachable, append events to an NDJSON
 * outbox and flush them on the next opportunity (hook run or setup).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { IngestEvent } from '../shared/types.ts';
import { spoolPath } from './config.ts';

export function spool(event: IngestEvent): void {
    mkdirSync(dirname(spoolPath()), { recursive: true });
    appendFileSync(spoolPath(), JSON.stringify(event) + '\n');
}

export function readSpool(): IngestEvent[] {
    if (!existsSync(spoolPath())) return [];
    return readFileSync(spoolPath(), 'utf-8')
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

export function rewriteSpool(events: IngestEvent[]): void {
    if (!events.length) {
        writeFileSync(spoolPath(), '');
        return;
    }
    writeFileSync(spoolPath(), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
