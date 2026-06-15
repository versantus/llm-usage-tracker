/**
 * Merge a Stop hook into ~/.claude/settings.json for NON-plugin installs.
 * The plugin install wires the hook via hooks/hooks.json instead, so this is
 * only used when `cut setup --wire-hook` is passed. Read-modify-write; never
 * clobbers existing hooks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function settingsPath(): string {
    return join(homedir(), '.claude', 'settings.json');
}

/** Absolute path to this repo's stop hook. */
function stopHookCommand(): string {
    const stopHook = join(import.meta.dir, 'hooks', 'stop.ts');
    return `npx -y bun ${stopHook}`;
}

export function wireClaudeCodeHook(): string {
    const p = settingsPath();
    let settings: any = {};
    if (existsSync(p)) {
        try {
            settings = JSON.parse(readFileSync(p, 'utf-8'));
        } catch {
            return `could not parse ${p} — left unchanged`;
        }
    }

    settings.hooks ??= {};
    settings.hooks.Stop ??= [];

    const command = stopHookCommand();
    const already = JSON.stringify(settings.hooks.Stop).includes('client/hooks/stop.ts');
    if (already) return 'already wired';

    settings.hooks.Stop.push({
        hooks: [{ type: 'command', command, async: true, timeout: 15 }]
    });

    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(settings, null, 2));
    return `wired into ${p}`;
}
