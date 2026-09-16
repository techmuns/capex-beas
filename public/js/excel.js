// public/js/excel.js
// Client-side "Download Excel" — builds a polished, client-ready .xlsx from the
// currently-filtered change rows using ExcelJS (loaded from a CDN <script>, so
// `window.ExcelJS` is a global). If ExcelJS didn't load, we fall back to CSV.
//
// This module is DEPENDENCY-FREE and references no DOM at import time, so
// `buildWorkbook(ExcelJS, rows)` can be unit-tested in Node with a real ExcelJS.
// The caller passes fully-prepared plain rows (see the shape in app.js
// toExportRow) — this module only lays them out and styles them.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Column layout (single source of truth for both the workbook and the CSV).
export const COLUMNS = [
  { key: 'company', header: 'Company', width: 26 },
  { key: 'scrip_cd', header: 'Scrip', width: 10 },
  { key: 'date', header: 'Date', width: 13, kind: 'date' },
  { key: 'week', header: 'Week', width: 18 },
  { key: 'event_type', header: 'Type', width: 18, wrap: true },
  { key: 'summary', header: 'Summary', width: 60, wrap: true },
  { key: 'capex_cr', header: 'Capex (₹Cr)', width: 14, numFmt: '#,##0', kind: 'num' },
  { key: 'old_new', header: 'Old → New', width: 20 },
  { key: 'pct', header: 'Change %', width: 12, numFmt: '+0.0%;-0.0%', kind: 'num' },
  { key: 'direction', header: 'Direction', width: 12 },
  { key: 'market_cap_cr', header: 'Market Cap (₹Cr)', width: 16, numFmt: '#,##0', kind: 'num' },
  { key: 'pe', header: 'P/E', width: 8, numFmt: '0.0', kind: 'num' },
  { key: 'industry', header: 'Industry', width: 22 },
  { key: 'source', header: 'Source', width: 14, kind: 'link' },
];

const BRAND = 'FF6366F1';
const WHITE = 'FFFFFFFF';
const ZEBRA = 'FFF7F7FB';
const BORDER = 'FFE5E7EB';
const MUTED = 'FF6B7280';

// event_type -> { fill (light), font (strong) }
const TYPE_STYLE = {
  'New Project': { fill: 'FFEEF2FF', font: 'FF4F46E5' },
  'Capacity Expansion': { fill: 'FFECFEFF', font: 'FF0E7490' },
  'Capex ↑': { fill: 'FFE7F8F0', font: 'FF059669' },
  'Capex ↓': { fill: 'FFFDECEF', font: 'FFE11D48' },
  'Guidance revision': { fill: 'FFF5F3FF', font: 'FF7C3AED' },
  'Quarterly capex': { fill: 'FFEFF6FF', font: 'FF2563EB' },
  'Acquisition (M&A)': { fill: 'FFF1F5F9', font: 'FF475569' },
};
const dirFont = (d) => (d === 'up' ? 'FF059669' : d === 'down' ? 'FFE11D48' : 'FF64748B');

const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thinBorder = () => {
  const s = { style: 'thin', color: { argb: BORDER } };
  return { top: s, left: s, right: s, bottom: s };
};

