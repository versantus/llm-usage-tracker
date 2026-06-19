/**
 * `lut gui` — the Windows tray + settings GUI, embedded in the binary.
 *
 * The tray UI is a PowerShell + WinForms script (windows-app/UsageTracker.ps1)
 * that's compiled into this binary as text. On `lut gui` we launch it hidden via
 * `powershell -EncodedCommand` — no separate script file to install, no temp
 * file written. The script calls back into this same `lut` for connect/watch.
 */

// Embedded at compile time (bun `with { type: 'text' }`); also works under `bun run`.
import trayScript from '../windows-app/UsageTracker.ps1' with { type: 'text' };

export function launchGui(): void {
    if (process.platform !== 'win32') {
        console.error(
            'The tray GUI is Windows-only.\n' +
                '  • macOS: use UsageTracker.app (the menu-bar app)\n' +
                '  • otherwise: configure with `lut connect` and view the dashboard in a browser.'
        );
        process.exit(1);
    }

    // PowerShell -EncodedCommand expects base64 of UTF-16LE. `#Requires` lines
    // are treated as comments in this mode, which is fine.
    const b64 = Buffer.from(trayScript, 'utf16le').toString('base64');
    const child = Bun.spawn(
        [
            'powershell',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-WindowStyle',
            'Hidden',
            '-EncodedCommand',
            b64
        ],
        { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
    );
    child.unref();
    console.error('Tray GUI launched — look for the system-tray icon (bottom-right, maybe under the ^).');
}
