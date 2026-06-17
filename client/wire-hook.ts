/**
 * Wire (or unwire) the Stop hook in ~/.claude/settings.json.
 *
 * Used by the `lut` binary (`lut wire` / `lut unwire` / `lut connect`) and by
 * `cut setup --wire-hook`. Read-modify-write; never clobbers other hooks.
 *
 * The hook command depends on how we're running:
 *   - compiled `lut` binary  -> "<abs path to lut>" hook
 *   - dev (bun/npx)          -> npx -y bun "<abs path to hooks/stop.ts>"
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function settingsPath(): string {
    return join(homedir(), '.claude', 'settings.json');
}

/** True when running as a compiled standalone binary (not under bun/node). */
function isCompiledBinary(): boolean {
    const exec = process.execPath.toLowerCase();
    return !exec.endsWith('bun') && !exec.includes('node');
}

/** The command Claude Code should run for the Stop hook, for this install. */
export function hookCommand(): string {
    if (isCompiledBinary()) {
        return `"${process.execPath}" hook`;
    }
    // Dev / npx-bun fallback: point at the standalone stop hook next to this file.
    const stopHook = join(import.meta.dir, 'hooks', 'stop.ts');
    return `npx -y bun "${stopHook}"`;
}

/** Every command string inside a Stop-hook entry (handles both shapes). */
function commandsOf(entry: any): string[] {
    const out: string[] = [];
    if (Array.isArray(entry?.hooks)) {
        for (const h of entry.hooks) if (typeof h?.command === 'string') out.push(h.command);
    }
    if (typeof entry?.command === 'string') out.push(entry.command);
    return out;
}

/** Recognise a command we own: the `lut … hook` binary or the legacy script. */
function isOurCommand(c: string): boolean {
    return c.includes('hooks/stop.ts') || /(^|[/"\s])lut"?\s+hook\b/.test(c);
}

/** Recognise a Stop-hook entry we own (binary or legacy script form). */
function isOurEntry(entry: unknown): boolean {
    return commandsOf(entry).some(isOurCommand);
}

function loadSettings(p: string): any | null {
    if (!existsSync(p)) return {};
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null; // unparseable
    }
}

function save(p: string, settings: any): void {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
}

/** Merge a Stop hook into ~/.claude/settings.json. Idempotent. */
export function wireClaudeCodeHook(command = hookCommand()): string {
    const p = settingsPath();
    const settings = loadSettings(p);
    if (settings === null) return `could not parse ${p} — left unchanged`;

    settings.hooks ??= {};
    settings.hooks.Stop ??= [];

    // Replace any existing entry we own so the command path stays current.
    const before = settings.hooks.Stop.length;
    settings.hooks.Stop = settings.hooks.Stop.filter((e: unknown) => !isOurEntry(e));
    const removed = before - settings.hooks.Stop.length;

    settings.hooks.Stop.push({
        hooks: [{ type: 'command', command, async: true, timeout: 15 }]
    });

    save(p, settings);
    return removed > 0 ? `updated hook in ${p}` : `wired into ${p}`;
}

/** Remove our Stop hook from ~/.claude/settings.json. */
export function unwireClaudeCodeHook(): string {
    const p = settingsPath();
    const settings = loadSettings(p);
    if (settings === null) return `could not parse ${p} — left unchanged`;
    if (!settings.hooks?.Stop?.length) return 'no hook to remove';

    const before = settings.hooks.Stop.length;
    settings.hooks.Stop = settings.hooks.Stop.filter((e: unknown) => !isOurEntry(e));
    if (settings.hooks.Stop.length === before) return 'no matching hook found';
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;

    save(p, settings);
    return `removed hook from ${p}`;
}

/** Whether our Stop hook is currently present. */
export function isHookWired(): boolean {
    const settings = loadSettings(settingsPath());
    const stop = settings?.hooks?.Stop;
    return Array.isArray(stop) && stop.some(isOurEntry);
}
