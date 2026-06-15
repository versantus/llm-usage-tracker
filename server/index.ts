#!/usr/bin/env bun
/**
 * Central server: ingestion endpoint, SSE stream, aggregation API, static dashboard.
 *
 *   bun run server/index.ts        # listens on http://localhost:4317
 *
 * Env: LUT_PORT (default 4317), LUT_DB_PATH (default ~/.config/llm-usage-tracker/server.db)
 */

import { join } from 'node:path';

import {
    getUser,
    modelsForUser,
    openDb,
    overTime,
    overTimeForUser,
    sessionsForUser,
    summaryByModel,
    summaryByProvider,
    summaryByUser,
    totals
} from './db.ts';
import { handleIngest } from './ingest.ts';
import { sseResponse } from './sse.ts';

const PORT = Number(process.env.LUT_PORT) || 4317;
const PUBLIC_DIR = join(import.meta.dir, 'public');

// --- Access control (fail-closed) ---
// LUT_DASH_PASS (+ optional LUT_DASH_USER) gate the dashboard, read APIs and SSE
// behind HTTP Basic Auth. LUT_INGEST_TOKEN gates /ingest behind a shared token.
//
// FAIL CLOSED: if a secret is not set, the corresponding surface is DENIED (503),
// not opened — forgetting to configure auth must never expose data. For local
// development, set LUT_ALLOW_NO_AUTH=1 to explicitly run without auth (only the
// /api/health probe is ever open regardless).
const DASH_USER = process.env.LUT_DASH_USER || '';
const DASH_PASS = process.env.LUT_DASH_PASS || '';
const INGEST_TOKEN = process.env.LUT_INGEST_TOKEN || '';
const ALLOW_NO_AUTH = process.env.LUT_ALLOW_NO_AUTH === '1';

const notConfigured = (what: string, env: string) =>
    new Response(
        `${what} auth is not configured. Set ${env} (or LUT_ALLOW_NO_AUTH=1 for local dev).`,
        { status: 503 }
    );

const unauthorizedDash = () =>
    new Response('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Usage Tracker"' }
    });

/** Returns a Response to short-circuit with, or null when the request may proceed. */
function dashGate(req: Request): Response | null {
    if (!DASH_PASS) return ALLOW_NO_AUTH ? null : notConfigured('Dashboard', 'LUT_DASH_PASS');

    const hdr = req.headers.get('authorization') || '';
    if (!hdr.startsWith('Basic ')) return unauthorizedDash();
    let decoded = '';
    try {
        decoded = atob(hdr.slice(6));
    } catch {
        return unauthorizedDash();
    }
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : '';
    const pass = i >= 0 ? decoded.slice(i + 1) : decoded;
    const ok = (!DASH_USER || user === DASH_USER) && pass === DASH_PASS;
    return ok ? null : unauthorizedDash();
}

/** Returns a Response to short-circuit with, or null when ingestion may proceed. */
function ingestGate(req: Request): Response | null {
    if (!INGEST_TOKEN) {
        return ALLOW_NO_AUTH ? null : notConfigured('Ingest', 'LUT_INGEST_TOKEN');
    }
    const token =
        req.headers.get('x-ingest-token') ||
        (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return token === INGEST_TOKEN
        ? null
        : Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

const db = openDb();

function daysParam(url: URL): number | undefined {
    const v = url.searchParams.get('days');
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const { pathname } = url;

        // --- Ingestion (requires LUT_INGEST_TOKEN unless LUT_ALLOW_NO_AUTH=1) ---
        if (pathname === '/ingest' && req.method === 'POST') {
            const gate = ingestGate(req);
            if (gate) return gate;
            return handleIngest(db, req);
        }

        // --- Health: always open (Fly healthcheck + client reachability probe) ---
        if (pathname === '/api/health') {
            return Response.json({ ok: true });
        }

        // --- Everything below requires dashboard auth (fail-closed) ---
        const gate = dashGate(req);
        if (gate) return gate;

        // --- Realtime stream ---
        if (pathname === '/events') {
            return sseResponse();
        }

        // --- Aggregation API ---
        if (pathname === '/api/summary') {
            const days = daysParam(url);
            return Response.json({
                totals: totals(db, days),
                byUser: summaryByUser(db, days),
                byProvider: summaryByProvider(db, days)
            });
        }
        if (pathname === '/api/by-model') {
            return Response.json(summaryByModel(db, daysParam(url)));
        }
        if (pathname === '/api/over-time') {
            return Response.json(overTime(db, daysParam(url)));
        }
        if (pathname.startsWith('/api/by-user/')) {
            const userId = decodeURIComponent(pathname.slice('/api/by-user/'.length));
            const days = daysParam(url);
            return Response.json({
                user: getUser(db, userId),
                models: modelsForUser(db, userId, days),
                overTime: overTimeForUser(db, userId, days),
                sessions: sessionsForUser(db, userId, days)
            });
        }

        // --- Static dashboard ---
        if (pathname === '/' || pathname === '/index.html') {
            return new Response(Bun.file(join(PUBLIC_DIR, 'index.html')));
        }
        if (pathname === '/dashboard.js' || pathname === '/styles.css') {
            return new Response(Bun.file(join(PUBLIC_DIR, pathname.slice(1))));
        }

        return new Response('Not found', { status: 404 });
    }
});

console.log(`llm-usage-tracker server listening on http://localhost:${server.port}`);
console.log(`dashboard: http://localhost:${server.port}/`);
const dashState = DASH_PASS ? 'PROTECTED' : ALLOW_NO_AUTH ? 'OPEN (LUT_ALLOW_NO_AUTH)' : 'LOCKED (503)';
const ingestState = INGEST_TOKEN ? 'TOKEN required' : ALLOW_NO_AUTH ? 'OPEN (LUT_ALLOW_NO_AUTH)' : 'LOCKED (503)';
console.log(`auth: dashboard ${dashState} · ingest ${ingestState}`);
if (!ALLOW_NO_AUTH && (!DASH_PASS || !INGEST_TOKEN)) {
    console.warn(
        '  ⚠ fail-closed: unset secrets return 503. Set LUT_DASH_PASS and LUT_INGEST_TOKEN,' +
            ' or LUT_ALLOW_NO_AUTH=1 for local dev.'
    );
}
