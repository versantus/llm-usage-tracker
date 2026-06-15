#!/usr/bin/env bun
/**
 * `cut report` — query the central server and print a usage + carbon report.
 *
 *   bun run cli/report.ts [--days N] [--by user|model] [--json] [--server URL]
 *
 * Defaults to the server URL from client config / LUT_SERVER_URL / localhost:4317.
 */

import { defaultServerUrl, loadConfig } from '../client/config.ts';
import {
    calculateWaterLiters,
    equivalents,
    formatCO2,
    formatEnergy,
    formatWater
} from '../shared/carbon-calculator.ts';

function flag(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}
const wantJson = process.argv.includes('--json');
const by = flag('by', 'user');
const days = Number(flag('days', '0')) || 0;
const serverUrl = (flag('server') || loadConfig()?.serverUrl || defaultServerUrl()).replace(
    /\/$/,
    ''
);

function q(path: string): string {
    return days ? `${serverUrl}${path}?days=${days}` : `${serverUrl}${path}`;
}

// If the server enforces dashboard Basic Auth, pass creds via env.
function authHeaders(): Record<string, string> {
    const user = process.env.LUT_DASH_USER || '';
    const pass = process.env.LUT_DASH_PASS || '';
    if (!pass) return {};
    return { authorization: 'Basic ' + btoa(`${user}:${pass}`) };
}

async function get(path: string): Promise<any> {
    const res = await fetch(q(path), { headers: authHeaders() });
    if (res.status === 401) throw new Error(`${path} -> 401 (set LUT_DASH_USER / LUT_DASH_PASS)`);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
}

function fmtTokens(n: number): string {
    return Math.round(n).toLocaleString();
}
function pad(s: string, w: number): string {
    return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
function padL(s: string, w: number): string {
    return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

let summary: any;
let byModel: any[] = [];
try {
    summary = await get('/api/summary');
    if (by === 'model') byModel = await get('/api/by-model');
} catch (err: any) {
    console.error(`Could not reach server at ${serverUrl}: ${err.message}`);
    console.error('Is `cut-server` running? Try: bun run server/index.ts');
    process.exit(1);
}

if (wantJson) {
    console.log(JSON.stringify({ summary, byModel }, null, 2));
    process.exit(0);
}

const t = summary.totals || {};
const rangeLabel = days ? `last ${days} days` : 'all time';

console.log('');
console.log('  Claude Usage Tracker — ' + rangeLabel);
console.log('  ' + '─'.repeat(56));
const energyWh = t.energy_wh || 0;
const water = calculateWaterLiters(energyWh);
console.log(
    `  CO₂ ${formatCO2(t.co2_grams || 0)}   ·   Energy ${formatEnergy(energyWh)}   ·   ` +
        `Water ${formatWater(water)}~   ·   ${fmtTokens(t.tokens || 0)} tokens   ·   ` +
        `${t.sessions || 0} sessions   ·   ${t.users || 0} users`
);
const eq = equivalents(energyWh, t.co2_grams || 0, water);
const n = (x: number) => (x >= 10 ? Math.round(x).toLocaleString() : x.toFixed(1));
console.log(
    `  ≈ ${n(eq.milesDriven)} miles driven · ${n(eq.phoneCharges)} phone charges · ` +
        `${n(eq.cupsOfTea)} cups of tea · ${n(eq.waterBottles)} bottles of water`
);
console.log('');

if (by === 'model') {
    console.log('  By model');
    console.log('  ' + '─'.repeat(56));
    const nameW = Math.max(5, ...byModel.map((r) => String(r.model).length));
    for (const r of byModel) {
        console.log(
            `  ${pad(r.model, nameW)}  ${padL(formatCO2(r.co2_grams), 9)}  ` +
                `${padL(fmtTokens(r.tokens), 14)} tok  ${padL(String(r.sessions), 3)} sess` +
                (r.carbon_approx ? '  ~approx' : '')
        );
    }
} else {
    console.log('  By user');
    console.log('  ' + '─'.repeat(56));
    const rows = summary.byUser || [];
    const nameW = Math.max(4, ...rows.map((r: any) => String(r.name).length));
    for (const r of rows) {
        console.log(
            `  ${pad(r.name, nameW)}  ${padL(formatCO2(r.co2_grams), 9)}  ` +
                `${padL(formatEnergy(r.energy_wh), 11)}  ${padL(fmtTokens(r.tokens), 14)} tok  ` +
                `${padL(String(r.sessions), 3)} sess`
        );
    }
    if (!rows.length) console.log('  (no usage yet)');
}
console.log('');
