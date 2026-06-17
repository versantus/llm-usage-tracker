/**
 * The Stop-hook body, extracted so it can be invoked both from the standalone
 * `hooks/stop.ts` entrypoint (plugin / npx-bun) and from the unified `lut`
 * binary (`lut hook`). Re-parses the session transcript, computes carbon, and
 * POSTs absolute totals to the central server. Never throws.
 */

import { loadConfig } from '../config.ts';
import { postEvent } from '../post.ts';
import { claudeCodeSource } from '../sources/claude-code-source.ts';
import { toIngestEvent } from '../sources/source.ts';
import { log, readStopInput } from './stdin.ts';

export async function stopHookMain(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg) {
        log('not configured — run `lut connect` (or /usage-tracker:setup). Skipping.');
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
    const ok = await postEvent(cfg.serverUrl, event, cfg.ingestToken);
    log(
        ok
            ? `sent ${session.sessionId} (${event.totalTokens} tok, ${event.co2Grams.toFixed(2)}g CO₂)`
            : `server unreachable — spooled ${session.sessionId}`
    );
}
