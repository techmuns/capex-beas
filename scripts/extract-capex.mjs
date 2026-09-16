// scripts/extract-capex.mjs
// Ask the LLM to pull capex figures out of a filing's text as STRICT JSON, then
// ENFORCE anti-hallucination rules in code so nothing fabricated survives:
//   1. every figure's digits must literally appear in its verbatim_quote,
//   2. every verbatim_quote must be found (whitespace-normalized) in the source,
//   3. a stated reason must itself be traceable to the source text, else -> null,
//   4. the ₹-crore value is computed deterministically from the verbatim text
//      (no LLM math trusted for INR figures; foreign-currency figures are kept
//      but left un-converted rather than guessed).
//
// CLI (needs an LLM key):
//   node scripts/extract-capex.mjs --url=<pdf-url> --company="ASK Automotive" --scrip=544022

import { callLLM, extractJSON } from './llm.mjs';
import { getFilingText } from './pdf-text.mjs';
import { normText, numericTokens, toCrore, log, parseArgs } from './lib/util.mjs';

const VALID_TYPES = new Set(['guidance', 'actual', 'plan', 'cumulative']);
const VALID_DIRS = new Set(['up', 'down', 'flat', 'unclear']);

// How much filing text to feed the model. We build a focused excerpt around
// capex mentions (plus the head for context) to keep token cost sane.
const TEXT_BUDGET = 16000;

const SYSTEM_PROMPT = `You are a meticulous equity analyst. You extract CAPITAL EXPENDITURE (capex) figures from an Indian company's BSE filing text.

Return ONLY a JSON array (no prose, no markdown fences). Each element describes ONE capex figure that is EXPLICITLY stated in the text:
{
  "fiscal_year": "FY27" | "H1FY27" | null,     // period the figure applies to; FY27 = Apr 2026-Mar 2027. null if not stated.
  "amount_text": "string",                       // the figure EXACTLY as written, e.g. "₹700 crore", "Rs. 1,200 cr", "$50 million"
  "amount_cr": number,                           // that figure normalized to Rupees crore (1 bn = 100 cr; 100 lakh = 1 cr; 10 mn = 1 cr)
  "amount_cr_low": number,                        // for a range, the low end (else = amount_cr)
  "amount_cr_high": number,                       // for a range, the high end (else = amount_cr)
  "type": "guidance" | "actual" | "plan" | "cumulative",  // guidance=forward target for a year; actual=already incurred; plan=intention w/o firm year; cumulative=multi-year total
  "segment_or_project": "string" | null,          // segment/project it is for, else null
  "direction": "up" | "down" | "flat" | "unclear",// how the filing frames it vs before
  "reason": "string" | null,                      // management's stated reason IN THEIR OWN WORDS copied from the text; null if none stated. NEVER infer.
  "verbatim_quote": "string"                       // the EXACT sentence/clause from the text that contains the figure
}

Hard rules:
- Only CAPITAL EXPENDITURE / capacity-expansion / plant & equipment investment figures. Ignore revenue, PAT, EBITDA, dividends, debt, market cap, order book, buyback, etc.
- "verbatim_quote" MUST be copied character-for-character from the provided text, including the number. If you cannot quote it verbatim, DO NOT include that item — it will be automatically rejected.
- Do NOT invent, round, or estimate any number. Do NOT infer a reason that is not written.
- If the text contains no capex figure, return exactly [].`;

/** Build a focused excerpt: the head + windows around capex mentions. */
function focusText(text, budget = TEXT_BUDGET) {
  if (text.length <= budget) return text;
  const head = text.slice(0, 2500);
  const rx = /capex|capital expenditure|capital outlay|capital investment|capacity|greenfield|brownfield|debottleneck|new plant|expansion|mtpa|\bmw\b|commission|invest/gi;
  const windows = [];
  let m;
  while ((m = rx.exec(text)) && windows.length < 30) {
    const start = Math.max(0, m.index - 600);
    const end = Math.min(text.length, m.index + 900);
    windows.push([start, end]);
  }
  // Merge overlapping windows.
  windows.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  let excerpt = head;
  for (const [s, e] of merged) {
    if (excerpt.length >= budget) break;
    excerpt += '\n…\n' + text.slice(s, e);
  }
  return excerpt.slice(0, budget);
}

