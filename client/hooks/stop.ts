#!/usr/bin/env bun
/**
 * Claude Code Stop hook: on each response, re-parse the session transcript,
 * compute carbon, and POST absolute totals to the central server.
 *
 * Wired by the plugin (hooks/hooks.json) or by `cut setup`. Never throws.
 */

import { loadConfig } from '../config.ts';
import { postEvent } from '../post.ts';
import { claudeCodeSource } from '../sources/claude-code-source.ts';
import { toIngestEvent } from '../sources/source.ts';
import { log, readStopInput, runHook } from './stdin.ts';

runHook(async () => {
    const cfg = loadConfig();
    if (!cfg) {
        log('not configured — run `cut setup` (or /usage-tracker:setup). Skipping.');
        return;
    }
    if (!cfg.surfaces.claudeCode) return;

    const input = await readStopInput();
    if (!input) {
        log('no hook input on stdin');
        return;
    }

    const session = claudeCodeSource.collectSession({
        sessionId: input.session_id,
        transcriptPath: input.transcript_path,
        cwd: input.cwd ?? input.project_path
    });
    if (!session) {
        log(`could not locate transcript for ${input.session_id}`);
        return;
    }
    if (session.usage.totals.totalTokens === 0) return; // nothing to report yet

    const event = toIngestEvent(cfg, session);
    const ok = await postEvent(cfg.serverUrl, event);
    log(
        ok
            ? `sent ${session.sessionId} (${event.totalTokens} tok, ${event.co2Grams.toFixed(2)}g CO₂)`
            : `server unreachable — spooled ${session.sessionId}`
    );
});
