/**
 * Server data store: SQLite via bun:sqlite.
 *
 * The sessions table is keyed by (user_id, session_id) so re-sends of a growing
 * session OVERWRITE rather than accumulate — the client always sends absolute
 * session totals. This is what prevents double-counting.
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

import type { IngestEvent } from '../shared/types.ts';

const SCHEMA_VERSION = 3;

export function defaultDbPath(): string {
    return (
        process.env.LUT_DB_PATH ||
        join(homedir(), '.config', 'llm-usage-tracker', 'server.db')
    );
}

export function openDb(dbPath = defaultDbPath()): Database {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    migrate(db);
    return db;
}

function migrate(db: Database): void {
    let current = (db.query('PRAGMA user_version').get() as { user_version: number })
        .user_version;
    if (current >= SCHEMA_VERSION) return;

    // v1: base schema (fresh installs get the latest column set directly).
    if (current < 1) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                user_id    TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                email      TEXT NOT NULL,
                first_seen TEXT NOT NULL,
                last_seen  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                user_id               TEXT NOT NULL,
                session_id            TEXT NOT NULL,
                provider              TEXT NOT NULL DEFAULT 'anthropic',
                surface               TEXT NOT NULL DEFAULT 'claude-code',
                machine_id            TEXT NOT NULL DEFAULT '',
                device_name           TEXT NOT NULL DEFAULT '',
                cwd                   TEXT NOT NULL DEFAULT '',
                primary_model         TEXT NOT NULL DEFAULT 'unknown',
                models_used           TEXT NOT NULL DEFAULT '{}',
                input_tokens          INTEGER NOT NULL DEFAULT 0,
                output_tokens         INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
                total_tokens          INTEGER NOT NULL DEFAULT 0,
                energy_wh             REAL NOT NULL DEFAULT 0,
                co2_grams             REAL NOT NULL DEFAULT 0,
                carbon_approx         INTEGER NOT NULL DEFAULT 0,
                category              TEXT NOT NULL DEFAULT 'unknown',
                category_confidence  REAL NOT NULL DEFAULT 0,
                category_source       TEXT NOT NULL DEFAULT 'none',
                started_at            TEXT NOT NULL,
                updated_at            TEXT NOT NULL,
                PRIMARY KEY (user_id, session_id)
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_model   ON sessions(primary_model);
            CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
        `);
        current = SCHEMA_VERSION; // fresh DB already has every column below
    }

    // v2: per-session device label (added to existing v1 databases).
    // Tolerate a re-run: a crash between this ALTER and the user_version bump
    // below would otherwise make every subsequent boot throw "duplicate column".
    if (current < 2) {
        try {
            db.exec(`ALTER TABLE sessions ADD COLUMN device_name TEXT NOT NULL DEFAULT '';`);
        } catch (err: any) {
            if (!String(err?.message ?? err).includes('duplicate column')) throw err;
        }
    }

    // v3: work-type category (privacy-safe closed enum + confidence + source).
    if (current < 3) {
        for (const ddl of [
            `ALTER TABLE sessions ADD COLUMN category TEXT NOT NULL DEFAULT 'unknown';`,
            `ALTER TABLE sessions ADD COLUMN category_confidence REAL NOT NULL DEFAULT 0;`,
            `ALTER TABLE sessions ADD COLUMN category_source TEXT NOT NULL DEFAULT 'none';`
        ]) {
            try {
                db.exec(ddl);
            } catch (err: any) {
                if (!String(err?.message ?? err).includes('duplicate column')) throw err;
            }
        }
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);

    // Idempotent index upkeep (runs on every boot, cheap when already applied).
    // Range filters and time buckets use updated_at — without these, every
    // dashboard aggregate is a full table scan.
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_updated      ON sessions(updated_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated_at);
        DROP INDEX IF EXISTS idx_sessions_started;
    `);
}

/**
 * Upsert a user + session from an ingest event. Absolute totals overwrite.
 * Preserves the original started_at on conflict.
 */
export const upsertEvent = (db: Database, e: IngestEvent): void => {
    // One transaction -> one WAL commit for the two statements.
    upsertTxn(db)(db, e);
};

