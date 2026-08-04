// Vanilla dashboard: fetch aggregates, draw hand-rolled SVG charts, live-refresh via SSE.

const SVGNS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#4ade80', '#38bdf8', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#34d399', '#60a5fa'];

const rangeEl = document.getElementById('range');

// Restore the previously selected range, if it's still a valid option.
const savedRange = localStorage.getItem('range');
if (savedRange && [...rangeEl.options].some((o) => o.value === savedRange)) {
    rangeEl.value = savedRange;
}
let days = Number(rangeEl.value);
let timeBy = localStorage.getItem('timeBy') === 'category' ? 'category' : 'user';

rangeEl.addEventListener('change', () => {
    days = Number(rangeEl.value);
    localStorage.setItem('range', rangeEl.value);
    refresh();
    // Keep an open drill-down in sync with the new range.
    if (currentUser && !modal.classList.contains('hidden')) {
        openUser(currentUser.id, currentUser.name);
    }
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
function fmtWater(l) {
    const ml = l * 1000;
    if (ml < 1) return '< 1 mL';
    if (l < 1) return Math.round(ml) + ' mL';
    if (l < 1000) return l.toFixed(2) + ' L';
    return (l / 1000).toFixed(2) + ' m³';
}

// Equivalence factors — mirror of shared/carbon-calculator.ts (kept inline because
// the dashboard is dependency-free vanilla JS served as a static file).
const MILES_PER_KG_CO2 = 22.4 / 8.887; // EPA: 22.4 mpg, 8.887 kg CO₂/gal
const WATER_L_PER_KWH = 1.8; // on-site cooling + off-site generation (approx)
const PHONE_CHARGE_WH = 12;
const KETTLE_CUP_WH = 32;
const WATER_BOTTLE_L = 0.5;

function waterLitres(energyWh) {
    return (energyWh / 1000) * WATER_L_PER_KWH;
}
function fmtNum(n) {
    if (n >= 100) return Math.round(n).toLocaleString();
    if (n >= 10) return n.toFixed(0);
    return n.toFixed(1);
}
// Human label for the selected range (supports fractional-day = hours).
function rangeLabel(d) {
    if (!d) return 'all time';
    if (d < 1) return `last ${Math.round(d * 24)} hours`;
    if (d === 1) return 'last 24 hours';
    return `last ${d} days`;
}
// Time-series bucket key -> short axis label. Hourly keys carry a 'T';
// monthly keys ('YYYY-MM', used for all-time/wide ranges) stay whole.
function fmtBucket(key) {
    if (key.includes('T')) return key.slice(11); // 'HH:00'
    if (key.length === 7) return key; // 'YYYY-MM'
    return key.slice(5); // 'MM-DD'
}

function qs(path) {
    return days ? `${path}?days=${days}` : path;
}

// Last successful payloads — kept so resize/toggles re-render without refetching.
let last = null;
const updatedEl = document.getElementById('updated');

function renderAll() {
    if (!last) return;
    renderCards(last.summary.totals);
    renderEquiv(last.summary.totals);
    renderProviders(last.summary.byProvider);
    renderUsers(last.summary.byUser);
    renderModelChart(last.byModel);
    renderCategoryChart(last.byCategory);
    if (timeBy === 'category') renderTimeChart(last.timeCat, null, 'category', categoryColor);
    else renderTimeChart(last.time, last.summary.byUser, 'user');
}

async function refresh() {
    try {
        const [summary, byModel, byCategory, time, timeCat] = await Promise.all([
            fetch(qs('/api/summary')).then((r) => r.json()),
            fetch(qs('/api/by-model')).then((r) => r.json()),
            fetch(qs('/api/by-category')).then((r) => r.json()),
            fetch(qs('/api/over-time')).then((r) => r.json()),
            fetch(qs('/api/over-time') + (days ? '&' : '?') + 'by=category').then((r) => r.json())
        ]);
        last = { summary, byModel, byCategory, time, timeCat };
        renderAll();
        if (updatedEl) {
            updatedEl.textContent = 'updated ' + new Date().toLocaleTimeString().slice(0, 5);
            updatedEl.classList.remove('stale');
        }
    } catch (err) {
        // Transient fetch failure (server restart etc.) — keep the last render
        // but mark it visibly stale.
        console.warn('refresh failed', err);
        if (updatedEl) updatedEl.classList.add('stale');
    }
}

// Coalesce bursts of SSE events into one refresh per second; hidden tabs just
// mark themselves dirty and catch up when they become visible again.
let refreshTimer = null;
let dirtyWhileHidden = false;
function scheduleRefresh() {
    if (document.hidden) {
        dirtyWhileHidden = true;
        return;
    }
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
    }, 1000);
}
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && dirtyWhileHidden) {
        dirtyWhileHidden = false;
        refresh();
    }
});

