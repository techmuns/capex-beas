// scripts/detect-changes.mjs
// The app's long-term memory + change detector.
//
//   public/data/capex-history.json : per-company list of every capex observation
//   public/data/capex-changes.json : capex GUIDANCE changes (and first-seen baselines)
//   public/data/processed.json     : seen NEWSIDs (dedupe across runs)
//   public/data/metadata.json      : last_run / window / counts
//
// A change fires when, for the SAME (company, fiscal_year, type="guidance"), a new
// observation's amount_cr (the TOP of a stated range) differs from the most-recent
// PRIOR guidance amount_cr by more than a threshold (default 2%, to ignore rounding).
// If there is no real prior,
// we record the new number with old_cr=null and no_prior_on_record=true — we NEVER
// invent a previous figure.
//
// Change detection is done by fully RECOMPUTING changes from history each run, which
// keeps the output deterministic and idempotent (detected_at is carried forward for
// changes we've already seen, so git diffs stay minimal).
//
// CLI:  node scripts/detect-changes.mjs   # rebuild capex-changes.json from history

import { FILES, readJSON, writeJSON, nowISO, deriveEventType, log } from './lib/util.mjs';

const DEFAULT_THRESHOLD_PCT = Number(process.env.CAPEX_CHANGE_PCT || 2);

// ---------------------------------------------------------------------------
// State load / save
// ---------------------------------------------------------------------------
export async function loadState() {
  const [history, changes, processed, metadata, cursor, enrichment] = await Promise.all([
    readJSON(FILES.history, {}),
    readJSON(FILES.changes, []),
    readJSON(FILES.processed, { version: 1, processed: {} }),
    readJSON(FILES.metadata, {}),
    readJSON(FILES.cursor, { initialized: false }),
    readJSON(FILES.enrichment, {}),
  ]);
  if (!processed.processed) processed.processed = {};
  return { history, changes, processed, metadata, cursor, enrichment };
}

export async function saveState({ history, changes, processed, metadata, cursor, enrichment }) {
  const tasks = [];
  if (history) tasks.push(writeJSON(FILES.history, sortHistory(history)));
  if (changes) tasks.push(writeJSON(FILES.changes, changes));
  if (processed) tasks.push(writeJSON(FILES.processed, processed));
  if (metadata) tasks.push(writeJSON(FILES.metadata, metadata));
  if (cursor) tasks.push(writeJSON(FILES.cursor, cursor));
  if (enrichment) tasks.push(writeJSON(FILES.enrichment, enrichment));
  await Promise.all(tasks);
}

