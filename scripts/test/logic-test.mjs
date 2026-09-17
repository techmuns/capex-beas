// scripts/test/logic-test.mjs
// Dependency-free unit tests for the pure logic: number normalization, the
// anti-hallucination gates, FY parsing, the defensive JSON extractor, change
// detection (top-of-range comparison), and the Bedrock Converse model-chain
// fallback (with fetch mocked — no network, no keys).
//
// Run:  npm test   (or: node scripts/test/logic-test.mjs)

import { _internals } from '../extract-capex.mjs';
import { recomputeChanges, makeObservation, addObservationToHistory, pruneImplausible, pruneNonCapex } from '../detect-changes.mjs';
import { numericTokens, toCrore, extractJSON, deriveEventType, weekOf, isPlausibleCapexCr, CAPEX_MAX_CR, classifyCapexFigure, isChangeEligible, figureClass, isGenuineAcquisition } from '../lib/util.mjs';
import { parseScreenerHtml, needsEnrichment } from '../enrich.mjs';

const { normalizeAmount, digitsAppearInQuote, quoteInSource, normFY, isAcquisition } = _internals;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const ok = (name, cond) => eq(name, !!cond, true);

// --- number normalization -------------------------------------------------
eq('toCrore 700 crore', toCrore(700, 'crore'), 700);
eq('toCrore 500 lakh', toCrore(500, 'lakh'), 5);
eq('toCrore 50 million', toCrore(50, 'million'), 5);
eq('toCrore 2 billion', toCrore(2, 'billion'), 200);
eq('numericTokens ₹1,200 cr', numericTokens('₹1,200 crore'), ['1200']);
eq('numericTokens range', numericTokens('450-500'), ['450', '500']);
// Indian digit grouping (lakh/crore comma style, e.g. 12,00,000 = 1,200,000).
eq('numericTokens Indian grouping 12,00,000', numericTokens('₹12,00,000 crore'), ['1200000']);
eq('numericTokens Indian grouping 2,48,00,00,000', numericTokens('Rs. 2,48,00,00,000/-'), ['2480000000']);

eq('normalizeAmount ₹700 crore', normalizeAmount('₹700 crore'), { currency: 'INR', low: 700, high: 700, midpoint: 700, comparable: true });
eq('normalizeAmount range 450-500 cr (high=500)', normalizeAmount('450-500 crore'), { currency: 'INR', low: 450, high: 500, midpoint: 475, comparable: true });
eq('normalizeAmount USD not comparable', normalizeAmount('$84 million'), { currency: 'USD', low: null, high: null, midpoint: null, comparable: false });

// --- PART 2: data-quality / plausibility guard ----------------------------
// Sona BLW's absurd "₹12,00,000 crore" (= ₹12 trillion, 1,200,000 cr) must be
// REJECTED (null) — never parsed into the data as ₹12,00,000 cr.
eq('normalizeAmount Sona BLW ₹12,00,000 crore -> null (absurd)', normalizeAmount('₹12,00,000 crore'), null);
eq('normalizeAmount ₹12 trillion -> null (absurd)', normalizeAmount('₹ 12 trillion'), null);
// But "Rs 12,00,000 lakh" = 1,200,000 lakh = ₹12,000 crore — plausible, kept.
eq('normalizeAmount Rs 12,00,000 lakh = ₹12,000 cr', normalizeAmount('Rs 12,00,000 lakh'), { currency: 'INR', low: 12000, high: 12000, midpoint: 12000, comparable: true });
eq('normalizeAmount right at ceiling kept', normalizeAmount(`₹${CAPEX_MAX_CR} crore`), { currency: 'INR', low: CAPEX_MAX_CR, high: CAPEX_MAX_CR, midpoint: CAPEX_MAX_CR, comparable: true });
ok('isPlausibleCapexCr: 700 ok', isPlausibleCapexCr(700));
ok('isPlausibleCapexCr: 1,200,000 rejected', !isPlausibleCapexCr(1200000));
ok('isPlausibleCapexCr: 0 rejected', !isPlausibleCapexCr(0));
ok('isPlausibleCapexCr: null rejected', !isPlausibleCapexCr(null));

