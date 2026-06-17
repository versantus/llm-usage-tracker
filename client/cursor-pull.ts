/**
 * Cursor usage puller (server-side). Cursor keeps per-request usage on its
 * servers, not on disk, so — unlike the other surfaces — there is no local
 * watcher. A team admin pulls usage via the Cursor Admin API and ingests it on
 * behalf of each member.
 *
 *   CURSOR_API_KEY=key_... lut cursor-pull [--days 30]
 *
 * Uses POST https://api.cursor.com/teams/filtered-usage-events (Basic auth, API
 * key as username). One ingest event per usage event, keyed by event id so the
 * server upserts. Carbon is approximate (Cursor proxies many models).
 *
 * ⚠️ UNVERIFIED: written to Cursor's documented Admin API shape but not yet run
 * against a real team key — field names may need adjusting once tested.
 */

import { calculateCarbonFromTokens, isCarbonApproximate } from '../shared/carbon-calculator.ts';
import type { IngestEvent } from '../shared/types.ts';
import type { ClientConfig } from './config.ts';
import { userIdFromEmail } from './config.ts';
import { postEvent } from './post.ts';

const API = 'https://api.cursor.com/teams/filtered-usage-events';

function num(v: unknown): number {
    return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** Pull recent Cursor usage events and ingest them. */
export async function cursorPull(cfg: ClientConfig): Promise<void> {
    const key = process.env.CURSOR_API_KEY || '';
    if (!key) {
        console.error('Set CURSOR_API_KEY (a Cursor team Admin API key) to pull Cursor usage.');
        process.exit(1);
    }
    const daysIdx = process.argv.indexOf('--days');
    const days = (daysIdx >= 0 && Number(process.argv[daysIdx + 1])) || 30;
    const endDate = Date.now();
    const startDate = endDate - days * 86400_000;

    const auth = 'Basic ' + btoa(`${key}:`);
    let page = 1;
    let sent = 0;
    const pageSize = 200;

    while (true) {
        let body: any;
        try {
            const res = await fetch(API, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: auth },
                body: JSON.stringify({ startDate, endDate, page, pageSize })
            });
            if (!res.ok) {
                console.error(`Cursor API ${res.status}: ${await res.text().catch(() => '')}`);
                process.exit(1);
            }
            body = await res.json();
        } catch (err: any) {
            console.error(`Cursor API request failed: ${err.message}`);
            process.exit(1);
        }

        // Defensive: Cursor has shipped this under a few names.
        const events: any[] =
            body.usageEvents || body.usageEventsDisplay || body.events || body.data || [];
        if (!events.length) break;

        for (const ev of events) {
            const email = ev.userEmail || ev.email || ev.user?.email;
            if (!email) continue;
            const tu = ev.tokenUsage || ev.tokens || {};
            const inputTokens = num(tu.inputTokens ?? tu.input ?? tu.promptTokens);
            const outputTokens = num(tu.outputTokens ?? tu.output ?? tu.completionTokens);
            const cacheRead = num(tu.cacheReadTokens ?? tu.cacheRead);
            const cacheWrite = num(tu.cacheWriteTokens ?? tu.cacheWrite);
            const totalTokens = num(tu.totalTokens) || inputTokens + outputTokens + cacheRead + cacheWrite;
            if (totalTokens === 0) continue;

            const model = String(ev.model || ev.modelIntent || 'cursor-unknown');
            const carbon = calculateCarbonFromTokens(outputTokens, model);
            const ts = ev.timestamp
                ? new Date(typeof ev.timestamp === 'number' ? ev.timestamp : Date.parse(ev.timestamp)).toISOString()
                : new Date().toISOString();
            const sessionId = `cursor:${ev.id ?? ev.requestId ?? `${email}:${ts}`}`;

            const event: IngestEvent = {
                userId: userIdFromEmail(email),
                userName: ev.userName || email.split('@')[0],
                userEmail: email,
                machineId: 'cursor-cloud',
                deviceName: 'Cursor',
                provider: 'cursor',
                surface: 'cursor',
                sessionId,
                cwd: '',
                primaryModel: model,
                modelsUsed: { [model]: totalTokens },
                inputTokens,
                outputTokens,
                cacheCreationTokens: cacheWrite,
                cacheReadTokens: cacheRead,
                totalTokens,
                energyWh: carbon.energy.energyWh,
                co2Grams: carbon.co2Grams,
                carbonApprox: isCarbonApproximate(model),
                startedAt: ts,
                updatedAt: ts
            };
            const ok = await postEvent(cfg.serverUrl, event, cfg.ingestToken);
            if (ok) sent++;
        }

        if (events.length < pageSize) break;
        page++;
        if (page > 100) break; // safety
    }

    console.error(`Cursor: ingested ${sent} usage event(s) over the last ${days} days.`);
}