// Re-render charts (from cached data) when the window is resized.
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 200);
});

function renderCards(t) {
    const cards = [
        { label: 'Total CO₂', value: fmtCO2(t.co2_grams || 0), sub: 'estimated emissions' },
        { label: 'Energy', value: fmtEnergy(t.energy_wh || 0), sub: 'compute energy' },
        { label: 'Water', value: fmtWater(waterLitres(t.energy_wh || 0)), sub: 'cooling + generation ~' },
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

// Relatable comparisons computed from the totals.
function renderEquiv(t) {
    const co2 = t.co2_grams || 0;
    const energy = t.energy_wh || 0;
    const water = waterLitres(energy);
    if (!co2 && !energy) {
        document.getElementById('equiv').textContent = '';
        return;
    }
    const items = [
        `🚗 ${fmtNum((co2 / 1000) * MILES_PER_KG_CO2)} miles driven`,
        `📱 ${fmtNum(energy / PHONE_CHARGE_WH)} phone charges`,
        `🫖 ${fmtNum(energy / KETTLE_CUP_WH)} cups of tea boiled`,
        `💧 ${fmtNum(water / WATER_BOTTLE_L)} bottles of water`
    ];
    document.getElementById('equiv').innerHTML =
        '<span class="equiv-lead">Roughly equivalent to</span> ' + items.join('<span class="dot">·</span>');
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
                `<tr data-user-id="${escapeHtml(r.user_id)}" data-user-name="${escapeHtml(r.name)}" title="View ${escapeHtml(r.name)}'s breakdown">` +
                `<td><span class="swatch" style="background:${color}"></span>${escapeHtml(r.name)}</td>` +
                `<td>${escapeHtml(r.email)}</td>` +
                `<td class="num">${fmtInt(r.sessions)}</td>` +
                `<td class="num">${fmtTokens(r.tokens)}</td>` +
                `<td class="num">${fmtEnergy(r.energy_wh)}</td>` +
                `<td class="num">${fmtCO2(r.co2_grams)}</td></tr>`
            );
        })
        .join('');
}

// One delegated click listener survives every tbody rebuild.
document.querySelector('#user-table tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-user-id]');
    if (tr) openUser(tr.dataset.userId, tr.dataset.userName);
});

// --- Horizontal bar chart: tokens by model ---
function renderModelChart(rows, host = document.getElementById('chart-model')) {
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

// --- Horizontal bar chart: tokens by work type ---
// Colours keyed by category (not index) so they stay stable across ranges.
const CATEGORY_COLORS = {
    coding: PALETTE[0],
    debugging: PALETTE[5],
    'docs-writing': PALETTE[3],
    research: PALETTE[1],
    planning: PALETTE[4],
    other: '#8b97a6',
    unknown: '#4a5561'
};

function renderCategoryChart(rows, host = document.getElementById('chart-category')) {
    if (!rows || !rows.length) {
        host.innerHTML = `<div class="empty">No data</div>`;
        return;
    }
    const w = host.clientWidth || 380;
    const rowH = 30;
    const h = rows.length * rowH + 10;
    const max = Math.max(...rows.map((r) => r.tokens), 1);
    const labelW = 110;
    const barW = w - labelW - 70;

    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, height: h });
    rows.forEach((r, i) => {
        const y = i * rowH + 6;
        const len = Math.max((r.tokens / max) * barW, 2);
        svg.appendChild(el('text', { x: 0, y: y + 14, fill: '#8b97a6', 'font-size': 12 }, r.category));
        const rect = el('rect', {
            x: labelW, y, width: len, height: 18, rx: 4,
            fill: CATEGORY_COLORS[r.category] || CATEGORY_COLORS.other
        });
        rect.appendChild(el('title', {}, `${r.category}: ${fmtInt(r.sessions)} sessions · ${fmtTokens(r.tokens)} tok`));
        svg.appendChild(rect);
        svg.appendChild(
            el('text', { x: labelW + len + 8, y: y + 14, fill: '#e6edf3', 'font-size': 12 },
                fmtTokens(r.tokens))
        );
    });
    host.replaceChildren(svg);
}