// pruneImplausible drops stored absurd observations and empties/removes the scrip.
const pruneHist = {
  '1': [{ amount_cr: 700, amount_cr_high: 700 }, { amount_cr: 1200000, amount_cr_high: 1200000 }],
  '2': [{ amount_cr: 5670000000, amount_cr_high: 5670000000 }],
};
const pr = pruneImplausible(pruneHist);
eq('prune removed 2', pr.removed, 2);
eq('prune kept the plausible one', pruneHist['1'].length, 1);
ok('prune deleted the all-absurd scrip', !('2' in pruneHist));

// --- FY normalization -----------------------------------------------------
eq('normFY FY2027', normFY('FY2027'), 'FY27');
eq('normFY 2027', normFY('2027'), 'FY27');
eq('normFY H1FY27', normFY('H1FY27'), 'H1FY27');

// --- anti-hallucination gates ---------------------------------------------
eq('digits appear (yes)', digitsAppearInQuote('₹700 crore', 'plans capex of ₹700 crore in FY27'), true);
eq('digits appear (no)', digitsAppearInQuote('₹700 crore', 'plans capex of ₹500 crore'), false);
const src = 'The Company plans a capital expenditure of ₹700 crore in FY27 to build a new plant in South India.';
eq('quote in source (exact)', quoteInSource('capital expenditure of ₹700 crore in FY27', src), true);
eq('quote NOT in source', quoteInSource('capex of ₹900 crore next year', src), false);