const txnCache = new WeakMap<Database, (db: Database, e: IngestEvent) => void>();
function upsertTxn(db: Database) {
    let txn = txnCache.get(db);
    if (!txn) {
        txn = db.transaction((d: Database, ev: IngestEvent) => doUpsert(d, ev)) as any;
        txnCache.set(db, txn!);
    }
    return txn!;
}

function doUpsert(db: Database, e: IngestEvent): void {
    const now = new Date().toISOString();

    db.query(
        `INSERT INTO users (user_id, name, email, first_seen, last_seen)
         VALUES ($id, $name, $email, $now, $now)
         ON CONFLICT(user_id) DO UPDATE SET
            name = excluded.name,
            email = excluded.email,
            last_seen = excluded.last_seen`
    ).run({ $id: e.userId, $name: e.userName, $email: e.userEmail, $now: now });

    db.query(
        `INSERT INTO sessions (
            user_id, session_id, provider, surface, machine_id, device_name, cwd,
            primary_model, models_used,
            input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
            energy_wh, co2_grams, carbon_approx,
            category, category_confidence, category_source, started_at, updated_at
         ) VALUES (
            $user_id, $session_id, $provider, $surface, $machine_id, $device_name, $cwd,
            $primary_model, $models_used,
            $input_tokens, $output_tokens, $cache_creation_tokens, $cache_read_tokens, $total_tokens,
            $energy_wh, $co2_grams, $carbon_approx,
            $category, $category_confidence, $category_source, $started_at, $updated_at
         )
         ON CONFLICT(user_id, session_id) DO UPDATE SET
            provider = excluded.provider,
            surface = excluded.surface,
            machine_id = excluded.machine_id,
            device_name = excluded.device_name,
            cwd = excluded.cwd,
            primary_model = excluded.primary_model,
            models_used = excluded.models_used,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_creation_tokens = excluded.cache_creation_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            total_tokens = excluded.total_tokens,
            energy_wh = excluded.energy_wh,
            co2_grams = excluded.co2_grams,
            carbon_approx = excluded.carbon_approx,
            category = excluded.category,
            category_confidence = excluded.category_confidence,
            category_source = excluded.category_source,
            updated_at = excluded.updated_at
         WHERE excluded.updated_at >= sessions.updated_at`
    ).run({
        $user_id: e.userId,
        $session_id: e.sessionId,
        $provider: e.provider,
        $surface: e.surface,
        $machine_id: e.machineId,
        $device_name: e.deviceName || '',
        $cwd: e.cwd,
        $primary_model: e.primaryModel,
        $models_used: JSON.stringify(e.modelsUsed),
        $input_tokens: e.inputTokens,
        $output_tokens: e.outputTokens,
        $cache_creation_tokens: e.cacheCreationTokens,
        $cache_read_tokens: e.cacheReadTokens,
        $total_tokens: e.totalTokens,
        $energy_wh: e.energyWh,
        $co2_grams: e.co2Grams,
        $carbon_approx: e.carbonApprox ? 1 : 0,
        $category: e.category,
        $category_confidence: e.categoryConfidence,
        $category_source: e.categorySource,
        $started_at: e.startedAt,
        $updated_at: e.updatedAt
    });
}

// Time-range filters use `updated_at` (session ACTIVE within the window), not
// `started_at`. Long-lived sessions — Cowork especially — can start days ago but
// still be appended to now; filtering by started_at hid that recent activity.
//
// The timestamp is BOUND ($since), never interpolated: bun:sqlite caches
// prepared statements by SQL text, so an embedded per-request timestamp would
// re-prepare every query and grow the cache without bound.
function sinceClause(days?: number): string {
    return days && days > 0 ? `WHERE updated_at >= $since` : '';
}

/** Like sinceClause but for appending to an existing WHERE (e.g. WHERE user_id = ?). */
function andSince(days?: number): string {
    return days && days > 0 ? ` AND updated_at >= $since` : '';
}

/** Bind values matching sinceClause/andSince (empty when unranged). */
function sinceParams(days?: number): Record<string, string> {
    return days && days > 0
        ? { $since: new Date(Date.now() - days * 86400_000).toISOString() }
        : {};
}

type ModelRow = {
    models_used: string;
    energy_wh: number;
    co2_grams: number;
    carbon_approx: number;
};

/**
 * Expand a set of session rows into a per-model rollup, allocating each
 * session's energy/CO₂ across its models proportionally to token share.
 * Shared by the global and per-user model breakdowns.
 */
