// public/js/app.js
// ONE screen: a plain-English feed of companies that changed how much they plan
// to spend on new plants & machines. Header · summary line · controls · list of
// event cards · (company name → full-history modal). Always source-backed; the
// backend, Excel export, email Brief, Week filter and enrichment are untouched.

import {
  h, fmtCr, fmtCrAxis, fmtMktCap, fmtPE, fmtDate, weekOf,
  newChart, disposeCharts, resizeCharts, CHART, PALETTE,
} from './ui.js';
import { downloadExcel } from './excel.js';

// ?demo=1 loads a local, git-ignored fixture so the populated layout can be
// eyeballed. Shipped data files stay empty; nothing fake is ever committed.
const DEMO = new URLSearchParams(location.search).has('demo');
const BASE = DEMO ? './demo' : './data';

const state = { changes: [], history: {}, metadata: null, enrichment: {} };
const ui = { week: 'all', show: 'all', q: '', everything: false };

// ---- data ----------------------------------------------------------------
async function loadJSON(path, fallback) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return fallback;
    return (await r.json()) ?? fallback;
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
const enrichOf = (scrip) => state.enrichment[String(scrip)] || null;

// ---- tiny toast ----------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3000);
}

// ---- events (the feed) ---------------------------------------------------
// A "kind" drives dot + badge + headline: up / down (real revisions) or newc
// (a first reading / new project / capacity add). Acquisitions never appear.
const eventTime = (e) => new Date(e.new_date || e.detected_at).getTime();
const kindOf = (c) => (c.no_prior_on_record ? 'newc' : (c.direction === 'up' ? 'up' : 'down'));

function allEvents() {
  const evs = state.changes.map((c) => ({ ...c, _kind: kindOf(c) }));
  if (ui.everything) {
    // Routine "quarterly / actual" capex figures live in history, not in the
    // change feed. Surface them only when the viewer asks. (M&A stays out.)
    for (const scrip of Object.keys(state.history)) {
      for (const o of state.history[scrip]) {
        if (o.type === 'actual' && o.amount_cr != null) {
          evs.push({
            company: o.company, scrip_cd: o.scrip_cd, fiscal_year: o.fiscal_year,
            event_type: o.event_type || 'Quarterly capex',
            old_cr: null, new_cr: o.amount_cr, delta_cr: null, pct_change: null,
            direction: 'unclear', reason: o.reason, new_quote: o.quote,
            new_pdf: o.source_pdf, new_date: o.date, week: o.week,
            no_prior_on_record: true, _kind: 'newc', _actual: true,
          });
        }
      }
    }
  }
  return evs;
}
function filteredEvents() {
  const q = ui.q.trim().toLowerCase();
  return allEvents().filter((e) => {
    if (ui.week !== 'all' && (weekOf(e.new_date || e.detected_at)?.key || '') !== ui.week) return false;
    if (ui.show !== 'all' && e._kind !== ui.show) return false;
    if (q && !(e.company || '').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => eventTime(b) - eventTime(a));
}
function distinctWeeks() {
  const seen = new Map();
  for (const c of state.changes) {
    const w = weekOf(c.new_date || c.detected_at);
    if (w && !seen.has(w.key)) seen.set(w.key, w.label);
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([key, label]) => ({ key, label }));
}

// ---- summary line --------------------------------------------------------
function renderSummary() {
  const el = document.getElementById('summary');
  el.innerHTML = '';
  const evs = filteredEvents();
  if (!evs.length) return; // the list area carries the empty message
  const companies = new Set(evs.map((e) => e.scrip_cd)).size;
  const up = evs.filter((e) => e._kind === 'up').length;
  const down = evs.filter((e) => e._kind === 'down').length;
  const neu = evs.filter((e) => e._kind === 'newc').length;
  const weekLabel = ui.week === 'all' ? 'all weeks' : (distinctWeeks().find((w) => w.key === ui.week)?.label || '');
  const pipe = () => h('span', { class: 'pipe' }, '·');
  el.append(
    h('span', {}, h('span', { class: 'big num' }, String(companies)),
      ` ${companies === 1 ? 'company' : 'companies'} changed their capex plans`),
    pipe(),
    h('span', { class: 'up num' }, `▲ ${up} increased`),
    h('span', { class: 'down num' }, `▼ ${down} decreased`),
    ...(neu ? [h('span', { class: 'newc num' }, `◆ ${neu} new`)] : []),
    h('span', { class: 'pipe' }, `· ${weekLabel}`),
  );
}

// ---- controls ------------------------------------------------------------
function buildControls() {
  const el = document.getElementById('controls');
  el.innerHTML = '';
  const weeks = distinctWeeks();
  const fld = (label, node) => h('div', { class: 'fld' }, h('label', {}, label), node);

  const weekSel = h('select', { id: 'f-week' },
    ...weeks.map((w) => h('option', { value: w.key }, w.label)),
    h('option', { value: 'all', selected: true }, 'All weeks'));
  const showSel = h('select', { id: 'f-show' },
    h('option', { value: 'all', selected: true }, 'All changes'),
    h('option', { value: 'up' }, 'Increased'),
    h('option', { value: 'down' }, 'Decreased'),
    h('option', { value: 'newc' }, 'New projects'));
  const q = h('input', { id: 'f-q', type: 'search', placeholder: 'e.g. ASK Automotive', value: ui.q });
  const dl = h('button', { class: 'btn solid', id: 'downloadBtn', type: 'button' }, '⬇️ Download Excel');

  el.append(fld('Week', weekSel), fld('Show', showSel),
    h('div', { class: 'fld grow' }, h('label', {}, 'Search company'), q), dl);

  weekSel.value = ui.week;
  weekSel.addEventListener('change', (e) => { ui.week = e.target.value; refresh(); });
  showSel.value = ui.show;
  showSel.addEventListener('change', (e) => { ui.show = e.target.value; refresh(); });
  let qt; q.addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { ui.q = e.target.value; refresh(); }, 150); });
  dl.addEventListener('click', exportExcel);

  // "show everything" toggle (routine quarterly figures, hidden by default)
  const bar = document.getElementById('everythingBar');
  bar.innerHTML = '';
  const cb = h('input', { type: 'checkbox', id: 'f-everything' });
  cb.checked = ui.everything;
  cb.addEventListener('change', (e) => { ui.everything = e.target.checked; refresh(); });
  bar.append(h('label', {}, cb, 'Also show routine quarterly capex figures'));
}

