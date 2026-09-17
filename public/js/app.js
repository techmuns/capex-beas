// public/js/app.js
// ONE screen: a plain-English feed of companies that changed how much they plan
// to spend on new plants & machines. Header · summary line · controls · list of
// event cards · (company name → full-history modal). Always source-backed; the
// backend, Excel export, email Brief, Week filter and enrichment are untouched.

import {
  h, fmtCr, fmtCrAxis, fmtMktCap, fmtPE, fmtDate, weekOf, isGenuineAcquisition,
  newChart, disposeCharts, resizeCharts, CHART, PALETTE,
} from './ui.js';
import { downloadExcel } from './excel.js';

// ?demo=1 loads a local, git-ignored fixture so the populated layout can be
// eyeballed. Shipped data files stay empty; nothing fake is ever committed.
const DEMO = new URLSearchParams(location.search).has('demo');
const BASE = DEMO ? './demo' : './data';

const state = { changes: [], history: {}, metadata: null, enrichment: {} };
// period: 30|90|180|all|custom · show: changes|up|down|routine|mna · from/to: YYYY-MM-DD (custom)
const ui = { period: 'all', from: '', to: '', show: 'changes', q: '' };

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

// ---- events --------------------------------------------------------------
// A "kind" drives the row stripe + pill:
//   up = raised guidance · down = cut guidance · new = new plan (first reading)
//   · routine = a quarterly "actual" spend figure · mna = an acquisition / major
//   capital commitment. M&A is NEVER organic capex: it lives in its own bucket,
//   is never counted as a capex change, and never shows in the default view.
const eventTime = (e) => new Date(e.new_date || e.detected_at).getTime();
const dayOf = (e) => { const d = new Date(e.new_date || e.detected_at); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };
const kindOf = (c) => (c._actual ? 'routine' : c.no_prior_on_record ? 'new' : (c.direction === 'up' ? 'up' : 'down'));

// Build a pool row from a history observation of a given kind.
function histRow(o, kind) {
  return {
    company: o.company, scrip_cd: o.scrip_cd, fiscal_year: o.fiscal_year,
    event_type: o.event_type || (kind === 'mna' ? 'Acquisition (M&A)' : 'Quarterly capex'),
    old_cr: null, new_cr: o.amount_cr, amount_text: o.amount_text, delta_cr: null, pct_change: null,
    direction: 'unclear', reason: o.reason, new_quote: o.quote,
    new_pdf: o.source_pdf, new_date: o.date, week: o.week,
    no_prior_on_record: true, _kind: kind, _actual: kind === 'routine', _mna: kind === 'mna',
  };
}

function allEvents() {
  const evs = state.changes.map((c) => ({ ...c, _kind: kindOf(c) }));
  // Routine "quarterly / actual" capex and acquisitions (M&A) live in history,
  // not in the change feed. They're always in the pool but gated by Show:
  // routine only under "Include routine…", M&A only under "Major commitments".
  for (const scrip of Object.keys(state.history)) {
    for (const o of state.history[scrip]) {
      if (o.type === 'actual') { if (o.amount_cr != null) evs.push(histRow(o, 'routine')); }
      // M&A accuracy filter: only GENUINE acquisitions reach the bucket (drops
      // debt/fund-raising & mis-parses). Genuine deals with no ₹ figure are kept.
      else if (o.type === 'acquisition' && isGenuineAcquisition(o)) evs.push(histRow(o, 'mna'));
    }
  }
  return evs;
}