function aggregateModels(rows: ModelRow[]) {
    const byModel: Record<
        string,
        { sessions: number; tokens: number; energy_wh: number; co2_grams: number; carbon_approx: number }
    > = {};

    for (const row of rows) {
        let modelsUsed: Record<string, number> = {};
        try {
            modelsUsed = JSON.parse(row.models_used) || {};
        } catch {
            // ignore malformed JSON
        }

        const totalTokens = Object.values(modelsUsed).reduce((a, b) => a + b, 0) || 1;

        for (const [model, tokens] of Object.entries(modelsUsed)) {
            if (!byModel[model]) {
                byModel[model] = {
                    sessions: 0,
                    tokens: 0,
                    energy_wh: 0,
                    co2_grams: 0,
                    carbon_approx: 0
                };
            }
            // Proportional allocation of energy/co2 to each model based on token share.
            // `sessions` counts sessions the model APPEARED in (fractional shares
            // rounded a 1-in-3-sessions model down to a misleading 0).
            const share = (tokens as number) / totalTokens;
            byModel[model].sessions += 1;
            byModel[model].tokens += tokens as number;
            byModel[model].energy_wh += row.energy_wh * share;
            byModel[model].co2_grams += row.co2_grams * share;
            byModel[model].carbon_approx = Math.max(byModel[model].carbon_approx, row.carbon_approx);
        }
    }

    return Object.entries(byModel)
        .map(([model, data]) => ({
            model,
            sessions: data.sessions,
            tokens: data.tokens,
            energy_wh: data.energy_wh,
            co2_grams: data.co2_grams,
            carbon_approx: data.carbon_approx
        }))
        .sort((a, b) => b.co2_grams - a.co2_grams);
}

/** Per-user rollup. */
export function summaryByUser(db: Database, days?: number) {
    return db
        .query(
            `SELECT u.user_id, u.name, u.email,
                    COUNT(*) AS sessions,
                    COALESCE(SUM(s.total_tokens), 0) AS tokens,
                    COALESCE(SUM(s.energy_wh), 0) AS energy_wh,
                    COALESCE(SUM(s.co2_grams), 0) AS co2_grams
             FROM sessions s JOIN users u USING(user_id)
             ${sinceClause(days)}
             GROUP BY s.user_id
             ORDER BY co2_grams DESC`
        )
        .all(sinceParams(days));
}

/** Per-model rollup: breaks down sessions by their full models_used breakdown, not just primary_model. */
export function summaryByModel(db: Database, days?: number) {
    const rows = db
        .query(
            `SELECT models_used, energy_wh, co2_grams, carbon_approx
             FROM sessions
             ${sinceClause(days)}`
        )
        .all(sinceParams(days)) as ModelRow[];
    return aggregateModels(rows);
}

/** Per-provider rollup. */
export function summaryByProvider(db: Database, days?: number) {
    return db
        .query(
            `SELECT provider,
                    COUNT(*) AS sessions,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams
             FROM sessions
             ${sinceClause(days)}
             GROUP BY provider
             ORDER BY co2_grams DESC`
        )
        .all(sinceParams(days));
}

/**
 * Time-series bucket: hourly for short ranges (≤ 2 days, e.g. the 12h/24h views),
 * daily otherwise. Hourly keys carry a 'T' so the frontend can format them as times.
 * Bucketed by `updated_at` to match the range filter (when a session was active).
 */
function timeBucket(days?: number): string {
    if (days != null && days > 0 && days <= 2) return `strftime('%Y-%m-%dT%H:00', updated_at)`;
    // Unranged ("all time") or very wide ranges bucket monthly so the payload
    // and chart node count stay bounded regardless of history length.
    if (!days || days <= 0 || days > 120) return `strftime('%Y-%m', updated_at)`;
    return `date(updated_at)`;
}

/** Time-series per user (for stacked charts), bucketed by hour or day per range. */
export function overTime(db: Database, days?: number) {
    return db
        .query(
            `SELECT ${timeBucket(days)} AS day,
                    u.name AS user,
                    COALESCE(SUM(s.total_tokens), 0) AS tokens,
                    COALESCE(SUM(s.co2_grams), 0) AS co2_grams
             FROM sessions s JOIN users u USING(user_id)
             ${sinceClause(days)}
             GROUP BY day, s.user_id
             ORDER BY day ASC`
        )
        .all(sinceParams(days));
}