// --- defensive JSON extractor ---------------------------------------------
eq('extractJSON fenced', extractJSON('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
eq('extractJSON prose-wrapped', extractJSON('Here you go: [1,2,3] hope that helps'), [1, 2, 3]);

// --- change detection: TOP OF RANGE ---------------------------------------
// Observations carry amount_cr = the top of a stated range. A FY27 series that
// moves 500 -> 700 fires a +40% change; a range 450-500 (amount_cr=500) vs a
// later 500 is FLAT (top-of-range 500 == 500), proving we compare on the top.
const obs = (id, date, amount_cr, extra = {}) => ({
  date, news_id: id, company: 'ASK Automotive Ltd', scrip_cd: 544022,
  fiscal_year: 'FY27', type: 'guidance', amount_cr, direction: 'unclear',
  reason: null, quote: `capex of ₹${amount_cr} crore`, source_pdf: `http://pdf/${id}`, ...extra,
});
const history = {
  '544022': [
    obs('n1', '2026-05-10T10:00:00', 500),   // range 450-500 -> top 500 (baseline)
    obs('n2', '2026-08-10T10:00:00', 700, { reason: 'to build a new plant in South India', direction: 'up' }),
    // a cumulative multi-year figure must never be compared against the guidance series:
    { ...obs('n2', '2026-08-10T10:00:00', 2000), type: 'cumulative' },
  ],
};
const changes = recomputeChanges(history, [], 2);
const real = changes.filter((c) => !c.no_prior_on_record);
const baseline = changes.find((c) => c.no_prior_on_record);
eq('one real change', real.length, 1);
eq('change 500 -> 700', [real[0].old_cr, real[0].new_cr], [500, 700]);
eq('change pct 40', real[0].pct_change, 40);
eq('change direction up', real[0].direction, 'up');
eq('change reason (mgmt words)', real[0].reason, 'to build a new plant in South India');
eq('baseline old_cr null, new 500', [baseline.old_cr, baseline.new_cr], [null, 500]);
ok('cumulative never fires a guidance change', changes.every((c) => c.type === 'guidance'));

// A later observation whose top-of-range equals the prior top is FLAT.
const flatHist = { '544022': [obs('a', '2026-01-01T00:00:00', 500), obs('b', '2026-02-01T00:00:00', 500)] };
eq('equal tops => no real change', recomputeChanges(flatHist, [], 2).filter((c) => !c.no_prior_on_record).length, 0);

// detected_at is carried forward across recomputes (stable git diffs).
const prev = changes.map((c) => ({ ...c, detected_at: '2020-01-01T00:00:00.000Z' }));
ok('detected_at carried forward', recomputeChanges(history, prev, 2).every((c) => c.detected_at === '2020-01-01T00:00:00.000Z'));

// --- Bedrock Converse model-chain fallback (fetch mocked) ------------------
async function bedrockChainTests() {
  process.env.BEDROCK_API_KEY = 'test-key';
  process.env.AWS_REGION = 'us-east-1';
  process.env.BEDROCK_RETRY_ROUNDS = '1';
  process.env.BEDROCK_MODEL_IDS = 'modelA,modelB';
  delete process.env.BEDROCK_MODEL;
  delete process.env.MISTRAL_API_KEY;
  const { callLLM } = await import('../llm.mjs');

  const realFetch = global.fetch;
  const converseOK = (text) => ({ ok: true, status: 200, json: async () => ({ output: { message: { content: [{ text }] } } }), text: async () => '' });
  const err = (status) => ({ ok: false, status, json: async () => ({}), text: async () => `HTTP ${status}` });

  // modelA busy (429) -> modelB answers.
  global.fetch = async (url) => (url.includes('modelA') ? err(429) : converseOK('pong-B'));
  const r1 = await callLLM({ prompt: 'hi', max_tokens: 8 });
  eq('bedrock: 429 on A falls through to B', [r1.provider, r1.model, r1.text], ['bedrock', 'modelB', 'pong-B']);

  // modelA hard 400 -> skipped -> modelB answers.
  global.fetch = async (url) => (url.includes('modelA') ? err(400) : converseOK('pong-B2'));
  const r2 = await callLLM({ prompt: 'hi', max_tokens: 8 });
  eq('bedrock: 400 on A skips to B', [r2.provider, r2.model], ['bedrock', 'modelB']);

  global.fetch = realFetch;
}

await bedrockChainTests();

// --- digest mapping / selection (email feature) ---------------------------
const { mapChange, selectItems, editionLabel, moneyCr } = await import('../../functions/_lib/digest.js');
eq('moneyCr', moneyCr(1200), '₹1,200 Cr');
eq('editionLabel increases', editionLabel('increases'), 'Increases');
const up = mapChange({ company: 'ASK Automotive Ltd', fiscal_year: 'FY27', old_cr: 500, new_cr: 700, direction: 'up', reason: 'new plant', new_pdf: 'http://x/p.pdf', new_date: '2026-08-10T10:00:00' });
eq('map up headline', up.headline, 'ASK Automotive Ltd raised FY27 capex ₹500 Cr → ₹700 Cr');
eq('map up category+color', [up.category, up.categoryColor], ['Increased', '#10b981']);
eq('map up status', up.status.label, 'Increased');
eq('map up link is source pdf', up.link, 'http://x/p.pdf');
const down = mapChange({ company: 'Meridian Chemicals Ltd', fiscal_year: 'FY26', old_cr: 900, new_cr: 650, direction: 'down', reason: null });
eq('map down headline', down.headline, 'Meridian Chemicals Ltd cut FY26 capex ₹900 Cr → ₹650 Cr');
eq('map down reason fallback', down.summary, 'Reason not stated in the filing');
eq('map down category rose', down.categoryColor, '#f43f5e');
const base = mapChange({ company: 'Surya Power Ltd', fiscal_year: 'FY26', new_cr: 1200, no_prior_on_record: true });
eq('map baseline headline', base.headline, 'Surya Power Ltd — first FY26 capex reading: ₹1,200 Cr');
eq('map baseline no status', base.status, null);
eq('map baseline slate', base.categoryColor, '#64748b');

const digestChanges = [
  { company: 'A', fiscal_year: 'FY27', old_cr: 100, new_cr: 200, direction: 'up', new_date: '2026-09-10T00:00:00' },
  { company: 'B', fiscal_year: 'FY27', old_cr: 300, new_cr: 200, direction: 'down', new_date: '2026-09-05T00:00:00' },
  { company: 'C', fiscal_year: 'FY27', new_cr: 50, no_prior_on_record: true, new_date: '2026-09-01T00:00:00' },
];
eq('select all (3)', selectItems(digestChanges, { filter: 'all' }).length, 3);
eq('select increases (1)', selectItems(digestChanges, { filter: 'increases' }).map((i) => i.entity), ['A']);
eq('select decreases (1)', selectItems(digestChanges, { filter: 'decreases' }).map((i) => i.entity), ['B']);
eq('select cutoff excludes older', selectItems(digestChanges, { cutoffISO: '2026-09-06T00:00:00' }).map((i) => i.entity), ['A']);
eq('select order: real before baseline', selectItems(digestChanges, {}).map((i) => i.baseline), [false, false, true]);

// --- Phase 4A: M&A / acquisition exclusion --------------------------------
ok('isAcquisition: acquire a company for crores', isAcquisition('agreed to acquire Omnia Holdings for Rs 11,300 crore'));
ok('isAcquisition: % stake purchase', isAcquisition('to acquire 51% stake in XYZ Pvt Ltd'));
ok('isAcquisition: merger / scheme', isAcquisition('scheme of arrangement for merger with ABC Ltd'));
ok('isAcquisition: JV stake', isAcquisition('acquire a stake in the joint venture'));
ok('NOT acquisition: greenfield capex', !isAcquisition('capex of ₹700 crore for a new greenfield plant'));
ok('NOT acquisition: acquire land for a plant', !isAcquisition('to acquire land to set up a new manufacturing plant'));
ok('NOT acquisition: buy machinery', !isAcquisition('purchase of new machinery worth ₹120 crore'));

// --- Phase 4C: event_type derivation --------------------------------------
eq('eventType acquisition', deriveEventType({ type: 'acquisition' }), 'Acquisition (M&A)');
eq('eventType capex up', deriveEventType({ type: 'guidance', direction: 'up', is_change: true }), 'Capex ↑');
eq('eventType capex down', deriveEventType({ type: 'guidance', direction: 'down', is_change: true }), 'Capex ↓');
eq('eventType new project', deriveEventType({ type: 'guidance', segment_or_project: 'new greenfield plant in Gujarat' }), 'New Project');
eq('eventType capacity', deriveEventType({ type: 'plan', quote: 'expand capacity by 2 MTPA at the existing unit' }), 'Capacity Expansion');
eq('eventType quarterly (actual)', deriveEventType({ type: 'actual', quote: 'capex incurred during the quarter was ₹120 crore' }), 'Quarterly capex');
eq('eventType guidance fallback', deriveEventType({ type: 'guidance', quote: 'capex of ₹500 crore for FY27' }), 'Guidance revision');

// End-to-end: an M&A figure the model mis-tags as "guidance" is FORCED to
// "acquisition" by the code-side guard, recorded, but emits NO capex change.
async function acquisitionExtractTests() {
  process.env.BEDROCK_API_KEY = 'test-key';
  process.env.AWS_REGION = 'us-east-1';
  process.env.BEDROCK_RETRY_ROUNDS = '1';
  process.env.BEDROCK_MODEL_IDS = 'modelA';
  delete process.env.BEDROCK_MODEL;
  delete process.env.MISTRAL_API_KEY;
  const { extractCapexFromText } = await import('../extract-capex.mjs');

  const realFetch = global.fetch;
  const converseOK = (text) => ({ ok: true, status: 200, json: async () => ({ output: { message: { content: [{ text }] } } }), text: async () => '' });
  const acqSrc = 'Solar Industries India Ltd has agreed to acquire Omnia Holdings for Rs 11,300 crore, expanding into mining chemicals.';
  const modelItem = [{
    fiscal_year: null, amount_text: 'Rs 11,300 crore', amount_cr: 11300, amount_cr_low: 11300, amount_cr_high: 11300,
    type: 'guidance', // deliberately WRONG — the guard must flip it
    segment_or_project: 'Omnia Holdings acquisition', direction: 'unclear', reason: null,
    verbatim_quote: 'agreed to acquire Omnia Holdings for Rs 11,300 crore',
  }];
  global.fetch = async () => converseOK(JSON.stringify(modelItem));

  const cand = { company: 'Solar Industries India Ltd', scrip_cd: 543525, news_id: 'acq1', news_dt: '2026-09-10T00:00:00', category: '', subcat: '', headline: 'Acquisition of Omnia Holdings' };
  const res = await extractCapexFromText(cand, acqSrc);
  eq('extract tags M&A as acquisition (not guidance)', res.items.map((i) => i.type), ['acquisition']);

  const hist = {};
  for (const it of res.items) addObservationToHistory(hist, makeObservation(it, cand, { source_pdf: 'http://pdf/acq' }));
  eq('acquisition observation event_type', hist['543525'][0].event_type, 'Acquisition (M&A)');
  eq('acquisition emits NO capex guidance change', recomputeChanges(hist, [], 2).length, 0);

  global.fetch = realFetch;
}
await acquisitionExtractTests();

// --- PART 1: single-filing revision (old AND new stated in ONE filing) -----
// The ASK Automotive story: "raised its FY27 capex guidance from ₹500 crore to
// ₹700 crore". A SINGLE filing states both figures — the pipeline must emit a
// REAL old→new change without needing a second filing.
async function singleFilingRevisionTests() {
  process.env.BEDROCK_API_KEY = 'test-key';
  process.env.AWS_REGION = 'us-east-1';
  process.env.BEDROCK_RETRY_ROUNDS = '1';
  process.env.BEDROCK_MODEL_IDS = 'modelA';
  delete process.env.BEDROCK_MODEL;
  delete process.env.MISTRAL_API_KEY;
  const { extractCapexFromText } = await import('../extract-capex.mjs');

  const realFetch = global.fetch;
  const converseOK = (text) => ({ ok: true, status: 200, json: async () => ({ output: { message: { content: [{ text }] } } }), text: async () => '' });

  const src = 'ASK Automotive Ltd has raised its FY27 capex guidance from ₹500 crore to ₹700 crore, citing higher demand for its advanced braking systems.';
  const modelItem = [{
    fiscal_year: 'FY27', amount_text: '₹700 crore', amount_cr: 700, amount_cr_low: 700, amount_cr_high: 700,
    type: 'guidance', segment_or_project: null, direction: 'up',
    is_revision: true, old_amount_text: '₹500 crore', new_amount_text: '₹700 crore',
    reason: 'citing higher demand for its advanced braking systems',
    verbatim_quote: 'raised its FY27 capex guidance from ₹500 crore to ₹700 crore',
  }];
  global.fetch = async () => converseOK(JSON.stringify(modelItem));

  const cand = { company: 'ASK Automotive Ltd', scrip_cd: 544022, news_id: 'rev1', news_dt: '2026-08-10T00:00:00', category: 'Company Update', subcat: 'Investor Presentation', headline: 'ASK Automotive raises FY27 capex guidance' };
  const res = await extractCapexFromText(cand, src);
  eq('revision: one item extracted', res.items.length, 1);
  const it = res.items[0];
  eq('revision: is_revision true', it.is_revision, true);
  eq('revision: old_cr/new_cr 500/700', [it.old_cr, it.new_cr], [500, 700]);
  eq('revision: amount_cr = new (700)', it.amount_cr, 700);
  eq('revision: direction up', it.direction, 'up');

  const hist = {};
  addObservationToHistory(hist, makeObservation(it, cand, { source_pdf: 'http://pdf/ask-rev1' }));
  eq('revision observation carries old/new', [hist['544022'][0].old_cr, hist['544022'][0].new_cr], [500, 700]);

  const chgs = recomputeChanges(hist, [], 2);
  const realChgs = chgs.filter((c) => !c.no_prior_on_record);
  eq('revision: exactly one real change (no dup baseline)', [chgs.length, realChgs.length], [1, 1]);
  const c = realChgs[0];
  eq('revision change 500 -> 700', [c.old_cr, c.new_cr], [500, 700]);
  eq('revision change pct 40', c.pct_change, 40);
  eq('revision change direction up', c.direction, 'up');
  eq('revision change is single_filing', c.single_filing, true);
  eq('revision change source pdf', [c.old_pdf, c.new_pdf], ['http://pdf/ask-rev1', 'http://pdf/ask-rev1']);
  eq('revision change event_type Capex ↑', c.event_type, 'Capex ↑');

  // Gate: model CLAIMS a revision but the OLD figure's digits are NOT in the quote
  // -> revision framing is DROPPED, item kept as a plain single figure (baseline).
  const badItem = [{
    fiscal_year: 'FY27', amount_text: '₹700 crore', type: 'guidance', direction: 'up',
    is_revision: true, old_amount_text: '₹500 crore', new_amount_text: '₹700 crore',
    reason: null, verbatim_quote: 'FY27 capex guidance of ₹700 crore', // NO 500 here
  }];
  global.fetch = async () => converseOK(JSON.stringify(badItem));
  const src2 = 'The board approved a FY27 capex guidance of ₹700 crore for the year.';
  const res2 = await extractCapexFromText(cand, src2);
  eq('revision gate: dropped when old not in quote (is_revision false)', res2.items[0]?.is_revision, false);
  eq('revision gate: no old_cr fabricated', res2.items[0]?.old_cr, null);
  const hist2 = {};
  addObservationToHistory(hist2, makeObservation(res2.items[0], cand, { source_pdf: 'http://pdf/x' }));
  const chg2 = recomputeChanges(hist2, [], 2);
  eq('revision gate: becomes a baseline, not a change', [chg2.length, chg2.filter((c) => !c.no_prior_on_record).length], [1, 0]);

  global.fetch = realFetch;
}
await singleFilingRevisionTests();

// --- ACCURACY FIX: capex figure classifier (real committed quotes) ---------
// Only genuine company-level capex in ₹crore is change-eligible. Fixtures use
// the ACTUAL verbatim quotes from the committed data that produced wrong changes.
const cls = (quote, amountText) => classifyCapexFigure({ quote, amountText });
const elig = (quote, amountText) => isChangeEligible(cls(quote, amountText));

// KEEP — genuine company-total capex
eq('classify ASK -> capex/company_total',
  cls('We had given guidance about around Rs. 450 crore to Rs. 500 crore, but the way we are going and receiving the orders, as I today revised the guidance to high-teens, I think our capex may go to something like Rs. 700 crore this year.', 'Rs. 700 crore'),
  { metric: 'capex', scope: 'company_total' });
eq('classify Yasho -> capex/company_total',
  cls('Accordingly, we have decided to enhance our planned capital expenditure for FY27 from Rs. 125 crores to Rs. 250 crores.', 'Rs. 250 crores'),
  { metric: 'capex', scope: 'company_total' });
ok('eligible CMR Green greenfield capex', elig('~₹ 200 Cr FY27 capex guidance – greenfield and brownfield expansion', '₹ 200 Cr'));
ok('eligible Blue Dart annualized capex', elig('So the capex - - the annualized capex may remain to the tune of INR100 crores', 'INR100 crores'));

// DROP — percentages
ok('drop Jain EBITDA margin %', !elig('reiterate our EBITDA margin guidance of around 14% on a standalone basis and 12.5%', '14%'));
ok('drop M&B revenue growth %', !elig('we remain confident of delivering revenue growth of over 25% in FY27', '25%'));
ok('drop Talbros revenue growth 18-20%', !elig('We expect the group revenue growth of 18-20% YoY while maintaining our EBITDA margins.', '20%'));
// DROP — wrong units
eq('classify Horizon msf -> capacity', cls('On track to achieve over 6.5 msf leasing and 6 msf development in FY27', '6').metric, 'capacity');
eq('classify JSW GW -> capacity', cls('The Company remains on track to deliver its 3 GW greenfield capacity addition target for FY2027.', '3').metric, 'capacity');
ok('drop Hindustan Oil barrels', !elig('Our target is to by 2027, we want to get to 10,000 to 11,000 barrels', '11,000'));
// DROP — revenue
eq('classify Sky Gold revenue', cls('FY27 Revenue projected at ~8,100 crore', '8,100').metric, 'revenue');
// DROP — bare table cell (no ₹ adjacent)
ok('drop Talbros gasket table cell', !elig('Gasket & Heat Shields 17 33 To be funded by Internal Accruals & some borrowings', '17'));
// DROP — segment / sub-line capex (real capex, but not company total)
eq('classify J.Kumar maintenance -> capex/segment',
  cls('INR100 crores maintenance capex will be there.', 'INR100 crores'), { metric: 'capex', scope: 'segment' });
ok('drop VRL on-the-properties sub-line', !elig('So, on the properties, we may invest around Rs. 150 crores – Rs. 160 crores.', 'Rs. 150 crores'));
// DROP — vague "investment" with no capex word / concrete asset
ok('drop Vijaya hub-centre investment (no capex cue)', !elig("we intend to acquire land for setting up another hub centre for future expansion plans with an estimated investment of INR8 crores", 'INR8 crores'));

// figureClass prefers stored metric/scope, else derives from the quote
eq('figureClass uses stored fields', figureClass({ metric: 'capex', scope: 'company_total' }), { metric: 'capex', scope: 'company_total' });

// Detection: two figures from the SAME filing are one statement, never a change.
const rid = 'sameNews1';
const vobs = (amount_cr, quote) => ({
  date: '2026-08-10T10:00:00', news_id: rid, company: 'VRL Logistics Ltd', scrip_cd: 539118,
  fiscal_year: 'FY27', type: 'guidance', amount_cr, direction: 'unclear', reason: null,
  quote, source_pdf: 'http://pdf/vrl', metric: 'capex', scope: 'company_total',
});
const vhist = { '539118': [
  vobs(220, 'the CAPEX will be around Rs. 220 crores – Rs. 240 crores in a full year basis'),
  vobs(200, 'about the CAPEX, around Rs. 200 crores – Rs. 240 crores every year'),
] };
eq('same-filing figures never make a cross-filing change',
  recomputeChanges(vhist, [], 2).filter((c) => !c.no_prior_on_record).length, 0);

// pruneNonCapex removes non-capex observations, keeps real capex.
const phist = { '1': [
  { type: 'guidance', amount_cr: 200, amount_text: '₹200 crore', quote: 'FY27 capex guidance of ₹200 crore for a new plant' },
  { type: 'guidance', amount_cr: 14, amount_text: '14%', quote: 'EBITDA margin guidance of around 14%' },
  { type: 'acquisition', amount_cr: 500, amount_text: 'Rs 500 crore', quote: 'to acquire ABC Ltd for Rs 500 crore' },
] };
const pr2 = pruneNonCapex(phist);
eq('pruneNonCapex removed the % row', pr2.removed, 1);
ok('pruneNonCapex kept capex + acquisition', phist['1'].length === 2 && phist['1'].every((o) => o.amount_cr !== 14));

// --- M&A accuracy filter (real committed acquisition quotes) ---------------
const acq = (quote, amount_cr, amount_text) => isGenuineAcquisition({ quote, amount_cr, amount_text });
// KEEP — genuine acquisitions / stake purchases / mergers / takeovers
ok('acq KEEP Batliboi 80% stake', acq('At closing, Batliboi will acquire an 80% stake in Penta for an upfront cash consideration of INR 15.84 crores.', 15.84, 'INR 15.84 crores'));
ok('acq KEEP Aurobindo $250m (no ₹)', acq('The transaction, valued at $250 million on a cash-free, debt-free basis and inclusive of normalized working capital, is expected to close before the end of June 2026.', null, '$250 million'));
ok('acq KEEP Rane slump sale', acq('Rane (Madras) Limited entered into an agreement with Hindustan Composites to acquire the Friction Business, as going concern, on slump sale basis for an enterprise value of INR 370 Crore', 370, 'INR 370 Crore'));
ok('acq KEEP Persistent takeover (no ₹)', acq('Persistent announces the intention to launch a voluntary public takeover offer for all outstanding Nagarro shares at EUR 81 per share', null, 'EUR 81 per share'));
// DROP — debt / capital-raising / buyback
ok('acq DROP Ugro NCD', !acq('Five-year NCD takes FMO’s cumulative commitment to UGRO to INR 890 crore', 890, 'INR 890 crore'));
ok('acq DROP TANFAC QIP', !acq('TANFAC Industries has successfully raised ₹ 250 crores through a Qualified Institutional Placement (QIP)', 250, '₹ 250 crores'));
ok('acq DROP Piramal equity raise', !acq('Piramal Finance announced a ₹3,850 crore equity capital infusion, comprising ₹2,100 crore raised through a QIP and a proposed ₹1,750 crore preferential allotment of promoter warrants', 3850, '₹3,850 crore'));
ok('acq DROP Diamond debt prepay', !acq('The Company has prepaid, in full, the entire ₹501 crore cash consideration payable to its erstwhile lenders under the NCLT-approved Resolution Plan.', 501, '₹501 crore'));
ok('acq DROP VRL buyback', !acq('the board had approved the buyback of shares by the company to the tune of Rs. 280 crores', 280, 'Rs. 280 crores'));
// DROP — rupee-as-crore mis-parses
ok('acq DROP Tokyo Plast misparse', !acq('Initial subscription of ₹4,99,990/- (49,999 Equity Shares of ₹10/- each).', 499990, '₹4,99,990/-'));
ok('acq DROP Ceigall ₹49,000 misparse', !acq('Will subscribe 4,900 Equity Shares of Rs.10/- each aggregating to Rs. 49,000/- [49%] in the JV to be incorporated', 49000, 'Rs. 49,000/-'));
ok('acq DROP figure above ceiling', !acq('to acquire 100% stake in Target Ltd', 200000, '₹2,00,000 crore'));

// --- Phase 4B: Screener enrichment parse (mocked HTML) ---------------------
const screenerHtml = `<html><head></head><body>
<h1> Solar Industries India Ltd </h1>
<ul id="top-ratios">
 <li class="flex flex-space-between"><span class="name">Market Cap</span><span class="nowrap value">₹ <span class="number">1,11,300</span> Cr.</span></li>
 <li class="flex flex-space-between"><span class="name">Current Price</span><span class="nowrap value">₹ <span class="number">12,300</span></span></li>
 <li class="flex flex-space-between"><span class="name">Stock P/E</span><span class="nowrap value"><span class="number">78.5</span></span></li>
 <li class="flex flex-space-between"><span class="name">Book Value</span><span class="nowrap value">₹ <span class="number">560</span></span></li>
</ul>
<p>Industry: Explosives &amp; Pyrotechnics</p>
</body></html>`;
const scr = parseScreenerHtml(screenerHtml);
eq('screener: company name', scr.company, 'Solar Industries India Ltd');
eq('screener: market cap (₹Cr)', scr.market_cap_cr, 111300);
eq('screener: stock P/E', scr.pe, 78.5);
eq('screener: industry', scr.industry, 'Explosives & Pyrotechnics');
eq('screener: blank page => all null', parseScreenerHtml('<html></html>'),
  { company: null, industry: null, sector: null, market_cap_cr: null, pe: null });

// Real Screener classification breadcrumb (title="…" anchors) — the structure
// the live pages actually use. Industry/sector must come out non-null.
const screenerBreadcrumb = `<html><body>
<h1>Hindustan Oil Exploration Company Ltd</h1>
<ul id="top-ratios"><li><span class="name">Market Cap</span><span class="value">₹ <span class="number">2,385</span> Cr.</span></li>
<li><span class="name">Stock P/E</span><span class="value"><span class="number">32.3</span></span></li></ul>
<p class="sub">
  <a href="/market/IN03/" title="Broad Sector">Energy</a>
  <a href="/market/IN03/IN0301/" title="Sector">Oil, Gas &amp; Consumable Fuels</a>
  <a href="/market/IN03/IN0301/IN030102/" title="Broad Industry">Oil</a>
  <a href="/market/IN03/IN0301/IN030102/IN030102001/" title="Industry">Oil Exploration &amp; Production</a>
</p></body></html>`;
const scr2 = parseScreenerHtml(screenerBreadcrumb);
eq('screener breadcrumb: industry (most specific)', scr2.industry, 'Oil Exploration & Production');
eq('screener breadcrumb: sector', scr2.sector, 'Oil, Gas & Consumable Fuels');
eq('screener breadcrumb: market cap', scr2.market_cap_cr, 2385);
ok('needsEnrichment: missing entry', needsEnrichment(undefined));
ok('needsEnrichment: fresh entry false', !needsEnrichment({ as_of: new Date().toISOString() }));
ok('needsEnrichment: stale entry true', needsEnrichment({ as_of: '2000-01-01T00:00:00.000Z' }));

// --- Phase 4.1: Mon–Sun week concept --------------------------------------
eq('weekOf mid-week label', weekOf('2026-09-16').label, '14–20 Sep 2026');    // Wed -> Mon 14 .. Sun 20
eq('weekOf mid-week key (Monday)', weekOf('2026-09-16').key, '20260914');
eq('weekOf cross-month', weekOf('2026-09-05').label, '31 Aug – 6 Sep 2026');  // Sat -> Mon 31 Aug .. Sun 6 Sep
eq('weekOf cross-month key', weekOf('2026-09-05').key, '20260831');
eq('weekOf cross-year', weekOf('2026-01-01').label, '29 Dec 2025 – 4 Jan 2026'); // Thu -> Mon 29 Dec .. Sun 4 Jan
eq('weekOf datetime string same as date', weekOf('2026-09-16T10:00:00').key, weekOf('2026-09-16').key);
eq('weekOf invalid -> null', weekOf('not-a-date'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
