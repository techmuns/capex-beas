// scripts/lib/util.mjs
// Shared, dependency-free helpers used across the pipeline: logging, retries,
// JSON read/write, date math, whitespace/number normalization, and a defensive
// JSON extractor for LLM output.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths — everything the app reads long-term lives under public/data.
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.join(ROOT, 'public', 'data');

export const FILES = {
  history: path.join(DATA_DIR, 'capex-history.json'),
  changes: path.join(DATA_DIR, 'capex-changes.json'),
  processed: path.join(DATA_DIR, 'processed.json'),
  metadata: path.join(DATA_DIR, 'metadata.json'),
  cursor: path.join(DATA_DIR, 'backfill-cursor.json'),
  // Phase 4: external market context (industry / market cap / P/E), cached
  // SEPARATELY from the source-backed capex data and always labelled "approx".
  enrichment: path.join(DATA_DIR, 'company-enrichment.json'),
};

// ---------------------------------------------------------------------------
// Logging — timestamped, prefixed. Everything goes to stderr except explicit
// data output, so piping a script's JSON to a file stays clean.
// ---------------------------------------------------------------------------
export function log(...args) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${t}]`, ...args);
}

// ---------------------------------------------------------------------------
// Timing / retries
// ---------------------------------------------------------------------------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` with exponential backoff. Retries on any thrown error unless
 * `shouldRetry(err)` returns false. Delays: base, base*2, base*4, ...
 */