// Period selector (Part B): presets keep the last N days; "custom" uses [from,to].
const PERIOD_DAYS = { 30: 30, 90: 90, 180: 180 };
function inPeriod(e) {
  if (ui.period === 'all') return true;
  if (ui.period === 'custom') {
    const d = dayOf(e); if (!d) return false;
    if (ui.from && d < ui.from) return false;
    if (ui.to && d > ui.to) return false;
    return true;
  }
  const days = PERIOD_DAYS[ui.period] || 90;
  return eventTime(e) >= Date.now() - days * 86400000;
}
// Show selector (Part C + A3): merges direction, the old routine checkbox, and the
// M&A bucket. M&A (mna) only appears under its own option — never in any other view.
function passesShow(e) {
  switch (ui.show) {
    case 'up': return e._kind === 'up';
    case 'down': return e._kind === 'down';
    case 'mna': return e._kind === 'mna';                        // ONLY acquisitions
    case 'routine': return e._kind !== 'mna';                    // changes + new plans + routine
    default: return e._kind !== 'routine' && e._kind !== 'mna';  // "changes": neither routine nor M&A
  }
}
function filteredEvents() {
  const q = ui.q.trim().toLowerCase();
  return allEvents().filter((e) => {
    if (!passesShow(e)) return false;
    if (!inPeriod(e)) return false;
    if (q && !(e.company || '').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => eventTime(b) - eventTime(a));
}
const periodLabel = () => (
  ui.period === 'all' ? 'all time'
    : ui.period === 'custom' ? (ui.from && ui.to ? `${fmtDate(ui.from)} – ${fmtDate(ui.to)}` : 'custom range')
      : `last ${PERIOD_DAYS[ui.period]} days`);

// ---- summary line --------------------------------------------------------
function renderSummary() {
  const el = document.getElementById('summary');
  el.innerHTML = '';
  const evs = filteredEvents();
  if (!evs.length) return; // the list area carries the empty message
  // M&A is its own bucket — counted and described separately, never as capex.
  if (ui.show === 'mna') {
    const n = evs.filter((e) => e._kind === 'mna').length;
    el.append(
      h('span', {}, h('span', { class: 'big num' }, String(n)),
        ` major capital commitment${n === 1 ? '' : 's'} (M&A) — not organic capex`),
      h('span', { class: 'pipe' }, `· ${periodLabel()}`));
    return;
  }
  const changed = new Set(evs.filter((e) => e._kind === 'up' || e._kind === 'down').map((e) => e.scrip_cd)).size;
  const nNew = evs.filter((e) => e._kind === 'new').length;
  const nRoutine = evs.filter((e) => e._kind === 'routine').length;
  const parts = [
    h('span', {}, h('span', { class: 'big num' }, String(changed)),
      ` ${changed === 1 ? 'company' : 'companies'} changed their capex guidance`),
    h('span', { class: 'pipe' }, `· ${nNew} new plan${nNew === 1 ? '' : 's'}`),
  ];
  if (nRoutine) parts.push(h('span', { class: 'pipe' }, `· ${nRoutine} quarterly`));
  parts.push(h('span', { class: 'pipe' }, `· ${periodLabel()}`));
  el.append(...parts);
}

// ---- controls ------------------------------------------------------------
function buildControls() {
  const el = document.getElementById('controls');
  el.innerHTML = '';
  const fld = (label, node, cls) => h('div', { class: `fld ${cls || ''}` }, h('label', {}, label), node);

  // Part B — Period + custom range
  const periodSel = h('select', { id: 'f-period' },
    h('option', { value: '30' }, 'Last 30 days'),
    h('option', { value: '90' }, 'Last 90 days'),
    h('option', { value: '180' }, 'Last 180 days'),
    h('option', { value: 'all' }, 'All time'),
    h('option', { value: 'custom' }, 'Custom range…'));
  periodSel.value = ui.period;
  const from = h('input', { id: 'f-from', type: 'date', value: ui.from });
  const to = h('input', { id: 'f-to', type: 'date', value: ui.to });
  const range = h('div', { class: 'range', id: 'f-range' },
    fld('From', from), fld('To', to));
  range.style.display = ui.period === 'custom' ? 'flex' : 'none';

  // Part C — one "Show" dropdown (direction + the old routine checkbox, merged)
  const showSel = h('select', { id: 'f-show' },
    h('option', { value: 'changes' }, 'Changes & new plans'),
    h('option', { value: 'up' }, 'Only raised guidance'),
    h('option', { value: 'down' }, 'Only cut guidance'),
    h('option', { value: 'routine' }, '＋ Include routine quarterly spend'),
    h('option', { value: 'mna' }, 'Major commitments (M&A)'));
  showSel.value = ui.show;

  const q = h('input', { id: 'f-q', type: 'search', placeholder: 'e.g. ASK Automotive', value: ui.q });
  const dl = h('button', { class: 'btn solid', id: 'downloadBtn', type: 'button' }, '⬇️ Download Excel');

  el.append(fld('Period', periodSel), range, fld('Show', showSel),
    fld('Search company', q, 'grow'), dl);

  periodSel.addEventListener('change', (e) => {
    ui.period = e.target.value;
    range.style.display = ui.period === 'custom' ? 'flex' : 'none';
    refresh();
  });
  from.addEventListener('change', (e) => { ui.from = e.target.value; if (ui.period === 'custom') refresh(); });
  to.addEventListener('change', (e) => { ui.to = e.target.value; if (ui.period === 'custom') refresh(); });
  showSel.addEventListener('change', (e) => { ui.show = e.target.value; refresh(); });
  let qt; q.addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { ui.q = e.target.value; refresh(); }, 150); });
  dl.addEventListener('click', exportExcel);
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

