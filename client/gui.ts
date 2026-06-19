/**
 * `lut gui` — the Windows tray + settings GUI, embedded in the binary.
 *
 * The tray UI is a PowerShell + WinForms script (windows-app/UsageTracker.ps1)
 * compiled into this binary as text. `lut gui` writes it to a file and runs it,
 * and KEEPS RUNNING as the host: if we spawned-and-exited, Windows would tear
 * the child down with the parent (job object) and the tray would never appear.
 * We pass our own path via $env:LUT_BIN so the tray drives the exact same `lut`.
 *
 *   lut gui            run hidden, host the tray (Ctrl-C or tray Quit to stop)
 *   lut gui --debug    run visible with errors shown (for troubleshooting)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Embedded at compile time (bun `with { type: 'text' }`); also works under `bun run`.
import trayScript from '../windows-app/UsageTracker.ps1' with { type: 'text' };

export async function launchGui(opts: { debug?: boolean } = {}): Promise<void> {
    if (process.platform !== 'win32') {
        console.error(
            'The tray GUI is Windows-only.\n' +
                '  • macOS: use UsageTracker.app (the menu-bar app)\n' +
                '  • otherwise: configure with `lut connect` and view the dashboard in a browser.'
        );
        process.exit(1);
    }

    // Materialise the embedded script so we can run it with -File (easier to
    // debug than -EncodedCommand, and no command-line length limit).
    const dir = join(process.env.LOCALAPPDATA || homedir(), 'llm-usage-tracker');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, 'tray.ps1');
    writeFileSync(scriptPath, trayScript, 'utf8');

    const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
    if (!opts.debug) psArgs.push('-WindowStyle', 'Hidden');
    psArgs.push('-File', scriptPath);

    const child = Bun.spawn(['powershell', ...psArgs], {
        // Tell the tray which lut to drive (itself), so it never has to guess.
        env: { ...process.env, LUT_BIN: process.execPath },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit'
    });

    if (opts.debug) {
        console.error(`Running tray GUI (visible/debug) from ${scriptPath} …`);
    } else {
        console.error('Tray GUI started — look for the system-tray icon. This window hosts it; closing it stops the tray.');
    }
    // Stay alive while the tray runs — exiting now would kill the child on Windows.
    await child.exited;
}
