#!/usr/bin/env bun
/**
 * `lut` — the unified Usage Tracker CLI, shipped as one compiled binary.
 *
 *   lut connect      write config, wire the Claude Code hook, enable watchers
 *   lut hook         the Stop-hook runtime (Claude Code runs this; reads stdin)
 *   lut wire|unwire  (re)wire / remove the Stop hook
 *   lut <surface> enable|disable|status     surface in: codex cowork copilot gemini ollama
 *   lut scan-<surface> [--hours N|--all]    one-off report
 *   lut watch-<surface> [--interval S]      continuous watcher (LaunchAgent runs this)
 *   lut cursor-pull  pull Cursor team usage via the Admin API (server-side)
 *   lut status | report | version
 *
 * Surfaces with no Stop-style hook (codex/cowork/copilot/gemini/ollama) are
 * tracked by background watchers; the hook needs no bun/npx at runtime.
 */

import { createInterface } from 'node:readline/promises';

import {
    buildConfig,
    configPath,
    defaultServerUrl,
    detectDeviceName,
    loadConfig,
    saveConfig
} from '../client/config.ts';
import type { ClientConfig } from '../client/config.ts';
import { cursorPull } from '../client/cursor-pull.ts';
import { launchGui } from '../client/gui.ts';
import { stopHookMain } from '../client/hooks/run-stop.ts';
import { runHook } from '../client/hooks/stdin.ts';
import { agentEnabled, disableAgent, enableAgent } from '../client/launch-agent.ts';
import { flushSpool } from '../client/post.ts';
import { scanSource, type ScanItem } from '../client/scan-source.ts';
import {
    codexAvailable,
    codexSource,
    listCodexRollouts
} from '../client/sources/codex-source.ts';
import {
    copilotAvailable,
    copilotSource,
    listCopilotFiles
} from '../client/sources/copilot-source.ts';
import {
    coworkAvailable,
    coworkSource,
    listCoworkAuditFiles
} from '../client/sources/cowork-source.ts';
import {
    enableGeminiTelemetry,
    geminiAvailable,
    geminiSource,
    geminiTelemetryMtime,
    geminiTelemetryOutfile,
    listGeminiSessions
} from '../client/sources/gemini-source.ts';
import {
    listOllamaChats,
    ollamaAvailable,
    ollamaSource
} from '../client/sources/ollama-source.ts';
import type { Source } from '../client/sources/source.ts';
import {
    isHookWired,
    settingsPath,
    unwireClaudeCodeHook,
    wireClaudeCodeHook
} from '../client/wire-hook.ts';

const VERSION = '0.3.0';

/**
 * Positional args, normalised across platforms. `bun --compile` lays out
 * process.argv differently: on macOS/Linux it injects a virtual entrypoint
 * (e.g. "/$bunfs/root/lut") at argv[1], so the command is argv[2]; on Windows
 * there's no such entry, so the command is argv[1]. We strip argv[0] (the exe)
 * and any bun virtual entry, leaving argv[0]=command, argv[1]=subcommand.
 */
const ARGS: string[] = (() => {
    const a = process.argv.slice(1);
    const first = a[0] || '';
    if (
        first === process.execPath ||
        first.includes('$bunfs') ||
        first.includes('~BUN') ||
        first.includes('/B/~BUN')
    ) {
        a.shift();
    }
    return a;
})();

