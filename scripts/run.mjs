// scripts/run.mjs
// Orchestrates the pipeline for a date window:
//   fetch-announcements -> pdf-text -> extract-capex -> detect-changes
// and persists state back into public/data/**.
//
// Modes:
//   --mode=daily     (default) forward run over the last ~2 days
//   --mode=backfill  drains a 90-day baseline using a resumable cursor
//   --from=YYYYMMDD --to=YYYYMMDD   explicit window (manual)
//   --prove[=N]      no-LLM proof: fetch + download + extract TEXT for N candidates,
//                    print it, and WRITE NOTHING (used to validate locally without keys)
//
// Env knobs (all optional):
//   BACKFILL_DAYS=90  DAILY_LOOKBACK_DAYS=2
//   BACKFILL_DAYS_PER_RUN=3  MAX_ANNOUNCEMENTS_PER_RUN=150 (daily uses DAILY_MAX=400)
//   CAPEX_CHANGE_PCT=2
//   ENRICH_CAP=15  ENRICH_STALE_DAYS=7  ENRICH_DELAY_MS=1500  ENRICH_DISABLE=1

import { fetchCandidates } from './fetch-announcements.mjs';
import { getFilingText } from './pdf-text.mjs';
import { extractCapexFromText } from './extract-capex.mjs';
import {
  loadState, saveState, isProcessed, markProcessed,
  makeObservation, addObservationToHistory, recomputeChanges, buildMetadata,
} from './detect-changes.mjs';
import { enrichCompanies } from './enrich.mjs';
import { ymd, todayUTC, addDays, parseYmd, dayRange, nowISO, log, parseArgs } from './lib/util.mjs';

const args = parseArgs();
const MODE = args.from || args.to ? 'manual' : (args.mode || 'daily');

const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 90);
const DAILY_LOOKBACK_DAYS = Number(process.env.DAILY_LOOKBACK_DAYS || 2);
const BACKFILL_DAYS_PER_RUN = Number(process.env.BACKFILL_DAYS_PER_RUN || 3);
const BACKFILL_MAX = Number(process.env.MAX_ANNOUNCEMENTS_PER_RUN || 150);
const DAILY_MAX = Number(process.env.DAILY_MAX || 400);

/** Download + extract + LLM for one candidate; add observations to history. */
async function processCandidate(candidate, state) {
  const filing = await getFilingText(candidate);
  if (!filing) {
    markProcessed(state.processed, candidate.news_id, { scrip_cd: candidate.scrip_cd, status: 'no_text' });
    return { added: 0, provider: null };
  }
  let res;
  try {
    res = await extractCapexFromText(candidate, filing.text);
  } catch (err) {
    log(`  extract failed for ${candidate.company}: ${err.message}`);
    // Do NOT mark processed on a transient LLM failure — let a later run retry.
    return { added: 0, provider: null, error: true };
  }
  let added = 0;
  for (const item of res.items) {
    const obs = makeObservation(item, candidate, filing);
    if (addObservationToHistory(state.history, obs)) added++;
  }
  markProcessed(state.processed, candidate.news_id, {
    scrip_cd: candidate.scrip_cd,
    status: res.items.length ? 'capex' : 'no_capex',
    capex_found: res.items.length,
  });
  if (res.items.length) log(`  ✓ ${candidate.company}: ${res.items.length} capex figure(s) [${res.provider}/${res.model}]`);
  return { added, provider: res.provider, model: res.model };
}

/** Process the pending candidates of a window up to `budget`. Returns work done. */
async function processWindow(from, to, state, budget) {
  const { candidates, stats } = await fetchCandidates({ from, to });
  // Chronological order so history builds in time order.
  candidates.sort((a, b) => new Date(a.news_dt) - new Date(b.news_dt));
  let processedCount = 0, added = 0, provider = null, consecutiveErrors = 0;
  for (const c of candidates) {
    if (budget <= 0) break;
    if (isProcessed(state.processed, c.news_id)) continue;
    const r = await processCandidate(c, state);
    if (r.error) {
      // Transient LLM failure: don't mark processed (retry later), don't spend budget.
      // But if the provider is clearly down, stop the run rather than hammer every filing.
      if (++consecutiveErrors >= 5) { log('  aborting window: 5 consecutive extraction failures (LLM likely unavailable)'); break; }
      continue;
    }
    consecutiveErrors = 0;
    processedCount++; budget--;
    added += r.added;
    if (r.provider) provider = r.model ? `${r.provider}/${r.model}` : r.provider;
  }
  return { stats, processedCount, added, provider, candidates };
}

