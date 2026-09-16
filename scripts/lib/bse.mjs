// scripts/lib/bse.mjs
// Thin client for BSE's public corporate-announcements API + filing PDFs.
//
// Key facts learned from the live API (see HANDOFF.md):
//   * The announcements endpoint is a PER-DAY query: strPrevDate MUST equal
//     strToDate. Passing a real multi-day range returns `{}`. Volume within a
//     day is handled by pagination (pageno=1,2,3…; 50 records/page).
//   * Records are under Table[]; Table1[0].ROWCNT is the day's total.
//   * PDFs live at AttachLive first; older filings fall back to AttachHis.
//   * No cookie handshake is needed — just browser-ish headers.
//
// Optional fallbacks (SCRAPE_DO_API_KEY, FIRECRAWL_API_KEY) kick in only if a
// direct fetch fails, e.g. if BSE ever blocks the runner's IP.

import { withRetry, sleep, log } from './util.mjs';

const BSE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
};

const API_BASE = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
const ATTACH_LIVE = 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/';
const ATTACH_HIS = 'https://www.bseindia.com/xml-data/corpfiling/AttachHis/';
const PAGE_SIZE = 50;

/** Build the announcements URL for a single day (YYYYMMDD) + page number. */
export function announcementsUrl(dayYmd, page = 1) {
  const p = new URLSearchParams({
    pageno: String(page),
    strCat: '-1',
    subcategory: '-1',
    strPrevDate: dayYmd,
    strToDate: dayYmd, // MUST equal strPrevDate — the API is per-day
    strSearch: 'P',
    strscrip: '',
    strType: 'C',
  });
  return `${API_BASE}?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Low-level fetch with fallbacks.
// ---------------------------------------------------------------------------

/** Fetch text (JSON) with a direct call, then scrape.do, then Firecrawl. */
async function fetchTextWithFallback(url, label) {
  // 1) Direct.
  try {
    return await withRetry(async () => {
      const res = await fetch(url, { headers: BSE_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    }, { attempts: 4, baseDelay: 1500, label });
  } catch (err) {
    log(`direct fetch failed for ${label}: ${err.message}`);
  }

  // 2) scrape.do proxy.
  const scrapeDoKey = process.env.SCRAPE_DO_API_KEY;
  if (scrapeDoKey) {
    try {
      const proxied = `https://api.scrape.do/?token=${encodeURIComponent(scrapeDoKey)}&url=${encodeURIComponent(url)}`;
      const res = await fetch(proxied);
      if (res.ok) { log(`fetched ${label} via scrape.do`); return await res.text(); }
      log(`scrape.do returned HTTP ${res.status} for ${label}`);
    } catch (err) { log(`scrape.do failed for ${label}: ${err.message}`); }
  }

  // 3) Firecrawl (returns rawHtml, which for a JSON endpoint is the JSON text).
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (firecrawlKey) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['rawHtml'] }),
      });
      if (res.ok) {
        const j = await res.json();
        const raw = j?.data?.rawHtml ?? j?.data?.html ?? j?.data?.markdown;
        if (raw) { log(`fetched ${label} via firecrawl`); return String(raw); }
      }
      log(`firecrawl returned HTTP ${res.status} for ${label}`);
    } catch (err) { log(`firecrawl failed for ${label}: ${err.message}`); }
  }

  throw new Error(`all fetch strategies failed for ${label}`);
}

/** Fetch binary (PDF) directly, then via scrape.do. Returns a Buffer or null. */
async function fetchBinaryWithFallback(url, label) {
  const isPdf = (buf) => buf && buf.length > 4 && buf.slice(0, 5).toString('latin1').startsWith('%PDF');

  // 1) Direct.
  try {
    const buf = await withRetry(async () => {
      const res = await fetch(url, { headers: BSE_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }, { attempts: 3, baseDelay: 1500, label, shouldRetry: (e) => !/HTTP 404/.test(e.message) });
    if (isPdf(buf)) return buf;
    // Non-PDF (usually an HTML 404 page) — signal caller to try the next URL.
    return null;
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return null; // try next location
    log(`direct PDF fetch failed for ${label}: ${err.message}`);
  }

  // 2) scrape.do proxy (binary passthrough).
  const scrapeDoKey = process.env.SCRAPE_DO_API_KEY;
  if (scrapeDoKey) {
    try {
      const proxied = `https://api.scrape.do/?token=${encodeURIComponent(scrapeDoKey)}&url=${encodeURIComponent(url)}`;
      const res = await fetch(proxied);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (isPdf(buf)) { log(`fetched PDF ${label} via scrape.do`); return buf; }
      }
    } catch (err) { log(`scrape.do PDF failed for ${label}: ${err.message}`); }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Fetch ALL announcements for a single day (YYYYMMDD), paginating through pages.
 * @returns {Promise<{day:string, rowCount:number, records:object[]}>}
 */
export async function fetchAnnouncementsForDay(dayYmd, { maxPages = 200, delayMs = 400 } = {}) {
  const records = [];
  let rowCount = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = announcementsUrl(dayYmd, page);
    const txt = await fetchTextWithFallback(url, `announcements ${dayYmd} p${page}`);

    let data;
    try { data = JSON.parse(txt); } catch { data = {}; }

    const table = Array.isArray(data.Table) ? data.Table : [];
    if (page === 1) {
      rowCount = data.Table1?.[0]?.ROWCNT ?? 0;
    }
    if (table.length === 0) break; // no more records for this day

    records.push(...table);

    // Stop once we've collected everything the day reports.
    if (rowCount && records.length >= rowCount) break;
    if (table.length < PAGE_SIZE) break; // short page => last page

    if (page === maxPages) {
      log(`WARNING: ${dayYmd} hit maxPages=${maxPages} (${records.length}/${rowCount} records) — raise maxPages to avoid truncation`);
    }
    await sleep(delayMs); // be polite; BSE occasionally rate-limits
  }

  return { day: dayYmd, rowCount: rowCount || records.length, records };
}

/**
 * Download a filing PDF by attachment name, trying AttachLive then AttachHis.
 * @returns {Promise<{buffer:Buffer, url:string} | null>}
 */
export async function downloadPdf(attachmentName) {
  if (!attachmentName) return null;
  const name = String(attachmentName).trim();

  for (const base of [ATTACH_LIVE, ATTACH_HIS]) {
    const url = base + name;
    const buf = await fetchBinaryWithFallback(url, name);
    if (buf) return { buffer: buf, url };
    await sleep(300);
  }
  return null;
}

/** Public helper: the canonical (AttachLive) URL for an attachment. */
export function attachLiveUrl(attachmentName) {
  return ATTACH_LIVE + String(attachmentName || '').trim();
}
export function attachHisUrl(attachmentName) {
  return ATTACH_HIS + String(attachmentName || '').trim();
}
