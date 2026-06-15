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
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.trim());
}

/** Find <session-id>.jsonl, optionally hinted by cwd's encoded dir. */
function findTranscriptPath(sessionId: string, cwd?: string): string | null {
    const projectsDir = claudeProjectsDir();

    if (cwd) {
        const encoded = cwd.replace(/\//g, '-');
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

function subagentRecords(transcriptPath: string, sessionId: string): TokenUsageRecord[] {
    const subDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    if (!existsSync(subDir)) return [];
    try {
        return readdirSync(subDir)
            .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
            .flatMap((f) => parseTranscriptLines(readLines(join(subDir, f))));
    } catch {
        return [];
    }
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
        const records = [
            ...parseTranscriptLines(lines),
            ...subagentRecords(path, basename(path, '.jsonl'))
        ];
        const usage = aggregate(records);

        const stat = statSync(path);
        const startedAt = getFirstTimestamp(lines) ?? stat.birthtime.toISOString();
        const updatedAt = getLastTimestamp(lines) ?? stat.mtime.toISOString();

        return {
            provider: 'anthropic',
            surface: 'claude-code',
            sessionId: resolvedId,
            cwd: cwd ?? '',
            usage,
            startedAt,
            updatedAt
        } satisfies CollectedSession;
    }
};