/** Per-work-type rollup. */
export function summaryByCategory(db: Database, days?: number) {
    return db
        .query(
            `SELECT category,
                    COUNT(*) AS sessions,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(energy_wh), 0) AS energy_wh,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams
             FROM sessions
             ${sinceClause(days)}
             GROUP BY category
             ORDER BY tokens DESC`
        )
        .all(sinceParams(days));
}

/** Per-work-type rollup for one user. */
export function categoriesForUser(db: Database, userId: string, days?: number) {
    return db
        .query(
            `SELECT category,
                    COUNT(*) AS sessions,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams
             FROM sessions WHERE user_id = $id${andSince(days)}
             GROUP BY category
             ORDER BY tokens DESC`
        )
        .all({ $id: userId, ...sinceParams(days) });
}

/** Time-series per work type (stacked charts), bucketed like overTime. */
export function overTimeByCategory(db: Database, days?: number) {
    return db
        .query(
            `SELECT ${timeBucket(days)} AS day,
                    category,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams
             FROM sessions
             ${sinceClause(days)}
             GROUP BY day, category
             ORDER BY day ASC`
        )
        .all(sinceParams(days));
}

/** Grand totals. */
export function totals(db: Database, days?: number) {
    return db
        .query(
            `SELECT COUNT(*) AS sessions,
                    COUNT(DISTINCT user_id) AS users,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(energy_wh), 0) AS energy_wh,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams
             FROM sessions ${sinceClause(days)}`
        )
        .get(sinceParams(days));
}

/** Recent sessions for a user, optionally restricted to the last `days`. */
export function sessionsForUser(db: Database, userId: string, days?: number, limit = 50) {
    return db
        .query(
            `SELECT session_id, provider, surface, device_name, primary_model, cwd, category,
                    total_tokens, energy_wh, co2_grams, started_at, updated_at
             FROM sessions WHERE user_id = $id${andSince(days)}
             ORDER BY updated_at DESC LIMIT $limit`
        )
        .all({ $id: userId, $limit: limit, ...sinceParams(days) });
}

/** Identity row for a single user (or null if unknown). */
export function getUser(db: Database, userId: string) {
    return db
        .query(`SELECT user_id, name, email, first_seen, last_seen FROM users WHERE user_id = $id`)
        .get({ $id: userId });
}

/** Per-model breakdown for one user (same proportional allocation as summaryByModel). */
export function modelsForUser(db: Database, userId: string, days?: number) {
    const rows = db
        .query(
            `SELECT models_used, energy_wh, co2_grams, carbon_approx
             FROM sessions WHERE user_id = $id${andSince(days)}`
        )
        .all({ $id: userId, ...sinceParams(days) }) as ModelRow[];
    return aggregateModels(rows);
}

/** Time-series for one user, bucketed by hour or day per range. */
export function overTimeForUser(db: Database, userId: string, days?: number) {
    return db
        .query(
            `SELECT ${timeBucket(days)} AS day,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams,
                    COALESCE(SUM(energy_wh), 0) AS energy_wh
             FROM sessions WHERE user_id = $id${andSince(days)}
             GROUP BY day
             ORDER BY day ASC`
        )
        .all({ $id: userId, ...sinceParams(days) });
}

/** Time-series per work type for one user (stacked charts). */
export function overTimeByCategoryForUser(db: Database, userId: string, days?: number) {
    return db
        .query(
            `SELECT ${timeBucket(days)} AS day,
                    category,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams
             FROM sessions WHERE user_id = $id${andSince(days)}
             GROUP BY day, category
             ORDER BY day ASC`
        )
        .all({ $id: userId, ...sinceParams(days) });
}

/** Per-(app × device) breakdown for one user, e.g. "cowork × macOS". */
export function appDeviceForUser(db: Database, userId: string, days?: number) {
    return db
        .query(
            `SELECT surface,
                    device_name,
                    COUNT(*) AS sessions,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(energy_wh), 0) AS energy_wh,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams
             FROM sessions WHERE user_id = $id${andSince(days)}
             GROUP BY surface, device_name
             ORDER BY tokens DESC`
        )
        .all({ $id: userId, ...sinceParams(days) });
}
