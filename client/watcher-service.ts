/**
 * Background watcher supervision, as ONE service per machine.
 *
 * Surfaces with no Stop-style hook (Codex, Cowork, Copilot, …) need something
 * polling for them. That used to be one OS service per surface running
 * `lut watch-<surface>`, but every watcher is a full embedded Bun runtime, so
 * five of them cost five baseline heaps to do work that is almost entirely idle
 * polling. There is now a single service running `lut watch-all --only a,b,c`,
 * and the per-surface on/off switch lives in a small state file instead of in
 * the presence of a service definition.
 *
 * Platforms:
 *   macOS   — a LaunchAgent (launchd restarts it, and it survives logout).
 *   Linux   — a systemd *user* unit, when systemd is present.
 *   Windows — not here: the tray process supervises `lut watch-all` itself,
 *             because Windows has no per-user service manager we can rely on.
 *
 * Legacy per-surface LaunchAgents are removed on the next `lut connect` (see
 * migrateLegacyAgents), so upgrades collapse to the single service by itself.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { agentWorkDir, configDir } from './config.ts';

const PREFIX = 'uk.co.versantus.usage-tracker';
/** Label / unit name of the one service that runs every enabled watcher. */
const SERVICE_LABEL = `${PREFIX}.watchers`;
const SYSTEMD_UNIT = 'llm-usage-tracker-watchers.service';

function isMac(): boolean {
    return process.platform === 'darwin';
}
function isLinux(): boolean {
    return process.platform === 'linux';
}
function gui(): string {
    return `gui/${userInfo().uid}`;
}
function xml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Login name, or null when it can't be determined. `userInfo()` yields the
 * literal string "unknown" where there's no passwd entry (minimal containers),
 * and printing that in a copy-pasteable command is worse than saying nothing.
 */
function currentUsername(): string | null {
    const fromEnv = process.env.USER || process.env.LOGNAME;
    if (fromEnv && fromEnv !== 'unknown') return fromEnv;
    try {
        const name = userInfo().username;
        return name && name !== 'unknown' ? name : null;
    } catch {
        return null;
    }
}

function plistPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}
function systemdUnitPath(): string {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(base, 'systemd', 'user', SYSTEMD_UNIT);
}

/** Whether a user-level service manager we can drive is available. */
export function serviceSupported(): boolean {
    if (isMac()) return true;
    if (!isLinux()) return false;
    try {
        execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
        return true;
    } catch {
        return false; // no systemd, or no user bus (container / bare init)
    }
}

// --- which surfaces are switched on -----------------------------------------

function statePath(): string {
    return join(configDir(), 'watchers.json');
}

/**
 * Surfaces the user has switched on. Absent state means "nothing yet" — callers
 * decide the default (connect enables everything it detects).
 */
export function enabledSurfaces(): string[] {
    try {
        const raw = JSON.parse(readFileSync(statePath(), 'utf-8')) as { surfaces?: unknown };
        if (!Array.isArray(raw?.surfaces)) return [];
        return raw.surfaces.filter((s): s is string => typeof s === 'string' && !!s);
    } catch {
        return [];
    }
}

export function setEnabledSurfaces(surfaces: string[]): void {
    const unique = [...new Set(surfaces)].sort();
    try {
        mkdirSync(configDir(), { recursive: true });
        writeFileSync(statePath(), JSON.stringify({ surfaces: unique }, null, 2));
    } catch {
        // best effort — the service still runs with whatever it was given
    }
}

export function surfaceEnabled(name: string): boolean {
    return enabledSurfaces().includes(name);
}

// --- service definition ------------------------------------------------------

