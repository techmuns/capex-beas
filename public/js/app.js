// public/js/app.js
// Loads the committed JSON and renders the three tabs. Visual-first, layperson
// friendly, and always source-backed (every row shows the verbatim quote + a
// link to the official filing). Degrades to a friendly empty state when there's
// no data yet — it never invents numbers.

import {
  h, esc as escHtml, fmtCr, fmtCrAxis, fmtSignedCr, fmtPct, fmtDate, fmtMktCap, fmtPE, weekOf, debounce,
  emptyState, newChart, disposeCharts, resizeCharts, icons,
  eventTypeStyle, CHART, SEMANTIC, PALETTE,
} from './ui.js';
import { downloadExcel } from './excel.js';

// h() inserts string children as TEXT NODES (already XSS-safe), which do NOT
// decode HTML entities — so text-node content must NOT be HTML-escaped, or an
// "&" in a name/industry shows as a literal "&amp;". `esc` here just stringifies
// for text children; use `escHtml` only when building an HTML string (e.g. an
// ECharts tooltip set via innerHTML).
const esc = (s) => (s == null ? '' : String(s));

// ?demo=1 loads a local, git-ignored fixture so the POPULATED layout can be
// eyeballed. The shipped data files stay empty; nothing fake is ever committed.
const DEMO = new URLSearchParams(location.search).has('demo');
const BASE = DEMO ? './demo' : './data';

const state = { changes: [], history: {}, metadata: null, enrichment: {} };

// ---- data ----------------------------------------------------------------
async function loadJSON(path, fallback) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return fallback;
    const j = await r.json();
    return j ?? fallback;
  } catch { return fallback; }
}

async function loadData() {
  const [changes, history, metadata, enrichment] = await Promise.all([
    loadJSON(`${BASE}/capex-changes.json`, []),
    loadJSON(`${BASE}/capex-history.json`, {}),
    loadJSON(`${BASE}/metadata.json`, null),
    loadJSON(`${BASE}/company-enrichment.json`, {}),
  ]);
  state.changes = Array.isArray(changes) ? changes : [];
  state.history = (history && typeof history === 'object') ? history : {};
  state.metadata = metadata;
  state.enrichment = (enrichment && typeof enrichment === 'object') ? enrichment : {};
}

// External market context for a scrip (industry / market cap / P/E), or null.
// This is auxiliary "approx" data — never confused with source-backed capex.
const enrichOf = (scrip) => state.enrichment[String(scrip)] || null;

