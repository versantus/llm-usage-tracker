#!/usr/bin/env bun
/**
 * `lut` — the unified Usage Tracker CLI, distributed as a single compiled
 * binary (see scripts/build-cli.sh). One small surface for the whole client:
 *
 *   lut connect     write identity/server config AND wire the Claude Code hook
 *   lut hook        the Stop-hook runtime (Claude Code runs this; reads stdin)
 *   lut wire        (re)wire the Stop hook into ~/.claude/settings.json
 *   lut unwire      remove the Stop hook
 *   lut status      show config, hook state, and server reachability
 *   lut report      print a usage + carbon summary
 *   lut version
 *
 * The hook needs no bun/npx at runtime — the binary embeds everything.
 */

import { createInterface } from 'node:readline/promises';

import {
    buildConfig,
    configPath,
    defaultServerUrl,
    detectDeviceName,
    loadConfig
} from '../client/config.ts';
import { saveConfig } from '../client/config.ts';
import { scanCodex } from '../client/codex-report.ts';
import { scanCowork } from '../client/cowork-report.ts';
import { stopHookMain } from '../client/hooks/run-stop.ts';
import { runHook } from '../client/hooks/stdin.ts';
import { agentEnabled, disableAgent, enableAgent } from '../client/launch-agent.ts';
import { flushSpool } from '../client/post.ts';
import { codexAvailable } from '../client/sources/codex-source.ts';
import { coworkAvailable } from '../client/sources/cowork-source.ts';
import {
    hookCommand,
    isHookWired,
    settingsPath,
    unwireClaudeCodeHook,
    wireClaudeCodeHook
} from '../client/wire-hook.ts';

const VERSION = '0.2.0';

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

async function ask(question: string, fallback?: string): Promise<string> {
    if (!process.stdin.isTTY) return fallback ?? '';
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    rl.close();
    return answer || fallback || '';
}

function authHeaders(): Record<string, string> {
    const user = process.env.LUT_DASH_USER || '';
    const pass = process.env.LUT_DASH_PASS || '';
    if (!pass) return {};
    return { authorization: 'Basic ' + btoa(`${user}:${pass}`) };
}

// --- commands ---------------------------------------------------------------

async function cmdConnect(): Promise<void> {
    const existing = loadConfig();
    let name = flag('name') ?? existing?.user.name ?? '';
    let email = flag('email') ?? existing?.user.email ?? '';
    const serverUrl = flag('server-url') ?? existing?.serverUrl ?? defaultServerUrl();
    const ingestToken =
        flag('ingest-token') ?? process.env.LUT_INGEST_TOKEN ?? existing?.ingestToken;
    let deviceName =
        flag('device-name') ?? process.env.LUT_DEVICE_NAME ?? existing?.deviceName ?? '';

    if (!name) name = await ask('Your name');
    if (!email) email = await ask('Your work email');
    if (!deviceName) deviceName = await ask('Device / OS label', detectDeviceName());

    if (!name || !email) {
        console.error('Name and email are required (pass --name and --email, or run interactively).');
        process.exit(1);
    }

    const cfg = buildConfig({
        name,
        email,
        serverUrl,
        ingestToken,
        deviceName,
        claudeCode: existing?.surfaces.claudeCode ?? true,
        cowork: has('no-cowork') ? false : existing?.surfaces.cowork ?? true
    });
    saveConfig(cfg);

    console.error(`✓ Config written to ${configPath()}`);
    console.error(`  ${cfg.user.name} <${cfg.user.email}>  ·  ${cfg.deviceName}  ·  ${cfg.serverUrl}`);

    if (!has('no-hook')) {
        console.error(`✓ Hook: ${wireClaudeCodeHook()}`);
    }

    // Codex CLI has no Stop-style hook, so track it via a background watcher.
    if (!has('no-codex') && codexAvailable()) {
        console.error(`✓ Codex: ${enableAgent('codex', process.execPath, 'watch-codex')}`);
        await scanCodex(cfg, { sinceHours: 24, quiet: true }); // backfill the last day
    }

    // Cowork (local agent mode) likewise has no hook — same watcher pattern.
    if (!has('no-cowork') && cfg.surfaces.cowork && coworkAvailable()) {
        console.error(`✓ Cowork: ${enableAgent('cowork', process.execPath, 'watch-cowork')}`);
        await scanCowork(cfg, { quiet: true });
    }

    await flushSpool(cfg.serverUrl, cfg.ingestToken);
    console.error('\nDone. New Claude Code sessions will report on each Stop.');
}