function plistBody(lutPath: string, surfaces: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(SERVICE_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(lutPath)}</string>
        <string>watch-all</string>
        <string>--only</string>
        <string>${xml(surfaces.join(','))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(agentWorkDir())}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/usage-tracker-watchers.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/usage-tracker-watchers.log</string>
</dict>
</plist>
`;
}

function unitBody(lutPath: string, surfaces: string[]): string {
    return `[Unit]
Description=LLM Usage Tracker watchers
Documentation=https://github.com/versantus/llm-usage-tracker
After=default.target

[Service]
Type=simple
ExecStart=${lutPath} watch-all --only ${surfaces.join(',')}
WorkingDirectory=${agentWorkDir()}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

// --- install / remove --------------------------------------------------------

/**
 * Write the service definition for the currently enabled surfaces and (re)start
 * it. With no surfaces enabled the service is removed instead — an idle
 * process that watches nothing is just overhead.
 */
export function installService(lutPath: string): string {
    const surfaces = enabledSurfaces();
    if (!surfaces.length) return removeService();
    if (!serviceSupported()) {
        return isLinux()
            ? `no systemd user session — run \`${lutPath} watch-all\` under your own service manager.`
            : `unsupported platform — run \`${lutPath} watch-all\` under your own service manager.`;
    }
    return isMac() ? installLaunchAgent(lutPath, surfaces) : installSystemdUnit(lutPath, surfaces);
}

function installLaunchAgent(lutPath: string, surfaces: string[]): string {
    const p = plistPath();
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(p, plistBody(lutPath, surfaces));

    try {
        execFileSync('launchctl', ['bootout', `${gui()}/${SERVICE_LABEL}`], { stdio: 'ignore' });
    } catch {
        // not loaded — fine
    }
    // One retry: bootstrap can race with the just-booted-out old instance
    // still winding down (seen as an immediate failure that succeeds ~1s later).
    for (let attempt = 0; ; attempt++) {
        try {
            execFileSync('launchctl', ['bootstrap', gui(), p], { stdio: 'ignore' });
            return `watching ${surfaces.join(', ')} (LaunchAgent ${SERVICE_LABEL})`;
        } catch (err: any) {
            if (attempt === 0) {
                try {
                    execFileSync('/bin/sleep', ['1'], { stdio: 'ignore' });
                } catch {
                    // sleep is best effort
                }
                continue;
            }
            return `failed to load LaunchAgent: ${err?.message ?? err}`;
        }
    }
}

function installSystemdUnit(lutPath: string, surfaces: string[]): string {
    const p = systemdUnitPath();
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, unitBody(lutPath, surfaces));
    try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
        execFileSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { stdio: 'ignore' });
        // Picks up an edited ExecStart when the unit was already running.
        execFileSync('systemctl', ['--user', 'restart', SYSTEMD_UNIT], { stdio: 'ignore' });
    } catch (err: any) {
        return `wrote ${p} but systemctl failed: ${err?.message ?? err}`;
    }
    // Without lingering, user units stop at logout — which silently ends
    // tracking on a machine the user thinks is set up.
    let note = '';
    const user = currentUsername();
    if (user) {
        try {
            const out = execFileSync('loginctl', ['show-user', user, '--property=Linger'], {
                encoding: 'utf-8'
            });
            if (!/Linger=yes/.test(out)) {
                note = `\n  note: run \`sudo loginctl enable-linger ${user}\` to keep watching after logout.`;
            }
        } catch {
            // loginctl absent — can't tell; stay quiet rather than guess
        }
    }
    return `watching ${surfaces.join(', ')} (systemd user unit ${SYSTEMD_UNIT})${note}`;
}

export function removeService(): string {
    if (isMac()) {
        try {
            execFileSync('launchctl', ['bootout', `${gui()}/${SERVICE_LABEL}`], { stdio: 'ignore' });
        } catch {
            // already out
        }
        if (existsSync(plistPath())) rmSync(plistPath());
        return `watcher service stopped (${SERVICE_LABEL})`;
    }
    if (isLinux()) {
        try {
            execFileSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { stdio: 'ignore' });
        } catch {
            // not installed
        }
        if (existsSync(systemdUnitPath())) rmSync(systemdUnitPath());
        return `watcher service stopped (${SYSTEMD_UNIT})`;
    }
    return 'no watcher service on this platform.';
}

/** Whether the service is currently loaded and running. */
export function serviceRunning(): boolean {
    if (isMac()) {
        if (!existsSync(plistPath())) return false;
        try {
            execFileSync('launchctl', ['print', `${gui()}/${SERVICE_LABEL}`], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }
    if (isLinux()) {
        if (!existsSync(systemdUnitPath())) return false;
        try {
            execFileSync('systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_UNIT], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

/** Restart the service so it picks up a replaced binary. */
export function restartService(): boolean {
    if (!serviceRunning()) return false;
    try {
        if (isMac()) {
            execFileSync('launchctl', ['kickstart', '-k', `${gui()}/${SERVICE_LABEL}`], { stdio: 'ignore' });
        } else {
            execFileSync('systemctl', ['--user', 'restart', SYSTEMD_UNIT], { stdio: 'ignore' });
        }
        return true;
    } catch {
        return false;
    }
}

// --- migration ---------------------------------------------------------------

/**
 * Tear down the old one-LaunchAgent-per-surface layout, returning the surfaces
 * that were switched on so the caller can carry them into the new state file.
 * Idempotent, and a no-op once nothing legacy is left.
 */
export function migrateLegacyAgents(): string[] {
    if (!isMac()) return [];
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    let files: string[];
    try {
        files = readdirSync(dir);
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const f of files) {
        if (!f.startsWith(`${PREFIX}.`) || !f.endsWith('.plist')) continue;
        const suffix = f.slice(PREFIX.length + 1, -'.plist'.length);
        if (!suffix || suffix === 'watchers') continue; // the new service
        found.push(suffix);
        try {
            execFileSync('launchctl', ['bootout', `${gui()}/${PREFIX}.${suffix}`], { stdio: 'ignore' });
        } catch {
            // already out
        }
        try {
            rmSync(join(dir, f));
        } catch {
            // best effort
        }
    }
    return found;
}
