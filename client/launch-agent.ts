/**
 * Manage background watchers as macOS LaunchAgents. Used for surfaces that have
 * no Stop-style hook (Codex CLI, Cowork). Linux/Windows: no-op with a hint to
 * run the watcher under your own service manager.
 *
 * Each agent is labelled uk.co.versantus.usage-tracker.<suffix> and runs
 * `<lut> <subcommand>` (e.g. `lut watch-codex`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'uk.co.versantus.usage-tracker';

function label(suffix: string): string {
    return `${PREFIX}.${suffix}`;
}
function plistPath(suffix: string): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${label(suffix)}.plist`);
}
function isMac(): boolean {
    return process.platform === 'darwin';
}
function gui(): string {
    return `gui/${userInfo().uid}`;
}

function plistBody(suffix: string, lutPath: string, subcommand: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label(suffix)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${lutPath}</string>
        <string>${subcommand}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/usage-tracker-${suffix}.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/usage-tracker-${suffix}.log</string>
</dict>
</plist>
`;
}

/** Install + (re)load a watcher LaunchAgent. `lutPath` must be absolute. */
export function enableAgent(suffix: string, lutPath: string, subcommand: string): string {
    if (!isMac()) {
        return `not macOS — run \`${lutPath} ${subcommand}\` under your own service manager.`;
    }
    const p = plistPath(suffix);
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(p, plistBody(suffix, lutPath, subcommand));

    try {
        execFileSync('launchctl', ['bootout', `${gui()}/${label(suffix)}`], { stdio: 'ignore' });
    } catch {
        // not loaded — fine
    }
    try {
        execFileSync('launchctl', ['bootstrap', gui(), p], { stdio: 'ignore' });
        return `enabled (LaunchAgent ${label(suffix)})`;
    } catch (err: any) {
        return `wrote ${p} but launchctl bootstrap failed: ${err?.message ?? err}`;
    }
}

/** Unload + remove a watcher LaunchAgent. */
export function disableAgent(suffix: string): string {
    if (!isMac()) return 'not macOS — nothing to remove.';
    const p = plistPath(suffix);
    try {
        execFileSync('launchctl', ['bootout', `${gui()}/${label(suffix)}`], { stdio: 'ignore' });
    } catch {
        // already out
    }
    if (existsSync(p)) rmSync(p);
    return `disabled (${label(suffix)})`;
}

export function agentEnabled(suffix: string): boolean {
    if (!isMac()) return false;
    if (!existsSync(plistPath(suffix))) return false;
    try {
        execFileSync('launchctl', ['print', `${gui()}/${label(suffix)}`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
