/**
 * Read + parse Claude Code hook input from stdin (dependency-free).
 * Hooks must never crash the host, so everything degrades gracefully.
 */

export interface StopInput {
    session_id: string;
    transcript_path?: string;
    cwd?: string;
    project_path?: string;
}

export async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return '';
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

export async function readStopInput(): Promise<StopInput | null> {
    const raw = await readStdin();
    if (!raw.trim()) return null;
    try {
        const json = JSON.parse(raw);
        if (typeof json.session_id !== 'string') return null;
        return {
            session_id: json.session_id,
            transcript_path:
                typeof json.transcript_path === 'string' ? json.transcript_path : undefined,
            cwd: typeof json.cwd === 'string' ? json.cwd : undefined,
            project_path: typeof json.project_path === 'string' ? json.project_path : undefined
        };
    } catch {
        return null;
    }
}

/** Run a hook body with a hard error boundary — never throw out of a hook. */
export function runHook(main: () => Promise<void>): void {
    main().catch((err) => {
        console.error(`[usage-tracker] hook error: ${err?.message ?? err}`);
        process.exit(0);
    });
}

export function log(message: string): void {
    console.error(`[usage-tracker] ${message}`);
}
