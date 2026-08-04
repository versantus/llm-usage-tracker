/**
 * Work-type categoriser — stage 1 (deterministic heuristics).
 *
 * PRIVACY CONTRACT: extraction reads transcript lines LOCALLY and reduces them
 * to a purely numeric feature vector — tool-name counts, file-EXTENSION
 * buckets, Bash first-word verb buckets, patch line COUNTS, plan-mode markers,
 * durations. No prompt text, code, paths, commands, or diffs are stored in the
 * vector, and only the resulting category enum (+confidence+source) is ever
 * sent to the server. The optional LLM stage (client/classify.ts) sees only
 * this vector too.
 *
 * Dependency-free so the hook path stays install-free.
 */

import type { CategoryResult, WorkCategory } from './types.ts';

export interface SessionFeatures {
    codeEdits: number; // Edit/Write/etc on code-extension files
    docEdits: number; // .md/.rst/.txt/…
    configEdits: number; // .json/.yml/.toml/…
    reads: number; // Read/Grep/Glob
    bashTotal: number;
    testRuns: number; // pytest/jest/… or "<runner> test"
    gitOps: number;
    buildRuns: number;
    webLookups: number; // WebSearch/WebFetch
    planSignals: number; // plan-mode entries/exits + plan attachments
    taskMgmt: number; // TaskCreate/TaskUpdate
    agentSpawns: number;
    mcpCalls: number;
    linesAdded: number; // structuredPatch hunk sizes (counts only)
    linesDeleted: number;
    editTestCycles: number; // edit -> test transitions (debug-loop signal)
    turns: number;
    durationMs: number;
}

export const EMPTY_FEATURES: SessionFeatures = Object.freeze({
    codeEdits: 0,
    docEdits: 0,
    configEdits: 0,
    reads: 0,
    bashTotal: 0,
    testRuns: 0,
    gitOps: 0,
    buildRuns: 0,
    webLookups: 0,
    planSignals: 0,
    taskMgmt: 0,
    agentSpawns: 0,
    mcpCalls: 0,
    linesAdded: 0,
    linesDeleted: 0,
    editTestCycles: 0,
    turns: 0,
    durationMs: 0
});

const DOC_EXTS = new Set(['md', 'mdx', 'rst', 'txt', 'adoc', 'tex']);
const CONFIG_EXTS = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'plist', 'conf']);

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'exit_plan_mode']);
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

const TEST_RUNNERS = new Set(['pytest', 'jest', 'vitest', 'phpunit', 'rspec', 'mocha', 'tox']);
const BUILD_TOOLS = new Set(['tsc', 'vite', 'webpack', 'gradle', 'mvn', 'msbuild', 'xcodebuild']);
const PKG_RUNNERS = new Set(['npm', 'yarn', 'pnpm', 'bun', 'bunx', 'npx', 'go', 'cargo', 'make', 'ddev']);

function ext(p: unknown): string {
    if (typeof p !== 'string') return '';
    const base = p.split(/[\\/]/).pop() || '';
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** First two whitespace tokens of a Bash command (only used to bump verb
 *  COUNTERS — the string itself is discarded, never stored or sent). */
function bashVerb(command: unknown): { first: string; second: string } {
    if (typeof command !== 'string') return { first: '', second: '' };
    const tokens = command.trim().split(/\s+/);
    // skip leading VAR=value assignments
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const first = (tokens[i] || '').split(/[\\/]/).pop() || '';
    return { first: first.toLowerCase(), second: (tokens[i + 1] || '').toLowerCase() };
}

/** Reduce transcript JSONL lines to the numeric feature vector. */
export function extractSessionFeatures(lines: string[]): SessionFeatures {
    const f: SessionFeatures = { ...EMPTY_FEATURES };
    let editSinceTest = false;
    let lastPermissionMode = '';

    for (const line of lines) {
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!entry || typeof entry !== 'object') continue;

        // Plan-mode signals: transitions into plan mode + plan attachments.
        const pm = typeof entry.permissionMode === 'string' ? entry.permissionMode : '';
        if (pm) {
            if (pm === 'plan' && lastPermissionMode !== 'plan') f.planSignals++;
            lastPermissionMode = pm;
        }
        if (entry.type === 'attachment') {
            const at = entry.attachment?.type;
            if (at === 'plan_mode' || at === 'plan_mode_exit') f.planSignals++;
            continue;
        }

        if (entry.type === 'system') {
            if (entry.subtype === 'turn_duration') {
                f.turns++;
                if (typeof entry.durationMs === 'number' && entry.durationMs > 0) {
                    f.durationMs += entry.durationMs;
                }
            }
            continue;
        }

        // Patch churn: hunk line-counts from tool results (user lines carry them).
        const patch = entry.toolUseResult?.structuredPatch;
        if (Array.isArray(patch)) {
            for (const hunk of patch) {
                if (typeof hunk?.newLines === 'number') f.linesAdded += hunk.newLines;
                if (typeof hunk?.oldLines === 'number') f.linesDeleted += hunk.oldLines;
            }
        }

        if (entry.type !== 'assistant') continue;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
            if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
            const name = block.name;
            const input = block.input ?? {};

            if (EDIT_TOOLS.has(name)) {
                const e = ext(input.file_path ?? input.notebook_path ?? input.path);
                if (DOC_EXTS.has(e)) f.docEdits++;
                else if (CONFIG_EXTS.has(e)) f.configEdits++;
                else f.codeEdits++;
                editSinceTest = true;
            } else if (READ_TOOLS.has(name)) {
                f.reads++;
            } else if (name === 'Bash') {
                f.bashTotal++;
                const { first, second } = bashVerb(input.command);
                const isTest =
                    TEST_RUNNERS.has(first) ||
                    (PKG_RUNNERS.has(first) && /test/.test(second)) ||
                    (first === 'bun' && second === 'test');
                if (isTest) {
                    f.testRuns++;
                    if (editSinceTest) {
                        f.editTestCycles++;
                        editSinceTest = false;
                    }
                } else if (first === 'git' || first === 'gh') {
                    f.gitOps++;
                } else if (
                    BUILD_TOOLS.has(first) ||
                    (PKG_RUNNERS.has(first) && /^(build|compile)/.test(second)) ||
                    (first === 'docker' && second === 'build')
                ) {
                    f.buildRuns++;
                }
            } else if (WEB_TOOLS.has(name)) {
                f.webLookups++;
            } else if (PLAN_TOOLS.has(name)) {
                f.planSignals++;
            } else if (TASK_TOOLS.has(name)) {
                f.taskMgmt++;
            } else if (AGENT_TOOLS.has(name)) {
                f.agentSpawns++;
            } else if (name.startsWith('mcp__')) {
                f.mcpCalls++;
            }
        }
    }
    return f;
}