function normFY(fy) {
  if (!fy) return null;
  let s = String(fy).toUpperCase().replace(/\s+/g, '');
  s = s.replace(/^FY(\d{4})$/, (_, y) => 'FY' + y.slice(2)); // FY2027 -> FY27
  s = s.replace(/^(\d{4})$/, (_, y) => 'FY' + y.slice(2));   // 2027 -> FY27
  return s || null;
}

/** Deterministically convert the verbatim amount text into ₹ crore (no LLM math for INR). */
function normalizeAmount(amountText) {
  const t = String(amountText || '');
  const currency = /[$]|usd|dollar/i.test(t) ? 'USD'
    : /[€]|eur/i.test(t) ? 'EUR'
      : /[£]|gbp/i.test(t) ? 'GBP'
        : 'INR'; // ₹ / Rs / INR / bare number => INR (BSE default)

  const unit = (t.toLowerCase().match(/(crores?|cr\.?|lakhs?|lacs?|millions?|mn|mln|billions?|bn|bln|trillions?|tn)\b/) || [])[1] || '';
  const stripped = t.replace(/(\d),(?=\d)/g, '$1');
  const range = stripped.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/i);

  let low, high;
  if (range) { low = Number(range[1]); high = Number(range[2]); }
  else {
    const first = (stripped.match(/\d+(?:\.\d+)?/) || [])[0];
    if (first != null) low = high = Number(first);
  }
  if (low == null || !Number.isFinite(low)) return null;

  if (currency === 'INR') {
    const lc = toCrore(low, unit);
    const hc = toCrore(high, unit);
    if (lc == null || hc == null) return null;
    return { currency, low: lc, high: hc, midpoint: (lc + hc) / 2, comparable: true };
  }
  // Foreign currency: we have no FX rate on hand — keep the item but do not guess a ₹ value.
  return { currency, low: null, high: null, midpoint: null, comparable: false };
}

/** All numeric tokens of `amountText` must appear in `quote` (comma-insensitive). */
function digitsAppearInQuote(amountText, quote) {
  const q = String(quote || '').replace(/(\d),(?=\d)/g, '$1');
  const toks = numericTokens(amountText);
  if (!toks.length) return false;
  return toks.every((tok) => q.includes(tok));
}

/** verbatim_quote must be present in the source (whitespace-normalized; alnum fallback). */
function quoteInSource(quote, sourceText) {
  const q = normText(quote);
  const s = normText(sourceText);
  if (q.length < 8) return false; // too short to be a meaningful quote
  if (s.includes(q)) return true;
  // Fallback: compare with punctuation stripped (handles ₹ spacing / hyphen line breaks).
  const alnum = (x) => x.replace(/[^a-z0-9]/gi, '');
  return alnum(s).includes(alnum(q)) && alnum(q).length >= 8;
}

/**
 * Extract validated capex statements for a candidate given its filing text.
 * @returns {Promise<{items:object[], provider:string|null, dropped:object}>}
 */
