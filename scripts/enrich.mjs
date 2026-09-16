// scripts/enrich.mjs
// Best-effort EXTERNAL MARKET CONTEXT for each tracked company: industry,
// market cap and P/E — read from the company's PUBLIC Screener page
// (https://www.screener.in/company/<SCRIP_CD>/, which resolves by BSE scrip
// code with no login).
//
// This is NOT the source-backed capex data. It is auxiliary market context:
//   * cached SEPARATELY in public/data/company-enrichment.json (keyed by scrip),
//   * always labelled "approx" in the UI,
//   * BLANKS ARE FINE — a value that isn't found is left null, never guessed,
//   * an enrichment failure must NEVER block or corrupt the capex pipeline.
//
// Incremental + gentle: only companies not cached (or stale > 7 days) are
// fetched, capped per run, with a small delay between requests. Falls back
// through SCRAPE_DO_API_KEY / FIRECRAWL_API_KEY if a direct fetch is blocked.
//
// CLI:  node scripts/enrich.mjs --scrip=544022 [--company="ASK Automotive"]
//       node scripts/enrich.mjs --all           # enrich every company in history (capped)

import {
  FILES, readJSON, writeJSON, withRetry, sleep, normText, nowISO, log, parseArgs,
} from './lib/util.mjs';

const ENRICH_CAP = Number(process.env.ENRICH_CAP || 15);
const ENRICH_STALE_DAYS = Number(process.env.ENRICH_STALE_DAYS || 7);
const ENRICH_DELAY_MS = Number(process.env.ENRICH_DELAY_MS || 1500);

const SCREENER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Public Screener company page — resolves by BSE scrip code, no login. */
export function screenerUrl(scrip) {
  return `https://www.screener.in/company/${encodeURIComponent(String(scrip).trim())}/`;
}