/** Sum two vectors (fold subagent transcripts into the parent session). */
export function mergeFeatures(a: SessionFeatures, b: SessionFeatures): SessionFeatures {
    const out = { ...a };
    for (const k of Object.keys(EMPTY_FEATURES) as (keyof SessionFeatures)[]) {
        out[k] = a[k] + b[k];
    }
    return out;
}

const min = Math.min;

/** Additive per-category scores; each signal capped so one loop can't dominate. */
export function scoreFeatures(f: SessionFeatures): Record<string, number> {
    const editing = f.codeEdits + f.docEdits;
    const readDominant = editing === 0 || f.reads > 4 * editing;
    // Share-weight docs by its fraction of all edits: caps alone would let a
    // session with 300 code edits + 30 doc edits score docs-writing HIGHER
    // than coding (the cap compresses the larger count more).
    const docShare = editing === 0 ? 0 : f.docEdits / editing;
    return {
        coding:
            3 * min(f.codeEdits, 10) +
            0.02 * min(f.linesAdded, 500) +
            min(f.configEdits, 5) +
            min(f.gitOps, 5) +
            min(f.buildRuns, 5),
        debugging:
            2.5 * min(f.testRuns, 10) +
            2 * min(f.editTestCycles, 8) +
            0.02 * min(f.linesDeleted, 300) +
            (f.testRuns > 0 ? min(f.reads, 10) / 2 : 0),
        'docs-writing': 4 * min(f.docEdits, 10) * docShare,
        research:
            3 * min(f.webLookups, 8) + (readDominant ? min(f.reads, 15) : 0.25 * min(f.reads, 15)),
        // Tight caps: heavy coding sessions dip into plan mode + task lists too,
        // so brief planning must not rival a session's real dominant signal.
        planning: 4 * min(f.planSignals, 3) + min(f.taskMgmt, 4),
        other: 1.0
    };
}

/** Margin below which the top-vs-second call is ambiguous (LLM-stage candidate). */
const ACCEPT_RATIO = 1.5;
/** Total signal below this = near-empty session (pure chat) -> 'other', never escalated. */
const MIN_SIGNAL_MASS = 2;

export function classifyHeuristic(f: SessionFeatures): CategoryResult {
    const scores = scoreFeatures(f);
    const signalMass = Object.values(scores).reduce((a, b) => a + b, 0) - scores.other;

    if (signalMass < MIN_SIGNAL_MASS) {
        return { category: 'other', confidence: 0.3, source: 'heuristic', ambiguous: false, scores };
    }

    const ranked = Object.entries(scores).sort(([, a], [, b]) => b - a);
    const [topName, top] = ranked[0];
    const second = ranked[1][1];

    if (top / Math.max(second, 0.001) >= ACCEPT_RATIO) {
        const confidence = min(0.95, 0.5 + 0.5 * (1 - second / top));
        return { category: topName as WorkCategory, confidence, source: 'heuristic', ambiguous: false, scores };
    }
    return { category: topName as WorkCategory, confidence: 0.45, source: 'heuristic', ambiguous: true, scores };
}

/** Convenience: lines -> classification in one call. */
export function categorizeLines(lines: string[], extra?: SessionFeatures): CategoryResult {
    let f = extractSessionFeatures(lines);
    if (extra) f = mergeFeatures(f, extra);
    return classifyHeuristic(f);
}