// Tiny transient toast (used by the Excel download button).
function toast(msg) {
  const t = h('div', { style: 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#14152A;color:#fff;padding:10px 16px;border-radius:12px;font-size:13px;font-weight:600;box-shadow:0 12px 30px rgba(0,0,0,.25);z-index:60;opacity:0;transition:opacity .2s;max-width:90vw;text-align:center' }, msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 2800);
}

const realChanges = () => state.changes.filter((c) => !c.no_prior_on_record);
const baselines = () => state.changes.filter((c) => c.no_prior_on_record);
const changeTime = (c) => new Date(c.new_date || c.detected_at).getTime();
const withinDays = (c, days) => days === Infinity || (Number.isFinite(changeTime(c)) && changeTime(c) >= Date.now() - days * 864e5);
const hasAnyData = () => state.changes.length > 0 || Object.keys(state.history).length > 0;

// ---- small shared UI bits ------------------------------------------------
function fyChip(fy) {
  return h('span', { class: 'pill', style: 'background:#F1EEFE;color:#6D28D9' }, fy || 'year n/a');
}

function dirPill(direction, pct) {
  const up = direction === 'up';
  const color = up ? SEMANTIC.up : SEMANTIC.down;
  const bg = up ? 'rgba(16,185,129,.12)' : 'rgba(244,63,94,.12)';
  return h('span', { class: 'pill num', style: `background:${bg};color:${color}` },
    h('i', { 'data-lucide': up ? 'trending-up' : 'trending-down', style: 'width:14px;height:14px' }),
    fmtPct(pct));
}

// Expandable "show the exact words from the filing" section.
function quoteToggle(quotes) {
  const body = h('div', { class: 'mt-3 hidden' },
    ...quotes.filter((q) => q && q.text).map((q) =>
      h('div', { class: 'mb-2' },
        q.label && h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:4px' }, q.label),
        h('div', { class: 'quote' }, `“${q.text}”`))));
  const btn = h('button', { class: 'btn-quote mt-3' },
    h('i', { 'data-lucide': 'quote', style: 'width:14px;height:14px' }),
    'Show the exact words from the filing');
  btn.addEventListener('click', () => {
    const open = !body.classList.toggle('hidden');
    btn.lastChild.textContent = open ? 'Hide the exact words' : 'Show the exact words from the filing';
  });
  return h('div', {}, btn, body);
}

function filingLink(url, label = 'See the official filing') {
  if (!url) return null;
  return h('a', { class: 'btn-link', href: url, target: '_blank', rel: 'noopener' },
    h('i', { 'data-lucide': 'file-text', style: 'width:14px;height:14px' }), label,
    h('i', { 'data-lucide': 'arrow-up-right', style: 'width:13px;height:13px' }));
}

// Colored canonical "Type" chip (event_type). Distinct color per category.
function typeChip(t) {
  if (!t) return null;
  const s = eventTypeStyle(t);
  return h('span', { class: 'pill', style: `background:${s.bg};color:${s.color}` },
    h('i', { 'data-lucide': s.icon, style: 'width:13px;height:13px' }), t);
}

// Neutral industry chip (external context, visually quieter than the capex data).
function industryChip(ind) {
  if (!ind) return null;
  return h('span', { class: 'pill', style: 'background:#F8FAFC;color:#475569;border:1px solid var(--line)' },
    h('i', { 'data-lucide': 'layers', style: 'width:12px;height:12px' }), ind);
}

// Market cap / P/E as small muted context. An "APPROX" badge + italic mono make
// it unmistakably distinct from the bold, source-backed capex figures.
function approxContext(e) {
  if (!e || (e.market_cap_cr == null && e.pe == null)) return null;
  const bits = [];
  if (e.market_cap_cr != null) bits.push(`Mkt cap ${fmtMktCap(e.market_cap_cr)}`);
  if (e.pe != null) bits.push(`P/E ${fmtPE(e.pe)}`);
  if (e.as_of) bits.push(`as of ${fmtDate(e.as_of)}`);
  return h('div', { class: 'mt-2 flex items-center gap-1.5', style: 'flex-wrap:wrap' },
    h('span', { class: 'pill', style: 'background:#F1F5F9;color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 8px' }, 'APPROX'),
    h('span', { class: 'num', style: 'font-size:11.5px;color:var(--muted);font-style:italic' }, bits.join('  ·  ')),
    e.source_url ? h('a', { href: e.source_url, target: '_blank', rel: 'noopener', style: 'font-size:11px;color:#A855F7' }, 'source') : null);
}

// ---- tab: OVERVIEW -------------------------------------------------------
function renderOverview() {
  const el = document.getElementById('panel-overview');
  el.innerHTML = '';
  const changes = realChanges();

  if (!hasAnyData()) {
    el.append(emptyState({
      icon: 'sparkles',
      title: 'The monitor is live and building history',
      msg: 'Capex changes will appear here as companies file them. Every figure is backed by the company’s own words and a link to the official filing — we never show sample or estimated data.',
    }));
    return;
  }

  const recent = changes.filter((c) => withinDays(c, 30));
  const set = recent.length ? recent : changes;
  const windowLabel = recent.length ? 'last 30 days' : 'all time';
  const companies = new Set(set.map((c) => c.scrip_cd)).size;
  const tracked = state.metadata?.counts?.companies_tracked ?? Object.keys(state.history).length;

  // Hero (one plain sentence) + two small chips only — no KPI wall.
  const chip = (v, l) => h('div', { class: 'chip text-center' },
    h('div', { class: 'num text-xl font-bold' }, v),
    h('div', { style: 'font-size:11px;color:var(--muted)' }, l));
  const hero = h('div', { class: 'card', style: 'padding:26px 28px' },
    h('div', { class: 'flex flex-wrap items-start justify-between gap-4' },
      h('h2', { class: 'font-display text-2xl sm:text-3xl font-bold leading-snug', style: 'max-width:52rem' },
        changes.length
          ? `${companies} ${companies === 1 ? 'company' : 'companies'} changed their capex plans (${windowLabel}).`
          : `Tracking capex plans across ${tracked} ${tracked === 1 ? 'company' : 'companies'} — no revisions yet.`),
      h('div', { class: 'flex gap-2.5' },
        chip(String(tracked), 'companies tracked'),
        changes.length ? chip(String(changes.length), 'capex changes') : chip(String(baselines().length), 'first readings'))));
  el.append(hero);

  if (!changes.length) {
    // No revisions yet — don't show an empty card. Show the latest first-time
    // capex readings so the page still answers "what have we seen so far?".
    const recentBase = [...baselines()].sort((a, b) => changeTime(b) - changeTime(a)).slice(0, 10);
    el.append(h('div', { class: 'mt-6 mb-2 flex items-center justify-between flex-wrap gap-2' },
      h('h3', { class: 'font-display font-bold', style: 'font-size:16px' }, 'Latest capex readings'),
      h('span', { style: 'font-size:12px;color:var(--muted)' }, 'the first capex figure we’ve seen for each — a change is flagged when it’s later revised')));
    el.append(recentBase.length
      ? miniReadingsTable(recentBase)
      : h('div', { class: 'card', style: 'padding:24px;text-align:center;color:var(--muted)' }, 'Readings will appear here as companies file.'));
    icons();
    return;
  }

  // Row: biggest movers (2/3) + donut & biggest-mover highlight (1/3)
  const grid = h('div', { class: 'grid grid-cols-1 lg:grid-cols-3 gap-5 mt-5' });

  const moversCard = h('div', { class: 'card lg:col-span-2', style: 'padding:20px 22px' },
    h('div', { class: 'flex items-center justify-between mb-1' },
      h('h3', { class: 'font-display font-bold' }, 'Biggest changes in plans'),
      h('span', { style: 'font-size:12px;color:var(--muted)' }, `by ₹ change · ${windowLabel}`)),
    h('div', { class: 'chart-md', id: 'chart-movers' }));
  const donutCard = h('div', { class: 'card', style: 'padding:20px 22px' },
    h('h3', { class: 'font-display font-bold mb-1' }, 'Up vs down'),
    h('div', { class: 'chart-sm', id: 'chart-donut' }));

  // biggest mover highlight
  const top = [...set].filter((c) => c.delta_cr != null).sort((a, b) => Math.abs(b.delta_cr) - Math.abs(a.delta_cr))[0];
  const highlight = top ? h('div', { class: 'card card-hover mt-5', style: `padding:18px 20px;border-left:5px solid ${top.direction === 'up' ? SEMANTIC.up : SEMANTIC.down}` },
    h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)' }, 'Biggest mover'),
    h('div', { class: 'font-display font-bold text-lg mt-1' }, esc(top.company)),
    h('div', { class: 'num mt-1', style: 'font-size:15px' },
      `${fmtCr(top.old_cr)} → `, h('b', { style: `color:${top.direction === 'up' ? SEMANTIC.up : SEMANTIC.down}` }, fmtCr(top.new_cr))),
    h('div', { class: 'mt-1.5' }, dirPill(top.direction, top.pct_change), ' ', h('span', { style: 'font-size:12px;color:var(--muted)' }, top.fiscal_year)),
    filingLink(top.new_pdf) && h('div', { class: 'mt-3' }, filingLink(top.new_pdf))) : null;

  grid.append(moversCard, h('div', {}, donutCard, highlight));
  el.append(grid);
  icons();

  drawMovers(set);
  drawDonut(set);
}

function drawMovers(set) {
  const top = [...set].filter((c) => c.delta_cr != null)
    .sort((a, b) => Math.abs(b.delta_cr) - Math.abs(a.delta_cr)).slice(0, 10)
    .sort((a, b) => a.delta_cr - b.delta_cr); // ascending so biggest hike sits on top
  if (!top.length) { document.getElementById('chart-movers').innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px">No sized changes yet.</p>'; return; }
  newChart(document.getElementById('chart-movers'), {
    grid: { left: 8, right: 24, top: 10, bottom: 8, containLabel: true },
    tooltip: {
      ...CHART.tooltip('#8B5CF6'),
      formatter: (p) => {
        const c = top[p.dataIndex];
        return `<b>${escHtml(c.company)}</b> · ${escHtml(c.fiscal_year || '')}<br/>`
          + `<span style="font-family:JetBrains Mono">${fmtCr(c.old_cr)} → ${fmtCr(c.new_cr)}</span><br/>`
          + `<span style="color:${c.direction === 'up' ? SEMANTIC.up : SEMANTIC.down};font-weight:700">${fmtSignedCr(c.delta_cr)} (${fmtPct(c.pct_change)})</span>`;
      },
    },
    xAxis: { type: 'value', axisLabel: { ...CHART.axisLabel, formatter: (v) => fmtCrAxis(v) }, splitLine: CHART.splitLine, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: {
      type: 'category',
      data: top.map((c) => (c.company.length > 18 ? c.company.slice(0, 17) + '…' : c.company)),
      axisLabel: { color: '#4b4d63', fontFamily: 'Inter', fontSize: 12 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    series: [{
      type: 'bar', data: top.map((c) => c.delta_cr),
      barWidth: '62%',
      itemStyle: { borderRadius: 6, color: (p) => (p.value >= 0 ? SEMANTIC.up : SEMANTIC.down) },
    }],
  });
}

function drawDonut(set) {
  const up = set.filter((c) => c.direction === 'up').length;
  const down = set.filter((c) => c.direction === 'down').length;
  newChart(document.getElementById('chart-donut'), {
    tooltip: { ...CHART.tooltip('#8B5CF6'), formatter: (p) => `<b>${p.name}</b><br/>${p.value} ${p.value === 1 ? 'change' : 'changes'} (${p.percent}%)` },
    legend: { bottom: 0, icon: 'circle', textStyle: { color: '#4b4d63', fontFamily: 'Inter' } },
    series: [{
      type: 'pie', radius: ['48%', '72%'], center: ['50%', '44%'], avoidLabelOverlap: true,
      itemStyle: { borderColor: '#fff', borderWidth: 3, borderRadius: 6 },
      label: { show: true, position: 'center', formatter: `${up + down}\nchanges`, fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 20, color: '#14152A' },
      data: [
        { name: 'Increased', value: up, itemStyle: { color: SEMANTIC.up } },
        { name: 'Decreased', value: down, itemStyle: { color: SEMANTIC.down } },
      ],
    }],
  });
}

// Compact, read-only table of first capex readings for the Overview zero-state.
function miniReadingsTable(rows) {
  const hasInd = rows.some((c) => industryOf(c));
  const heads = ['Company', hasInd ? 'Industry' : null, 'Type', 'Capex (₹Cr)', 'Date', 'Filing'].filter(Boolean);
  const table = h('table', { class: 'tbl' });
  table.append(h('thead', {}, h('tr', {}, ...heads.map((t) => h('th', {}, t)))));
  const tb = h('tbody');
  for (const c of rows) {
    tb.append(h('tr', {},
      h('td', {}, h('b', {}, esc(c.company))),
      hasInd ? h('td', { style: 'color:#475569' }, industryOf(c) ? esc(industryOf(c)) : '') : null,
      h('td', {}, typeChip(c.event_type) || ''),
      h('td', { class: 'num font-bold' }, fmtCr(c.new_cr)),
      h('td', { class: 'num', style: 'color:var(--muted)' }, fmtDate(c.new_date)),
      h('td', {}, c.new_pdf ? h('a', { class: 'btn-link', href: c.new_pdf, target: '_blank', rel: 'noopener', style: 'padding:5px 9px' }, h('i', { 'data-lucide': 'file-text', style: 'width:13px;height:13px' }), 'open') : '')));
  }
  table.append(tb);
  return h('div', { class: 'card', style: 'padding:8px 6px;overflow-x:auto' }, table);
}

// ---- tab: CHANGES --------------------------------------------------------
const changesUI = { window: 30, direction: 'all', industry: 'all', type: 'all', week: 'all', q: '', view: 'table', sort: { key: 'date', dir: 'desc' } };

const industryOf = (c) => enrichOf(c.scrip_cd)?.industry || '';
// A change's week key (Monday YYYYMMDD) from its display date.
const weekKeyOf = (c) => weekOf(c.new_date || c.detected_at)?.key || '';

function filteredChanges() {
  const q = changesUI.q.trim().toLowerCase();
  return state.changes.filter((c) => {
    // A specific week is authoritative — it overrides the rolling time window
    // so "pick a week → see/download exactly that week" always works.
    if (changesUI.week !== 'all') { if (weekKeyOf(c) !== changesUI.week) return false; }
    else if (!withinDays(c, changesUI.window)) return false;
    if (changesUI.direction === 'up' && !(c.direction === 'up' && !c.no_prior_on_record)) return false;
    if (changesUI.direction === 'down' && !(c.direction === 'down' && !c.no_prior_on_record)) return false;
    if (changesUI.industry !== 'all' && industryOf(c) !== changesUI.industry) return false;
    if (changesUI.type !== 'all' && (c.event_type || '') !== changesUI.type) return false;
    if (q && !(c.company || '').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => changeTime(b) - changeTime(a));
}

// Distinct dropdown option values present across all changes (so filters only
// ever offer values that exist in the data).
const distinctIndustries = () => [...new Set(state.changes.map(industryOf).filter(Boolean))].sort();
const distinctTypes = () => [...new Set(state.changes.map((c) => c.event_type).filter(Boolean))].sort();
// Available weeks, newest first, as { key, label }.
function distinctWeeks() {
  const seen = new Map();
  for (const c of state.changes) {
    const w = weekOf(c.new_date || c.detected_at);
    if (w && !seen.has(w.key)) seen.set(w.key, w.label);
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([key, label]) => ({ key, label }));
}

// Map a change row -> a flat, fully-resolved row for the Excel/CSV export.
function toExportRow(c) {
  const e = enrichOf(c.scrip_cd) || {};
  const real = !c.no_prior_on_record;
  const plain = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  let summary;
  if (c.reason) summary = c.reason;
  else if (real) summary = `${c.direction === 'up' ? 'Raised' : 'Cut'} ${c.fiscal_year || ''} capex from ${plain(c.old_cr)} to ${plain(c.new_cr)} Cr`.replace(/\s+/g, ' ').trim();
  else summary = `First ${c.fiscal_year || ''} capex reading: ${plain(c.new_cr)} Cr`.replace(/\s+/g, ' ').trim();
  return {
    company: c.company || '',
    scrip_cd: c.scrip_cd ?? '',
    date: c.new_date || null,
    week: c.week || weekOf(c.new_date || c.detected_at)?.label || '',
    event_type: c.event_type || '',
    summary,
    capex_cr: c.new_cr ?? null,
    old_new: real ? `${plain(c.old_cr)} → ${plain(c.new_cr)}` : (c.new_cr != null ? `— → ${plain(c.new_cr)}` : '—'),
    pct: (c.pct_change == null ? null : c.pct_change / 100), // fraction; Excel % format renders it
    direction: real ? (c.direction || '') : 'first reading',
    market_cap_cr: e.market_cap_cr ?? null,
    pe: e.pe ?? null,
    industry: e.industry || '',
    source: c.new_pdf || '',
    is_change: real,
  };
}

function renderChanges() {
  const el = document.getElementById('panel-changes');
  el.innerHTML = '';

  if (!hasAnyData()) {
    el.append(emptyState({
      icon: 'bell',
      title: 'No capex changes yet',
      msg: 'This is the live feed of every capex plan change. As companies file, each change will appear here — newest first — with the old plan, the new plan, the reason, and a one-click link to verify it in the official document.',
    }));
    return;
  }

  // controls
  const sel = (label, id, opts) => h('label', { class: 'flex flex-col gap-1' },
    h('span', { style: 'font-size:11px;font-weight:600;color:var(--muted)' }, label),
    h('select', { class: 'select', id }, ...opts.map((o) => h('option', { value: o.v, selected: o.sel }, o.t))));

  const weeks = distinctWeeks();
  const controls = h('div', { class: 'card', style: 'padding:16px 18px' },
    h('div', { class: 'flex flex-wrap items-end gap-3' },
      weeks.length ? sel('Week', 'f-week', [
        { v: 'all', t: 'All time', sel: true }, ...weeks.map((w) => ({ v: w.key, t: w.label }))]) : null,
      sel('Time window', 'f-window', [
        { v: '1', t: 'Today' }, { v: '7', t: 'Last 7 days' },
        { v: '30', t: 'Last 30 days', sel: true }, { v: '90', t: 'Last 90 days' }, { v: 'all', t: 'All time' }]),
      sel('Direction', 'f-dir', [
        { v: 'all', t: 'All changes', sel: true }, { v: 'up', t: 'Increased' }, { v: 'down', t: 'Decreased' }]),
      distinctTypes().length ? sel('Type', 'f-type', [
        { v: 'all', t: 'All types', sel: true }, ...distinctTypes().map((t) => ({ v: t, t }))]) : null,
      distinctIndustries().length ? sel('Industry', 'f-industry', [
        { v: 'all', t: 'All industries', sel: true }, ...distinctIndustries().map((i) => ({ v: i, t: i }))]) : null,
      h('label', { class: 'flex flex-col gap-1 grow', style: 'min-width:180px' },
        h('span', { style: 'font-size:11px;font-weight:600;color:var(--muted)' }, 'Search company'),
        h('input', { class: 'search', id: 'f-q', type: 'search', placeholder: 'e.g. ASK Automotive', value: changesUI.q })),
      h('div', { class: 'flex rounded-xl overflow-hidden', style: 'border:1px solid var(--line)' },
        h('button', { class: 'view-btn', id: 'v-cards', dataset: { view: 'cards' } }, 'Cards'),
        h('button', { class: 'view-btn', id: 'v-table', dataset: { view: 'table' } }, 'Table'))));
  el.append(controls);

  const headline = h('div', { class: 'mt-5', id: 'changes-headline' });
  el.append(headline);
  const feed = h('div', { class: 'mt-3', id: 'changes-feed' });
  el.append(feed);

  // wire controls
  controls.querySelector('#f-window').value = String(changesUI.window === Infinity ? 'all' : changesUI.window);
  controls.querySelector('#f-dir').value = changesUI.direction;
  controls.querySelector('#f-window').addEventListener('change', (e) => { changesUI.window = e.target.value === 'all' ? Infinity : Number(e.target.value); drawFeed(); });
  controls.querySelector('#f-dir').addEventListener('change', (e) => { changesUI.direction = e.target.value; drawFeed(); });
  const weekSel = controls.querySelector('#f-week');
  if (weekSel) { weekSel.value = changesUI.week; weekSel.addEventListener('change', (e) => { changesUI.week = e.target.value; drawFeed(); }); }
  const typeSel = controls.querySelector('#f-type');
  if (typeSel) { typeSel.value = changesUI.type; typeSel.addEventListener('change', (e) => { changesUI.type = e.target.value; drawFeed(); }); }
  const indSel = controls.querySelector('#f-industry');
  if (indSel) { indSel.value = changesUI.industry; indSel.addEventListener('change', (e) => { changesUI.industry = e.target.value; drawFeed(); }); }
  controls.querySelector('#f-q').addEventListener('input', debounce((e) => { changesUI.q = e.target.value; drawFeed(); }, 180));
  for (const b of controls.querySelectorAll('.view-btn')) {
    b.style.cssText = 'padding:8px 14px;font-size:13px;font-weight:600;background:#fff;border:none;cursor:pointer;color:var(--muted)';
    b.addEventListener('click', () => { changesUI.view = b.dataset.view; syncViewButtons(controls); drawFeed(); });
  }
  syncViewButtons(controls);
  drawFeed();
  icons();
}

function syncViewButtons(root) {
  for (const b of root.querySelectorAll('.view-btn')) {
    const active = b.dataset.view === changesUI.view;
    b.style.background = active ? 'linear-gradient(90deg,var(--i1),var(--i2))' : '#fff';
    b.style.color = active ? '#fff' : 'var(--muted)';
  }
}

function drawFeed() {
  const feed = document.getElementById('changes-feed');
  const head = document.getElementById('changes-headline');
  if (!feed) return;
  const rows = filteredChanges();
  const real = rows.filter((c) => !c.no_prior_on_record);
  const base = rows.filter((c) => c.no_prior_on_record);
  feed.innerHTML = '';
  if (head) head.innerHTML = '';

  if (!rows.length) {
    if (head) head.append(sectionHeadline('No matches', 'Nothing matches these filters yet.'));
    feed.append(h('div', { class: 'card', style: 'padding:28px;text-align:center;color:var(--muted)' },
      'Try a wider time window, a different week, or clear the search.'));
    return;
  }

  if (real.length) {
    // Lead with the real capex-plan CHANGES.
    const nCo = new Set(real.map((c) => c.scrip_cd)).size;
    if (head) head.append(sectionHeadline(
      `${nCo} ${nCo === 1 ? 'company' : 'companies'} changed their capex plans`,
      'A change is flagged when a company revises how much it plans to spend. Newest first — every figure links its BSE filing.'));
    feed.append(changesUI.view === 'cards' ? cardsView(real) : tableView(real));
    if (base.length) feed.append(firstReadingsSection(base));
  } else {
    // No real changes in view — show a friendly line + the first readings as a
    // simple list, never a blank table.
    if (head) head.append(sectionHeadline(
      'No capex plan changes in this view yet',
      `Here ${base.length === 1 ? 'is' : 'are'} the ${base.length} first-time capex reading${base.length === 1 ? '' : 's'} we’ve recorded — the baseline we compare against when a company next revises its plan.`));
    feed.append(changesUI.view === 'cards' ? cardsView(base) : tableView(base));
  }
  icons();
}

// A plain-English section headline + one-line explainer.
function sectionHeadline(title, sub) {
  return h('div', {},
    h('h2', { class: 'font-display', style: 'font-size:20px;font-weight:700;line-height:1.2' }, title),
    sub ? h('p', { style: 'font-size:13px;color:var(--muted);margin-top:4px;max-width:52rem' }, sub) : null);
}

// Collapsible "first readings" section, kept out of the main changes list.
function firstReadingsSection(base) {
  const wrap = h('div', { class: 'mt-6' });
  const label = () => `Show ${base.length} first reading${base.length === 1 ? '' : 's'}`;
  const body = h('div', { class: 'mt-3 hidden' }, tableView(base));
  const txt = h('span', {}, label());
  const btn = h('button', { class: 'btn-quote' }, h('i', { 'data-lucide': 'flag', style: 'width:14px;height:14px' }), txt);
  btn.addEventListener('click', () => {
    const open = !body.classList.toggle('hidden');
    txt.textContent = open ? 'Hide first readings' : label();
    if (open) icons();
  });
  wrap.append(btn, body);
  return wrap;
}

function cardsView(rows) {
  const wrap = h('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-4' });
  for (const c of rows) wrap.append(c.no_prior_on_record ? baselineCard(c) : changeCard(c));
  return wrap;
}

function changeCard(c) {
  const color = c.direction === 'up' ? SEMANTIC.up : SEMANTIC.down;
  const e = enrichOf(c.scrip_cd);
  return h('div', { class: 'card card-hover', style: 'padding:20px 22px' },
    h('div', { class: 'flex items-start justify-between gap-3' },
      h('div', {}, h('div', { class: 'font-display font-bold text-lg leading-tight' }, esc(c.company)),
        h('div', { class: 'mt-1.5 flex items-center gap-2', style: 'flex-wrap:wrap' },
          fyChip(c.fiscal_year), industryChip(e?.industry),
          h('span', { class: 'num', style: 'font-size:11px;color:var(--muted)' }, `scrip ${c.scrip_cd}`))),
      h('div', { class: 'flex flex-col items-end gap-1.5' }, dirPill(c.direction, c.pct_change), typeChip(c.event_type))),
    // Old plan -> New plan
    h('div', { class: 'mt-4 flex items-center flex-wrap gap-2', style: 'font-size:20px' },
      h('span', { class: 'num', style: 'color:var(--muted)' }, fmtCr(c.old_cr)),
      h('i', { 'data-lucide': 'arrow-right', style: 'width:18px;height:18px;color:var(--muted)' }),
      h('span', { class: 'num font-bold', style: `color:${color}` }, fmtCr(c.new_cr)),
      h('span', { class: 'num', style: `font-size:13px;color:${color}` }, `(${fmtSignedCr(c.delta_cr)})`)),
    h('div', { class: 'flex gap-4 mt-1', style: 'font-size:11px;color:var(--muted)' },
      h('span', {}, 'Old plan'), h('span', {}, 'New plan')),
    approxContext(e),
    // Why
    h('div', { class: 'mt-4' },
      h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)' }, 'Why'),
      h('div', { style: 'font-size:14px;margin-top:2px;color:#3d3f57' }, c.reason ? esc(c.reason) : h('span', { style: 'color:var(--muted);font-style:italic' }, 'Reason not stated in the filing'))),
    quoteToggle([{ label: 'New filing', text: c.new_quote }, { label: 'Previous filing', text: c.old_quote }]),
    h('div', { class: 'flex items-center justify-between mt-4 flex-wrap gap-2' },
      filingLink(c.new_pdf),
      h('span', { class: 'num', style: 'font-size:12px;color:var(--muted)' }, fmtDate(c.new_date))));
}

function baselineCard(c) {
  const e = enrichOf(c.scrip_cd);
  return h('div', { class: 'card', style: 'padding:18px 20px;opacity:.96;border-style:dashed' },
    h('div', { class: 'flex items-start justify-between gap-3' },
      h('div', {}, h('div', { class: 'font-display font-bold leading-tight' }, esc(c.company)),
        h('div', { class: 'mt-1.5 flex items-center gap-2', style: 'flex-wrap:wrap' }, fyChip(c.fiscal_year), industryChip(e?.industry))),
      h('div', { class: 'flex flex-col items-end gap-1.5' },
        h('span', { class: 'pill', style: 'background:#F1F5F9;color:#64748B' }, h('i', { 'data-lucide': 'flag', style: 'width:13px;height:13px' }), 'First reading'),
        typeChip(c.event_type))),
    h('div', { class: 'num mt-3', style: 'font-size:20px;font-weight:700' }, fmtCr(c.new_cr)),
    h('div', { style: 'font-size:12.5px;color:var(--muted);margin-top:2px' }, 'First time we saw a capex number for this company & year — nothing to compare against yet.'),
    approxContext(e),
    quoteToggle([{ label: 'Filing', text: c.new_quote }]),
    h('div', { class: 'flex items-center justify-between mt-3 flex-wrap gap-2' },
      filingLink(c.new_pdf),
      h('span', { class: 'num', style: 'font-size:12px;color:var(--muted)' }, fmtDate(c.new_date))));
}

// Sortable table for change rows. Columns marked `always` are always shown;
// the rest are DROPPED when every visible row is empty for them — so a table of
// first-readings won't show empty "Was / Change / Change %" columns, and market
// columns disappear when no visible row has enrichment. No wall of "—".
function tableView(rows) {
  const cellApprox = 'font-style:italic;color:var(--muted)';
  const dirColor = (c) => (c.direction === 'up' ? SEMANTIC.up : c.direction === 'down' ? SEMANTIC.down : 'var(--muted)');
  const openTd = (c) => h('td', {}, c.new_pdf ? h('a', { class: 'btn-link', href: c.new_pdf, target: '_blank', rel: 'noopener', style: 'padding:5px 9px' }, h('i', { 'data-lucide': 'file-text', style: 'width:13px;height:13px' }), 'open') : '');
  const cols = [
    { k: 'company', t: 'Company', always: true, sortVal: (c) => c.company,
      cell: (c) => h('td', {}, h('b', {}, esc(c.company)), c.no_prior_on_record ? h('span', { class: 'pill', style: 'background:#F1F5F9;color:#64748B;font-size:10px;margin-left:6px' }, 'first reading') : null) },
    { k: 'industry', t: 'Industry', has: (c) => !!industryOf(c), sortVal: (c) => industryOf(c),
      cell: (c) => h('td', { style: 'color:#475569;max-width:13rem' }, industryOf(c) ? esc(industryOf(c)) : '') },
    { k: 'event_type', t: 'Type', has: (c) => !!c.event_type, sortVal: (c) => c.event_type || '',
      cell: (c) => h('td', {}, typeChip(c.event_type) || '') },
    { k: 'fiscal_year', t: 'Year', has: (c) => !!c.fiscal_year, sortVal: (c) => c.fiscal_year || '',
      cell: (c) => h('td', {}, c.fiscal_year || '') },
    { k: 'new_cr', t: 'Capex (₹Cr)', always: true, num: true, sortVal: (c) => c.new_cr,
      cell: (c) => h('td', { class: 'num', style: `font-weight:700;color:${dirColor(c)}` }, fmtCr(c.new_cr)) },
    { k: 'old_cr', t: 'Was (₹Cr)', num: true, has: (c) => c.old_cr != null, sortVal: (c) => c.old_cr,
      cell: (c) => h('td', { class: 'num', style: 'color:var(--muted)' }, c.old_cr == null ? '' : fmtCr(c.old_cr)) },
    { k: 'delta_cr', t: 'Change (₹Cr)', num: true, has: (c) => c.delta_cr != null, sortVal: (c) => c.delta_cr,
      cell: (c) => h('td', { class: 'num' }, c.delta_cr == null ? '' : fmtSignedCr(c.delta_cr)) },
    { k: 'pct_change', t: 'Change %', num: true, has: (c) => c.pct_change != null, sortVal: (c) => c.pct_change,
      cell: (c) => h('td', { class: 'num', style: `color:${dirColor(c)}` }, c.pct_change == null ? '' : fmtPct(c.pct_change)) },
    { k: 'market_cap_cr', t: 'Mkt Cap ~', num: true, has: (c) => enrichOf(c.scrip_cd)?.market_cap_cr != null, sortVal: (c) => enrichOf(c.scrip_cd)?.market_cap_cr ?? null,
      cell: (c) => { const v = enrichOf(c.scrip_cd)?.market_cap_cr; return h('td', { class: 'num', style: cellApprox }, v != null ? fmtMktCap(v) : ''); } },
    { k: 'pe', t: 'P/E ~', num: true, has: (c) => enrichOf(c.scrip_cd)?.pe != null, sortVal: (c) => enrichOf(c.scrip_cd)?.pe ?? null,
      cell: (c) => { const v = enrichOf(c.scrip_cd)?.pe; return h('td', { class: 'num', style: cellApprox }, v != null ? fmtPE(v) : ''); } },
    { k: 'date', t: 'Date', always: true, num: true, sortVal: (c) => changeTime(c),
      cell: (c) => h('td', { class: 'num', style: 'color:var(--muted)' }, fmtDate(c.new_date)) },
    { k: 'filing', t: 'Filing', always: true, sortVal: () => 0, cell: openTd },
  ];
  const shown = cols.filter((col) => col.always || rows.some((c) => col.has && col.has(c)));

  const { key, dir } = changesUI.sort;
  const sortCol = shown.find((c) => c.k === key) || shown.find((c) => c.k === 'date');
  const sorted = [...rows].sort((a, b) => {
    let av = sortCol.sortVal(a), bv = sortCol.sortVal(b);
    if (sortCol.num) { av = av ?? -Infinity; bv = bv ?? -Infinity; return dir === 'asc' ? av - bv : bv - av; }
    av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const table = h('table', { class: 'tbl' });
  const tr = h('tr');
  for (const col of shown) {
    const arrow = key === col.k ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = h('th', {}, col.t + arrow);
    if (col.k !== 'filing') th.addEventListener('click', () => {
      changesUI.sort = { key: col.k, dir: key === col.k && dir === 'desc' ? 'asc' : 'desc' };
      drawFeed();
    });
    tr.append(th);
  }
  table.append(h('thead', {}, tr));
  const tbody = h('tbody');
  for (const c of sorted) tbody.append(h('tr', {}, ...shown.map((col) => col.cell(c))));
  table.append(tbody);

  const hasApprox = shown.some((c) => c.k === 'market_cap_cr' || c.k === 'pe' || c.k === 'industry');
  const note = hasApprox
    ? h('div', { style: 'padding:8px 12px 4px;font-size:11px;color:var(--muted);font-style:italic' },
      'Industry, Mkt Cap (~) and P/E (~) are approximate market context from Screener — not from the filing. Capex figures stay source-backed.')
    : null;
  return h('div', { class: 'card', style: 'padding:8px 6px;overflow-x:auto' }, table, note);
}

// ---- tab: BY COMPANY -----------------------------------------------------
// One row per tracked company with the bits the browse list shows.
function companyList() {
  return Object.keys(state.history).map((scrip) => {
    const obs = (state.history[scrip] || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first
    const e = enrichOf(scrip) || {};
    const latest = obs[0] || null;
    // "Latest capex" is the most recent real capex figure — acquisitions/M&A are
    // recorded but are not capex, so they don't set this number.
    const latestCapex = obs.find((o) => o.amount_cr != null && o.type !== 'acquisition') || null;
    return {
      scrip,
      name: latest?.company || `Scrip ${scrip}`,
      count: obs.length,
      industry: e.industry || '',
      latestCapexCr: latestCapex?.amount_cr ?? null,
      latestDate: (latestCapex || latest)?.date || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Default view: a searchable, browsable list of every tracked company. Nothing
// is auto-selected — the user clicks a card (or searches) to drill into detail.
const companyUI = { q: '', industry: 'all', sort: { key: 'name', dir: 'asc' } };

// The By Company tab opens on a dense, sortable TABLE of every tracked company
// (search + industry filter above). Clicking a row opens that company's detail.
function renderCompany() {
  const el = document.getElementById('panel-company');
  disposeCharts();
  el.innerHTML = '';
  const companies = companyList();

  if (!companies.length) {
    el.append(emptyState({
      icon: 'building-2',
      title: 'No company history yet',
      msg: 'Once the engine has read a company’s filings they’ll appear here — pick one to see how its capex plan moved over time, each point backed by the exact quote and the source document.',
    }));
    return;
  }

  const industries = [...new Set(companies.map((c) => c.industry).filter(Boolean))].sort();
  const sel = (label, id, opts) => h('label', { class: 'flex flex-col gap-1' },
    h('span', { style: 'font-size:11px;font-weight:600;color:var(--muted)' }, label),
    h('select', { class: 'select', id }, ...opts.map((o) => h('option', { value: o.v, selected: o.sel }, o.t))));

  const controls = h('div', { class: 'card', style: 'padding:16px 18px' },
    h('div', { class: 'flex items-end gap-3 flex-wrap' },
      h('label', { class: 'flex flex-col gap-1 grow', style: 'min-width:220px' },
        h('span', { style: 'font-size:11px;font-weight:600;color:var(--muted)' }, 'Search company'),
        h('input', { class: 'search', id: 'co-q', type: 'search', placeholder: 'Type a company name…', autocomplete: 'off', value: companyUI.q })),
      industries.length ? sel('Industry', 'co-ind', [{ v: 'all', t: 'All industries', sel: true }, ...industries.map((i) => ({ v: i, t: i }))]) : null,
      h('span', { style: 'font-size:12px;color:var(--muted);margin-left:auto' }, `${companies.length} ${companies.length === 1 ? 'company' : 'companies'} tracked`)));
  el.append(controls);
  const holder = h('div', { class: 'mt-5', id: 'company-holder' });
  el.append(holder);

  const drawTable = () => {
    const ql = companyUI.q.trim().toLowerCase();
    const rows = companies.filter((c) =>
      (!ql || c.name.toLowerCase().includes(ql) || c.industry.toLowerCase().includes(ql)) &&
      (companyUI.industry === 'all' || c.industry === companyUI.industry));
    holder.innerHTML = '';
    holder.append(companyTable(rows, drawTable));
    icons();
  };

  controls.querySelector('#co-q').addEventListener('input', debounce((ev) => { companyUI.q = ev.target.value; drawTable(); }, 140));
  const indSel = controls.querySelector('#co-ind');
  if (indSel) { indSel.value = companyUI.industry; indSel.addEventListener('change', (ev) => { companyUI.industry = ev.target.value; drawTable(); }); }
  drawTable();
  icons();
}

// Dense sortable company table. onSort re-renders just the table (keeps the
// search box focused). Clicking a row opens the company detail.
function companyTable(rows, onSort) {
  if (!rows.length) return h('div', { class: 'card', style: 'padding:24px;text-align:center;color:var(--muted)' }, 'No companies match your search.');
  const cols = [
    { k: 'name', t: 'Company', get: (c) => c.name, cell: (c) => h('td', {}, h('b', {}, esc(c.name))) },
    { k: 'industry', t: 'Industry', get: (c) => c.industry, cell: (c) => h('td', { style: 'max-width:16rem' }, c.industry ? esc(c.industry) : h('span', { style: 'color:var(--muted)' }, '—')) },
    { k: 'count', t: '#Obs', num: true, get: (c) => c.count, cell: (c) => h('td', { class: 'num' }, String(c.count)) },
    { k: 'latestCapexCr', t: 'Latest capex (₹Cr)', num: true, get: (c) => c.latestCapexCr, cell: (c) => h('td', { class: 'num font-bold' }, c.latestCapexCr != null ? fmtCr(c.latestCapexCr) : '—') },
    { k: 'latestDate', t: 'Latest date', num: true, get: (c) => (c.latestDate ? new Date(c.latestDate).getTime() : -Infinity), cell: (c) => h('td', { class: 'num', style: 'color:var(--muted)' }, fmtDate(c.latestDate)) },
    { k: 'view', t: '', get: () => 0, cell: () => h('td', {}, h('span', { class: 'btn-link', style: 'padding:5px 10px;pointer-events:none' }, 'View', h('i', { 'data-lucide': 'arrow-right', style: 'width:13px;height:13px' }))) },
  ];
  const { key, dir } = companyUI.sort;
  const sortCol = cols.find((c) => c.k === key) || cols[0];
  const sorted = [...rows].sort((a, b) => {
    let av = sortCol.get(a), bv = sortCol.get(b);
    if (sortCol.num) { av = av ?? -Infinity; bv = bv ?? -Infinity; return dir === 'asc' ? av - bv : bv - av; }
    av = String(av || '').toLowerCase(); bv = String(bv || '').toLowerCase();
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const table = h('table', { class: 'tbl' });
  const tr = h('tr');
  for (const col of cols) {
    const arrow = key === col.k ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = h('th', {}, col.t + arrow);
    if (col.k !== 'view') th.addEventListener('click', () => {
      companyUI.sort = { key: col.k, dir: key === col.k && dir === 'desc' ? 'asc' : 'desc' };
      onSort();
    });
    tr.append(th);
  }
  table.append(h('thead', {}, tr));
  const tb = h('tbody');
  for (const c of sorted) {
    const row = h('tr', { style: 'cursor:pointer' }, ...cols.map((col) => col.cell(c)));
    row.addEventListener('click', () => drawCompanyDetail(c.scrip));
    tb.append(row);
  }
  table.append(tb);
  return h('div', { class: 'card', style: 'padding:8px 6px;overflow-x:auto' }, table);
}

// Company detail: always a header + observations table; the "capex plan over
// time" chart appears ONLY when there are ≥2 forward-guidance points (a real
// trend) — never an empty chart box.
function drawCompanyDetail(scrip) {
  const el = document.getElementById('panel-company');
  disposeCharts();
  el.innerHTML = '';
  const obs = (state.history[scrip] || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const name = obs[obs.length - 1]?.company || obs[0]?.company || `Scrip ${scrip}`;
  const e = enrichOf(scrip);

  const back = h('button', { class: 'btn-link', style: 'cursor:pointer;margin-bottom:16px' },
    h('i', { 'data-lucide': 'arrow-left', style: 'width:14px;height:14px' }), 'All companies');
  back.addEventListener('click', renderCompany);
  el.append(back);

  const ctxBits = [];
  if (e?.market_cap_cr != null) ctxBits.push(`Mkt cap ${fmtMktCap(e.market_cap_cr)}`);
  if (e?.pe != null) ctxBits.push(`P/E ${fmtPE(e.pe)}`);
  el.append(h('div', { class: 'card', style: 'padding:20px 22px' },
    h('div', { class: 'flex items-start justify-between flex-wrap gap-2' },
      h('div', {},
        h('h3', { class: 'font-display font-bold', style: 'font-size:18px' }, esc(name)),
        (e && (e.industry || ctxBits.length)) ? h('div', { class: 'mt-1.5 flex items-center gap-2', style: 'flex-wrap:wrap' },
          industryChip(e?.industry),
          ctxBits.length ? h('span', { class: 'pill', style: 'background:#F1F5F9;color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 8px' }, 'APPROX') : null,
          ctxBits.length ? h('span', { class: 'num', style: 'font-size:12px;color:var(--muted);font-style:italic' }, ctxBits.join('  ·  ')) : null,
          e?.source_url ? h('a', { href: e.source_url, target: '_blank', rel: 'noopener', style: 'font-size:11px;color:#A855F7' }, 'source') : null) : null),
      h('span', { class: 'pill', style: 'background:#F1EEFE;color:#6D28D9;font-size:11px' }, `${obs.length} observation${obs.length === 1 ? '' : 's'}`))));

  // Chart only for a real trend (≥2 forward-guidance points). No empty box.
  const guidance = obs.filter((o) => o.type === 'guidance' && o.fiscal_year && o.amount_cr != null);
  if (guidance.length >= 2) {
    el.append(h('div', { class: 'card mt-5', style: 'padding:20px 22px' },
      h('div', { class: 'flex items-center justify-between mb-1 flex-wrap gap-2' },
        h('h4', { class: 'font-display font-bold' }, 'Capex plan over time'),
        h('span', { style: 'font-size:12px;color:var(--muted)' }, 'guidance figures, by fiscal year')),
      h('div', { class: 'chart-lg', id: 'chart-company' })));
    drawCompanyChart(guidance);
  } else {
    el.append(h('div', { style: 'font-size:13px;color:var(--muted);margin-top:14px;padding:0 4px' },
      guidance.length === 1
        ? 'Only one forward-guidance figure on record so far — not enough to chart a trend yet.'
        : 'No forward-guidance trend to chart yet.'));
  }

  // Observations table (always).
  const table = h('table', { class: 'tbl' });
  table.append(h('thead', {}, h('tr', {},
    ...['Date', 'Year', 'Type', 'Amount', '₹ Cr', 'What for', 'Filing'].map((t) => h('th', {}, t)))));
  const tbody = h('tbody');
  for (const o of [...obs].reverse()) {
    tbody.append(h('tr', {},
      h('td', { class: 'num', style: 'color:var(--muted)' }, fmtDate(o.date)),
      h('td', {}, o.fiscal_year || '—'),
      h('td', {}, typeChip(o.event_type) || h('span', { class: 'pill', style: 'background:#F1EEFE;color:#6D28D9;font-size:11px' }, o.type),
        h('div', { style: 'font-size:10px;color:var(--muted);margin-top:3px' }, o.type)),
      h('td', { class: 'num' }, esc(o.amount_text || '—')),
      h('td', { class: 'num font-bold' }, fmtCr(o.amount_cr)),
      h('td', { style: 'max-width:16rem' }, o.segment_or_project ? esc(o.segment_or_project) : '—'),
      h('td', {}, o.source_pdf ? h('a', { class: 'btn-link', href: o.source_pdf, target: '_blank', rel: 'noopener', style: 'padding:5px 9px' }, h('i', { 'data-lucide': 'file-text', style: 'width:13px;height:13px' }), 'open') : '—')));
  }
  table.append(tbody);
  el.append(h('div', { class: 'card mt-5', style: 'padding:8px 6px;overflow-x:auto' },
    h('div', { class: 'font-display font-bold', style: 'padding:12px 12px 4px' }, 'All observations'), table));
  icons();
}

function drawCompanyChart(guidance) {
  const byFY = {};
  for (const o of guidance) (byFY[o.fiscal_year] ||= []).push(o);
  const fys = Object.keys(byFY).sort();
  const series = fys.map((fy, i) => {
    const color = PALETTE[i % PALETTE.length];
    return {
      name: fy, type: 'line', step: 'end', smooth: false, showSymbol: true, symbolSize: 9,
      lineStyle: { width: 3, color }, itemStyle: { color },
      areaStyle: { color: CHART.areaGradient(color) },
      data: byFY[fy].map((o) => ({ value: [o.date, o.amount_cr], quote: o.quote, amount_text: o.amount_text })),
    };
  });
  newChart(document.getElementById('chart-company'), {
    color: PALETTE,
    legend: { top: 0, icon: 'circle', textStyle: { color: '#4b4d63', fontFamily: 'Inter' } },
    grid: { left: 8, right: 20, top: 40, bottom: 8, containLabel: true },
    tooltip: {
      ...CHART.tooltip('#6366F1'), trigger: 'item', confine: true,
      formatter: (p) => {
        const q = p.data.quote ? `<div style="max-width:280px;white-space:normal;color:#6B7280;margin-top:6px;font-size:12px">“${escHtml(p.data.quote)}”</div>` : '';
        return `<b>${p.seriesName}</b> · ${fmtDate(p.data.value[0])}<br/>`
          + `<span style="font-family:JetBrains Mono;font-weight:700">${fmtCr(p.data.value[1])}</span> `
          + `<span style="color:#6B7280">${escHtml(p.data.amount_text || '')}</span>${q}`;
      },
    },
    xAxis: { type: 'time', axisLabel: { ...CHART.axisLabel, fontFamily: 'Inter' }, axisLine: { lineStyle: { color: '#E3E0F2' } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { ...CHART.axisLabel, formatter: (v) => fmtCrAxis(v) }, splitLine: CHART.splitLine },
    series,
  });
}

// ---- tabs / boot ---------------------------------------------------------
const panels = { overview: renderOverview, changes: renderChanges, company: renderCompany };
function activate(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `panel-${tab}`));
  disposeCharts();
  (panels[tab] || renderOverview)();
  icons();
  requestAnimationFrame(resizeCharts);
}

async function boot() {
  await loadData();
  const meta = state.metadata;
  document.getElementById('lastRun').textContent = meta?.last_run
    ? `updated ${fmtDate(meta.last_run)}${DEMO ? ' · demo' : ''}`
    : (DEMO ? 'demo preview' : 'building…');
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (b) activate(b.dataset.tab);
  });

  // Download Excel — exports the CURRENTLY FILTERED changes (so pick a week →
  // download gives exactly that week). Falls back to CSV if ExcelJS is missing.
  const dlBtn = document.getElementById('downloadBtn');
  if (dlBtn) dlBtn.addEventListener('click', async () => {
    const rows = filteredChanges().map(toExportRow);
    if (!rows.length) { toast('No changes match the current filters to export.'); return; }
    dlBtn.disabled = true; dlBtn.style.opacity = '.6';
    try {
      const res = await downloadExcel(rows);
      toast(res && res.format === 'csv'
        ? `Excel wasn’t available — downloaded ${rows.length} row${rows.length === 1 ? '' : 's'} as CSV.`
        : `Downloaded ${rows.length} row${rows.length === 1 ? '' : 's'} to Excel.`);
    } catch (err) {
      toast('Sorry — the export failed. Please try again.');
      console.error(err);
    } finally { dlBtn.disabled = false; dlBtn.style.opacity = ''; }
  });

  activate('overview');
  icons();
}

boot();
