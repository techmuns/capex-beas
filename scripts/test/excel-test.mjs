// scripts/test/excel-test.mjs
// Smoke test for the client-side Excel builder (public/js/excel.js). Runs the
// pure buildWorkbook() on a small fixture with a REAL ExcelJS and checks the
// workbook shape (title band, headers, data, 2nd sheet, hyperlink, buffer),
// plus the CSV fallback and filename. Skips cleanly if exceljs isn't installed
// (it's a --no-save dev dep, kept out of package.json like pdfjs-dist).
//
// Run:  npm install exceljs --no-save && node scripts/test/excel-test.mjs

import { buildWorkbook, buildCsv, excelFilename, COLUMNS } from '../../public/js/excel.js';

let ExcelJS;
try {
  ExcelJS = (await import('exceljs')).default || (await import('exceljs'));
} catch {
  console.log('SKIP excel smoke test — exceljs not installed (npm install exceljs --no-save to run it)');
  process.exit(0);
}

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const ok = (name, cond) => eq(name, !!cond, true);

const rows = [
  { company: 'ASK Automotive Ltd', scrip_cd: 544022, date: '2026-08-10T10:00:00', week: '10–16 Aug 2026', event_type: 'Capex ↑', type_display: 'Capex Guidance ↑', summary: 'Raised FY27 capex from ₹500 to ₹700 Cr', guidance_change: 'Capex guidance raised ₹500→₹700 Cr (+40%)', capex_cr: 700, old_new: '₹500 → ₹700', pct: 0.4, direction: 'up', market_cap_cr: 12500, pe: 34.2, industry: 'Auto Ancillaries', source: 'https://www.bseindia.com/x/b.pdf', is_change: true },
  { company: 'Surya Power Ltd', scrip_cd: 532666, date: '2026-09-01T10:00:00', week: '31 Aug – 6 Sep 2026', event_type: 'New Project', type_display: 'New Project', summary: 'First FY26 capex reading: ₹1,200 Cr', guidance_change: 'New capex guidance issued', capex_cr: 1200, old_new: '— → ₹1,200', pct: null, direction: 'first reading', market_cap_cr: null, pe: null, industry: '', source: '', is_change: false },
];

const wb = buildWorkbook(ExcelJS, rows);

// Two sheets: the full tracker + a "Guidance Changes" sheet (1 real change here).
eq('two worksheets', wb.worksheets.map((w) => w.name), ['Capex Tracker', 'Guidance Changes']);

const ws = wb.getWorksheet('Capex Tracker');
ok('title band mentions the product', String(ws.getCell('A1').value).includes('Capex Change Monitor'));
ok('title band counts 2 companies', String(ws.getCell('A1').value).includes('2 companies'));
// Client column order: Company · Announcement Date · Type · Announcement Summary ·
// Capex / Project Value · Capex Guidance Change · Market Cap · P/E · Industry · Source · …extras
eq('col 1 Company', ws.getRow(3).getCell(1).value, 'Company');
eq('col 2 Announcement Date', ws.getRow(3).getCell(2).value, 'Announcement Date');
eq('col 3 Type', ws.getRow(3).getCell(3).value, 'Type');
eq('col 4 Announcement Summary', ws.getRow(3).getCell(4).value, 'Announcement Summary');
eq('col 6 Capex Guidance Change', ws.getRow(3).getCell(6).value, 'Capex Guidance Change');
eq('col 10 Source', ws.getRow(3).getCell(10).value, 'Source');
eq('last col Scrip', ws.getRow(3).getCell(COLUMNS.length).value, 'Scrip');
eq('data row 4 company', ws.getRow(4).getCell(1).value, 'ASK Automotive Ltd');
eq('Type shows client vocabulary', ws.getRow(4).getCell(3).value, 'Capex Guidance ↑');
eq('capex is numeric (col 5)', ws.getRow(4).getCell(5).value, 700);
eq('guidance-change note (col 6)', ws.getRow(4).getCell(6).value, 'Capex guidance raised ₹500→₹700 Cr (+40%)');
ok('source cell is a hyperlink (col 10)', ws.getRow(4).getCell(10).value?.hyperlink === 'https://www.bseindia.com/x/b.pdf');
ok('date cell is a Date (col 2)', ws.getRow(4).getCell(2).value instanceof Date);
ok('frozen header + first column', ws.views?.[0]?.state === 'frozen' && ws.views[0].ySplit === 3 && ws.views[0].xSplit === 1);
ok('auto-filter set from header row', ws.autoFilter && ws.autoFilter.from.row === 3);

const gc = wb.getWorksheet('Guidance Changes');
eq('guidance sheet has only the real change', gc.getRow(4).getCell(1).value, 'ASK Automotive Ltd');
ok('guidance sheet has no 2nd data row', gc.getRow(5).getCell(1).value == null);

const buf = await wb.xlsx.writeBuffer();
ok('workbook writes a non-trivial buffer', buf && buf.byteLength > 2000);

// CSV fallback + filename.
const csv = buildCsv(rows);
ok('csv header in client order', csv.startsWith('Company,Announcement Date,Type,Announcement Summary,Capex / Project Value (Rs Cr),Capex Guidance Change'));
ok('csv has a data row', csv.includes('ASK Automotive Ltd'));
ok('csv Type uses client vocabulary', csv.includes('Capex Guidance ↑'));
ok('csv renders pct as %', csv.includes('+40.0%') || csv.includes('40.0%'));
eq('filename spans the date range', excelFilename(rows), 'capex_tracker_2026-08-10_2026-09-01.xlsx');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
