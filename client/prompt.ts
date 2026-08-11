/**
 * Terminal prompts for `lut connect` / `cut setup`.
 *
 * Deliberately does NOT use node:readline: inside a `bun build --compile`
 * binary readline's TTY input stream never delivers data, so the prompt
 * renders and then hangs forever with keystrokes going nowhere — exactly what
 * the piped one-line installer used to hit. A blocking readSync on fd 0
 * behaves identically in every mode we ship (installer, plain shell,
 * `bun run`). (Diagnosis credit: Andy's original fix branch.)
 *
 * ONE interactivity predicate decides everything: prompt only when the
 * question is VISIBLE (stderr is a terminal — prompts are written there) AND
 * ANSWERABLE (stdin is a terminal — answers are read there). Splitting those
 * across different checks is how you get invisible hangs:
 *   - `lut connect < /dev/null` / piped stdin  -> non-interactive, fallbacks
 *     (the standard scripting idiom keeps working);
 *   - `lut connect 2>log`                      -> non-interactive (nobody can
 *     see the question, so never block on an answer);
 *   - GUI apps spawning `lut connect` with stderr piped but stdin inherited
 *     from a terminal                          -> non-interactive, no deadlock;
 *   - the piped installer reattaches stdin with `</dev/tty` before calling
 *     `lut connect`, which makes stdin a real terminal again — no /dev/tty
 *     handling is needed in here at all.
 *
 * The terminal stays in canonical mode, so the tty driver handles echo and
 * backspace; we just collect the finished line. Known limitation: on Windows
 * consoles raw fd-0 bytes arrive in the active codepage, so non-ASCII input
 * may mis-decode — the tray GUI (`lut gui`) is the first-class Windows path.
 */

import { readSync } from 'node:fs';

const LF = 0x0a;
const CR = 0x0d;

/** True when a human can both see a question (stderr) and answer it (stdin). */
export function canPrompt(): boolean {
    return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/** Read one line from stdin (a terminal, per canPrompt). Null on EOF. */
function readLine(): string | null {
    const byte = Buffer.alloc(1);
    const bytes: number[] = [];
    for (;;) {
        let n: number;
        try {
            n = readSync(0, byte, 0, 1, null);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // Non-blocking fd not ready yet: wait and retry.
            if (code === 'EAGAIN') {
                Bun.sleepSync(10);
                continue;
            }
            // Bun/Node surface a clean EOF on some ttys as an error — treat it
            // exactly like the n === 0 EOF below.
            if (code === 'EOF') {
                if (bytes.length === 0) return null;
                break;
            }
            throw err;
        }
        if (n === 0) {
            if (bytes.length === 0) return null;
            break;
        }
        if (byte[0] === LF) break;
        if (byte[0] === CR) continue;
        bytes.push(byte[0]!);
    }
    return Buffer.from(bytes).toString('utf8');
}

/**
 * Ask a question and return the trimmed answer, or `fallback` when the user
 * just hits enter or there is no usable terminal.
 */
export function ask(question: string, fallback?: string): string {
    if (!canPrompt()) return fallback ?? '';
    const suffix = fallback ? ` [${fallback}]` : '';
    process.stderr.write(`${question}${suffix}: `);
    const line = readLine();
    if (line === null) {
        process.stderr.write('\n');
        return fallback ?? '';
    }
    return line.trim() || fallback || '';
}