// Our Type label → the client's tracker vocabulary (Excel display text only; the
// original event_type still drives the cell colour).
const TYPE_VOCAB = {
  'Capex ↑': 'Capex Guidance ↑',
  'Capex ↓': 'Capex Guidance ↓',
  'Guidance revision': 'Capex Guidance Change',
  'New Project': 'New Project',
  'Capacity Expansion': 'New Project (Capacity Expansion)',
  'Quarterly capex': 'Capex Update',
  'Acquisition (M&A)': 'Major Capital Commitment (M&A)',
};
const plainCr = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
// Plain-English "Capex Guidance Change" note — deterministic, source-backed.
function guidanceNote(e) {
  if (e._kind === 'mna') return 'Major investment commitment (acquisition, not organic capex)';
  if (e._kind === 'routine') return 'Quarterly capex update (not a guidance change)';
  if (e._kind === 'up') return `Capex guidance raised ₹${plainCr(e.old_cr)}→₹${plainCr(e.new_cr)} Cr (+${Math.round(e.pct_change)}%)`;
  if (e._kind === 'down') return `Capex guidance cut ₹${plainCr(e.old_cr)}→₹${plainCr(e.new_cr)} Cr (−${Math.abs(Math.round(e.pct_change))}%)`;
  return 'New capex guidance issued'; // new plan (no prior)
}

// Flat row for excel.js. Column ORDER is defined in excel.js; this supplies the
// fields (respects the current filters). event_type stays original for colour;
// type_display carries the client's vocabulary.
function toExportRow(e) {
  const en = enrichOf(e.scrip_cd) || {};
  const real = !e.no_prior_on_record;
  const plain = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  const summary = e.reason || headlineText(e);
  return {
    company: e.company || '', scrip_cd: e.scrip_cd ?? '', date: e.new_date || null,
    week: e.week || weekOf(e.new_date || e.detected_at)?.label || '',
    event_type: e.event_type || '', type_display: TYPE_VOCAB[e.event_type] || e.event_type || '',
    summary, guidance_change: guidanceNote(e),
    capex_cr: e.new_cr ?? null,
    old_new: (e.old_cr != null) ? `${plain(e.old_cr)} → ${plain(e.new_cr)}` : (e.new_cr != null ? plain(e.new_cr) : '—'),
    pct: (e.pct_change == null ? null : e.pct_change / 100),
    direction: e._mna ? 'M&A' : (real ? (e.direction || '') : 'new'),
    market_cap_cr: en.market_cap_cr ?? null, pe: en.pe ?? null, industry: en.industry || '',
    source: e.new_pdf || '', is_change: real,
  };
}

// ---- the table (Part A) --------------------------------------------------
function refresh() { renderSummary(); renderList(); }

// kind → pill label + stripe/pill class.
const KIND = {
  up: { pill: '▲ Raised guidance', cls: 'k-up' },
  down: { pill: '▼ Cut guidance', cls: 'k-down' },
  new: { pill: '✦ New plan', cls: 'k-new' },
  routine: { pill: 'Quarterly spend', cls: 'k-routine' },
  mna: { pill: '🤝 M&A — not organic capex', cls: 'k-mna' },
};
const fyPart = (e) => (e.fiscal_year ? `${e.fiscal_year} ` : '');

