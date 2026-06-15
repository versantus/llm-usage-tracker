#!/usr/bin/env bun
/**
 * `cut setup` / `/usage-tracker:setup`
 *
 * Writes local identity + server config. As a plugin, the Stop hook is wired
 * automatically via hooks/hooks.json, so setup only records who you are and
 * where the server is — then flushes any spooled events and hints at Cowork.
 *
 *   bun run client/setup.ts --name "Nik" --email you@example.com \
 *       --server-url http://localhost:4317 [--no-cowork] [--wire-hook]
 */

import { createInterface } from 'node:readline/promises';

import {
    buildConfig,
    configPath,
    defaultServerUrl,
    loadConfig,
    saveConfig
} from './config.ts';
import { flushSpool } from './post.ts';
import { coworkAvailable, coworkSessionsRoot } from './sources/cowork-source.ts';
import { wireClaudeCodeHook } from './wire-hook.ts';

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

async function prompt(question: string, fallback?: string): Promise<string> {
    if (!process.stdin.isTTY) return fallback ?? '';
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    rl.close();
    return answer || fallback || '';
}

const existing = loadConfig();

let name = flag('name') ?? existing?.user.name ?? '';
let email = flag('email') ?? existing?.user.email ?? '';
const serverUrl = flag('server-url') ?? existing?.serverUrl ?? defaultServerUrl();

if (!name) name = await prompt('Your name');
if (!email) email = await prompt('Your work email');

if (!name || !email) {
    console.error('Name and email are required. Pass --name and --email, or run interactively.');
    process.exit(1);
}

const cfg = buildConfig({
    name,
    email,
    serverUrl,
    claudeCode: existing?.surfaces.claudeCode ?? true,
    cowork: has('no-cowork') ? false : existing?.surfaces.cowork ?? true
});
saveConfig(cfg);

console.error(`\n✓ Config written to ${configPath()}`);
console.error(`  User:   ${cfg.user.name} <${cfg.user.email}>  (id ${cfg.userId})`);
console.error(`  Server: ${cfg.serverUrl}`);

// Plugin installs wire the hook via hooks/hooks.json. For a non-plugin install,
// pass --wire-hook to merge a Stop hook into ~/.claude/settings.json.
if (has('wire-hook')) {
    const res = wireClaudeCodeHook();
    console.error(`  Hook:   ${res}`);
}

await flushSpool(cfg.serverUrl);

if (cfg.surfaces.cowork) {
    if (coworkAvailable()) {
        console.error(
            `\nCowork detected. Start the watcher to track Cowork sessions:\n` +
                `  bun run ${import.meta.dir}/watch-cowork.ts`
        );
    } else {
        console.error(
            `\nCowork not detected at ${coworkSessionsRoot()} (it'll be picked up once present).`
        );
    }
}

console.error('\nDone. New Claude Code sessions will report to the server on each Stop.');