export function isProcessed(processed, newsId) {
  return !!processed.processed[newsId];
}
export function markProcessed(processed, newsId, meta = {}) {
  processed.processed[newsId] = { at: nowISO(), ...meta };
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/** Build the history observation object for one extracted capex item. */
export function makeObservation(item, candidate, filing) {
  return {
    date: candidate.news_dt || nowISO(),
    news_id: candidate.news_id,
    company: candidate.company,
    scrip_cd: candidate.scrip_cd,
    fiscal_year: item.fiscal_year,
    type: item.type,
    // Plain-English canonical tag, derived deterministically (never from the LLM).
    event_type: deriveEventType({
      type: item.type,
      direction: item.direction,
      segment_or_project: item.segment_or_project,
      quote: item.verbatim_quote,
      headline: candidate.headline,
    }),
    amount_text: item.amount_text,
    currency: item.currency,
    amount_cr: item.amount_cr, // comparison value = top of a stated range
    amount_cr_low: item.amount_cr_low,
    amount_cr_high: item.amount_cr_high,
    comparable: item.comparable,
    segment_or_project: item.segment_or_project,
    direction: item.direction,
    reason: item.reason,
    quote: item.verbatim_quote,
    source_pdf: filing.source_pdf,
    category: candidate.category,
    subcat: candidate.subcat,
  };
}

const obsKey = (o) => `${o.news_id}|${o.fiscal_year}|${o.type}|${o.amount_text}`;

/** Add an observation to history under its scrip code, de-duplicated. Returns true if added. */
export function addObservationToHistory(history, obs) {
  const key = String(obs.scrip_cd);
  if (!history[key]) history[key] = [];
  const exists = history[key].some((o) => obsKey(o) === obsKey(obs));
  if (exists) return false;
  history[key].push(obs);
  return true;
}

function sortHistory(history) {
  for (const k of Object.keys(history)) {
    history[k].sort((a, b) => new Date(a.date) - new Date(b.date));
  }
  return history;
}

// ---------------------------------------------------------------------------
// Change detection (recompute from history)
// ---------------------------------------------------------------------------
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function changeKey(c) {
  return c.no_prior_on_record
    ? `${c.scrip_cd}|${c.fiscal_year}|${c.type}|${c.new_news_id}|baseline`
    : `${c.scrip_cd}|${c.fiscal_year}|${c.type}|${c.new_news_id}`;
}

/**
 * Rebuild the full changes list from history. Only guidance observations with a
 * fiscal_year and a comparable ₹-crore figure participate. The comparison uses
 * amount_cr, which is the TOP of a stated range (low == high for a single value).
 * @param prevChanges previous changes.json (to carry forward detected_at)
 */
export function recomputeChanges(history, prevChanges = [], thresholdPct = DEFAULT_THRESHOLD_PCT) {
  const prevByKey = new Map(prevChanges.map((c) => [changeKey(c), c]));
  const out = [];

  for (const scrip of Object.keys(history)) {
    const guidance = history[scrip]
      .filter((o) => o.type === 'guidance' && o.fiscal_year && o.amount_cr != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Group by fiscal year — a change is only meaningful within the same target year.
    const byFY = {};
    for (const o of guidance) (byFY[o.fiscal_year] ||= []).push(o);

    for (const fy of Object.keys(byFY)) {
      const series = byFY[fy];
      for (let i = 0; i < series.length; i++) {
        const cur = series[i];
        if (i === 0) {
          // First real sighting of guidance for this (company, FY): baseline, no invented prior.
          out.push(finalize({
            company: cur.company, scrip_cd: cur.scrip_cd, fiscal_year: fy, type: 'guidance',
            // First reading is not a ↑/↓ move — tag by nature (project/capacity/revision).
            event_type: cur.event_type || deriveEventType({
              type: 'guidance', segment_or_project: cur.segment_or_project, quote: cur.quote,
            }),
            old_cr: null, new_cr: cur.amount_cr, delta_cr: null, pct_change: null,
            direction: cur.direction || 'unclear', reason: cur.reason,
            old_quote: null, new_quote: cur.quote, old_pdf: null, new_pdf: cur.source_pdf,
            old_date: null, new_date: cur.date, old_news_id: null, new_news_id: cur.news_id,
            no_prior_on_record: true,
          }, prevByKey));
          continue;
        }
        const prev = series[i - 1];
        const pct = ((cur.amount_cr - prev.amount_cr) / prev.amount_cr) * 100;
        if (Math.abs(pct) <= thresholdPct) continue; // within rounding noise — not a change
        const dir = cur.amount_cr > prev.amount_cr ? 'up' : 'down';
        out.push(finalize({
          company: cur.company, scrip_cd: cur.scrip_cd, fiscal_year: fy, type: 'guidance',
          event_type: deriveEventType({ type: 'guidance', direction: dir, is_change: true }),
          old_cr: prev.amount_cr, new_cr: cur.amount_cr,
          delta_cr: round2(cur.amount_cr - prev.amount_cr), pct_change: round2(pct),
          direction: dir,
          reason: cur.reason,
          old_quote: prev.quote, new_quote: cur.quote,
          old_pdf: prev.source_pdf, new_pdf: cur.source_pdf,
          old_date: prev.date, new_date: cur.date,
          old_news_id: prev.news_id, new_news_id: cur.news_id,
          no_prior_on_record: false,
        }, prevByKey));
      }
    }
  }

  // Newest detections first.
  out.sort((a, b) => new Date(b.new_date) - new Date(a.new_date));
  return out;
}

function finalize(change, prevByKey) {
  const key = changeKey(change);
  const prev = prevByKey.get(key);
  change.detected_at = prev?.detected_at || nowISO(); // stable across recomputes
  return change;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
export function buildMetadata({ mode, window, history, changes, processed, provider }) {
  const observations = Object.values(history).reduce((a, l) => a + l.length, 0);
  const realChanges = changes.filter((c) => !c.no_prior_on_record).length;
  return {
    last_run: nowISO(),
    mode: mode || null,
    window: window || null,
    counts: {
      companies_tracked: Object.keys(history).length,
      observations,
      changes: realChanges,
      baselines: changes.length - realChanges,
      processed_news_ids: Object.keys(processed.processed).length,
    },
    provider_used: provider || null,
    generated_at: nowISO(),
  };
}

// --- CLI: rebuild changes.json from the committed history -----------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const state = await loadState();
  const changes = recomputeChanges(state.history, state.changes);
  await writeJSON(FILES.changes, changes);
  const real = changes.filter((c) => !c.no_prior_on_record).length;
  log(`recomputed changes: ${changes.length} entries (${real} real changes, ${changes.length - real} baselines)`);
}
