/**
 * Windows first-run: when `lut.exe` is double-clicked (no arguments), launch the
 * tray GUI and set it to start at login — so the whole flow is GUI, no terminal.
 *
 * We drop a tiny launcher .vbs into the Startup and Start-Menu folders (a .vbs
 * runs via wscript with NO console window) that runs `lut gui` hidden, and we
 * run it once now to bring the tray up immediately. The tray's Settings window
 * handles connect + per-tool toggles, so nothing else needs the terminal.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function windowsFirstRun(): void {
    const exe = process.execPath;
    const appData = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const startMenu = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

    // VBScript: Run "<exe>" gui  (0 = hidden window, False = don't wait).
    // In VBScript a literal quote is written as "" — so """<exe>"" gui" yields
    // the string: "<exe>" gui
    const vbsBody = `CreateObject("WScript.Shell").Run """${exe}"" gui", 0, False\n`;

    const launchers = [
        join(startup, 'AI Carbon Tracker.vbs'),
        join(startMenu, 'AI Carbon Tracker.vbs')
    ];
    for (const path of launchers) {
        try {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, vbsBody, 'ascii');
        } catch {
            // ignore — best effort
        }
    }

    // Bring the tray up now, detached + hidden, via the launcher we just wrote.
    try {
        Bun.spawn(['wscript.exe', launchers[0]], {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore'
        }).unref();
    } catch {
        // ignore
    }

    console.error(
        'AI Carbon Tracker is starting in your system tray (bottom-right of the taskbar).\n' +
            'It will also start automatically at login. Click the tray icon -> Settings to finish setup.'
    );
}
