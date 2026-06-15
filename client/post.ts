/**
 * POST events to the server, with an offline spool + flush.
 */

import type { IngestEvent } from '../shared/types.ts';
import { readSpool, rewriteSpool, spool } from './spool.ts';

async function send(
    serverUrl: string,
    event: IngestEvent,
    token?: string,
    timeoutMs = 5000
): Promise<boolean> {
    try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token) headers['x-ingest-token'] = token;
        const res = await fetch(`${serverUrl.replace(/\/$/, '')}/ingest`, {
            method: 'POST',
            headers,
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(timeoutMs)
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Try to flush any spooled events first, then send this one.
 * Anything that fails (including the current event) is (re)spooled.
 */
export async function postEvent(
    serverUrl: string,
    event: IngestEvent,
    token?: string
): Promise<boolean> {
    await flushSpool(serverUrl, token);

    const ok = await send(serverUrl, event, token);
    if (!ok) spool(event);
    return ok;
}

export async function flushSpool(serverUrl: string, token?: string): Promise<void> {
    const pending = readSpool();
    if (!pending.length) return;

    const stillPending: IngestEvent[] = [];
    for (const e of pending) {
        const ok = await send(serverUrl, e, token);
        if (!ok) stillPending.push(e);
    }
    rewriteSpool(stillPending);
}
