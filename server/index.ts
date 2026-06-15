#!/usr/bin/env bun
/**
 * Central server: ingestion endpoint, SSE stream, aggregation API, static dashboard.
 *
 *   bun run server/index.ts        # listens on http://localhost:4317
 *
 * Env: LUT_PORT (default 4317), LUT_DB_PATH (default ~/.config/claude-usage-tracker/server.db)
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

// --- Access control (opt-in via env) ---
// LUT_DASH_PASS (+ optional LUT_DASH_USER) gate the dashboard, read APIs and SSE
// behind HTTP Basic Auth. LUT_INGEST_TOKEN gates /ingest behind a shared token.
// When a var is unset the corresponding check is disabled (keeps local dev open).
const DASH_USER = process.env.LUT_DASH_USER || '';
const DASH_PASS = process.env.LUT_DASH_PASS || '';
const INGEST_TOKEN = process.env.LUT_INGEST_TOKEN || '';

function dashAuthOk(req: Request): boolean {
    if (!DASH_PASS) return true; // auth disabled
    const hdr = req.headers.get('authorization') || '';
    if (!hdr.startsWith('Basic ')) return false;
    let decoded = '';
    try {
        decoded = atob(hdr.slice(6));
    } catch {
        return false;
    }
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : '';
    const pass = i >= 0 ? decoded.slice(i + 1) : decoded;
    return (!DASH_USER || user === DASH_USER) && pass === DASH_PASS;
}

function ingestAuthOk(req: Request): boolean {
    if (!INGEST_TOKEN) return true; // token check disabled
    const token =
        req.headers.get('x-ingest-token') ||
        (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return token === INGEST_TOKEN;
}

const unauthorizedDash = () =>
    new Response('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Usage Tracker"' }
    });

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

        // --- Ingestion (gated by LUT_INGEST_TOKEN if set) ---
        if (pathname === '/ingest' && req.method === 'POST') {
            if (!ingestAuthOk(req)) {
                return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
            }
            return handleIngest(db, req);
        }

        // --- Health: always open (Fly healthcheck + client reachability probe) ---
        if (pathname === '/api/health') {
            return Response.json({ ok: true });
        }

        // --- Everything below requires dashboard auth (if LUT_DASH_PASS set) ---
        if (!dashAuthOk(req)) return unauthorizedDash();

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

console.log(`claude-usage-tracker server listening on http://localhost:${server.port}`);
console.log(`dashboard: http://localhost:${server.port}/`);
console.log(
    `auth: dashboard ${DASH_PASS ? 'PROTECTED' : 'OPEN'} · ingest ${INGEST_TOKEN ? 'TOKEN required' : 'OPEN'}`
);
if (!DASH_PASS) {
    console.warn('  ⚠ dashboard is publicly readable — set LUT_DASH_PASS to require a login.');
}
