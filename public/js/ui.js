// public/js/ui.js
// Design-system helpers: colors, formatters, a tiny DOM builder, an empty-state,
// and a shared ECharts theme/registry (rounded colorful tooltips, de-cluttered
// axes, auto-resize). Dependency-free beyond the CDN globals (echarts, lucide).

// Colorful categorical palette (from the brief).
export const PALETTE = [
  '#6366F1', '#8B5CF6', '#A855F7', '#EC4899', '#F43F5E', '#F59E0B',
  '#10B981', '#14B8A6', '#06B6D4', '#3B82F6', '#F97316', '#84CC16', '#0EA5E9',
];
// Semantic colors — capex UP = green, DOWN = red. Used everywhere consistently.
export const SEMANTIC = { up: '#10B981', down: '#F43F5E', flat: '#94A3B8', neutral: '#8B5CF6' };

// ---- formatters ----------------------------------------------------------
export const fmtCr = (n) =>
  n == null || Number.isNaN(Number(n)) ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;

export const fmtCrAxis = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export const fmtSignedCr = (n) =>
  n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtCr(Math.abs(n))}`;

export const fmtPct = (n) => (n == null ? '' : `${n > 0 ? '+' : ''}${n}%`);

// External market context (approx). Market cap compacts to "L Cr" (lakh crore)
// once it crosses ₹1,00,000 Cr so big caps stay readable.
export const fmtMktCap = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 100000) return `₹${(v / 100000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L Cr`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
};
export const fmtPE = (n) =>
  (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 }));

// Canonical event-type tag -> chip style. Each label is visually distinct.
export const EVENT_TYPE_STYLES = {
  'New Project': { bg: '#EEF2FF', color: '#4F46E5', icon: 'sparkles' },
  'Capacity Expansion': { bg: '#ECFEFF', color: '#0E7490', icon: 'factory' },
  'Capex ↑': { bg: 'rgba(16,185,129,.12)', color: '#059669', icon: 'trending-up' },
  'Capex ↓': { bg: 'rgba(244,63,94,.12)', color: '#E11D48', icon: 'trending-down' },
  'Guidance revision': { bg: '#F5F3FF', color: '#7C3AED', icon: 'pencil-line' },
  'Quarterly capex': { bg: '#EFF6FF', color: '#2563EB', icon: 'calendar-days' },
  'Acquisition (M&A)': { bg: '#FFF7ED', color: '#C2410C', icon: 'handshake' },
};
export const eventTypeStyle = (t) => EVENT_TYPE_STYLES[t] || { bg: '#F1F5F9', color: '#475569', icon: 'tag' };

export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Week concept (Phase 4.1) — mirrors scripts/lib/util.mjs weekOf(): a Mon–Sun
// label like "7–13 Sep 2026", derived deterministically from the UTC calendar
// date. `key` is the Monday as YYYYMMDD (sortable). Returns null on a bad date.
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _pad2 = (n) => String(n).padStart(2, '0');
const _ymd = (d) => `${d.getUTCFullYear()}${_pad2(d.getUTCMonth() + 1)}${_pad2(d.getUTCDate())}`;
export function weekOf(input) {
  const s = String(input ?? '');
  let d;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  else { const t = new Date(s); if (Number.isNaN(t.getTime())) return null; d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())); }
  const diffToMon = (d.getUTCDay() + 6) % 7;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - diffToMon);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const dM = mon.getUTCDate(), dS = sun.getUTCDate();
  const moM = MONTHS_SHORT[mon.getUTCMonth()], moS = MONTHS_SHORT[sun.getUTCMonth()];
  const yM = mon.getUTCFullYear(), yS = sun.getUTCFullYear();
  const label = (yM === yS && mon.getUTCMonth() === sun.getUTCMonth()) ? `${dM}–${dS} ${moM} ${yM}`
    : (yM === yS) ? `${dM} ${moM} – ${dS} ${moS} ${yM}`
      : `${dM} ${moM} ${yM} – ${dS} ${moS} ${yS}`;
  return { key: _ymd(mon), label, startISO: mon.toISOString(), endISO: sun.toISOString() };
}

// M&A accuracy filter — mirrors scripts/lib/util.mjs isGenuineAcquisition(). Keeps
// genuine acquisitions / stake purchases / mergers / takeovers / slump sales and
// drops debt & capital-raising (NCD, QIP, rights issue, preferential allotment,
// warrants, commercial paper, buybacks, debt prepayment, resolution-plan payments)
// plus rupee-as-crore mis-parses. Keep the two in sync.
const _ACQ_SIGNAL = /\bacquisitions?\b|\bacquir(?:e|es|ed|ing)\b|\bstake\b|\bmerger\b|amalgamat\w*|\btakeover\b|take[- ]over|\bbuyout\b|buy[- ]?out|controlling (?:stake|interest)|majority (?:stake|interest)|share purchase agreement|\bslump sale\b|scheme of arrangement|\bopen offer\b|enterprise value|definitive agreement|binding agreement|wholly[- ]owned subsidiary|cash-free|debt-free|voting rights/i;
const _NOT_ACQ = /\bncd\b|non-convertible debenture|rights issue|\bqip\b|qualified institutional placement|preferential (?:allotment|issue)|\bwarrants?\b|commercial paper|equity capital (?:raise|infusion)|equity raise|fund[- ]?rais(?:e|es|ed|ing)|\bbuy-?back\b|debt prepay\w*|\bprepaid\b|prepay\w*|resolution plan|\bnclt\b/i;
function _looksRupeeMisparse(o) {
  const q = String(o.quote || ''); const at = String(o.amount_text || '');
  return /shares?\s+of\s+(?:rs\.?|₹)\s*10\/?-?\s*each/i.test(q) || (/\/-/.test(at) && /equity shares?|subscri/i.test(q));
}
export function isGenuineAcquisition(o = {}) {
  const q = String(o.quote || '');
  if (!_ACQ_SIGNAL.test(q)) return false;
  if (_NOT_ACQ.test(q)) return false;
  if (o.amount_cr != null && o.amount_cr > 150000) return false;
  if (_looksRupeeMisparse(o)) return false;
  return true;
}

export const debounce = (fn, ms = 150) => {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

// Tiny DOM builder: h('div', {class:'x', onclick:fn}, child, 'text', [more]).
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const icons = () => window.lucide && window.lucide.createIcons();

// Friendly, on-brand empty state (returned as an element).
export function emptyState({ icon = 'inbox', title, msg }) {
  return h('div', { class: 'card', style: 'padding:48px 28px;text-align:center' },
    h('div', {
      class: 'mx-auto mb-4 grid place-items-center',
      style: 'width:64px;height:64px;border-radius:20px;color:#fff;background:linear-gradient(135deg,var(--i1),var(--pink))',
    }, h('i', { 'data-lucide': icon, style: 'width:28px;height:28px' })),
    h('h3', { class: 'font-display text-lg font-bold mb-1.5' }, title),
    h('p', { style: 'color:var(--muted);max-width:34rem;margin:0 auto;font-size:14px;line-height:1.6' }, msg),
  );
}

// ---- ECharts registry ----------------------------------------------------
const _charts = [];

const tooltipTheme = (accent = '#8B5CF6') => ({
  trigger: 'item',
  backgroundColor: '#ffffff',
  borderColor: accent,
  borderWidth: 1.5,
  padding: [10, 14],
  extraCssText: 'border-radius:14px;box-shadow:0 16px 40px rgba(20,21,42,.16);',
  textStyle: { color: '#14152A', fontFamily: 'Inter, sans-serif', fontSize: 13 },
});

export const CHART = {
  palette: PALETTE,
  tooltip: tooltipTheme,
  textStyle: { fontFamily: 'Inter, sans-serif', color: '#6B7280' },
  axisLabel: { color: '#6B7280', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
  splitLine: { lineStyle: { color: '#EFEDF7', type: 'dashed' } },
  // soft vertical area gradient for line charts
  areaGradient(hex) {
    return {
      type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
      colorStops: [{ offset: 0, color: hex + '55' }, { offset: 1, color: hex + '05' }],
    };
  },
};

/** Create (or replace) an ECharts instance on a container element. */
export function newChart(elm, option) {
  if (!elm || typeof echarts === 'undefined') return null; // resilient to a CDN hiccup
  const existing = echarts.getInstanceByDom(elm);
  if (existing) existing.dispose();
  const inst = echarts.init(elm, null, { renderer: 'canvas' });
  inst.setOption(option);
  _charts.push(inst);
  return inst;
}

/** Dispose every tracked chart (call before re-rendering a tab). */
export function disposeCharts() {
  while (_charts.length) { const c = _charts.pop(); try { c.dispose(); } catch {} }
}

export function resizeCharts() {
  for (const c of _charts) { try { c.resize(); } catch {} }
}

window.addEventListener('resize', debounce(resizeCharts, 160));
