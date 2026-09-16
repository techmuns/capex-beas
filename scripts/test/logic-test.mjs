// scripts/test/logic-test.mjs
// Dependency-free unit tests for the pure logic: number normalization, the
// anti-hallucination gates, FY parsing, the defensive JSON extractor, change
// detection (top-of-range comparison), and the Bedrock Converse model-chain
// fallback (with fetch mocked — no network, no keys).
//
// Run:  npm test   (or: node scripts/test/logic-test.mjs)

import { _internals } from '../extract-capex.mjs';
import { recomputeChanges } from '../detect-changes.mjs';
import { numericTokens, toCrore, extractJSON } from '../lib/util.mjs';

const { normalizeAmount, digitsAppearInQuote, quoteInSource, normFY } = _internals;

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

eq('normalizeAmount ₹700 crore', normalizeAmount('₹700 crore'), { currency: 'INR', low: 700, high: 700, midpoint: 700, comparable: true });
eq('normalizeAmount range 450-500 cr (high=500)', normalizeAmount('450-500 crore'), { currency: 'INR', low: 450, high: 500, midpoint: 475, comparable: true });
eq('normalizeAmount USD not comparable', normalizeAmount('$84 million'), { currency: 'USD', low: null, high: null, midpoint: null, comparable: false });

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
