// public/js/app.js
// Loads the committed JSON and renders the three tabs. Visual-first, layperson
// friendly, and always source-backed (every row shows the verbatim quote + a
// link to the official filing). Degrades to a friendly empty state when there's
// no data yet — it never invents numbers.

import {
  h, esc, fmtCr, fmtCrAxis, fmtSignedCr, fmtPct, fmtDate, fmtMktCap, fmtPE, debounce,
  emptyState, newChart, disposeCharts, resizeCharts, icons,
  eventTypeStyle, CHART, SEMANTIC, PALETTE,
} from './ui.js';

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

  // Hero (one sentence) + a couple of small chips only — no KPI wall.
  const hero = h('div', { class: 'card', style: 'padding:26px 28px' },
    h('div', { class: 'flex flex-wrap items-start justify-between gap-4' },
      h('h2', { class: 'font-display text-2xl sm:text-3xl font-bold leading-snug', style: 'max-width:44rem' },
        changes.length
          ? `${companies} ${companies === 1 ? 'company' : 'companies'} changed their capex plans (${windowLabel}).`
          : 'We’re tracking capex plans — no changes yet.'),
      h('div', { class: 'flex gap-2.5' },
        h('div', { class: 'chip text-center' }, h('div', { class: 'num text-xl font-bold' }, String(tracked)), h('div', { style: 'font-size:11px;color:var(--muted)' }, 'companies tracked')),
        h('div', { class: 'chip text-center' }, h('div', { class: 'num text-xl font-bold' }, String(changes.length)), h('div', { style: 'font-size:11px;color:var(--muted)' }, 'capex changes')))));
  el.append(hero);

  if (!changes.length) {
    el.append(h('div', { class: 'mt-5' }, emptyState({
      icon: 'bell',
      title: 'No plan changes recorded yet',
      msg: 'The engine has started reading filings. As soon as a company revises how much it plans to spend, the change will show up here.',
    })));
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
        return `<b>${esc(c.company)}</b> · ${esc(c.fiscal_year || '')}<br/>`
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

// ---- tab: CHANGES --------------------------------------------------------
const changesUI = { window: 30, direction: 'all', industry: 'all', type: 'all', q: '', view: 'cards', sort: { key: 'date', dir: 'desc' } };

const industryOf = (c) => enrichOf(c.scrip_cd)?.industry || '';

function filteredChanges() {
  const q = changesUI.q.trim().toLowerCase();
  return state.changes.filter((c) => {
    if (!withinDays(c, changesUI.window)) return false;
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

  const controls = h('div', { class: 'card', style: 'padding:16px 18px' },
    h('div', { class: 'flex flex-wrap items-end gap-3' },
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

  const feed = h('div', { class: 'mt-5', id: 'changes-feed' });
  el.append(feed);

  // wire controls
  controls.querySelector('#f-window').value = String(changesUI.window === Infinity ? 'all' : changesUI.window);
  controls.querySelector('#f-dir').value = changesUI.direction;
  controls.querySelector('#f-window').addEventListener('change', (e) => { changesUI.window = e.target.value === 'all' ? Infinity : Number(e.target.value); drawFeed(); });
  controls.querySelector('#f-dir').addEventListener('change', (e) => { changesUI.direction = e.target.value; drawFeed(); });
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
  if (!feed) return;
  const rows = filteredChanges();
  feed.innerHTML = '';
  if (!rows.length) {
    feed.append(h('div', { class: 'card', style: 'padding:28px;text-align:center;color:var(--muted)' }, 'No changes match these filters. Try a wider time window or clearing the search.'));
    return;
  }
  feed.append(changesUI.view === 'cards' ? cardsView(rows) : tableView(rows));
  icons();
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

function tableView(rows) {
  const cols = [
    { k: 'company', t: 'Company', get: (c) => c.company },
    { k: 'industry', t: 'Industry', get: (c) => industryOf(c) },
    { k: 'event_type', t: 'Type', get: (c) => c.event_type || '' },
    { k: 'fiscal_year', t: 'Year', get: (c) => c.fiscal_year || '' },
    { k: 'old_cr', t: 'Old (₹Cr)', get: (c) => c.old_cr, num: true },
    { k: 'new_cr', t: 'New (₹Cr)', get: (c) => c.new_cr, num: true },
    { k: 'delta_cr', t: 'Change (₹Cr)', get: (c) => c.delta_cr, num: true },
    { k: 'pct_change', t: 'Change %', get: (c) => c.pct_change, num: true },
    { k: 'market_cap_cr', t: 'Mkt Cap ~', get: (c) => enrichOf(c.scrip_cd)?.market_cap_cr ?? null, num: true },
    { k: 'pe', t: 'P/E ~', get: (c) => enrichOf(c.scrip_cd)?.pe ?? null, num: true },
    { k: 'date', t: 'Date', get: (c) => changeTime(c), num: true },
    { k: 'filing', t: 'Filing', get: () => 0 },
  ];
  const { key, dir } = changesUI.sort;
  const sorted = [...rows].sort((a, b) => {
    const col = cols.find((c) => c.k === key) || cols.find((c) => c.k === 'date');
    let av = col.get(a), bv = col.get(b);
    if (col.num) { av = av ?? -Infinity; bv = bv ?? -Infinity; return dir === 'asc' ? av - bv : bv - av; }
    av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const table = h('table', { class: 'tbl' });
  const thead = h('thead');
  const tr = h('tr');
  for (const col of cols) {
    const arrow = key === col.k ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = h('th', {}, col.t + arrow);
    if (col.k !== 'filing') th.addEventListener('click', () => {
      changesUI.sort = { key: col.k, dir: key === col.k && dir === 'desc' ? 'asc' : 'desc' };
      drawFeed();
    });
    tr.append(th);
  }
  thead.append(tr); table.append(thead);
  const tbody = h('tbody');
  for (const c of sorted) {
    const color = c.direction === 'up' ? SEMANTIC.up : c.direction === 'down' ? SEMANTIC.down : 'var(--muted)';
    const e = enrichOf(c.scrip_cd);
    const approxNum = 'font-style:italic;color:var(--muted)';
    tbody.append(h('tr', {},
      h('td', {}, h('b', {}, esc(c.company)), c.no_prior_on_record ? h('span', { class: 'pill ml-1', style: 'background:#F1F5F9;color:#64748B;font-size:10px' }, 'first') : null),
      h('td', { style: 'color:var(--muted);max-width:11rem' }, e?.industry ? esc(e.industry) : '—'),
      h('td', {}, typeChip(c.event_type) || '—'),
      h('td', {}, c.fiscal_year || '—'),
      h('td', { class: 'num' }, c.old_cr == null ? '—' : fmtCr(c.old_cr)),
      h('td', { class: 'num', style: `color:${color};font-weight:700` }, fmtCr(c.new_cr)),
      h('td', { class: 'num' }, c.delta_cr == null ? '—' : fmtSignedCr(c.delta_cr)),
      h('td', { class: 'num', style: `color:${color}` }, c.pct_change == null ? '—' : fmtPct(c.pct_change)),
      h('td', { class: 'num', style: approxNum }, e?.market_cap_cr != null ? fmtMktCap(e.market_cap_cr) : '—'),
      h('td', { class: 'num', style: approxNum }, e?.pe != null ? fmtPE(e.pe) : '—'),
      h('td', { class: 'num', style: 'color:var(--muted)' }, fmtDate(c.new_date)),
      h('td', {}, c.new_pdf ? h('a', { class: 'btn-link', href: c.new_pdf, target: '_blank', rel: 'noopener', style: 'padding:5px 9px' }, h('i', { 'data-lucide': 'file-text', style: 'width:13px;height:13px' }), 'open') : '—')));
  }
  table.append(tbody);
  const note = Object.keys(state.enrichment).length
    ? h('div', { style: 'padding:8px 12px 4px;font-size:11px;color:var(--muted);font-style:italic' },
      'Industry, Mkt Cap (~) and P/E (~) are approximate market context from Screener — not from the filing. Capex figures stay source-backed.')
    : null;
  return h('div', { class: 'card', style: 'padding:8px 6px;overflow-x:auto' }, table, note);
}

// ---- tab: BY COMPANY -----------------------------------------------------
function companyList() {
  return Object.keys(state.history).map((scrip) => {
    const obs = state.history[scrip] || [];
    return { scrip, name: obs[0]?.company || `Scrip ${scrip}`, count: obs.length };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function renderCompany() {
  const el = document.getElementById('panel-company');
  el.innerHTML = '';
  const companies = companyList();

  if (!companies.length) {
    el.append(emptyState({
      icon: 'building-2',
      title: 'No company history yet',
      msg: 'Once the engine has read a company’s filings, pick it here to see how its capex plan moved over time — each point backed by the exact quote and the source document.',
    }));
    return;
  }

  const picker = h('div', { class: 'card', style: 'padding:16px 18px' },
    h('label', { class: 'flex flex-col gap-1', style: 'max-width:24rem' },
      h('span', { style: 'font-size:11px;font-weight:600;color:var(--muted)' }, 'Choose a company'),
      h('input', { class: 'search', id: 'company-input', list: 'company-list', placeholder: 'Type to search…', autocomplete: 'off' })),
    h('datalist', { id: 'company-list' }, ...companies.map((c) => h('option', { value: c.name }))));
  el.append(picker);
  const holder = h('div', { class: 'mt-5', id: 'company-holder' });
  el.append(holder);

  const input = picker.querySelector('#company-input');
  input.addEventListener('change', () => {
    const match = companies.find((c) => c.name.toLowerCase() === input.value.trim().toLowerCase());
    if (match) drawCompany(match.scrip);
  });

  // auto-select the company with the most observations to show something useful
  const initial = [...companies].sort((a, b) => b.count - a.count)[0];
  input.value = initial.name;
  drawCompany(initial.scrip);
  icons();
}

function drawCompany(scrip) {
  const holder = document.getElementById('company-holder');
  holder.innerHTML = '';
  const obs = (state.history[scrip] || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const name = obs[0]?.company || `Scrip ${scrip}`;

  const e = enrichOf(scrip);
  const ctxBits = [];
  if (e?.market_cap_cr != null) ctxBits.push(`Mkt cap ${fmtMktCap(e.market_cap_cr)}`);
  if (e?.pe != null) ctxBits.push(`P/E ${fmtPE(e.pe)}`);
  const chartCard = h('div', { class: 'card', style: 'padding:20px 22px' },
    h('div', { class: 'flex items-start justify-between mb-1 flex-wrap gap-2' },
      h('div', {},
        h('h3', { class: 'font-display font-bold' }, `${esc(name)} — capex plan over time`),
        (e && (e.industry || ctxBits.length)) ? h('div', { class: 'mt-1.5 flex items-center gap-2', style: 'flex-wrap:wrap' },
          industryChip(e?.industry),
          ctxBits.length ? h('span', { class: 'pill', style: 'background:#F1F5F9;color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 8px' }, 'APPROX') : null,
          ctxBits.length ? h('span', { class: 'num', style: 'font-size:12px;color:var(--muted);font-style:italic' }, ctxBits.join('  ·  ')) : null,
          e?.source_url ? h('a', { href: e.source_url, target: '_blank', rel: 'noopener', style: 'font-size:11px;color:#A855F7' }, 'source') : null) : null),
      h('span', { style: 'font-size:12px;color:var(--muted)' }, 'guidance figures, by fiscal year')),
    h('div', { class: 'chart-lg', id: 'chart-company' }));
  holder.append(chartCard);

  const guidance = obs.filter((o) => o.type === 'guidance' && o.amount_cr != null);
  if (guidance.length) drawCompanyChart(guidance);
  else document.getElementById('chart-company').innerHTML = '<p style="color:var(--muted);font-size:13px;padding:16px">No forward guidance figures parsed for this company yet — see the observations below.</p>';

  // observations table
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
  holder.append(h('div', { class: 'card mt-5', style: 'padding:8px 6px;overflow-x:auto' },
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
        const q = p.data.quote ? `<div style="max-width:280px;white-space:normal;color:#6B7280;margin-top:6px;font-size:12px">“${esc(p.data.quote)}”</div>` : '';
        return `<b>${p.seriesName}</b> · ${fmtDate(p.data.value[0])}<br/>`
          + `<span style="font-family:JetBrains Mono;font-weight:700">${fmtCr(p.data.value[1])}</span> `
          + `<span style="color:#6B7280">${esc(p.data.amount_text || '')}</span>${q}`;
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
  activate('overview');
  icons();
}

boot();