// ---------------------------------------------------------------------------
// HTML parsing (pure — unit-tested with mocked HTML).
// ---------------------------------------------------------------------------
const stripTags = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** First finite number in a string, ignoring thousands separators. Else null. */
function toNum(s) {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Reject obvious UI-chrome strings that are not an industry name. */
function cleanIndustry(raw) {
  const s = stripTags(raw);
  if (!s || s.length < 3 || s.length > 60) return null;
  if (/add to|compare|edit|export|screen|log ?in|sign|watchlist|follow|website|bse|nse|home|about/i.test(s)) return null;
  if (!/[a-z]/i.test(s)) return null;
  return s;
}

/**
 * Parse a Screener company page into market context. Every field is nullable —
 * anything not confidently found is left null (blanks are fine, never guessed).
 * @returns {{company:string|null, industry:string|null, sector:string|null, market_cap_cr:number|null, pe:number|null}}
 */
export function parseScreenerHtml(html) {
  const out = { company: null, industry: null, sector: null, market_cap_cr: null, pe: null };
  const H = String(html || '');
  if (!H) return out;

  // Company name from the page <h1>.
  const h1 = H.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) out.company = stripTags(h1[1]) || null;

  // Top ratios list: <ul id="top-ratios"> of <li> each with a .name label and a
  // numeric .value (usually wrapped in <span class="number">).
  const ratios = {};
  const ul = H.match(/<ul[^>]*id=["']top-ratios["'][^>]*>([\s\S]*?)<\/ul>/i);
  const scope = ul ? ul[1] : H;
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(scope))) {
    const li = m[1];
    const nameM = li.match(/class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    if (!nameM) continue;
    const name = normText(stripTags(nameM[1])).replace(/[:]+$/, '').trim();
    const numM = li.match(/class=["'][^"']*\bnumber\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const rawVal = numM ? stripTags(numM[1]) : stripTags(li.replace(nameM[0], ''));
    if (name) ratios[name] = rawVal;
  }
  if (ratios['market cap'] != null) out.market_cap_cr = toNum(ratios['market cap']);
  if (ratios['stock p/e'] != null) out.pe = toNum(ratios['stock p/e']);
  else if (ratios['p/e'] != null) out.pe = toNum(ratios['p/e']);

  // Fallbacks on flat text if the ratios list wasn't found / matched.
  const flat = stripTags(H);
  if (out.market_cap_cr == null) {
    const mc = flat.match(/market cap[^0-9₹]*₹?\s*([\d,]+(?:\.\d+)?)\s*cr/i);
    if (mc) out.market_cap_cr = toNum(mc[1]);
  }
  if (out.pe == null) {
    const pe = flat.match(/stock p\/e[^0-9]*([\d,]+(?:\.\d+)?)/i);
    if (pe) out.pe = toNum(pe[1]);
  }

  // Industry / sector — best effort. Prefer an explicit "Industry:" / "Sector:"
  // label, then a Screener sector/industry compare-link's text.
  const indLabel = flat.match(/\bindustry\s*[:>]\s*([A-Za-z][A-Za-z0-9 &/,'.\-]{2,60})/i);
  if (indLabel) out.industry = cleanIndustry(indLabel[1]);
  const secLabel = flat.match(/\bsector\s*[:>]\s*([A-Za-z][A-Za-z0-9 &/,'.\-]{2,60})/i);
  if (secLabel) out.sector = cleanIndustry(secLabel[1]);
  if (!out.industry) {
    const link = H.match(/<a[^>]+href=["'][^"']*\/company\/compare\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (link) out.industry = cleanIndustry(link[1]);
  }

  // Sanitise numeric outliers (a negative or non-finite P/E / market cap is noise).
  if (out.pe != null && (!Number.isFinite(out.pe) || out.pe < 0)) out.pe = null;
  if (out.market_cap_cr != null && (!Number.isFinite(out.market_cap_cr) || out.market_cap_cr < 0)) out.market_cap_cr = null;

  return out;
}

// ---------------------------------------------------------------------------
// Fetch with fallback (direct -> scrape.do -> firecrawl).
// ---------------------------------------------------------------------------
async function fetchHtml(url, label) {
  // 1) Direct.
  try {
    return await withRetry(async () => {
      const res = await fetch(url, { headers: SCREENER_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    }, { attempts: 3, baseDelay: 1500, label, shouldRetry: (e) => !/HTTP 4\d\d/.test(e.message) });
  } catch (err) {
    log(`  screener direct failed for ${label}: ${err.message}`);
  }

  // 2) scrape.do proxy.
  const scrapeDoKey = process.env.SCRAPE_DO_API_KEY;
  if (scrapeDoKey) {
    try {
      const proxied = `https://api.scrape.do/?token=${encodeURIComponent(scrapeDoKey)}&url=${encodeURIComponent(url)}`;
      const res = await fetch(proxied);
      if (res.ok) { log(`  screener via scrape.do: ${label}`); return await res.text(); }
      log(`  screener scrape.do HTTP ${res.status} for ${label}`);
    } catch (err) { log(`  screener scrape.do failed for ${label}: ${err.message}`); }
  }

  // 3) Firecrawl.
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
        const raw = j?.data?.rawHtml ?? j?.data?.html;
        if (raw) { log(`  screener via firecrawl: ${label}`); return String(raw); }
      }
      log(`  screener firecrawl HTTP ${res.status} for ${label}`);
    } catch (err) { log(`  screener firecrawl failed for ${label}: ${err.message}`); }
  }

  throw new Error(`all screener fetch strategies failed for ${label}`);
}

/** Fetch + parse one company's market context into a cache record. */
export async function fetchEnrichment(scrip, fallbackName) {
  const url = screenerUrl(scrip);
  const html = await fetchHtml(url, `screener ${scrip}`);
  const parsed = parseScreenerHtml(html);
  return {
    company: parsed.company || fallbackName || null,
    industry: parsed.industry || null,
    sector: parsed.sector || null,
    market_cap_cr: parsed.market_cap_cr ?? null,
    pe: parsed.pe ?? null,
    as_of: nowISO(),
    source_url: url,
  };
}

/** A cache entry needs (re)fetching if it's missing or older than staleDays. */
export function needsEnrichment(entry, staleDays = ENRICH_STALE_DAYS) {
  if (!entry || !entry.as_of) return true;
  const age = Date.now() - new Date(entry.as_of).getTime();
  return !(age >= 0) || age > staleDays * 864e5;
}

/**
 * Enrich the companies in `history` incrementally. Mutates + returns `cache`.
 * Only un-cached / stale companies are fetched, capped at `cap` per call.
 * NEVER throws — a failure logs and leaves that company for a later run.
 */
export async function enrichCompanies(history, cache = {}, {
  cap = ENRICH_CAP, staleDays = ENRICH_STALE_DAYS, delayMs = ENRICH_DELAY_MS,
} = {}) {
  if (process.env.ENRICH_DISABLE === '1') { log('enrichment disabled (ENRICH_DISABLE=1)'); return cache; }
  const scrips = Object.keys(history || {});
  const todo = scrips.filter((s) => needsEnrichment(cache[s], staleDays)).slice(0, cap);
  if (!todo.length) {
    log(`enrichment: nothing to fetch (${scrips.length} companies all fresh)`);
    return cache;
  }
  log(`enrichment: fetching ${todo.length}/${scrips.length} companies (cap ${cap})`);
  let done = 0, withData = 0;
  for (const s of todo) {
    const name = history[s]?.[0]?.company || cache[s]?.company || null;
    try {
      const rec = await fetchEnrichment(s, name);
      cache[s] = rec; // cache even when some fields are blank — avoids re-hammering; blanks are fine
      done++;
      if (rec.market_cap_cr != null || rec.pe != null || rec.industry) withData++;
      log(`  ✓ ${name || s}: mktcap=${rec.market_cap_cr ?? '—'} pe=${rec.pe ?? '—'} industry=${rec.industry ?? '—'}`);
    } catch (err) {
      // Hard failure (network / blocked): do NOT cache, so a later run retries.
      log(`  ✗ enrich ${name || s} failed: ${err.message}`);
    }
    await sleep(delayMs);
  }
  log(`enrichment done: ${done}/${todo.length} fetched, ${withData} with ≥1 value`);
  return cache;
}

// Exported for unit tests (pure, no I/O).
export const _internals = { parseScreenerHtml, needsEnrichment, cleanIndustry, toNum };

// --- CLI ------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.all) {
    const history = await readJSON(FILES.history, {});
    const cache = await readJSON(FILES.enrichment, {});
    const updated = await enrichCompanies(history, cache, { cap: Number(args.cap) || ENRICH_CAP });
    await writeJSON(FILES.enrichment, updated);
    log(`wrote ${FILES.enrichment}`);
  } else if (args.scrip) {
    const rec = await fetchEnrichment(String(args.scrip), args.company);
    process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
  } else {
    log('usage: node scripts/enrich.mjs --scrip=<SCRIP_CD> [--company="Name"]');
    log('       node scripts/enrich.mjs --all [--cap=15]');
    process.exit(1);
  }
}
