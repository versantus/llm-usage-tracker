/**
 * Cowork source: reads Anthropic Cowork (local agent mode) audit logs.
 *
 *   ~/Library/Application Support/Claude/local-agent-mode-sessions/
 *       <owner>/<project>/<session-id>/audit.jsonl
 *
 * The audit.jsonl lines share Claude Code's shape (assistant + message.usage),
 * so the same parser/calculator apply. Cowork exposes no user hook, so the
 * watcher (watch-cowork.ts) polls these files; this source does the parsing.
 *
 * NOTE: the exact on-disk layout is best-effort/unconfirmed across Cowork
 * versions — we discover audit.jsonl files by scanning, and degrade gracefully.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
    aggregate,
    getFirstTimestamp,
    getLastTimestamp,
    parseTranscriptLines
} from '../../shared/transcript-parser.ts';
import type { CollectedSession } from '../../shared/types.ts';
import type { Source } from './source.ts';

export function coworkSessionsRoot(): string {
    return join(
        homedir(),
        'Library',
        'Application Support',
        'Claude',
        'local-agent-mode-sessions'
    );
}

export function coworkAvailable(): boolean {
    return existsSync(coworkSessionsRoot());
}

export interface CoworkAuditFile {
    sessionId: string;
    auditPath: string;
    mtimeMs: number;
}

/** Recursively find audit.jsonl files under the Cowork sessions root. */
export function listCoworkAuditFiles(root = coworkSessionsRoot()): CoworkAuditFile[] {
    const out: CoworkAuditFile[] = [];
    if (!existsSync(root)) return out;

    const walk = (dir: string, depth: number): void => {
        if (depth > 6) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            const full = join(dir, name);
            let st: ReturnType<typeof statSync>;
            try {
                st = statSync(full);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                walk(full, depth + 1);
            } else if (name === 'audit.jsonl') {
                out.push({
                    sessionId: basename(dirname(full)),
                    auditPath: full,
                    mtimeMs: st.mtimeMs
                });
            }
        }
    };

    walk(root, 0);
    return out;
}

function readLines(file: string): string[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.trim());
}

/** Best-effort: pull a cwd from a sibling metadata JSON if one exists. */
function findCwd(auditPath: string): string {
    const sessionDir = dirname(auditPath);
    for (const candidate of ['metadata.json', 'session.json']) {
        const p = join(sessionDir, candidate);
        if (existsSync(p)) {
            try {
                const meta = JSON.parse(readFileSync(p, 'utf-8'));
                if (typeof meta.cwd === 'string') return meta.cwd;
                if (typeof meta.workingDirectory === 'string') return meta.workingDirectory;
            } catch {
                // ignore
            }
        }
    }
    return '';
}

export const coworkSource: Source = {
    collectSession({ sessionId, transcriptPath }) {
        const auditPath = transcriptPath ?? null;
        if (!auditPath || !existsSync(auditPath)) return null;

        const lines = readLines(auditPath);
        const usage = aggregate(parseTranscriptLines(lines));

        const stat = statSync(auditPath);
        const startedAt = getFirstTimestamp(lines) ?? stat.birthtime.toISOString();
        const updatedAt = getLastTimestamp(lines) ?? stat.mtime.toISOString();

        return {
            provider: 'anthropic',
            surface: 'cowork',
            sessionId,
            cwd: findCwd(auditPath),
            usage,
            startedAt,
            updatedAt
        } satisfies CollectedSession;
    }
};