function flag(name: string): string | undefined {
    const i = ARGS.indexOf(`--${name}`);
    return i >= 0 ? ARGS[i + 1] : undefined;
}
function has(name: string): boolean {
    return ARGS.includes(`--${name}`);
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

// --- watcher surfaces (no Stop-style hook) ---------------------------------

interface SurfaceDef {
    available: () => boolean;
    /** Build scan items; sinceHours=0 means "all". */
    items: (sinceHours: number) => ScanItem[];
    source: Source;
    backfillHours: number; // window used on connect / one-off scans
    interval: number; // watch interval (seconds)
    onEnable?: () => string; // extra setup before the LaunchAgent (e.g. gemini telemetry)
    /** Optional gate read from config (cowork respects surfaces.cowork). */
    gate?: (cfg: ClientConfig) => boolean;
}

const SURFACES: Record<string, SurfaceDef> = {
    codex: {
        available: codexAvailable,
        items: (h) => listCodexRollouts(h),
        source: codexSource,
        backfillHours: 24,
        interval: 30
    },
    cowork: {
        available: coworkAvailable,
        items: () => listCoworkAuditFiles().map((f) => ({ sessionId: f.sessionId, path: f.auditPath, mtimeMs: f.mtimeMs })),
        source: coworkSource,
        backfillHours: 0,
        interval: 15,
        gate: (cfg) => cfg.surfaces.cowork !== false
    },
    copilot: {
        available: copilotAvailable,
        items: (h) => listCopilotFiles(h),
        source: copilotSource,
        backfillHours: 24,
        interval: 30
    },
    gemini: {
        available: geminiAvailable,
        items: () => listGeminiSessions().map((s) => ({ sessionId: s.sessionId, path: geminiTelemetryOutfile(), mtimeMs: geminiTelemetryMtime() })),
        source: geminiSource,
        backfillHours: 0,
        interval: 30,
        onEnable: enableGeminiTelemetry
    },
    ollama: {
        available: ollamaAvailable,
        items: (h) => listOllamaChats(h),
        source: ollamaSource,
        backfillHours: 0,
        interval: 60
    }
};

const SURFACE_NAMES = Object.keys(SURFACES);

// --- commands ---------------------------------------------------------------

function requireConfig(): ClientConfig {
    const cfg = loadConfig();
    if (!cfg) {
        console.error('not configured — run `lut connect` first.');
        process.exit(1);
    }
    return cfg;
}

async function cmdConnect(): Promise<void> {
    const existing = loadConfig();
    let name = flag('name') ?? existing?.user.name ?? '';
    let email = flag('email') ?? existing?.user.email ?? '';
    const serverUrl = flag('server-url') ?? existing?.serverUrl ?? defaultServerUrl();
    const ingestToken = flag('ingest-token') ?? process.env.LUT_INGEST_TOKEN ?? existing?.ingestToken;
    let deviceName = flag('device-name') ?? process.env.LUT_DEVICE_NAME ?? existing?.deviceName ?? '';

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

    if (!has('no-hook')) console.error(`✓ Claude Code hook: ${wireClaudeCodeHook()}`);

    // Auto-enable a watcher for each detected surface (unless --no-<surface>).
    for (const name of SURFACE_NAMES) {
        const def = SURFACES[name];
        if (has(`no-${name}`)) continue;
        if (def.gate && !def.gate(cfg)) continue;
        if (!def.available()) continue;
        if (def.onEnable) console.error(`  ${name}: ${def.onEnable()}`);
        console.error(`✓ ${name}: ${enableAgent(name, process.execPath, `watch-${name}`)}`);
        await scanSource(cfg, name, def.items(def.backfillHours), def.source, { quiet: true });
    }

    await flushSpool(cfg.serverUrl, cfg.ingestToken);
    console.error('\nDone. Claude Code reports on each Stop; other tools via their watchers.');
}

function surfaceState(name: string): string {
    const def = SURFACES[name];
    if (!def.available()) return 'not detected';
    return agentEnabled(name) ? 'watcher enabled' : `detected, watcher OFF (run \`lut ${name} enable\`)`;
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
    for (const name of SURFACE_NAMES) console.log(`  ${(name + ':').padEnd(10)} ${surfaceState(name)}`);
    console.log(`  binary:    ${process.execPath}`);

    if (cfg) {
        try {
            const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(4000) });
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
            console.log(`    ${String(u.name).padEnd(20)} ${(u.co2_grams || 0).toFixed(1)}g`);
        }
        console.log('');
    } catch (err: any) {
        console.error(`Could not reach ${serverUrl}: ${err.message}`);
        process.exit(1);
    }
}