async function exportExcel() {
  const rows = filteredEvents().map(toExportRow);
  if (!rows.length) { toast('Nothing to export in the current view.'); return; }
  const btn = document.getElementById('downloadBtn');
  btn.disabled = true;
  try {
    const res = await downloadExcel(rows);
    toast(res && res.format === 'csv'
      ? `Excel wasn’t available — downloaded ${rows.length} row${rows.length === 1 ? '' : 's'} as CSV.`
      : `Downloaded ${rows.length} row${rows.length === 1 ? '' : 's'} to Excel.`);
  } catch { toast('Sorry — the export failed. Please try again.'); }
  finally { btn.disabled = false; }
}

// Flat row for excel.js (unchanged export format; respects current filters).
function toExportRow(e) {
  const en = enrichOf(e.scrip_cd) || {};
  const real = !e.no_prior_on_record;
  const plain = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  let summary;
  if (e.reason) summary = e.reason;
  else if (real) summary = headlineText(e);
  else summary = headlineText(e);
  return {
    company: e.company || '', scrip_cd: e.scrip_cd ?? '', date: e.new_date || null,
    week: e.week || weekOf(e.new_date || e.detected_at)?.label || '',
    event_type: e.event_type || '', summary,
    capex_cr: e.new_cr ?? null,
    old_new: (e.old_cr != null) ? `${plain(e.old_cr)} → ${plain(e.new_cr)}` : (e.new_cr != null ? plain(e.new_cr) : '—'),
    pct: (e.pct_change == null ? null : e.pct_change / 100),
    direction: real ? (e.direction || '') : 'new',
    market_cap_cr: en.market_cap_cr ?? null, pe: en.pe ?? null, industry: en.industry || '',
    source: e.new_pdf || '', is_change: real,
  };
}

// ---- the list ------------------------------------------------------------
function refresh() { renderSummary(); renderList(); }

function renderList() {
  const list = document.getElementById('list');
  const none = document.getElementById('none');
  list.innerHTML = '';
  const evs = filteredEvents();
  if (!evs.length) {
    list.style.display = 'none';
    none.style.display = 'block';
    none.textContent = allEvents().length
      ? 'No companies match — try a wider filter or clear the search.'
      : 'No capex changes recorded yet — as companies file, they’ll appear here, each backed by its BSE filing.';
    return;
  }
  none.style.display = 'none';
  list.style.display = 'flex';
  for (const e of evs) list.append(eventRow(e));
}

const pctUp = (p) => `▲ +${Math.round(p)}%`;
const pctDown = (p) => `▼ −${Math.abs(Math.round(p))}%`;

