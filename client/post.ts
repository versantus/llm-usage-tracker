/**
 * POST events to the server, with an offline spool + flush.
 */

import type { IngestEvent } from '../shared/types.ts';
import { claimSpool, finishClaim, spool } from './spool.ts';

type SendResult = 'ok' | 'retry' | 'drop';

async function send(
    serverUrl: string,
    event: IngestEvent,
    token?: string,
    timeoutMs = 5000
): Promise<SendResult> {
    try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token) headers['x-ingest-token'] = token;
        const res = await fetch(`${serverUrl.replace(/\/$/, '')}/ingest`, {
            method: 'POST',
            headers,
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (res.ok) return 'ok';
        // 4xx (bad token, schema reject) is permanent: retrying can never
        // succeed, and spooling it would grow the outbox forever.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            console.error(`[usage-tracker] server rejected event (${res.status}) — dropped`);
            return 'drop';
        }
        return 'retry';
    } catch {
        return 'retry';
    }
}

/**
 * Try to flush any spooled events first (bounded, so a backlog can't eat the
 * Stop hook's 15s budget), then send this one. Retryable failures are spooled.
 */
export async function postEvent(
    serverUrl: string,
    event: IngestEvent,
    token?: string
): Promise<boolean> {
    await flushSpool(serverUrl, token, Date.now() + 8000);

    const r = await send(serverUrl, event, token);
    if (r === 'retry') spool(event);
    return r === 'ok';
}

export async function flushSpool(
    serverUrl: string,
    token?: string,
    deadlineMs = Date.now() + 60_000
): Promise<void> {
    const pending = claimSpool();
    if (!pending.length) return;

    const failed: IngestEvent[] = [];
    for (let i = 0; i < pending.length; i++) {
        const left = deadlineMs - Date.now();
        if (left <= 0) {
            failed.push(...pending.slice(i));
            break;
        }
        const r = await send(serverUrl, pending[i], token, Math.min(5000, left));
        if (r === 'retry') failed.push(pending[i]);
        // 'drop': permanently rejected — discard rather than retry forever
    }
    finishClaim(failed);
}