function toDate(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const fmtDMY = (d) => (d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '—');
const fnDate = (d) => (d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` : 'na');

function dateRange(rows) {
  const ds = rows.map((r) => toDate(r.date)).filter(Boolean);
  if (!ds.length) return { min: null, max: null };
  return { min: new Date(Math.min(...ds)), max: new Date(Math.max(...ds)) };
}

function applyCell(cell, col, r) {
  const v = r[col.key];
  switch (col.key) {
    case 'date':
      cell.value = toDate(v); cell.numFmt = 'dd mmm yyyy'; break;
    case 'source':
      if (v) { cell.value = { text: 'Open filing', hyperlink: v }; cell.font = { color: { argb: 'FF2563EB' }, underline: true }; }
      else cell.value = 'N/A';
      break;
    case 'event_type': {
      cell.value = v || '';
      const st = TYPE_STYLE[v];
      if (st) { cell.fill = solid(st.fill); cell.font = { bold: true, color: { argb: st.font } }; }
      break;
    }
    case 'pct':
      cell.value = (v == null ? null : v); // stored as a fraction; numFmt renders %
      if (v != null) cell.font = { color: { argb: v >= 0 ? 'FF059669' : 'FFE11D48' } };
      break;
    case 'direction':
      cell.value = v || '';
      cell.font = { color: { argb: dirFont(r.direction) } };
      break;
    case 'old_new':
      cell.value = v || '';
      if (r.is_change) cell.font = { color: { argb: dirFont(r.direction) } };
      break;
    case 'capex_cr':
      cell.value = (v == null ? null : Number(v)); break;
    case 'market_cap_cr':
    case 'pe':
      cell.value = (v == null ? null : Number(v));
      if (v != null) cell.font = { italic: true, color: { argb: MUTED } };
      break;
    case 'scrip_cd':
      cell.value = (v === '' || v == null) ? '' : Number(v); break;
    default:
      cell.value = (v == null ? '' : v);
  }
}

function buildSheet(wb, name, rows) {
  const nCols = COLUMNS.length;
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] });
  COLUMNS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  // Row 1 — title band (merged, brand fill, white bold).
  ws.mergeCells(1, 1, 1, nCols);
  const { min, max } = dateRange(rows);
  const nCo = new Set(rows.map((r) => r.company).filter(Boolean)).size;
  const t = ws.getCell(1, 1);
  t.value = `Capex Change Monitor — ${nCo} ${nCo === 1 ? 'company' : 'companies'} · ${fmtDMY(min)}–${fmtDMY(max)}`;
  t.fill = solid(BRAND);
  t.font = { name: 'Calibri', size: 16, bold: true, color: { argb: WHITE } };
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 30;

  // Row 2 — subtitle (muted).
  ws.mergeCells(2, 1, 2, nCols);
  const s = ws.getCell(2, 1);
  s.value = 'Every capex figure is source-backed to a BSE filing. Market Cap / P/E are approximate snapshots.';
  s.font = { italic: true, size: 10, color: { argb: MUTED } };
  s.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 18;

  // Row 3 — header (brand fill, white bold, centered).
  const hr = ws.getRow(3);
  COLUMNS.forEach((c, i) => {
    const cell = hr.getCell(i + 1);
    cell.value = c.header;
    cell.fill = solid(BRAND);
    cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  });
  hr.height = 28;

  // Data rows from row 4.
  rows.forEach((r, idx) => {
    const row = ws.getRow(4 + idx);
    const zebra = idx % 2 === 1;
    COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.border = thinBorder();
      if (zebra) cell.fill = solid(ZEBRA);
      applyCell(cell, c, r); // may override fill (Type) / font
      const base = c.wrap ? { wrapText: true, vertical: 'top' } : { vertical: 'middle' };
      cell.alignment = { ...base, ...(cell.alignment || {}) };
      if (c.numFmt && cell.numFmt == null) cell.numFmt = c.numFmt;
    });
  });

  // Excel auto-filter across the header + data range.
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + rows.length, column: nCols } };
  return ws;
}

/** Pure: build (but don't save) the workbook. Testable in Node with real ExcelJS. */
export function buildWorkbook(ExcelJS, rows, opts = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Capex Change Monitor';
  wb.created = new Date();
  buildSheet(wb, opts.sheetName || 'Capex Tracker', rows || []);
  const changesOnly = (rows || []).filter((r) => r.is_change);
  if (changesOnly.length) buildSheet(wb, 'Guidance Changes', changesOnly);
  return wb;
}

/** Compute the download filename from the rows' date span. */
export function excelFilename(rows, ext = 'xlsx') {
  const { min, max } = dateRange(rows || []);
  return `capex_tracker_${fnDate(min)}_${fnDate(max)}.${ext}`;
}

// ---- CSV fallback --------------------------------------------------------
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function buildCsv(rows) {
  const head = COLUMNS.map((c) => csvCell(c.header)).join(',');
  const body = (rows || []).map((r) => COLUMNS.map((c) => {
    if (c.key === 'source') return csvCell(r.source || '');
    if (c.key === 'pct') return csvCell(r.pct == null ? '' : `${(r.pct * 100).toFixed(1)}%`);
    if (c.key === 'date') { const d = toDate(r.date); return csvCell(d ? fnDate(d) : ''); }
    return csvCell(r[c.key]);
  }).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

// ---- browser download ----------------------------------------------------
function saveBlob(blob, filename) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

function downloadCsv(rows) {
  saveBlob(new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' }), excelFilename(rows, 'csv'));
}

/** Build + download the .xlsx (or CSV if ExcelJS didn't load / fails). */
export async function downloadExcel(rows, opts = {}) {
  const ExcelJS = (typeof window !== 'undefined') && window.ExcelJS;
  if (!ExcelJS) { downloadCsv(rows); return { ok: true, format: 'csv' }; }
  try {
    const wb = buildWorkbook(ExcelJS, rows, opts);
    const buf = await wb.xlsx.writeBuffer();
    saveBlob(
      new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      excelFilename(rows, 'xlsx'),
    );
    return { ok: true, format: 'xlsx' };
  } catch (e) {
    console.error('Excel build failed; falling back to CSV', e);
    downloadCsv(rows);
    return { ok: true, format: 'csv', error: String(e) };
  }
}
