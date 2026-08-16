/**
 * GitHub Copilot source. Two local shapes (mirrors agentcat-connectors):
 *   1. Copilot CLI    ~/.copilot/session-state/<hash>/events.jsonl
 *   2. VS Code chat   <workspaceStorage>/<hash>/GitHub.copilot-chat/transcripts/*.jsonl
 *
 * Transcripts start with {"type":"session.start","data":{"producer":"copilot-agent"}}.
 * Output tokens come from data.outputTokens when present, else a char/4 estimate
 * of the message content (+ reasoningText), so Copilot carbon is approximate.
 * One file = one session; we report absolute totals (server upserts).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { CollectedSession, Provider, SessionUsage } from '../../shared/types.ts';
import { eachLine } from '../line-reader.ts';
import type { Source } from './source.ts';

/** VS Code (+ Insiders) workspaceStorage roots per platform. */
function vscodeWorkspaceRoots(): string[] {
    const h = homedir();
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || join(h, 'AppData', 'Roaming');
        return [join(appData, 'Code', 'User', 'workspaceStorage'),
                join(appData, 'Code - Insiders', 'User', 'workspaceStorage')];
    }
    if (process.platform === 'darwin') {
        const base = join(h, 'Library', 'Application Support');
        return [join(base, 'Code', 'User', 'workspaceStorage'),
                join(base, 'Code - Insiders', 'User', 'workspaceStorage')];
    }
    return [join(h, '.config', 'Code', 'User', 'workspaceStorage'),
            join(h, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
            join(h, '.vscode-server', 'data', 'User', 'workspaceStorage')];
}

function copilotCliRoot(): string {
    return join(homedir(), '.copilot', 'session-state');
}

export function copilotAvailable(): boolean {
    if (existsSync(copilotCliRoot())) return true;
    for (const root of vscodeWorkspaceRoots()) {
        if (!existsSync(root)) continue;
        try {
            for (const ws of readdirSync(root)) {
                if (existsSync(join(root, ws, 'GitHub.copilot-chat', 'transcripts'))) return true;
            }
        } catch {
            // ignore
        }
    }
    return false;
}

export interface CopilotFile {
    sessionId: string;
    path: string;
    mtimeMs: number;
}

/** All Copilot session files (CLI events + VS Code transcripts), newest first. */
export function listCopilotFiles(sinceHours = 0): CopilotFile[] {
    const out: CopilotFile[] = [];
    const cutoff = sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : 0;
    const add = (path: string, idPrefix: string) => {
        let st;
        try {
            st = statSync(path);
        } catch {
            return;
        }
        if (cutoff && st.mtimeMs < cutoff) return;
        out.push({ sessionId: `${idPrefix}:${basename(path).replace(/\.jsonl$/, '')}`, path, mtimeMs: st.mtimeMs });
    };

    // CLI: ~/.copilot/session-state/<hash>/events.jsonl
    const cli = copilotCliRoot();
    if (existsSync(cli)) {
        try {
            for (const dir of readdirSync(cli)) {
                const f = join(cli, dir, 'events.jsonl');
                if (existsSync(f)) add(f, `cli:${dir}`);
            }
        } catch {
            // ignore
        }
    }

    // VS Code: <workspaceStorage>/<hash>/GitHub.copilot-chat/transcripts/*.jsonl
    for (const root of vscodeWorkspaceRoots()) {
        if (!existsSync(root)) continue;
        try {
            for (const ws of readdirSync(root)) {
                const tdir = join(root, ws, 'GitHub.copilot-chat', 'transcripts');
                if (!existsSync(tdir)) continue;
                for (const name of readdirSync(tdir)) {
                    if (name.endsWith('.jsonl')) add(join(tdir, name), `vscode:${ws}`);
                }
            }
        } catch {
            // ignore
        }
    }

    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const charTokens = (text: unknown): number =>
    typeof text === 'string' && text ? Math.max(1, Math.floor((text.length + 3) / 4)) : 0;
const nonneg = (v: unknown): number => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);

function inferProvider(model: string): Provider {
    const m = model.toLowerCase();
    if (m.includes('anthropic') || m.includes('claude')) return 'anthropic';
    if (m.includes('openai') || m.includes('gpt')) return 'openai';
    if (m.includes('gemini')) return 'google';
    return 'unknown';
}

/** Pick the dominant model, mirroring agentcat's tool-call-id heuristic. */
/**
 * Incremental model inference. Events are fed in one at a time so the caller
 * can stream the transcript instead of materialising every parsed event first.
 */
function modelInferrer() {
    const counts: Record<string, number> = {};
    const bump = (k: string, n: number) => (counts[k] = (counts[k] || 0) + n);
    return {
        push(e: any, data: any) {
            if (typeof data.model === 'string' && data.model) bump(data.model, 100);
            if (e?.type !== 'assistant.message' || !Array.isArray(data.toolRequests)) return;
            for (const tool of data.toolRequests) {
                const id = String(tool?.toolCallId || '');
                if (/^toolu(_bdrk_|_vrtx_|se_|_)/.test(id) || id.startsWith('tooluse_')) {
                    bump('copilot-anthropic-auto', 1);
                } else if (id.startsWith('call_')) {
                    bump('copilot-openai-auto', 1);
                }
            }
        },
        result(): string {
            const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            return top ? top[0] : 'copilot-auto';
        }
    };
}

export const copilotSource: Source = {
    collectSession({ sessionId, transcriptPath }) {
        if (!transcriptPath || !existsSync(transcriptPath)) return null;

        // One streaming pass: model inference and token accumulation share the
        // walk, so no array of parsed events is ever held (see line-reader.ts).
        const inferrer = modelInferrer();
        let seenAny = false;
        let inputTokens = 0;
        let outputTokens = 0;
        let pendingInput = 0;
        let firstTs = '';
        let lastTs = '';

        for (const line of eachLine(transcriptPath)) {
            let e: any;
            try {
                e = JSON.parse(line);
            } catch {
                continue;
            }
            if (!e) continue;
            seenAny = true;
            const data = (typeof e.data === 'object' && e.data) || {};
            inferrer.push(e, data);
            if (typeof e.timestamp === 'string') {
                if (!firstTs) firstTs = e.timestamp;
                lastTs = e.timestamp;
            }
            if (e.type === 'user.message') {
                pendingInput = charTokens(data.content);
            } else if (e.type === 'assistant.message') {
                const out = nonneg(data.outputTokens) || charTokens(data.content);
                outputTokens += out + charTokens(data.reasoningText);
                inputTokens += pendingInput;
                pendingInput = 0;
            }
        }
        if (!seenAny) return null;
        const model = inferrer.result();

        const totalTokens = inputTokens + outputTokens;
        if (totalTokens === 0) return null;

        const usage: SessionUsage = {
            records: [{ requestId: sessionId, model, inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 }],
            totals: { inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens },
            modelBreakdown: { [model]: totalTokens },
            primaryModel: model
        };
        const now = new Date().toISOString();
        return {
            provider: inferProvider(model),
            surface: 'copilot',
            sessionId,
            cwd: '',
            usage,
            startedAt: firstTs || now,
            updatedAt: lastTs || firstTs || now
        } satisfies CollectedSession;
    }
};
