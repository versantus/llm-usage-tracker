#!/usr/bin/env bun
/**
 * Central server: ingestion endpoint, SSE stream, aggregation API, static dashboard.
 *
 *   bun run server/index.ts        # listens on http://localhost:4317
 *
 * Env: CUT_PORT (default 4317), CUT_DB_PATH (default ~/.config/claude-usage-tracker/server.db)
 */

import { join } from 'node:path';

import {
    openDb,
    overTime,
    sessionsForUser,
    summaryByModel,
    summaryByProvider,
    summaryByUser,
    totals
} from './db.ts';
import { handleIngest } from './ingest.ts';
import { sseResponse } from './sse.ts';

const PORT = Number(process.env.CUT_PORT) || 4317;
const PUBLIC_DIR = join(import.meta.dir, 'public');

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

        // --- Ingestion ---
        if (pathname === '/ingest' && req.method === 'POST') {
            return handleIngest(db, req);
        }

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
            return Response.json(sessionsForUser(db, userId));
        }
        if (pathname === '/api/health') {
            return Response.json({ ok: true });
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