/** `lut <surface> <enable|disable|status>`. */
function cmdSurface(name: string): void {
    const def = SURFACES[name];
    const sub = ARGS[1];
    switch (sub) {
        case 'enable':
            if (def.onEnable) console.error(`  ${def.onEnable()}`);
            console.error(enableAgent(name, process.execPath, `watch-${name}`));
            break;
        case 'disable':
            console.error(disableAgent(name));
            break;
        case 'status':
            console.error(`${name}: ${surfaceState(name)}`);
            break;
        default:
            console.error(`usage: lut ${name} <enable|disable|status>`);
            process.exit(1);
    }
}

async function cmdScan(name: string): Promise<void> {
    const def = SURFACES[name];
    const cfg = requireConfig();
    const hours = has('all') ? 0 : Number(flag('hours') || String(def.backfillHours)) || def.backfillHours;
    const res = await scanSource(cfg, name, def.items(hours), def.source, {});
    console.error(`scanned ${res.scanned} ${name} session(s), sent ${res.sent}.`);
}

async function cmdWatch(name: string): Promise<void> {
    const def = SURFACES[name];
    const cfg = requireConfig();
    const interval = Number(flag('interval') || String(def.interval)) || def.interval;
    const seen = new Map<string, number>();
    console.error(`[usage-tracker:${name}] watching every ${interval}s`);
    await scanSource(cfg, name, def.items(0), def.source, { seen }); // initial full pass
    setInterval(() => scanSource(cfg, name, def.items(def.backfillHours || 48), def.source, { seen }).catch(() => {}), interval * 1000);
    await new Promise(() => {});
}

async function cmdCursorPull(): Promise<void> {
    const cfg = requireConfig();
    await cursorPull(cfg);
}

function usage(): void {
    console.log(
        [
            'lut — Usage Tracker CLI',
            '',
            'Usage: lut <command> [options]',
            '',
            'Core:',
            '  connect    write config, wire the Claude Code hook, enable watchers',
            '             [--name N --email E --server-url U --ingest-token T]',
            '             [--device-name D] [--no-hook] [--no-<surface>]',
            '  hook       Stop-hook runtime (Claude Code invokes this)',
            '  wire | unwire   (re)wire / remove the Stop hook',
            '  gui        launch the tray + settings GUI (Windows)',
            '  status | report [--days N] | version',
            '',
            'Watcher surfaces: ' + SURFACE_NAMES.join(', '),
            '  <surface> enable|disable|status',
            '  scan-<surface> [--hours N | --all]',
            '  watch-<surface> [--interval S]',
            '',
            'Cursor (server-side, needs CURSOR_API_KEY):',
            '  cursor-pull [--days N]'
        ].join('\n')
    );
}

// --- dispatch ---------------------------------------------------------------

const cmd = ARGS[0];
const scanMatch = cmd?.match(/^scan-(.+)$/);
const watchMatch = cmd?.match(/^watch-(.+)$/);

if (cmd === 'hook') {
    runHook(stopHookMain);
} else if (cmd === 'connect' || cmd === 'setup') {
    await cmdConnect();
} else if (cmd === 'wire') {
    console.error(wireClaudeCodeHook());
} else if (cmd === 'unwire') {
    console.error(unwireClaudeCodeHook());
} else if (cmd && SURFACE_NAMES.includes(cmd)) {
    cmdSurface(cmd);
} else if (scanMatch && SURFACE_NAMES.includes(scanMatch[1])) {
    await cmdScan(scanMatch[1]);
} else if (watchMatch && SURFACE_NAMES.includes(watchMatch[1])) {
    await cmdWatch(watchMatch[1]);
} else if (cmd === 'cursor-pull') {
    await cmdCursorPull();
} else if (cmd === 'gui' || cmd === 'tray') {
    await launchGui({ debug: has('debug') });
} else if (cmd === 'status') {
    await cmdStatus();
} else if (cmd === 'report') {
    await cmdReport();
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
} else if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
} else {
    console.error(`unknown command: ${cmd}\n`);
    usage();
    process.exit(1);
}
