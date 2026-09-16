// functions/_lib/digest.js
// Pure, dependency-free logic shared by the Pages Functions and the local preview
// script: map a capex CHANGE record to newspaper fields, select what's "new since
// last send", and format dates in IST. No Cloudflare or Node-only APIs (Intl only),
// so it imports cleanly in both a Worker and Node.

// ---- IST date helpers (Asia/Kolkata) -------------------------------------
const IST = 'Asia/Kolkata';

/** YYYY-MM-DD for the given date, in IST. */
export function istDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
/** "HH:MM" (24h) for the given date, in IST. */
export function istHHMM(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
/** Day of week in IST: 0=Sun … 6=Sat. */
export function istWeekday(date = new Date()) {
  const [y, m, d] = istDateStr(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // noon UTC of the IST calendar date
}
/** "Saturday, 5 September 2026" in IST. */
export function istFull(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}
/** "5 Sep" in IST. */
export function istDMon(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: 'numeric', month: 'short' }).format(d);
}

// ---- money ---------------------------------------------------------------
export const moneyCr = (n) =>
  n == null || Number.isNaN(Number(n)) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;

// ---- category / status palette (fixed) -----------------------------------
export const CATEGORY = {
  Increased: '#10b981',     // green
  Decreased: '#f43f5e',     // rose
  'First reading': '#64748b', // slate
};

/** The subscriber's filter shown as the newspaper "Edition". */
export const editionLabel = (f) => (f === 'increases' ? 'Increases' : f === 'decreases' ? 'Decreases' : 'All changes');

/** Map one capex change record to newspaper item fields. */
export function mapChange(c) {
  const baseline = !!c.no_prior_on_record;
  const dir = c.direction;
  let category, status;
  if (baseline) { category = 'First reading'; status = null; }
  else if (dir === 'up') { category = 'Increased'; status = { label: 'Increased', color: CATEGORY.Increased }; }
  else { category = 'Decreased'; status = { label: 'Decreased', color: CATEGORY.Decreased }; }

  const fy = c.fiscal_year || '';
  const headline = baseline
    ? `${c.company} — first ${fy} capex reading: ${moneyCr(c.new_cr)}`
    : `${c.company} ${dir === 'up' ? 'raised' : 'cut'} ${fy} capex ${moneyCr(c.old_cr)} → ${moneyCr(c.new_cr)}`;

  return {
    headline,
    summary: c.reason ? String(c.reason) : 'Reason not stated in the filing',
    category,
    categoryColor: CATEGORY[category],
    status,
    entity: c.company || '',
    source: 'BSE filing',
    link: c.new_pdf || '',        // the real source filing PDF
    date: c.new_date || c.detected_at || null,
    pct: c.pct_change,
    baseline,
  };
}

const ts = (c) => new Date(c.new_date || c.detected_at || 0).getTime();

/**
 * Select capex changes that are NEW since `cutoffISO` (exclusive), apply the
 * subscriber's filter, and return mapped items sorted for the newspaper
 * (real increases/decreases first by recency, then baselines by recency).
 * @param {object[]} changes  capex-changes.json array
 * @param {object}   opts     { cutoffISO?: string, filter?: 'all'|'increases'|'decreases' }
 */
export function selectItems(changes, { cutoffISO = null, filter = 'all' } = {}) {
  const cutoff = cutoffISO ? new Date(cutoffISO).getTime() : -Infinity;
  const kept = (Array.isArray(changes) ? changes : []).filter((c) => {
    if (ts(c) <= cutoff) return false;                       // only what's new since last send
    if (filter === 'increases') return !c.no_prior_on_record && c.direction === 'up';
    if (filter === 'decreases') return !c.no_prior_on_record && c.direction === 'down';
    return true;                                             // 'all'
  });
  kept.sort((a, b) => {
    const ab = a.no_prior_on_record ? 1 : 0, bb = b.no_prior_on_record ? 1 : 0;
    if (ab !== bb) return ab - bb;                           // real changes before baselines
    return ts(b) - ts(a);                                    // newest first
  });
  return kept.map(mapChange);
}

/** Split mapped items into a front page (top real changes) and the rest. */
export function splitFrontAndRest(items, frontMax = 3) {
  const front = items.filter((i) => !i.baseline).slice(0, frontMax);
  const frontSet = new Set(front);
  const rest = items.filter((i) => !frontSet.has(i));
  return { front, rest };
}