function categoryColor(name) {
    return CATEGORY_COLORS[name] || CATEGORY_COLORS.other;
}

// --- Stacked bars over time: CO2 per bucket, stacked by user OR work type ---
function renderTimeChart(rows, users, keyField = 'user', colorFor = null) {
    const host = document.getElementById('chart-time');
    if (!rows || !rows.length) {
        host.innerHTML = `<div class="empty">No data</div>`;
        return;
    }
    const userColor = {};
    (users || []).forEach((u, i) => (userColor[u.name] = PALETTE[i % PALETTE.length]));
    const color = colorFor || ((name) => userColor[name] || '#60a5fa');

    // group by day -> {series: co2}
    const days = [...new Set(rows.map((r) => r.day))].sort();
    const byDay = {};
    for (const d of days) byDay[d] = {};
    let maxTotal = 0;
    for (const r of rows) {
        const key = r[keyField];
        byDay[r.day][key] = (byDay[r.day][key] || 0) + r.co2_grams;
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
        for (const [series, co2] of stacks) {
            const segH = (co2 / maxTotal) * plotH;
            yTop -= segH;
            const rect = el('rect', {
                x, y: yTop, width: barW, height: Math.max(segH, 0.5), rx: 2,
                fill: color(series)
            });
            rect.appendChild(
                el('title', {}, `${series} — ${d}: ${fmtCO2(co2)} ≈ ${fmtNum((co2 / 1000) * MILES_PER_KG_CO2)} mi driven`)
            );
            svg.appendChild(rect);
        }
        if (i % Math.ceil(days.length / 8) === 0 || days.length <= 8) {
            svg.appendChild(
                el('text', { x: x + barW / 2, y: h - 8, fill: '#8b97a6', 'font-size': 10,
                    'text-anchor': 'middle' }, fmtBucket(d))
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

// --- Per-user drill-down modal ---
const modal = document.getElementById('user-modal');
let currentUser = null; // {id, name} while the modal is open — re-fetched on range change

async function openUser(userId, fallbackName) {
    currentUser = { id: userId, name: fallbackName };
    document.getElementById('detail-name').textContent = fallbackName || 'User';
    document.getElementById('detail-sub').textContent = 'Loading…';
    document.getElementById('detail-model').innerHTML = '';
    document.getElementById('detail-category').innerHTML = '';
    document.getElementById('detail-time').innerHTML = '';
    document.querySelector('#detail-appdevice tbody').innerHTML = '';
    document.querySelector('#detail-sessions tbody').innerHTML = '';
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    let data;
    try {
        data = await fetch(qs(`/api/by-user/${encodeURIComponent(userId)}`)).then((r) => r.json());
    } catch {
        document.getElementById('detail-sub').textContent = 'Failed to load.';
        return;
    }

    const name = (data.user && data.user.name) || fallbackName || 'User';
    const email = (data.user && data.user.email) || '';
    document.getElementById('detail-name').textContent = name;
    const label = rangeLabel(days);
    document.getElementById('detail-sub').textContent = email ? `${email} · ${label}` : label;

    renderModelChart(data.models, document.getElementById('detail-model'));
    renderCategoryChart(data.categories, document.getElementById('detail-category'));
    renderUserTimeChart(data.overTime, document.getElementById('detail-time'));
    renderAppDevice(data.appDevice);
    renderUserSessions(data.sessions);
}

// App × device breakdown for one user (e.g. cowork × macOS).
function renderAppDevice(rows) {
    const tbody = document.querySelector('#detail-appdevice tbody');
    if (!rows || !rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty">No data in range.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows
        .map(
            (r) =>
                `<tr><td>${escapeHtml(r.surface || 'unknown')}</td>` +
                `<td>${escapeHtml(r.device_name || '—')}</td>` +
                `<td class="num">${fmtInt(r.sessions)}</td>` +
                `<td class="num">${fmtTokens(r.tokens)}</td>` +
                `<td class="num">${fmtWater(waterLitres(r.energy_wh))}</td>` +
                `<td class="num">${fmtCO2(r.co2_grams)}</td></tr>`
        )
        .join('');
}

// Per-day bar chart (single user): CO₂ height, tokens in tooltip.
function renderUserTimeChart(rows, host) {
    if (!rows || !rows.length) {
        host.innerHTML = `<div class="empty">No data</div>`;
        return;
    }
    const days_ = rows.map((r) => r.day);
    const max = Math.max(...rows.map((r) => r.co2_grams), 1);

    const w = host.clientWidth || 420;
    const h = 200;
    const padL = 46, padB = 26, padT = 10;
    const plotW = w - padL - 10;
    const plotH = h - padB - padT;
    const slot = plotW / days_.length;
    const barW = Math.min(slot * 0.6, 34);

    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, height: h });
    for (let g = 0; g <= 3; g++) {
        const val = (max / 3) * g;
        const y = padT + plotH - (val / max) * plotH;
        svg.appendChild(el('line', { x1: padL, y1: y, x2: w - 10, y2: y, stroke: '#2a323d' }));
        svg.appendChild(el('text', { x: 0, y: y + 4, fill: '#8b97a6', 'font-size': 11 }, fmtCO2(val)));
    }
    rows.forEach((r, i) => {
        const x = padL + i * slot + (slot - barW) / 2;
        const segH = (r.co2_grams / max) * plotH;
        const y = padT + plotH - segH;
        const rect = el('rect', {
            x, y, width: barW, height: Math.max(segH, 0.5), rx: 2, fill: PALETTE[1]
        });
        rect.appendChild(el('title', {}, `${r.day}: ${fmtCO2(r.co2_grams)} · ${fmtTokens(r.tokens)} tok`));
        svg.appendChild(rect);
        if (i % Math.ceil(days_.length / 8) === 0 || days_.length <= 8) {
            svg.appendChild(
                el('text', { x: x + barW / 2, y: h - 8, fill: '#8b97a6', 'font-size': 10,
                    'text-anchor': 'middle' }, fmtBucket(r.day))
            );
        }
    });
    host.replaceChildren(svg);
}

function renderUserSessions(rows) {
    const tbody = document.querySelector('#detail-sessions tbody');
    if (!rows || !rows.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty">No sessions in range.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows
        .map(
            (r) =>
                `<tr><td>${escapeHtml(String(r.started_at).slice(0, 16).replace('T', ' '))}</td>` +
                `<td>${escapeHtml(r.surface)}</td>` +
                `<td>${escapeHtml(r.device_name || '—')}</td>` +
                `<td>${escapeHtml(shortModel(r.primary_model))}</td>` +
                `<td>${escapeHtml(r.category || 'unknown')}</td>` +
                `<td class="num">${fmtTokens(r.total_tokens)}</td>` +
                `<td class="num">${fmtWater(waterLitres(r.energy_wh))}</td>` +
                `<td class="num">${fmtCO2(r.co2_grams)}</td></tr>`
        )
        .join('');
}

function closeModal() {
    currentUser = null;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}
modal.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', closeModal));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
});

// --- Live updates ---
const liveEl = document.getElementById('live');
function connectSSE() {
    const es = new EventSource('/events');
    es.addEventListener('session', () => {
        liveEl.classList.add('flash');
        setTimeout(() => liveEl.classList.remove('flash'), 300);
        scheduleRefresh();
    });
    es.onopen = () => liveEl.classList.remove('off');
    es.onerror = () => liveEl.classList.add('off');
}

// Time-chart series toggle (by user / by work type).
const timeByEl = document.getElementById('time-by');
if (timeByEl) {
    timeByEl.value = timeBy;
    timeByEl.addEventListener('change', () => {
        timeBy = timeByEl.value;
        localStorage.setItem('timeBy', timeBy);
        renderAll();
    });
}

refresh();
connectSSE();