// ---------------------------------------------------------------------------
// PROVE mode — validate fetch + PDF + text with NO LLM and NO writes.
// ---------------------------------------------------------------------------
async function runProve() {
  const n = Number(args.prove === true ? 2 : args.prove) || 2;
  const to = args.to || ymd(todayUTC());
  const from = args.from || ymd(addDays(parseYmd(to), -(DAILY_LOOKBACK_DAYS + 3)));
  log(`PROVE mode: window ${from}..${to}, up to ${n} filings (no LLM, no writes)`);
  const { candidates, stats } = await fetchCandidates({ from, to });
  log(`candidates=${candidates.length} stats=${JSON.stringify(stats)}`);
  let shown = 0;
  for (const c of candidates) {
    if (shown >= n) break;
    log(`\n--- ${c.company} (${c.scrip_cd}) | ${c.category}/${c.subcat} | match=${c.match.join(',')}`);
    log(`headline: ${c.headline}`);
    const filing = await getFilingText(c);
    if (!filing) { log('  (no usable text — skipped)'); continue; }
    log(`  source_pdf: ${filing.source_pdf}`);
    log(`  pages=${filing.numPages} chars=${filing.charCount}`);
    log(`  text sample: ${filing.text.slice(0, 500).replace(/\s+/g, ' ')}…`);
    shown++;
  }
  log(`\nPROVE complete: fetched feed + parsed ${shown} real PDFs. LLM extraction runs in GitHub Actions.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (args.prove) return runProve();

  const haveLLM = !!(process.env.BEDROCK_API_KEY || process.env.MISTRAL_API_KEY);
  if (!haveLLM) {
    log('No LLM provider configured (BEDROCK_API_KEY / MISTRAL_API_KEY).');
    log('Run with --prove to validate fetch+PDF+text locally, or provide a key. Exiting without changes.');
    process.exit(0);
  }

  const state = await loadState();
  let window, provider = null, processedCount = 0, added = 0;

  if (MODE === 'manual') {
    const to = args.to || ymd(todayUTC());
    const from = args.from || to;
    window = { from, to };
    log(`MANUAL run: ${from}..${to}`);
    const r = await processWindow(from, to, state, DAILY_MAX);
    ({ processedCount, added, provider } = r);
  } else if (MODE === 'backfill') {
    const cur = ensureCursor(state.cursor);
    if (cur.done) { log('backfill already complete — nothing to do'); return finishNoOp(state, cur); }
    let day = cur.cursor_date;
    let budget = BACKFILL_MAX, daysThisRun = 0;
    log(`BACKFILL run: cursor at ${day}, end ${cur.end_date}, budget ${budget}`);
    while (day <= cur.end_date && budget > 0 && daysThisRun < BACKFILL_DAYS_PER_RUN) {
      const r = await processWindow(day, day, state, budget);
      budget -= r.processedCount;
      added += r.added; processedCount += r.processedCount;
      if (r.provider) provider = r.provider;
      const remaining = r.candidates.filter((c) => !isProcessed(state.processed, c.news_id)).length;
      if (remaining === 0) { day = ymd(addDays(parseYmd(day), 1)); daysThisRun++; }
      else { log(`  budget exhausted mid-day ${day}; ${remaining} candidates remain for next run`); break; }
    }
    cur.cursor_date = day;
    cur.done = parseYmd(day) > parseYmd(cur.end_date);
    cur.updated_at = nowISO();
    state.cursor = cur;
    window = { from: cur.start_date, to: cur.end_date, cursor: cur.cursor_date, done: cur.done };
    if (cur.done) log('backfill reached the end of the window — caught up ✔');
  } else {
    // daily / forward
    const to = ymd(todayUTC());
    const from = ymd(addDays(todayUTC(), -DAILY_LOOKBACK_DAYS));
    window = { from, to };
    log(`DAILY run: ${from}..${to}`);
    const r = await processWindow(from, to, state, DAILY_MAX);
    ({ processedCount, added, provider } = r);
  }

  // Recompute changes from the (now updated) history, then persist everything.
  state.changes = recomputeChanges(state.history, state.changes);

  // Phase 4: best-effort external market context (industry / market cap / P/E).
  // Isolated in try/catch — an enrichment failure must NEVER block or corrupt
  // the source-backed capex pipeline.
  try {
    state.enrichment = await enrichCompanies(state.history, state.enrichment || {});
  } catch (err) {
    log(`enrichment step skipped (non-fatal): ${err?.message || err}`);
  }

  state.metadata = buildMetadata({
    mode: MODE, window, history: state.history, changes: state.changes,
    processed: state.processed, provider,
  });
  await saveState(state);

  const real = state.changes.filter((c) => !c.no_prior_on_record).length;
  log(`done: processed ${processedCount} filings, +${added} observations, ` +
    `${state.changes.length} change entries (${real} real changes). provider=${provider}`);
}

function ensureCursor(cursor) {
  if (cursor && cursor.initialized) return cursor;
  const end = todayUTC();
  const start = addDays(end, -BACKFILL_DAYS);
  const c = {
    initialized: true, done: false,
    start_date: ymd(start), end_date: ymd(end), cursor_date: ymd(start),
    updated_at: nowISO(),
  };
  log(`initializing backfill cursor: ${c.start_date}..${c.end_date}`);
  return c;
}

async function finishNoOp(state, cursor) {
  state.cursor = cursor;
  state.metadata = buildMetadata({
    mode: 'backfill', window: { done: true }, history: state.history,
    changes: state.changes, processed: state.processed, provider: null,
  });
  await saveState(state);
}

main().catch((err) => { log('FATAL', err?.stack || err); process.exit(1); });