function badge(e) {
  if (e._kind === 'up') return h('span', { class: 'badge up num' }, pctUp(e.pct_change));
  if (e._kind === 'down') return h('span', { class: 'badge down num' }, pctDown(e.pct_change));
  const label = e._actual ? 'Quarterly'
    : e.event_type === 'Capacity Expansion' ? 'Capacity add'
      : e.event_type === 'New Project' ? 'New project' : 'New';
  return h('span', { class: 'badge newc' }, label);
}

const fyPart = (e) => (e.fiscal_year ? `${e.fiscal_year} ` : '');

// Returns a DOM .headline node (colored new figure).
function headline(e) {
  if (e._kind === 'up') return h('div', { class: 'headline' },
    `Raised ${fyPart(e)}capex `, h('span', { class: 'num' }, fmtCr(e.old_cr)),
    h('span', { class: 'arw' }, '→'), h('span', { class: 'num up' }, fmtCr(e.new_cr)));
  if (e._kind === 'down') return h('div', { class: 'headline' },
    `Trimmed ${fyPart(e)}capex `, h('span', { class: 'num' }, fmtCr(e.old_cr)),
    h('span', { class: 'arw' }, '→'), h('span', { class: 'num down' }, fmtCr(e.new_cr)));
  if (e._actual) return h('div', { class: 'headline' }, `Reported ${fyPart(e)}capex of `, h('span', { class: 'num' }, fmtCr(e.new_cr)));
  if (e.event_type === 'New Project') return h('div', { class: 'headline' }, 'New ', h('span', { class: 'num' }, fmtCr(e.new_cr)), ' expansion announced');
  if (e.event_type === 'Capacity Expansion') return h('div', { class: 'headline' }, 'New ', h('span', { class: 'num' }, fmtCr(e.new_cr)), ' capacity expansion');
  return h('div', { class: 'headline' }, `New ${fyPart(e)}capex plan: `, h('span', { class: 'num' }, fmtCr(e.new_cr)));
}
// Plain-text version (Excel summary fallback).
function headlineText(e) {
  if (e._kind === 'up') return `Raised ${fyPart(e)}capex ${fmtCr(e.old_cr)} → ${fmtCr(e.new_cr)}`;
  if (e._kind === 'down') return `Trimmed ${fyPart(e)}capex ${fmtCr(e.old_cr)} → ${fmtCr(e.new_cr)}`;
  if (e._actual) return `Reported ${fyPart(e)}capex of ${fmtCr(e.new_cr)}`;
  if (e.event_type === 'New Project') return `New ${fmtCr(e.new_cr)} expansion announced`;
  if (e.event_type === 'Capacity Expansion') return `New ${fmtCr(e.new_cr)} capacity expansion`;
  return `New ${fyPart(e)}capex plan: ${fmtCr(e.new_cr)}`;
}

function filingLink(url) {
  if (!url) return null;
  return h('a', { href: url, target: '_blank', rel: 'noopener' }, 'See the filing →');
}

function eventRow(e) {
  const en = enrichOf(e.scrip_cd);
  const co = h('span', { class: 'co', role: 'button', tabindex: '0' }, e.company);
  const open = () => openHistory(e.scrip_cd);
  co.addEventListener('click', open);
  co.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });

  const rtop = h('div', { class: 'rtop' },
    h('span', { class: `cdot ${e._kind}` }), co,
    en?.industry ? h('span', { class: 'chip' }, en.industry) : null,
    en?.market_cap_cr != null ? h('span', { class: 'mc num' }, `${fmtMktCap(en.market_cap_cr)} mkt cap`) : null,
    badge(e));

  const meta = h('div', { class: 'rmeta' }, h('span', { class: 'num' }, fmtDate(e.new_date)));
  const link = filingLink(e.new_pdf);
  if (link) meta.append(document.createTextNode('· '), link);

  return h('article', { class: 'row' },
    rtop, headline(e),
    e.reason ? h('div', { class: 'why' }, h('b', {}, 'Why: '), e.reason) : null,
    meta);
}

