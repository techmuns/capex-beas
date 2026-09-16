// scripts/fetch-announcements.mjs
// Pull the BSE announcements feed for a date window and CHEAPLY prefilter it
// (on HEADLINE / NEWSSUB / SUBCATNAME) down to the filings that plausibly carry
// capex guidance — before we download a single PDF.
//
// CLI:  node scripts/fetch-announcements.mjs --from=20250601 --to=20250605
//       (prints the kept candidates as JSON to stdout; logs go to stderr)

import { fetchAnnouncementsForDay, attachLiveUrl, attachHisUrl } from './lib/bse.mjs';
import { dayRange, normText, log, parseArgs, ymd, todayUTC, addDays } from './lib/util.mjs';

// Subcategories where forward-looking capex GUIDANCE actually shows up: investor
// decks, analyst/institutional meets, con-calls / earnings-call transcripts, and
// media releases. We deliberately do NOT keep the "Financial Results" subcat here
// — on a results day that alone is ~900 filings/day (raw financial statements that
// rarely state forward capex), and the guidance for those companies is filed
// separately as the accompanying deck / con-call, which these hints catch.
const HIGH_SIGNAL_SUBCAT_HINTS = [
  'investor presentation',
  'analyst',            // "Analysts/Institutional Investor Meet", "Analyst / Investor Meet"
  'investor meet',
  'con call', 'concall', 'con. call', 'conference call', 'earnings call', 'earnings',
  'press release', 'media release',
];

// Opt-in broad mode (CAPEX_BROAD=1): also keep every Result / Board Meeting filing
// and the Financial Results subcat. Much higher LLM cost; use only if you want
// maximum recall and have the budget. Default is the tight, guidance-focused set.
const BROAD = process.env.CAPEX_BROAD === '1';

// Capex signal words. A hit in the headline/subject keeps the filing regardless
// of category. Kept lowercase; matched against normalized text.
const CAPEX_KEYWORDS = [
  'capex', 'capital expenditure', 'capital outlay', 'capital investment',
  'capacity expansion', 'capacity addition', 'greenfield', 'brownfield',
  'debottlenecking', 'new plant', 'expansion', 'mtpa', 'commissioning',
  'capital work-in-progress', 'capital work in progress', 'cwip',
  'ramp-up', 'ramp up', 'setting up', 'set up a', 'invest ', 'investment of',
];
// " mw" is matched separately so it doesn't fire inside words like "mwh review".
const MW_RE = /\b\d[\d,.]*\s?mw\b/i;

function matchReasons(rec) {
  const reasons = [];
  const cat = normText(rec.CATEGORYNAME);
  const sub = normText(rec.SUBCATNAME);
  const hay = normText(`${rec.HEADLINE || ''} ${rec.NEWSSUB || ''}`);

  const kw = CAPEX_KEYWORDS.filter((k) => hay.includes(k));
  if (kw.length) reasons.push(`keyword:${kw.slice(0, 3).join('|')}`);
  if (MW_RE.test(rec.HEADLINE || '') || MW_RE.test(rec.NEWSSUB || '')) reasons.push('keyword:MW');

  if (HIGH_SIGNAL_SUBCAT_HINTS.some((h) => sub.includes(h))) reasons.push(`subcat:${rec.SUBCATNAME}`);
  if (rec.Investor_Presentation) reasons.push('flag:investor_presentation');

  // Broad, high-cost keeps — only in opt-in broad mode.
  if (BROAD && sub.includes('financial results')) reasons.push('subcat:FinancialResults');
  if (BROAD && cat === 'result') reasons.push('category:Result');
  if (BROAD && cat === 'board meeting') reasons.push('category:BoardMeeting');

  return reasons;
}

/** Turn a raw BSE record into our internal candidate shape. */
function toCandidate(rec, reasons) {
  const attach = rec.ATTACHMENTNAME ? String(rec.ATTACHMENTNAME).trim() : '';
  return {
    news_id: rec.NEWSID,
    scrip_cd: rec.SCRIP_CD,
    company: rec.SLONGNAME,
    headline: rec.HEADLINE || '',
    subject: rec.NEWSSUB || '',
    category: rec.CATEGORYNAME || '',
    subcat: rec.SUBCATNAME || '',
    attachment: attach,
    news_dt: rec.NEWS_DT || rec.DT_TM || rec.DissemDT || null,
    dissem_dt: rec.DissemDT || null,
    pdf_live: attach ? attachLiveUrl(attach) : null,
    pdf_his: attach ? attachHisUrl(attach) : null,
    match: reasons,
  };
}

/**
 * Fetch + prefilter candidates for an inclusive [fromYmd, toYmd] window.
 * Only filings that (a) match the capex prefilter AND (b) have a PDF attachment
 * are returned — Phase 1 needs the filing text to extract anything.
 */
export async function fetchCandidates({ from, to, maxPagesPerDay = 60, delayMs = 500 } = {}) {
  const days = dayRange(from, to);
  const candidates = [];
  const stats = { days: days.length, records: 0, kept: 0, no_pdf_dropped: 0 };

  for (const day of days) {
    const { rowCount, records } = await fetchAnnouncementsForDay(day, { maxPages: maxPagesPerDay, delayMs });
    stats.records += records.length;
    let keptToday = 0;
    for (const rec of records) {
      const reasons = matchReasons(rec);
      if (!reasons.length) continue;
      const attach = rec.ATTACHMENTNAME ? String(rec.ATTACHMENTNAME).trim() : '';
      if (!attach.toLowerCase().endsWith('.pdf')) { stats.no_pdf_dropped++; continue; }
      candidates.push(toCandidate(rec, reasons));
      keptToday++;
    }
    stats.kept += keptToday;
    log(`day ${day}: ${records.length}/${rowCount} records, kept ${keptToday} candidates`);
  }

  return { candidates, stats };
}

// --- CLI ------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const to = args.to || ymd(todayUTC());
  const from = args.from || ymd(addDays(todayUTC(), -2));
  log(`fetch-announcements: window ${from}..${to}`);
  const { candidates, stats } = await fetchCandidates({ from, to });
  log(`stats: ${JSON.stringify(stats)}`);
  // Data output on stdout only.
  process.stdout.write(JSON.stringify(candidates, null, 2) + '\n');
}
