#!/usr/bin/env bun
/**
 * Dev-only calibration: classify every local Claude Code transcript and print
 * the label + the signals that drove it. Reads ONLY local files, sends nothing.
 *
 *   bun run scripts/classify-local.ts [--hours N] [--verbose]
 */

import { readFileSync } from 'node:fs';

import { classifyHeuristic, extractSessionFeatures } from '../shared/categorizer.ts';
import { listClaudeCodeTranscripts } from '../client/sources/claude-code-source.ts';

const verbose = process.argv.includes('--verbose');
const hi = process.argv.indexOf('--hours');
const hours = hi >= 0 ? Number(process.argv[hi + 1]) || 0 : 0;

const items = listClaudeCodeTranscripts(hours).sort((a, b) => b.mtimeMs - a.mtimeMs);
console.log(`${items.length} transcript(s)\n`);

for (const it of items) {
    let lines: string[];
    try {
        lines = readFileSync(it.path, 'utf-8').split('\n').filter((l) => l.trim());
    } catch {
        continue;
    }
    const f = extractSessionFeatures(lines);
    const r = classifyHeuristic(f);
    const dir = it.path.split('/').slice(-2, -1)[0].slice(0, 36);
    console.log(
        `${r.category.padEnd(13)} ${(r.confidence.toFixed(2) + (r.ambiguous ? '?' : ' ')).padEnd(6)} ` +
            `${dir.padEnd(38)} edits(c/d/cfg)=${f.codeEdits}/${f.docEdits}/${f.configEdits} ` +
            `reads=${f.reads} test=${f.testRuns} web=${f.webLookups} plan=${f.planSignals} task=${f.taskMgmt}`
    );
    if (verbose) console.log('   scores:', JSON.stringify(r.scores));
}