export async function withRetry(fn, { attempts = 4, baseDelay = 1500, label = 'op', shouldRetry = () => true } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !shouldRetry(err)) break;
      const delay = baseDelay * Math.pow(2, i);
      log(`retry ${label}: attempt ${i + 1}/${attempts} failed (${err?.message || err}); waiting ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// JSON read / write. Writes are pretty-printed so committed data files produce
// readable git diffs, and written via a temp file + rename to avoid a half
// written file if a run is killed mid-write.
// ---------------------------------------------------------------------------
export async function readJSON(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback;
    const txt = await readFile(file, 'utf8');
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch (err) {
    log(`readJSON: could not parse ${file} (${err.message}); using fallback`);
    return fallback;
  }
}

export async function writeJSON(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const txt = JSON.stringify(obj, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, txt, 'utf8');
  // rename is atomic on the same filesystem
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Date helpers. The BSE API keys everything by calendar day (YYYYMMDD) and
// requires strPrevDate === strToDate, so we work day-by-day in UTC.
// ---------------------------------------------------------------------------
export function ymd(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function parseYmd(s) {
  // "YYYYMMDD" -> Date at UTC midnight
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  return new Date(Date.UTC(y, m, d));
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

export function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Inclusive list of "YYYYMMDD" strings from `fromYmd` to `toYmd`. */
export function dayRange(fromYmd, toYmd) {
  const out = [];
  let cur = parseYmd(fromYmd);
  const end = parseYmd(toYmd);
  while (cur <= end) {
    out.push(ymd(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

export const nowISO = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Week concept (Phase 4.1). A Mon–Sun week label derived from an event's date,
// e.g. "7–13 Sep 2026". Kept deterministic (UTC calendar date only) so the same
// label is produced in the pipeline and in the browser. Returns null on a bad
// date. `key` is the Monday as YYYYMMDD (sortable, newest-first = descending).
// ---------------------------------------------------------------------------
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toUTCDateOnly(input) {
  const s = String(input ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

function fmtWeekRange(mon, sun) {
  const dM = mon.getUTCDate(), dS = sun.getUTCDate();
  const moM = MONTHS_SHORT[mon.getUTCMonth()], moS = MONTHS_SHORT[sun.getUTCMonth()];
  const yM = mon.getUTCFullYear(), yS = sun.getUTCFullYear();
  if (yM === yS && mon.getUTCMonth() === sun.getUTCMonth()) return `${dM}–${dS} ${moM} ${yM}`;
  if (yM === yS) return `${dM} ${moM} – ${dS} ${moS} ${yM}`;
  return `${dM} ${moM} ${yM} – ${dS} ${moS} ${yS}`;
}

/** @returns {{key:string,label:string,startISO:string,endISO:string}|null} */
export function weekOf(input) {
  const d = toUTCDateOnly(input);
  if (!d) return null;
  const diffToMon = (d.getUTCDay() + 6) % 7;   // 0=Sun..6=Sat -> days since Monday
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - diffToMon);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return { key: ymd(mon), label: fmtWeekRange(mon, sun), startISO: mon.toISOString(), endISO: sun.toISOString() };
}

// ---------------------------------------------------------------------------
// Text / number normalization (used by anti-hallucination checks + amounts).
// ---------------------------------------------------------------------------

/** Collapse all whitespace to single spaces, trim, lowercase. */
export function normText(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Pull the numeric tokens out of a string, ignoring thousands separators.
 * "₹700 crore" -> ["700"]; "450-500" -> ["450","500"]; "1,234.5" -> ["1234.5"].
 */
export function numericTokens(s) {
  const cleaned = String(s ?? '').replace(/(\d),(?=\d)/g, '$1'); // strip thousands commas
  const matches = cleaned.match(/\d+(?:\.\d+)?/g);
  return matches ? matches : [];
}

// Plausibility ceiling for a single-company capex figure (in ₹ crore). A stated
// figure above this is almost certainly a mis-extraction — e.g. a raw-rupee
// amount read as crores ("INR 5,67,00,00,000" → ₹567 cr, not ₹5.67 bn cr), or
// "₹12,00,000 crore" (= ₹12 trillion). We reject/prune such figures rather than
// let a fabricated giant number pollute the data or fire a bogus change.
// ~₹5 lakh crore is well above any real single-company capex programme.
export const CAPEX_MAX_CR = Number(process.env.CAPEX_MAX_CR || 500000);

/** True if `cr` is a finite, positive ₹-crore figure within the plausibility ceiling. */
export function isPlausibleCapexCr(cr) {
  return Number.isFinite(cr) && cr > 0 && cr <= CAPEX_MAX_CR;
}

// Unit -> multiplier to convert into ₹ crore.
const UNIT_TO_CR = {
  crore: 1, crores: 1, cr: 1, 'cr.': 1, khokha: 1,
  lakh: 0.01, lakhs: 0.01, lac: 0.01, lacs: 0.01, lakhrs: 0.01,
  million: 0.1, millions: 0.1, mn: 0.1, mln: 0.1, mm: 0.1,
  billion: 100, billions: 100, bn: 100, bln: 100,
  trillion: 100000, trillions: 100000, tn: 100000,
  thousand: 0.0001, thousands: 0.0001, k: 0.0001,
};

/** Convert a numeric value + unit word into ₹ crore. Unknown/absent unit => assume crore. */
export function toCrore(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const u = String(unit || '').trim().toLowerCase();
  const mult = UNIT_TO_CR[u] ?? 1;
  return v * mult;
}

/**
 * Best-effort code-side parse of an amount string into ₹ crore. Used only as a
 * cross-check / fallback for the LLM's normalized figure — never to invent one.
 * Returns { low, high, midpoint } in crore, or null if no number is present.
 */
export function parseAmountToCr(amountText) {
  if (!amountText) return null;
  const text = String(amountText);
  // Find a trailing unit word if present.
  const unitMatch = text.toLowerCase().match(/(crores?|cr\.?|lakhs?|lacs?|millions?|mn|mln|billions?|bn|bln|trillions?|tn|thousands?|k)\b/);
  const unit = unitMatch ? unitMatch[1] : '';
  const nums = numericTokens(text).map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  const crs = nums.map((n) => toCrore(n, unit)).filter((n) => n != null);
  if (!crs.length) return null;
  const low = Math.min(...crs);
  const high = Math.max(...crs);
  return { low, high, midpoint: (low + high) / 2 };
}

// ---------------------------------------------------------------------------
// Event "Type" tag (Phase 4). A plain-English, canonical label derived
// DETERMINISTICALLY in code from an observation/change — never from the LLM.
// Canonical set (exactly these strings):
//   "New Project" | "Capacity Expansion" | "Capex ↑" | "Capex ↓" |
//   "Guidance revision" | "Quarterly capex" | "Acquisition (M&A)"
// ---------------------------------------------------------------------------
export const EVENT_TYPES = [
  'New Project', 'Capacity Expansion', 'Capex ↑', 'Capex ↓',
  'Guidance revision', 'Quarterly capex', 'Acquisition (M&A)',
];

const NEW_PROJECT_RE =
  /\bnew (?:project|plant|facilit|unit|line|factory|complex|campus|greenfield)|greenfield|setting up|set(?:ting)? up (?:a|an|the|new)|to set up|new manufacturing|foundation stone|breaking ground/;
const CAPACITY_RE =
  /capacity|expansion|expand|brownfield|debottleneck|de-bottleneck|\bmtpa\b|\bmw\b|\bgw\b|augment|additional (?:line|capacity|unit)|ramp[- ]?up|scale up|de-?bottlenecking/;

/**
 * Return one canonical event-type label. `is_change` picks the ↑/↓ labels for a
 * detected guidance move; otherwise the label is derived from type + keywords.
 */
export function deriveEventType({ type, direction, segment_or_project, quote, headline, is_change } = {}) {
  if (type === 'acquisition') return 'Acquisition (M&A)';
  if (is_change) {
    if (direction === 'up') return 'Capex ↑';
    if (direction === 'down') return 'Capex ↓';
  }
  if (type === 'actual') return 'Quarterly capex';
  const hay = normText(`${segment_or_project || ''} ${quote || ''} ${headline || ''}`);
  if (NEW_PROJECT_RE.test(hay)) return 'New Project';
  if (CAPACITY_RE.test(hay)) return 'Capacity Expansion';
  return 'Guidance revision';
}

// ---------------------------------------------------------------------------
// Capex figure classifier (accuracy guard). Deterministically decides, from an
// observation's verbatim quote + amount text, WHAT a number really is:
//   metric: "capex" | "revenue" | "margin" | "capacity" | "other"
//   scope:  "company_total" | "segment" | "unclear"
// ONLY metric="capex" AND scope="company_total" may feed change detection. This
// stops percentages (revenue growth %, EBITDA margin %), different units (msf,
// MW, tonnes, barrels), segment / sub-line breakdowns, and bare table fragments
// from ever being compared as if they were company-level capex.
//
// It is NUMBER-ANCHORED: each disqualifier is checked in the immediate
// neighbourhood of the figure, so a capex sentence that merely also mentions a
// growth % elsewhere (e.g. "…revised to high-teens… capex may go to ₹700 crore")
// is still recognised as capex.
// ---------------------------------------------------------------------------
const CAPEX_CUE = /\bcapex\b|capital expenditure|capital outlay|capital investment|capital spend/i;
const CAPEX_VERB = /\b(invest|investing|invested|investment|spend|spending|deploy|deploying|outlay|commission|commissioning|set up|setting up|put up|putting up)\b/i;
// Concrete productive assets only — a bare "expansion"/"growth"/"investment"
// without one of these is too vague to count as capex.
const CAPEX_OBJECT = /\b(plant|facilit\w*|capacity|new line|production line|assembly line|machiner\w*|equipment|greenfield|brownfield|debottleneck\w*)\b/i;
const NONCAPEX_DESC = /\b(revenue|ebitda|margin|top-?line|topline|yoy|year-on-year|profit|\bpat\b|order\s?book|turnover)\b/i;
const WRONG_UNIT = /\b(msf|mn\s?sq|sq\.?\s?ft|sqft|mw|gw|kw|units?|tonnes?|mtpa|tpa|acres?|barrels?|bpd|boepd|rooms?|beds?|stores?|outlets?|seats?)\b/i;
const MONEY_NEAR = /(₹|rs\.?|inr|crore|crores|\bcr\b|cr\.)/i;
// Segment / sub-line markers — a figure so scoped is NOT the company total.
const SUBLINE = /\bon the propert|maintenance capex|routine capex|\bsegment\b|\bdivision\b|sub-?category|product[- ]line|business vertical|per (?:unit|store|outlet|segment)/i;

export const CAPEX_METRICS = ['capex', 'revenue', 'margin', 'capacity', 'other'];
export const CAPEX_SCOPES = ['company_total', 'segment', 'unclear'];

/**
 * Classify a figure as {metric, scope} from its verbatim quote + amount text.
 * Pure and deterministic (no LLM). Used both at extraction time and as a
 * backward-compatible guard over already-stored observations.
 */
export function classifyCapexFigure({ quote, amountText } = {}) {
  const qStrip = String(quote || '').replace(/(\d),(?=\d)/g, '$1');
  const qsl = qStrip.toLowerCase();
  const toks = numericTokens(amountText).length ? numericTokens(amountText) : numericTokens(qStrip);

  let anyMoneyCapexNum = false, anyPct = false, anyUnit = false, anyRevNum = false;
  for (const tok of toks) {
    const idx = qsl.indexOf(tok.toLowerCase());
    if (idx < 0) continue;
    const end = idx + tok.length;
    const before = qsl.slice(Math.max(0, idx - 24), idx);
    const after = qsl.slice(end, end + 20);
    const near = qsl.slice(Math.max(0, idx - 24), end + 20);
    const pct = /^\s*(%|percent|per cent)/.test(after);
    const unit = WRONG_UNIT.test(after);
    const money = /(₹|rs\.?|inr)\s*$/.test(before) || /^\s*(crore|crores|cr\b|cr\.)/.test(after) || MONEY_NEAR.test(near);
    const rev = NONCAPEX_DESC.test(near);
    if (pct) anyPct = true;
    if (unit) anyUnit = true;
    if (rev && !money) anyRevNum = true;
    if (money && !pct && !unit && !rev) anyMoneyCapexNum = true;
  }

  const cue = CAPEX_CUE.test(qsl) || (CAPEX_VERB.test(qsl) && CAPEX_OBJECT.test(qsl));

  let metric;
  if (anyPct) metric = 'margin';
  else if (anyRevNum || (NONCAPEX_DESC.test(qsl) && !anyMoneyCapexNum && !cue)) metric = 'revenue';
  else if (anyUnit && !anyMoneyCapexNum) metric = 'capacity';
  else if (cue && anyMoneyCapexNum) metric = 'capex';
  else metric = 'other';

  let scope = 'unclear';
  if (metric === 'capex') scope = SUBLINE.test(qsl) ? 'segment' : 'company_total';
  return { metric, scope };
}

/** True only for company-level capex — the only thing change detection may compare. */
export function isChangeEligible({ metric, scope } = {}) {
  return metric === 'capex' && scope === 'company_total';
}

/**
 * Resolve an observation's {metric, scope}: trust stored fields when present,
 * else classify deterministically from its quote (backward-compatible with data
 * captured before these fields existed).
 */
export function figureClass(o = {}) {
  if (o.metric && o.scope) return { metric: o.metric, scope: o.scope };
  return classifyCapexFigure({ quote: o.quote, amountText: o.amount_text });
}

// ---------------------------------------------------------------------------
// M&A accuracy filter (display layer). The extractor tags many capital events as
// type "acquisition"; only some are genuine M&A. This keeps real acquisitions /
// stake purchases / mergers / takeovers / slump sales and DROPS debt & capital-
// raising events (NCD, QIP, rights issue, preferential allotment, warrants,
// commercial paper, buybacks, debt prepayment, resolution-plan payments),
// follow-on funding of an EXISTING subsidiary (a "further investment / infusion
// of additional funds in [our wholly-owned subsidiary]" — that is intercompany
// funding, not an acquisition event), land / acreage purchases and capex actually
// spent (those are organic capex, not M&A), and rupee-as-crore mis-parses (a
// "Rs X/-" subscription of shares at ₹10 face value, or a nominal "N equity shares
// at ₹X each" incorporation). Deterministic; used to filter the dashboard's "Major
// commitments (M&A)" bucket. Mirrored in public/js/ui.js for the browser. Never
// touches capex.
//
// NOTE: "wholly-owned subsidiary" is deliberately NOT an acquisition signal on its
// own — it over-matched follow-on infusions into subsidiaries the company already
// owns. Genuine deals that create a subsidiary still qualify via acquire / stake /
// merger / takeover / definitive agreement / enterprise value, etc.
// ---------------------------------------------------------------------------
const ACQ_SIGNAL = /\bacquisitions?\b|\bacquir(?:e|es|ed|ing)\b|\bstake\b|\bmerger\b|amalgamat\w*|\btakeover\b|take[- ]over|\bbuyout\b|buy[- ]?out|controlling (?:stake|interest)|majority (?:stake|interest)|share purchase agreement|\bslump sale\b|scheme of arrangement|\bopen offer\b|enterprise value|definitive agreement|binding agreement|cash-free|debt-free|voting rights/i;
const NOT_ACQ = /\bncd\b|non-convertible debenture|rights issue|\bqip\b|qualified institutional placement|preferential (?:allotment|issue)|\bwarrants?\b|commercial paper|equity capital (?:raise|infusion)|equity raise|fund[- ]?rais(?:e|es|ed|ing)|\bbuy-?back\b|debt prepay\w*|\bprepaid\b|prepay\w*|resolution plan|\bnclt\b|further investment|infusion of (?:additional )?funds|additional funds not exceeding|inter[- ]?corporate deposit|acquisition of\s+(?:approximately\s+|about\s+)?[\d,.]+\s*acres?|acquisition of\s+(?:the\s+)?(?:land|industrial land|freehold|leasehold|a plot)|\b(?:has|have|had|was|were)\s+(?:been\s+)?spent\b/i;

/** A "Rs X/-" subscription of shares at ₹10 face value — or a nominal "N equity
 * shares at ₹X per share" incorporation — is RUPEES / a token stake, not crore. */
function looksRupeeMisparse(o = {}) {
  const q = String(o.quote || '');
  const at = String(o.amount_text || '');
  const sharesAt10 = /shares?\s+of\s+(?:rs\.?|₹)\s*10\/?-?\s*each/i.test(q);
  const rupeeSub = /\/-/.test(at) && /equity shares?|subscri/i.test(q);
  const nominalShares = /\d+\s+equity shares?\s+(?:of|at)\s+(?:rs\.?|₹)\s*[\d,.]+\s*(?:per|each|\/-)/i.test(q);
  return sharesAt10 || rupeeSub || nominalShares;
}

/**
 * True only for a genuine acquisition / M&A. Applied to already-`acquisition`-typed
 * observations to keep the real deals and drop debt/fund-raising and mis-parses.
 * A row with no ₹ figure (e.g. a "$250 million" deal) still qualifies.
 */
export function isGenuineAcquisition(o = {}) {
  const q = String(o.quote || '');
  if (!ACQ_SIGNAL.test(q)) return false;                       // (1) describes an acquisition
  if (NOT_ACQ.test(q)) return false;                           // (2) not debt / capital-raise / buyback
  if (o.amount_cr != null && o.amount_cr > 150000) return false; // (3a) implausible for one deal
  if (looksRupeeMisparse(o)) return false;                     // (3b) rupee-as-crore mis-parse
  return true;
}

// ---------------------------------------------------------------------------
// Defensive JSON extractor for LLM output. Handles code fences, leading prose,
// and trailing junk by balancing brackets while respecting string literals.
// ---------------------------------------------------------------------------
export function extractJSON(raw) {
  if (raw == null) throw new Error('extractJSON: empty input');
  let text = String(raw).trim();

  // 1) Straight parse.
  try { return JSON.parse(text); } catch { /* fall through */ }

  // 2) Strip a ```json ... ``` (or plain ```) fence if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = fence[1].trim();
    try { return JSON.parse(inner); } catch { text = inner; }
  }

  // 3) Balance-match the first top-level array or object.
  const start = firstOf(text, ['[', '{']);
  if (start === -1) throw new Error('extractJSON: no JSON structure found');
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        return JSON.parse(candidate);
      }
    }
  }
  throw new Error('extractJSON: unbalanced JSON structure');
}

function firstOf(text, chars) {
  let idx = -1;
  for (const c of chars) {
    const i = text.indexOf(c);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Tiny CLI arg parser: --key=value and --flag. Returns { key: value|true }.
// ---------------------------------------------------------------------------
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
