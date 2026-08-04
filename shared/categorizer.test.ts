import { describe, expect, test } from 'bun:test';

import {
    EMPTY_FEATURES,
    classifyHeuristic,
    extractSessionFeatures,
    mergeFeatures,
    type SessionFeatures
} from './categorizer.ts';

function feats(partial: Partial<SessionFeatures>): SessionFeatures {
    return { ...EMPTY_FEATURES, ...partial };
}

const assistantLine = (blocks: any[]) =>
    JSON.stringify({ type: 'assistant', message: { content: blocks } });
const toolUse = (name: string, input: any = {}) => ({ type: 'tool_use', name, input });

describe('classifyHeuristic', () => {
    test('empty vector -> other, low confidence, never ambiguous', () => {
        const r = classifyHeuristic(feats({}));
        expect(r.category).toBe('other');
        expect(r.confidence).toBeLessThan(0.5);
        expect(r.ambiguous).toBe(false);
    });

    test('edit-heavy session -> coding', () => {
        const r = classifyHeuristic(feats({ codeEdits: 8, linesAdded: 300, gitOps: 3, reads: 5 }));
        expect(r.category).toBe('coding');
        expect(r.ambiguous).toBe(false);
        expect(r.confidence).toBeGreaterThan(0.5);
    });

    test('test-loop session -> debugging', () => {
        const r = classifyHeuristic(
            feats({ testRuns: 6, editTestCycles: 5, linesDeleted: 100, reads: 8, codeEdits: 2 })
        );
        expect(r.category).toBe('debugging');
    });

    test('markdown-only edits -> docs-writing', () => {
        const r = classifyHeuristic(feats({ docEdits: 6, reads: 4 }));
        expect(r.category).toBe('docs-writing');
    });

    test('read/web dominant with no edits -> research', () => {
        const r = classifyHeuristic(feats({ webLookups: 5, reads: 12 }));
        expect(r.category).toBe('research');
    });

    test('plan-mode heavy session -> planning', () => {
        const r = classifyHeuristic(feats({ planSignals: 4, taskMgmt: 5, reads: 3 }));
        expect(r.category).toBe('planning');
    });

    test('near-tie is flagged ambiguous with the top label still returned', () => {
        // coding 3*3=9 vs debugging 2.5*3+... — engineer a close call
        const r = classifyHeuristic(feats({ codeEdits: 3, testRuns: 3, reads: 2 }));
        expect(r.ambiguous).toBe(true);
        expect(r.confidence).toBeLessThan(0.5);
        expect(['coding', 'debugging']).toContain(r.category);
    });
});

describe('extractSessionFeatures', () => {
    test('counts tools, extensions, bash verbs and patch churn', () => {
        const lines = [
            assistantLine([toolUse('Edit', { file_path: '/x/app.ts' })]),
            assistantLine([toolUse('Write', { file_path: '/x/README.md' })]),
            assistantLine([toolUse('Edit', { file_path: '/x/config.yml' })]),
            assistantLine([toolUse('Read', { file_path: '/x/app.ts' }), toolUse('Grep', {})]),
            assistantLine([toolUse('Bash', { command: 'git status' })]),
            assistantLine([toolUse('Bash', { command: 'FOO=1 bun test shared/' })]),
            assistantLine([toolUse('Bash', { command: 'npm run build' })]),
            assistantLine([toolUse('WebSearch', {})]),
            assistantLine([toolUse('ExitPlanMode', {})]),
            assistantLine([toolUse('mcp__blender__get_objects_summary', {})]),
            JSON.stringify({
                type: 'user',
                toolUseResult: { structuredPatch: [{ oldLines: 3, newLines: 10 }] }
            }),
            JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1234 }),
            'not json at all'
        ];
        const f = extractSessionFeatures(lines);
        expect(f.codeEdits).toBe(1);
        expect(f.docEdits).toBe(1);
        expect(f.configEdits).toBe(1);
        expect(f.reads).toBe(2);
        expect(f.gitOps).toBe(1);
        expect(f.testRuns).toBe(1);
        expect(f.editTestCycles).toBe(1); // edits happened before the test run
        expect(f.buildRuns).toBe(0); // "npm run build" second token is 'run', not build
        expect(f.webLookups).toBe(1);
        expect(f.planSignals).toBe(1);
        expect(f.mcpCalls).toBe(1);
        expect(f.linesAdded).toBe(10);
        expect(f.linesDeleted).toBe(3);
        expect(f.turns).toBe(1);
        expect(f.durationMs).toBe(1234);
    });

    test('permission-mode transitions and plan attachments count once each', () => {
        const lines = [
            JSON.stringify({ type: 'user', permissionMode: 'plan' }),
            JSON.stringify({ type: 'assistant', permissionMode: 'plan', message: { content: [] } }),
            JSON.stringify({ type: 'attachment', attachment: { type: 'plan_mode' } }),
            JSON.stringify({ type: 'user', permissionMode: 'default' }),
            JSON.stringify({ type: 'user', permissionMode: 'plan' })
        ];
        // one transition into plan + one attachment + one re-entry = 3
        expect(extractSessionFeatures(lines).planSignals).toBe(3);
    });
});

describe('mergeFeatures', () => {
    test('sums every field', () => {
        const a = feats({ codeEdits: 2, reads: 1, durationMs: 10 });
        const b = feats({ codeEdits: 3, webLookups: 4, durationMs: 5 });
        const m = mergeFeatures(a, b);
        expect(m.codeEdits).toBe(5);
        expect(m.reads).toBe(1);
        expect(m.webLookups).toBe(4);
        expect(m.durationMs).toBe(15);
    });
});
