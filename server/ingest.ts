/**
 * Ingest handler: validate the body, upsert, broadcast to the dashboard.
 */

import type { Database } from 'bun:sqlite';

import { IngestEventSchema } from './schema.ts';
import { upsertEvent } from './db.ts';
import { broadcast } from './sse.ts';

export async function handleIngest(db: Database, req: Request): Promise<Response> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
    }

    const parsed = IngestEventSchema.safeParse(body);
    if (!parsed.success) {
        return Response.json(
            { ok: false, error: 'validation failed', issues: parsed.error.issues },
            { status: 400 }
        );
    }

    const event = parsed.data;
    upsertEvent(db, event);

    broadcast('session', {
        userId: event.userId,
        userName: event.userName,
        provider: event.provider,
        surface: event.surface,
        sessionId: event.sessionId,
        primaryModel: event.primaryModel,
        totalTokens: event.totalTokens,
        co2Grams: event.co2Grams,
        updatedAt: event.updatedAt
    });

    return Response.json({ ok: true, session: event.sessionId });
}