// ---- company history modal ----------------------------------------------
function openHistory(scrip) {
  const obs = (state.history[String(scrip)] || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const name = obs[obs.length - 1]?.company || obs[0]?.company || `Scrip ${scrip}`;
  const e = enrichOf(scrip);
  const body = document.getElementById('modalBody');
  disposeCharts();
  body.innerHTML = '';

  const close = h('button', { class: 'modal-x', 'aria-label': 'Close' }, '×');
  close.addEventListener('click', closeHistory);
  body.append(close);

  const ctx = [];
  if (e?.industry) ctx.push(e.industry);
  if (e?.market_cap_cr != null) ctx.push(`${fmtMktCap(e.market_cap_cr)} mkt cap`);
  if (e?.pe != null) ctx.push(`P/E ${fmtPE(e.pe)}`);
  body.append(
    h('h2', { class: 'disp', style: 'font-size:20px;font-weight:700;margin:0 0 2px' }, name),
    ctx.length ? h('div', { style: 'font-size:13px;color:var(--muted);margin-bottom:4px' },
      ctx.join('  ·  '), e?.source_url ? h('span', {}, '  ·  ', h('a', { href: e.source_url, target: '_blank', rel: 'noopener', style: 'color:var(--b1);text-decoration:none' }, 'source')) : null) : null,
    h('div', { style: 'font-size:12.5px;color:var(--muted);margin-bottom:12px' }, `${obs.length} capex observation${obs.length === 1 ? '' : 's'} on record — each links its BSE filing.`),
  );

  // trend chart only when there's a real trend (≥2 forward-guidance points)
  const guidance = obs.filter((o) => o.type === 'guidance' && o.fiscal_year && o.amount_cr != null);
  if (guidance.length >= 2) {
    body.append(h('div', { class: 'chart-lg', id: 'chart-company' }));
    drawHistoryChart(guidance);
  }

  // full observations table
  const table = h('table', { class: 'tbl' });
  table.append(h('thead', {}, h('tr', {}, ...['Date', 'Year', 'Type', 'Amount', '₹ Cr', 'What for', 'Filing'].map((t) => h('th', {}, t)))));
  const tb = h('tbody');
  for (const o of [...obs].reverse()) {
    tb.append(h('tr', {},
      h('td', { class: 'num', style: 'color:var(--muted)' }, fmtDate(o.date)),
      h('td', {}, o.fiscal_year || '—'),
      h('td', {}, o.event_type || o.type || '—'),
      h('td', { class: 'num' }, o.amount_text || '—'),
      h('td', { class: 'num', style: 'font-weight:700' }, fmtCr(o.amount_cr)),
      h('td', {}, o.segment_or_project || '—'),
      h('td', {}, o.source_pdf ? h('a', { href: o.source_pdf, target: '_blank', rel: 'noopener' }, 'open') : '—')));
  }
  table.append(tb);
  body.append(table);

  document.getElementById('modal').classList.add('show');
  requestAnimationFrame(resizeCharts);
}
function closeHistory() { document.getElementById('modal').classList.remove('show'); disposeCharts(); }

function drawHistoryChart(guidance) {
  const byFY = {};
  for (const o of guidance) (byFY[o.fiscal_year] ||= []).push(o);
  const fys = Object.keys(byFY).sort();
  const series = fys.map((fy, i) => {
    const color = PALETTE[i % PALETTE.length];
    return {
      name: fy, type: 'line', step: 'end', showSymbol: true, symbolSize: 9,
      lineStyle: { width: 3, color }, itemStyle: { color }, areaStyle: { color: CHART.areaGradient(color) },
      data: byFY[fy].map((o) => ({ value: [o.date, o.amount_cr], amount_text: o.amount_text })),
    };
  });
  newChart(document.getElementById('chart-company'), {
    color: PALETTE,
    legend: { top: 0, icon: 'circle', textStyle: { color: getComputedStyle(document.body).getPropertyValue('--muted') } },
    grid: { left: 8, right: 18, top: 34, bottom: 8, containLabel: true },
    tooltip: {
      ...CHART.tooltip('#8B5CF6'), trigger: 'item', confine: true,
      formatter: (p) => `<b>${p.seriesName}</b> · ${fmtDate(p.data.value[0])}<br/><span style="font-weight:700">${fmtCr(p.data.value[1])}</span> ${p.data.amount_text || ''}`,
    },
    xAxis: { type: 'time', axisLabel: { ...CHART.axisLabel }, axisLine: { lineStyle: { color: 'var(--line)' } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { ...CHART.axisLabel, formatter: (v) => fmtCrAxis(v) }, splitLine: CHART.splitLine },
    series,
  });
}

// ---- boot ----------------------------------------------------------------
async function boot() {
  await loadData();
  const meta = state.metadata;
  document.getElementById('updated').textContent = meta?.last_run
    ? `updated ${fmtDate(meta.last_run)}${DEMO ? ' · demo' : ''}` : (DEMO ? 'demo preview' : 'building…');
  buildControls();
  refresh();

  const modal = document.getElementById('modal');
  modal.addEventListener('click', (ev) => { if (ev.target === modal) closeHistory(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeHistory(); });
  window.addEventListener('resize', () => { if (modal.classList.contains('show')) resizeCharts(); });
}
boot();