async function cmdStatus(): Promise<void> {
    const cfg = loadConfig();
    console.log('Usage Tracker status');
    console.log('  config:    ' + (cfg ? configPath() : 'not configured (run `lut connect`)'));
    if (cfg) {
        console.log(`  user:      ${cfg.user.name} <${cfg.user.email}>`);
        console.log(`  device:    ${cfg.deviceName}`);
        console.log(`  server:    ${cfg.serverUrl}`);
        console.log(`  ingest:    ${cfg.ingestToken ? 'token set' : 'no token'}`);
    }
    console.log(`  hook:      ${isHookWired() ? 'wired' : 'NOT wired'}  (${settingsPath()})`);
    console.log(`  codex:     ${watcherState('codex', codexAvailable())}`);
    console.log(`  cowork:    ${watcherState('cowork', coworkAvailable())}`);
    console.log(`  binary:    ${process.execPath}`);

    if (cfg) {
        try {
            const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/health`, {
                signal: AbortSignal.timeout(4000)
            });
            console.log(`  server up: ${res.ok ? 'yes' : 'no (' + res.status + ')'}`);
        } catch {
            console.log('  server up: no (unreachable)');
        }
    }
}

async function cmdReport(): Promise<void> {
    const cfg = loadConfig();
    const serverUrl = (flag('server') || cfg?.serverUrl || defaultServerUrl()).replace(/\/$/, '');
    const days = Number(flag('days') || '0') || 0;
    const url = days ? `${serverUrl}/api/summary?days=${days}` : `${serverUrl}/api/summary`;
    try {
        const res = await fetch(url, { headers: authHeaders() });
        if (res.status === 401) {
            console.error('401 — set LUT_DASH_USER / LUT_DASH_PASS for the dashboard.');
            process.exit(1);
        }
        if (!res.ok) {
            console.error(`${serverUrl} -> ${res.status}`);
            process.exit(1);
        }
        const s: any = await res.json();
        const t = s.totals || {};
        console.log(`\n  Usage Tracker — ${days ? 'last ' + days + ' days' : 'all time'}`);
        console.log('  ' + '─'.repeat(48));
        console.log(
            `  CO₂ ${(t.co2_grams || 0).toFixed(1)}g · ${Math.round(t.tokens || 0).toLocaleString()} tok · ` +
                `${t.sessions || 0} sessions · ${t.users || 0} users`
        );
        for (const u of (s.byUser || []).slice(0, 10)) {
            console.log(`    ${u.name.padEnd(20)} ${(u.co2_grams || 0).toFixed(1)}g`);
        }
        console.log('');
    } catch (err: any) {
        console.error(`Could not reach ${serverUrl}: ${err.message}`);
        process.exit(1);
    }
}

/** Human-friendly watcher state for `lut status`. */
function watcherState(suffix: string, available: boolean): string {
    if (!available) return 'not detected';
    return agentEnabled(suffix)
        ? 'watcher enabled'
        : `detected, watcher OFF (run \`lut ${suffix} enable\`)`;
}

function requireConfig() {
    const cfg = loadConfig();
    if (!cfg) {
        console.error('not configured — run `lut connect` first.');
        process.exit(1);
    }
    return cfg;
}

async function cmdScanCodex(): Promise<void> {
    const hours = has('all') ? 0 : Number(flag('hours') || '24') || 24;
    const res = await scanCodex(requireConfig(), { sinceHours: hours });
    console.error(`scanned ${res.scanned} rollout(s), sent ${res.sent}.`);
}

async function cmdWatchCodex(): Promise<void> {
    const cfg = requireConfig();
    const interval = Number(flag('interval') || '30') || 30;
    const seen = new Map<string, number>();
    console.error(`[usage-tracker:codex] watching ~/.codex/sessions every ${interval}s`);
    await scanCodex(cfg, { sinceHours: 48, seen });
    setInterval(() => scanCodex(cfg, { sinceHours: 2, seen }).catch(() => {}), interval * 1000);
    await new Promise(() => {});
}

async function cmdScanCowork(): Promise<void> {
    const res = await scanCowork(requireConfig());
    console.error(`scanned ${res.scanned} session(s), sent ${res.sent}.`);
}

async function cmdWatchCowork(): Promise<void> {
    const cfg = requireConfig();
    const interval = Number(flag('interval') || '15') || 15;
    const seen = new Map<string, number>();
    console.error(`[usage-tracker:cowork] watching every ${interval}s`);
    await scanCowork(cfg, { seen });
    setInterval(() => scanCowork(cfg, { seen }).catch(() => {}), interval * 1000);
    await new Promise(() => {});
}

/** `lut <codex|cowork> <enable|disable|status>`. */
function cmdSurface(suffix: 'codex' | 'cowork', available: boolean): void {
    const sub = process.argv[3];
    const watchCmd = `watch-${suffix}`;
    switch (sub) {
        case 'enable':
            console.error(enableAgent(suffix, process.execPath, watchCmd));
            break;
        case 'disable':
            console.error(disableAgent(suffix));
            break;
        case 'status':
            console.error(`${suffix}: ${watcherState(suffix, available)}`);
            break;
        default:
            console.error(`usage: lut ${suffix} <enable|disable|status>`);
            process.exit(1);
    }
}

function usage(): void {
    console.log(
        [
            'lut — Usage Tracker CLI',
            '',
            'Usage: lut <command> [options]',
            '',
            'Commands:',
            '  connect    write config and wire the Claude Code Stop hook',
            '             [--name N --email E --server-url U --ingest-token T]',
            '             [--device-name D] [--no-cowork] [--no-hook]',
            '  hook       Stop-hook runtime (Claude Code invokes this)',
            '  wire       (re)wire the Stop hook into ~/.claude/settings.json',
            '  unwire     remove the Stop hook',
            '  codex      manage Codex tracking: codex <enable|disable|status>',
            '  cowork     manage Cowork tracking: cowork <enable|disable|status>',
            '  scan-codex / scan-cowork    report sessions once',
            '  watch-codex / watch-cowork  watch sessions continuously [--interval S]',
            '  status     show config, hook state, server reachability',
            '  report     print a usage + carbon summary [--days N] [--server U]',
            '  version'
        ].join('\n')
    );
}

// --- dispatch ---------------------------------------------------------------

const cmd = process.argv[2];

switch (cmd) {
    case 'hook':
        runHook(stopHookMain);
        break;
    case 'connect':
    case 'setup':
        await cmdConnect();
        break;
    case 'wire':
        console.error(wireClaudeCodeHook());
        break;
    case 'unwire':
        console.error(unwireClaudeCodeHook());
        break;
    case 'codex':
        cmdSurface('codex', codexAvailable());
        break;
    case 'cowork':
        cmdSurface('cowork', coworkAvailable());
        break;
    case 'scan-codex':
        await cmdScanCodex();
        break;
    case 'watch-codex':
        await cmdWatchCodex();
        break;
    case 'scan-cowork':
        await cmdScanCowork();
        break;
    case 'watch-cowork':
        await cmdWatchCowork();
        break;
    case 'status':
        await cmdStatus();
        break;
    case 'report':
        await cmdReport();
        break;
    case 'version':
    case '--version':
    case '-v':
        console.log(VERSION);
        break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
        usage();
        break;
    default:
        console.error(`unknown command: ${cmd}\n`);
        usage();
        process.exit(1);
}
