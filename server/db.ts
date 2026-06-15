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

const SCHEMA_VERSION = 1;

export function defaultDbPath(): string {
    return (
        process.env.LUT_DB_PATH ||
        join(homedir(), '.config', 'claude-usage-tracker', 'server.db')
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
    const current = (db.query('PRAGMA user_version').get() as { user_version: number })
        .user_version;
    if (current >= SCHEMA_VERSION) return;

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
            started_at            TEXT NOT NULL,
            updated_at            TEXT NOT NULL,
            PRIMARY KEY (user_id, session_id)
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_model   ON sessions(primary_model);
        CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
    `);

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

/**
 * Upsert a user + session from an ingest event. Absolute totals overwrite.
 * Preserves the original started_at on conflict.
 */
export function upsertEvent(db: Database, e: IngestEvent): void {
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
            user_id, session_id, provider, surface, machine_id, cwd,
            primary_model, models_used,
            input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
            energy_wh, co2_grams, carbon_approx, started_at, updated_at
         ) VALUES (
            $user_id, $session_id, $provider, $surface, $machine_id, $cwd,
            $primary_model, $models_used,
            $input_tokens, $output_tokens, $cache_creation_tokens, $cache_read_tokens, $total_tokens,
            $energy_wh, $co2_grams, $carbon_approx, $started_at, $updated_at
         )
         ON CONFLICT(user_id, session_id) DO UPDATE SET
            provider = excluded.provider,
            surface = excluded.surface,
            machine_id = excluded.machine_id,
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
            updated_at = excluded.updated_at`
    ).run({
        $user_id: e.userId,
        $session_id: e.sessionId,
        $provider: e.provider,
        $surface: e.surface,
        $machine_id: e.machineId,
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
        $started_at: e.startedAt,
        $updated_at: e.updatedAt
    });
}

function sinceClause(days?: number): string {
    if (!days || days <= 0) return '';
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return `WHERE started_at >= '${since}'`;
}

/** Like sinceClause but for appending to an existing WHERE (e.g. WHERE user_id = ?). */
function andSince(days?: number): string {
    if (!days || days <= 0) return '';
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return ` AND started_at >= '${since}'`;
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
        const sessionCount = Object.keys(modelsUsed).length || 1;

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
            // Proportional allocation of energy/co2 to each model based on token share
            const share = (tokens as number) / totalTokens;
            byModel[model].sessions += 1 / sessionCount;
            byModel[model].tokens += tokens as number;
            byModel[model].energy_wh += row.energy_wh * share;
            byModel[model].co2_grams += row.co2_grams * share;
            byModel[model].carbon_approx = Math.max(byModel[model].carbon_approx, row.carbon_approx);
        }
    }

    return Object.entries(byModel)
        .map(([model, data]) => ({
            model,
            sessions: Math.round(data.sessions),
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
        .all();
}

/** Per-model rollup: breaks down sessions by their full models_used breakdown, not just primary_model. */
export function summaryByModel(db: Database, days?: number) {
    const rows = db
        .query(
            `SELECT models_used, energy_wh, co2_grams, carbon_approx
             FROM sessions
             ${sinceClause(days)}`
        )
        .all() as ModelRow[];
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
        .all();
}

/** Daily time-series per user (for stacked charts). */
export function overTime(db: Database, days?: number) {
    return db
        .query(
            `SELECT date(started_at) AS day,
                    u.name AS user,
                    COALESCE(SUM(s.total_tokens), 0) AS tokens,
                    COALESCE(SUM(s.co2_grams), 0) AS co2_grams
             FROM sessions s JOIN users u USING(user_id)
             ${sinceClause(days)}
             GROUP BY day, s.user_id
             ORDER BY day ASC`
        )
        .all();
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
        .get();
}

/** Recent sessions for a user, optionally restricted to the last `days`. */
export function sessionsForUser(db: Database, userId: string, days?: number, limit = 50) {
    return db
        .query(
            `SELECT session_id, provider, surface, primary_model, cwd,
                    total_tokens, energy_wh, co2_grams, started_at, updated_at
             FROM sessions WHERE user_id = $id${andSince(days)}
             ORDER BY updated_at DESC LIMIT $limit`
        )
        .all({ $id: userId, $limit: limit });
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
        .all({ $id: userId }) as ModelRow[];
    return aggregateModels(rows);
}

/** Daily time-series for one user. */
export function overTimeForUser(db: Database, userId: string, days?: number) {
    return db
        .query(
            `SELECT date(started_at) AS day,
                    COALESCE(SUM(total_tokens), 0) AS tokens,
                    COALESCE(SUM(co2_grams), 0) AS co2_grams,
                    COALESCE(SUM(energy_wh), 0) AS energy_wh
             FROM sessions WHERE user_id = $id${andSince(days)}
             GROUP BY day
             ORDER BY day ASC`
        )
        .all({ $id: userId });
}
