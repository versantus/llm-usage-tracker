// Vanilla dashboard: fetch aggregates, draw hand-rolled SVG charts, live-refresh via SSE.

const SVGNS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#4ade80', '#38bdf8', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#34d399', '#60a5fa'];

const rangeEl = document.getElementById('range');
let days = Number(rangeEl.value);

rangeEl.addEventListener('change', () => {
    days = Number(rangeEl.value);
    refresh();
});

function fmtInt(n) {
    return Math.round(n).toLocaleString();
}
function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
}
function fmtCO2(g) {
    if (g >= 1000) return (g / 1000).toFixed(2) + ' kg';
    return g.toFixed(1) + ' g';
}
function fmtEnergy(wh) {
    if (wh >= 1000) return (wh / 1000).toFixed(2) + ' kWh';
    return wh.toFixed(1) + ' Wh';
}

function qs(path) {
    return days ? `${path}?days=${days}` : path;
}

async function refresh() {
    const [summary, byModel, time] = await Promise.all([
        fetch(qs('/api/summary')).then((r) => r.json()),
        fetch(qs('/api/by-model')).then((r) => r.json()),
        fetch(qs('/api/over-time')).then((r) => r.json())
    ]);
    renderCards(summary.totals);
    renderProviders(summary.byProvider);
    renderUsers(summary.byUser);
    renderModelChart(byModel);
    renderTimeChart(time, summary.byUser);
}

function renderCards(t) {
    const cards = [
        { label: 'Total CO₂', value: fmtCO2(t.co2_grams || 0), sub: 'estimated emissions' },
        { label: 'Energy', value: fmtEnergy(t.energy_wh || 0), sub: 'compute energy' },
        { label: 'Tokens', value: fmtTokens(t.tokens || 0), sub: `${fmtInt(t.sessions || 0)} sessions` },
        { label: 'Users', value: fmtInt(t.users || 0), sub: 'tracked' }
    ];
    document.getElementById('cards').innerHTML = cards
        .map(
            (c) =>
                `<div class="card"><div class="label">${c.label}</div>` +
                `<div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>`
        )
        .join('');
}

function renderProviders(rows) {
    if (!rows || !rows.length) {
        document.getElementById('providers').textContent = '';
        return;
    }
    document.getElementById('providers').textContent =
        'Providers: ' +
        rows.map((r) => `${r.provider} (${fmtTokens(r.tokens)} tok)`).join(' · ') +
        ' —';
}

function renderUsers(rows) {
    const tbody = document.querySelector('#user-table tbody');
    if (!rows || !rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty">No usage yet. Run a session or POST to /ingest.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows
        .map((r, i) => {
            const color = PALETTE[i % PALETTE.length];
            return (
                `<tr><td><span class="swatch" style="background:${color}"></span>${escapeHtml(r.name)}</td>` +
                `<td>${escapeHtml(r.email)}</td>` +
                `<td class="num">${fmtInt(r.sessions)}</td>` +
                `<td class="num">${fmtTokens(r.tokens)}</td>` +
                `<td class="num">${fmtEnergy(r.energy_wh)}</td>` +
                `<td class="num">${fmtCO2(r.co2_grams)}</td></tr>`
            );
        })
        .join('');
}

// --- Horizontal bar chart: tokens by model ---
function renderModelChart(rows) {
    const host = document.getElementById('chart-model');
    if (!rows || !rows.length) {
        host.innerHTML = `<div class="empty">No data</div>`;
        return;
    }
    const w = host.clientWidth || 380;
    const rowH = 30;
    const h = rows.length * rowH + 10;
    const max = Math.max(...rows.map((r) => r.tokens), 1);
    const labelW = 130;
    const barW = w - labelW - 70;

    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, height: h });
    rows.forEach((r, i) => {
        const y = i * rowH + 6;
        const len = Math.max((r.tokens / max) * barW, 2);
        svg.appendChild(
            el('text', { x: 0, y: y + 14, fill: '#8b97a6', 'font-size': 12 }, shortModel(r.model))
        );
        svg.appendChild(
            el('rect', {
                x: labelW, y, width: len, height: 18, rx: 4,
                fill: PALETTE[i % PALETTE.length]
            })
        );
        svg.appendChild(
            el('text', { x: labelW + len + 8, y: y + 14, fill: '#e6edf3', 'font-size': 12 },
                fmtTokens(r.tokens) + (r.carbon_approx ? ' ~' : ''))
        );
    });
    host.replaceChildren(svg);
}