// "Capex plan" cell: a change shows "₹old → ₹new" + a delta chip; a new plan /
// routine figure shows just the single amount.
function planCell(e) {
  if (e._kind === 'up' || e._kind === 'down') {
    const p = Math.round(e.pct_change ?? 0);
    const chip = h('span', { class: `delta ${e._kind === 'up' ? 'up' : 'down'} num` },
      `${p >= 0 ? '+' : '−'}${Math.abs(p)}%`);
    return h('td', { class: 'num' },
      h('span', {}, fmtCr(e.old_cr)), h('span', { class: 'arw' }, '→'),
      h('span', {}, fmtCr(e.new_cr)), chip);
  }
  // M&A: show the deal value the filing literally stated (verbatim, source-backed
  // — avoids normalizing "approximately 21% stake" into a bogus ₹ figure).
  if (e._kind === 'mna') return h('td', {}, e.amount_text || fmtCr(e.new_cr));
  return h('td', { class: 'num' }, fmtCr(e.new_cr));
}

function tableRow(e) {
  const k = KIND[e._kind] || KIND.new;
  const en = enrichOf(e.scrip_cd);

  // Company — bold name (opens the history modal), grey enrichment subline.
  const co = h('span', { class: 'co', role: 'button', tabindex: '0' }, e.company);
  const open = () => openHistory(e.scrip_cd);
  co.addEventListener('click', open);
  co.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
  const sub = [];
  if (en?.industry) sub.push(en.industry);
  if (en?.market_cap_cr != null) sub.push(`${fmtMktCap(en.market_cap_cr)} mkt cap`);
  const companyCell = h('td', {}, co, sub.length ? h('div', { class: 'sub2' }, sub.join(' · ')) : null);

  // What happened — colored pill + fiscal year.
  const happened = h('td', {},
    h('span', { class: `pill ${k.cls}` }, k.pill),
    e.fiscal_year ? h('span', { class: 'fy num' }, e.fiscal_year) : null);

  // Source — link to the real BSE filing PDF.
  const src = e.new_pdf
    ? h('a', { class: 'src', href: e.new_pdf, target: '_blank', rel: 'noopener' }, 'See the filing →')
    : h('span', { style: 'color:var(--muted)' }, '—');

  return h('tr', { class: k.cls },
    companyCell, happened, planCell(e),
    h('td', { class: 'num when' }, fmtDate(e.new_date)),
    h('td', {}, src));
}

function renderList() {
  const list = document.getElementById('list');
  const none = document.getElementById('none');
  list.innerHTML = '';
  const evs = filteredEvents();
  if (!evs.length) {
    list.style.display = 'none';
    none.style.display = 'block';
    none.textContent = allEvents().length
      ? 'No companies match — try a wider period, a different Show filter, or clear the search.'
      : 'No capex changes recorded yet — as companies file, they’ll appear here, each backed by its BSE filing.';
    return;
  }
  none.style.display = 'none';
  list.style.display = 'block';
  const head = h('thead', {}, h('tr', {},
    ...['Company', 'What happened', 'Capex plan', 'When', 'Source'].map((t) => h('th', {}, t))));
  const body = h('tbody');
  for (const e of evs) body.append(tableRow(e));
  list.append(h('div', { class: 'tablewrap' }, h('table', { class: 'dt' }, head, body)));
}

// Plain-text version, used by the Excel export summary column.
function headlineText(e) {
  if (e._kind === 'mna') return `Announced ${e.amount_text || (e.new_cr != null ? fmtCr(e.new_cr) : '')} acquisition`.replace(/\s+/g, ' ').trim();
  if (e._kind === 'up') return `Raised ${fyPart(e)}capex ${fmtCr(e.old_cr)} → ${fmtCr(e.new_cr)}`;
  if (e._kind === 'down') return `Trimmed ${fyPart(e)}capex ${fmtCr(e.old_cr)} → ${fmtCr(e.new_cr)}`;
  if (e._actual) return `Reported ${fyPart(e)}capex of ${fmtCr(e.new_cr)}`;
  if (e.event_type === 'New Project') return `New ${fmtCr(e.new_cr)} expansion announced`;
  if (e.event_type === 'Capacity Expansion') return `New ${fmtCr(e.new_cr)} capacity expansion`;
  return `New ${fyPart(e)}capex plan: ${fmtCr(e.new_cr)}`;
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