export async function extractCapexFromText(candidate, filingText) {
  const dropped = { no_quote: 0, digits_mismatch: 0, quote_not_in_source: 0, no_amount: 0, not_capex: 0 };
  const excerpt = focusText(filingText);

  const userPrompt =
    `Company: ${candidate.company} (BSE scrip ${candidate.scrip_cd})\n` +
    `Filing category: ${candidate.category} / ${candidate.subcat}\n` +
    `Headline: ${candidate.headline}\n\n` +
    `--- FILING TEXT (verbatim, may be truncated) ---\n${excerpt}\n--- END ---\n\n` +
    `Return the JSON array now.`;

  const { text, provider } = await callLLM({
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    max_tokens: 3000,
    temperature: 0,
  });

  let arr;
  try {
    const parsed = extractJSON(text);
    arr = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.statements) ? parsed.statements
        : Array.isArray(parsed?.items) ? parsed.items
          : (parsed && typeof parsed === 'object') ? [parsed] : [];
  } catch (err) {
    log(`  extract: could not parse LLM JSON for ${candidate.company}: ${err.message}`);
    return { items: [], provider, dropped };
  }

  const items = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const quote = (raw.verbatim_quote || '').trim();
    const amountText = (raw.amount_text || '').trim();

    // Gate 0: must have a quote and an amount.
    if (!quote) { dropped.no_quote++; continue; }
    if (!amountText || !numericTokens(amountText).length) { dropped.no_amount++; continue; }

    // Gate 1: amount digits must literally appear in the quote.
    if (!digitsAppearInQuote(amountText, quote)) { dropped.digits_mismatch++; continue; }

    // Gate 2: the quote must be found in the source filing text.
    if (!quoteInSource(quote, filingText)) { dropped.quote_not_in_source++; continue; }

    // Deterministic ₹-crore normalization from the verbatim text.
    const amt = normalizeAmount(amountText);
    if (!amt) { dropped.no_amount++; continue; }

    // Gate 3: reason must itself be traceable; otherwise null it out (keep the figure).
    let reason = raw.reason ? String(raw.reason).trim() : null;
    if (reason && !quoteInSource(reason, filingText)) reason = null;

    let type = String(raw.type || '').toLowerCase();
    if (!VALID_TYPES.has(type)) type = 'plan'; // conservative: won't create false "guidance" changes
    let direction = String(raw.direction || '').toLowerCase();
    if (!VALID_DIRS.has(direction)) direction = 'unclear';

    items.push({
      company: candidate.company,
      scrip_cd: candidate.scrip_cd,
      fiscal_year: normFY(raw.fiscal_year),
      amount_text: amountText,
      currency: amt.currency,
      amount_cr: amt.comparable ? round2(amt.midpoint) : null,
      amount_cr_low: amt.comparable ? round2(amt.low) : null,
      amount_cr_high: amt.comparable ? round2(amt.high) : null,
      midpoint_cr: amt.comparable ? round2(amt.midpoint) : null,
      comparable: amt.comparable,
      type,
      segment_or_project: raw.segment_or_project ? String(raw.segment_or_project).trim() : null,
      direction,
      reason,
      verbatim_quote: quote,
    });
  }

  return { items, provider, dropped };
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Exported for unit tests (pure, no I/O).
export const _internals = { normalizeAmount, digitsAppearInQuote, quoteInSource, normFY, focusText };

/** Convenience for CLI / tests: download+extract text, then extract capex. */
export async function extractCapexForCandidate(candidate) {
  const filing = await getFilingText(candidate);
  if (!filing) return { items: [], provider: null, dropped: {}, filing: null };
  const res = await extractCapexFromText({ ...candidate }, filing.text);
  return { ...res, filing };
}

// --- CLI ------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (!args.url && !args.attach) {
    log('usage: node scripts/extract-capex.mjs --url=<pdf> [--company=".." --scrip=NN]');
    process.exit(1);
  }
  const attach = args.attach || (args.url ? args.url.split('/').pop() : null);
  const candidate = {
    company: args.company || 'Unknown',
    scrip_cd: args.scrip ? Number(args.scrip) : null,
    category: args.category || '', subcat: args.subcat || '',
    headline: args.headline || '', attachment: attach,
  };
  const { items, provider, dropped, filing } = await extractCapexForCandidate(candidate);
  log(`provider=${provider} | source=${filing?.source_pdf} | dropped=${JSON.stringify(dropped)}`);
  process.stdout.write(JSON.stringify(items, null, 2) + '\n');
}
