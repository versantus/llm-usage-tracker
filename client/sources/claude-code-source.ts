/**
 * Claude Code source: reads session transcripts from
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * and merges any subagent transcripts (<session-id>/subagents/agent-*.jsonl).
 *
 * Resolves agent-* session ids to their parent UUID, matching carbonlog.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
    classifyHeuristic,
    extractSessionFeatures,
    mergeFeatures
} from '../../shared/categorizer.ts';
import {
    aggregate,
    extractParentSessionIdFromLines,
    getFirstTimestamp,
    getLastTimestamp,
    isAgentSessionId,
    parseTranscriptLines
} from '../../shared/transcript-parser.ts';
import type { CollectedSession, TokenUsageRecord } from '../../shared/types.ts';
import type { Source } from './source.ts';

function claudeProjectsDir(): string {
    return join(homedir(), '.claude', 'projects');
}

function readLines(file: string): string[] {
    let text: string;
    try {
        text = readFileSync(file, 'utf-8');
    } catch {
        return []; // missing or unreadable
    }
    return text.split('\n').filter((l) => l.trim());
}

/** Find <session-id>.jsonl, optionally hinted by cwd's encoded dir. */
function findTranscriptPath(sessionId: string, cwd?: string): string | null {
    const projectsDir = claudeProjectsDir();

    if (cwd) {
        // Claude Code encodes cwd by replacing separators AND ':' '.' '_' with
        // '-' (covers Windows drive paths like C:\Users\... and dotted dirs).
        const encoded = cwd.replace(/[\\/:._]/g, '-');
        const direct = join(projectsDir, encoded, `${sessionId}.jsonl`);
        if (existsSync(direct)) return direct;
    }

    if (!existsSync(projectsDir)) return null;
    try {
        for (const dir of readdirSync(projectsDir)) {
            const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
            if (existsSync(candidate)) return candidate;
        }
    } catch {
        // ignore
    }
    return null;
}

/** Resolve agent-* ids to the parent UUID + its transcript path. */
function resolve(sessionId: string, cwd?: string): { sessionId: string; path: string } | null {
    if (!isAgentSessionId(sessionId)) {
        const path = findTranscriptPath(sessionId, cwd);
        return path ? { sessionId, path } : null;
    }
    const agentPath = findTranscriptPath(sessionId, cwd);
    if (!agentPath) return null;
    const parentId = extractParentSessionIdFromLines(readLines(agentPath));
    if (!parentId) return null;
    const parentPath = findTranscriptPath(parentId, cwd);
    return parentPath ? { sessionId: parentId, path: parentPath } : null;
}

function subagentLineSets(transcriptPath: string): string[][] {
    const subDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    if (!existsSync(subDir)) return [];
    try {
        return readdirSync(subDir)
            .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
            .map((f) => readLines(join(subDir, f)));
    } catch {
        return [];
    }
}

/** All top-level session transcripts, optionally only those touched in the
 *  last `sinceHours` (0 = all). Used by `lut scan-claude-code` backfill. */
export function listClaudeCodeTranscripts(
    sinceHours = 0
): { sessionId: string; path: string; mtimeMs: number }[] {
    const projectsDir = claudeProjectsDir();
    if (!existsSync(projectsDir)) return [];
    const cutoff = sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : 0;
    const out: { sessionId: string; path: string; mtimeMs: number }[] = [];
    try {
        for (const dir of readdirSync(projectsDir)) {
            const full = join(projectsDir, dir);
            let files: string[];
            try {
                files = readdirSync(full);
            } catch {
                continue;
            }
            for (const f of files) {
                if (!f.endsWith('.jsonl')) continue;
                const p = join(full, f);
                let st: ReturnType<typeof statSync>;
                try {
                    st = statSync(p);
                } catch {
                    continue;
                }
                if (!st.isFile()) continue;
                if (cutoff && st.mtimeMs < cutoff) continue;
                out.push({ sessionId: basename(f, '.jsonl'), path: p, mtimeMs: st.mtimeMs });
            }
        }
    } catch {
        // projects dir unreadable — nothing to scan
    }
    return out;
}

export const claudeCodeSource: Source = {
    collectSession({ sessionId, transcriptPath, cwd }) {
        let path = transcriptPath && existsSync(transcriptPath) ? transcriptPath : null;
        let resolvedId = sessionId;

        if (!path) {
            const r = resolve(sessionId, cwd);
            if (!r) return null;
            path = r.path;
            resolvedId = r.sessionId;
        } else if (isAgentSessionId(sessionId)) {
            const r = resolve(sessionId, cwd);
            if (r) {
                path = r.path;
                resolvedId = r.sessionId;
            }
        }

        const lines = readLines(path);
        const subagents = subagentLineSets(path);
        const records = [
            ...parseTranscriptLines(lines),
            ...subagents.flatMap((ls) => parseTranscriptLines(ls))
        ];
        const usage = aggregate(records);

        let features = extractSessionFeatures(lines);
        for (const ls of subagents) features = mergeFeatures(features, extractSessionFeatures(ls));
        const category = classifyHeuristic(features);

        let stat: ReturnType<typeof statSync>;
        try {
            stat = statSync(path);
        } catch {
            return null; // transcript removed mid-read — skip
        }
        const startedAt = getFirstTimestamp(lines) ?? stat.birthtime.toISOString();
        const updatedAt = getLastTimestamp(lines) ?? stat.mtime.toISOString();

        return {
            provider: 'anthropic',
            surface: 'claude-code',
            sessionId: resolvedId,
            cwd: cwd ?? '',
            usage,
            category,
            startedAt,
            updatedAt
        } satisfies CollectedSession;
    }
};