// --- Stacked area-ish bars: CO2 per day, stacked by user ---
function renderTimeChart(rows, users) {
    const host = document.getElementById('chart-time');
    if (!rows || !rows.length) {
        host.innerHTML = `<div class="empty">No data</div>`;
        return;
    }
    const userColor = {};
    (users || []).forEach((u, i) => (userColor[u.name] = PALETTE[i % PALETTE.length]));

    // group by day -> {user: co2}
    const days = [...new Set(rows.map((r) => r.day))].sort();
    const byDay = {};
    for (const d of days) byDay[d] = {};
    let maxTotal = 0;
    for (const r of rows) {
        byDay[r.day][r.user] = (byDay[r.day][r.user] || 0) + r.co2_grams;
    }
    for (const d of days) {
        const total = Object.values(byDay[d]).reduce((a, b) => a + b, 0);
        if (total > maxTotal) maxTotal = total;
    }
    maxTotal = maxTotal || 1;

    const w = host.clientWidth || 520;
    const h = 220;
    const padL = 46, padB = 28, padT = 10;
    const plotW = w - padL - 10;
    const plotH = h - padB - padT;
    const slot = plotW / days.length;
    const barW = Math.min(slot * 0.6, 36);

    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, height: h });

    // y gridlines
    for (let g = 0; g <= 3; g++) {
        const val = (maxTotal / 3) * g;
        const y = padT + plotH - (val / maxTotal) * plotH;
        svg.appendChild(el('line', { x1: padL, y1: y, x2: w - 10, y2: y, stroke: '#2a323d' }));
        svg.appendChild(el('text', { x: 0, y: y + 4, fill: '#8b97a6', 'font-size': 11 }, fmtCO2(val)));
    }

    days.forEach((d, i) => {
        const x = padL + i * slot + (slot - barW) / 2;
        let yTop = padT + plotH;
        const stacks = Object.entries(byDay[d]).sort((a, b) => b[1] - a[1]);
        for (const [user, co2] of stacks) {
            const segH = (co2 / maxTotal) * plotH;
            yTop -= segH;
            const rect = el('rect', {
                x, y: yTop, width: barW, height: Math.max(segH, 0.5), rx: 2,
                fill: userColor[user] || '#60a5fa'
            });
            rect.appendChild(el('title', {}, `${user} — ${d}: ${fmtCO2(co2)}`));
            svg.appendChild(rect);
        }
        if (i % Math.ceil(days.length / 8) === 0 || days.length <= 8) {
            svg.appendChild(
                el('text', { x: x + barW / 2, y: h - 8, fill: '#8b97a6', 'font-size': 10,
                    'text-anchor': 'middle' }, d.slice(5))
            );
        }
    });

    host.replaceChildren(svg);
}

function shortModel(m) {
    return m.replace(/^claude-/, '').replace(/-\d{8}$/, '').slice(0, 22);
}
function el(tag, attrs, text) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- Live updates ---
const liveEl = document.getElementById('live');
function connectSSE() {
    const es = new EventSource('/events');
    es.addEventListener('session', () => {
        liveEl.classList.add('flash');
        setTimeout(() => liveEl.classList.remove('flash'), 300);
        refresh();
    });
    es.onopen = () => liveEl.classList.remove('off');
    es.onerror = () => liveEl.classList.add('off');
}

refresh();
connectSSE();
