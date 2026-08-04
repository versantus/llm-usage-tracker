/**
 * Stage-2 work-type classification (optional, deferred).
 *
 * Sessions the heuristic scorer couldn't call confidently are queued in
 * ~/.config/llm-usage-tracker/reclassify.ndjson by the Stop hook, and drained
 * later (detached `lut classify --once`, or opportunistically by watcher
 * cycles) so the 15s hook budget is never spent on an LLM call.
 *
 * PRIVACY: the model is invoked LOCALLY via the user's own `claude` CLI and is
 * shown ONLY the numeric feature vector + heuristic scores — never prompts,
 * code, paths, or any session text. If `claude` is absent, or categories /
 * llmClassify are disabled, this whole stage is a no-op and the heuristic
 * label stands.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SessionFeatures } from '../shared/categorizer.ts';
import { classifyHeuristic, extractSessionFeatures, mergeFeatures } from '../shared/categorizer.ts';
import type { CategoryResult, Surface, WorkCategory } from '../shared/types.ts';
import { configDir, type ClientConfig } from './config.ts';
import { postEvent } from './post.ts';
import { claudeCodeSource } from './sources/claude-code-source.ts';
import { coworkSource } from './sources/cowork-source.ts';
import { toIngestEvent } from './sources/source.ts';

const CATEGORIES: WorkCategory[] = [
    'coding',
    'debugging',
    'docs-writing',
    'research',
    'planning',
    'other'
];
const MAX_QUEUE_AGE_MS = 7 * 86400_000;

export interface ReclassifyItem {
    sessionId: string;
    transcriptPath: string;
    surface: Surface;
    queuedAt: string;
}

export function queuePath(): string {
    return join(configDir(), 'reclassify.ndjson');
}

/** Append an ambiguous session for later LLM classification. Never throws. */
export function queueForReclassify(item: Omit<ReclassifyItem, 'queuedAt'>): void {
    try {
        mkdirSync(dirname(queuePath()), { recursive: true });
        appendFileSync(
            queuePath(),
            JSON.stringify({ ...item, queuedAt: new Date().toISOString() }) + '\n'
        );
    } catch {
        // best effort — the heuristic label was already sent
    }
}

/** Whether the local `claude` CLI exists (stage 2 is skipped without it). */
export function claudeCliPath(): string | null {
    const found = Bun.which('claude');
    if (found) return found;
    const fallback = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    return existsSync(fallback) ? fallback : null;
}

function readQueueFile(path: string): ReclassifyItem[] {
    let text: string;
    try {
        text = readFileSync(path, 'utf-8');
    } catch {
        return [];
    }
    return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
            try {
                return JSON.parse(l) as ReclassifyItem;
            } catch {
                return null;
            }
        })
        .filter((i): i is ReclassifyItem => i !== null && typeof i.sessionId === 'string');
}

/** Claim the queue (same rename-aside pattern as the spool). */
function claimQueue(): ReclassifyItem[] {
    const work = `${queuePath()}.working`;
    if (!existsSync(work)) {
        if (!existsSync(queuePath())) return [];
        try {
            renameSync(queuePath(), work);
        } catch {
            return []; // another process claimed it
        }
    }
    return readQueueFile(work);
}

function finishQueue(remaining: ReclassifyItem[]): void {
    for (const item of remaining) {
        try {
            appendFileSync(queuePath(), JSON.stringify(item) + '\n');
        } catch {
            // drop — heuristic label already stands
        }
    }
    try {
        rmSync(`${queuePath()}.working`);
    } catch {
        // already gone
    }
}

/**
 * Ask the local `claude` CLI (haiku) to pick a category from the NUMERIC
 * feature vector only. Returns null on any failure — the heuristic stands.
 */
export async function llmClassify(
    features: SessionFeatures,
    heuristic: CategoryResult,
    timeoutMs = 45_000 // runs detached, never inside the hook — cold-start takes ~10s alone
): Promise<CategoryResult | null> {
    const cli = claudeCliPath();
    if (!cli) return null;

    const prompt =
        'Classify a software work session from NUMERIC METADATA ONLY (no content is available).\n' +
        `Categories: ${CATEGORIES.join(', ')}.\n` +
        `Feature counts: ${JSON.stringify(features)}\n` +
        `Heuristic scores (top two were too close to call): ${JSON.stringify(heuristic.scores ?? {})}\n` +
        'Reply with ONLY this JSON: {"category":"<one>","confidence":<0..1>}';

    try {
        const proc = Bun.spawn([cli, '-p', '--model', 'haiku', prompt], {
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'ignore'
        });
        const killer = setTimeout(() => proc.kill(), timeoutMs);
        const out = await new Response(proc.stdout).text();
        clearTimeout(killer);

        const match = out.match(/\{[^{}]*\}/g)?.pop();
        if (!match) return null;
        const parsed = JSON.parse(match);
        if (!CATEGORIES.includes(parsed?.category)) return null;
        const confidence =
            typeof parsed.confidence === 'number'
                ? Math.min(1, Math.max(0, parsed.confidence))
                : 0.6;
        return { category: parsed.category, confidence, source: 'llm', ambiguous: false };
    } catch {
        return null;
    }
}

function collectFor(item: ReclassifyItem) {
    const source = item.surface === 'cowork' ? coworkSource : claudeCodeSource;
    return source.collectSession({ sessionId: item.sessionId, transcriptPath: item.transcriptPath });
}

/**
 * Drain queued ambiguous sessions: re-collect, LLM-classify, re-POST.
 * The server upsert is idempotent, and re-collection yields same-or-newer
 * updatedAt, so re-sends always pass the monotonicity guard.
 */
export async function drainReclassifyQueue(
    cfg: ClientConfig,
    opts: { limit?: number; quiet?: boolean } = {}
): Promise<{ processed: number; reclassified: number }> {
    const result = { processed: 0, reclassified: 0 };
    if (cfg.categories === false || cfg.llmClassify === false) return result;
    if (!claudeCliPath()) return result;

    const items = claimQueue();
    if (!items.length) return result;
    const limit = opts.limit ?? 10;

    const remaining: ReclassifyItem[] = [];
    const now = Date.now();

    for (const item of items) {
        if (result.processed >= limit) {
            remaining.push(item);
            continue;
        }
        const age = now - Date.parse(item.queuedAt || '');
        if (!Number.isFinite(age) || age > MAX_QUEUE_AGE_MS) continue; // stale — drop
        if (!existsSync(item.transcriptPath)) continue; // transcript gone — drop

        result.processed++;
        const session = collectFor(item);
        if (!session || session.usage.totals.totalTokens === 0) continue;

        // Re-derive the vector from the fresh transcript (it may have grown).
        const lines = readFileSync(item.transcriptPath, 'utf-8').split('\n').filter((l) => l.trim());
        const features = extractSessionFeatures(lines);
        const heuristic = session.category ?? classifyHeuristic(features);

        const llm = await llmClassify(features, heuristic);
        if (llm) {
            session.category = llm;
            result.reclassified++;
        } else if (!heuristic.ambiguous) {
            continue; // transcript grew enough to disambiguate — already correct server-side
        }
        await postEvent(cfg.serverUrl, toIngestEvent(cfg, session), cfg.ingestToken);
        if (!opts.quiet) {
            console.error(
                `[usage-tracker:classify] ${item.sessionId} -> ${session.category?.category} (${session.category?.source})`
            );
        }
    }

    finishQueue(remaining);
    return result;
}
