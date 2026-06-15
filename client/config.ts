/**
 * Client config: identity + server URL, stored at
 * ~/.config/claude-usage-tracker/config.json. Env vars override for dev.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ClientConfig {
    user: { name: string; email: string };
    userId: string;
    machineId: string;
    serverUrl: string;
    surfaces: { claudeCode: boolean; cowork: boolean };
}

export function configDir(): string {
    return join(homedir(), '.config', 'claude-usage-tracker');
}

export function configPath(): string {
    return join(configDir(), 'config.json');
}

export function spoolPath(): string {
    return join(configDir(), 'spool.ndjson');
}

/** Stable id derived from the email (dedups a person across machines). */
export function userIdFromEmail(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** Stable per-machine id (hostname + username). */
export function machineId(): string {
    let username = 'unknown';
    try {
        username = userInfo().username;
    } catch {
        // ignore
    }
    return createHash('sha256').update(`${hostname()}:${username}`).digest('hex').slice(0, 12);
}

export function defaultServerUrl(): string {
    return process.env.CUT_SERVER_URL || 'http://localhost:4317';
}

export function loadConfig(): ClientConfig | null {
    const p = configPath();
    if (!existsSync(p)) return null;
    try {
        const cfg = JSON.parse(readFileSync(p, 'utf-8')) as ClientConfig;
        // Env overrides
        if (process.env.CUT_SERVER_URL) cfg.serverUrl = process.env.CUT_SERVER_URL;
        if (process.env.CUT_USER_EMAIL) {
            cfg.user.email = process.env.CUT_USER_EMAIL;
            cfg.userId = userIdFromEmail(process.env.CUT_USER_EMAIL);
        }
        return cfg;
    } catch {
        return null;
    }
}

export function saveConfig(cfg: ClientConfig): void {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

export function buildConfig(opts: {
    name: string;
    email: string;
    serverUrl?: string;
    claudeCode?: boolean;
    cowork?: boolean;
}): ClientConfig {
    return {
        user: { name: opts.name, email: opts.email },
        userId: userIdFromEmail(opts.email),
        machineId: machineId(),
        serverUrl: opts.serverUrl || defaultServerUrl(),
        surfaces: {
            claudeCode: opts.claudeCode ?? true,
            cowork: opts.cowork ?? true
        }
    };
}
