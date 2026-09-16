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

export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
