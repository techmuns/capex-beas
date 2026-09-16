// scripts/llm.mjs
// callLLM(): Claude via Amazon Bedrock as PRIMARY (Converse endpoint + Bearer
// token, model fallback chain, patient retry), Mistral as FALLBACK.
//
// Env:
//   BEDROCK_API_KEY      Bearer token for the Bedrock runtime
//   AWS_REGION           default "us-east-1"
//   BEDROCK_MODEL_IDS    comma-separated model chain (see DEFAULT_MODEL_IDS)
//   BEDROCK_MODEL        optional single id, prepended to the chain (back-compat)
//   BEDROCK_RETRY_ROUNDS optional (default 8; the backfill workflow sets it higher)
//   MISTRAL_API_KEY      fallback provider key
//   MISTRAL_MODEL        optional (default: mistral-large-latest)
//
// CLI:  node scripts/llm.mjs --selftest

import { withRetry, sleep, log, extractJSON, parseArgs } from './lib/util.mjs';

// Re-export so callers can `import { extractJSON } from './llm.mjs'`.
export { extractJSON };

const RETRYABLE = (err) => /HTTP (429|5\d\d)|fetch failed|network|timeout|ECONN|ETIMEDOUT|abort/i.test(err?.message || '');

// The proven model chain for our AWS account. Tried in order; first 200 wins.
const DEFAULT_MODEL_IDS = [
  'anthropic.claude-sonnet-5',
  'us.anthropic.claude-sonnet-5',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
];

/** Build the Bedrock model fallback chain from env (deduped, order-preserving). */
function bedrockModelChain() {
  const fromEnv = (process.env.BEDROCK_MODEL_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const chain = fromEnv.length ? fromEnv : [...DEFAULT_MODEL_IDS];
  const single = (process.env.BEDROCK_MODEL || '').trim();
  if (single) chain.unshift(single); // back-compat: a single id takes priority
  return [...new Set(chain)];
}

/** fetch() with a hard per-attempt timeout via AbortController. */
async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('attempt timeout')), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Bedrock — Converse endpoint, model fallback chain, patient retry.
// ---------------------------------------------------------------------------
async function callBedrock({ system, prompt, max_tokens, temperature, imagesB64 = [] }) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const key = process.env.BEDROCK_API_KEY;
  if (!key) throw new Error('bedrock: missing BEDROCK_API_KEY');

  const chain = bedrockModelChain();
  const rounds = Number(process.env.BEDROCK_RETRY_ROUNDS || 8);
  const attemptTimeoutMs = Number(process.env.BEDROCK_TIMEOUT_MS || 300000); // ~300s

  // Optional images (for the vision/OCR fallback) in Converse shape.
  const images = (imagesB64 || []).map((b64) => ({ image: { format: 'jpeg', source: { bytes: b64 } } }));
  const body = JSON.stringify({
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: prompt }, ...images] }],
    inferenceConfig: { temperature, maxTokens: max_tokens },
  });
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  let lastErr;
  for (let round = 0; round < rounds; round++) {
    let anyBusy = false; // did any model look transiently busy (worth waiting for)?
    for (const model of chain) {
      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
      try {
        const res = await fetchWithTimeout(url, { method: 'POST', headers, body }, attemptTimeoutMs);

        if (res.status === 429 || res.status >= 500) {
          anyBusy = true;
          lastErr = new Error(`HTTP ${res.status} (${model})`);
          log(`bedrock ${model}: busy (HTTP ${res.status}) — next model`);
          continue;
        }
        if (res.status === 400 || res.status === 403 || res.status === 404) {
          const detail = (await res.text().catch(() => '')).slice(0, 200);
          lastErr = new Error(`HTTP ${res.status} (${model}) ${detail}`);
          log(`bedrock ${model}: unusable on this account (HTTP ${res.status}) — skipping`);
          continue; // hard-skip, do NOT wait
        }
        if (!res.ok) {
          anyBusy = true;
          lastErr = new Error(`HTTP ${res.status} (${model})`);
          continue;
        }

        const json = await res.json();
        const parts = json?.output?.message?.content;
        const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
        if (!text) { lastErr = new Error(`bedrock ${model}: empty content`); continue; }
        return { text, model };
      } catch (err) {
        anyBusy = true; // network/timeout — transient, worth another round
        lastErr = err;
        log(`bedrock ${model}: ${err.message} — next model`);
      }
    }

    // A whole round produced no 200. If nothing looked transient (every model
    // hard-rejected), more rounds would fail identically — bail out early.
    if (!anyBusy) break;
    if (round < rounds - 1) {
      log(`bedrock: all models busy this round (${round + 1}/${rounds}); waiting 60s`);
      await sleep(60000);
    }
  }
  throw lastErr || new Error('bedrock: all models/rounds exhausted');
}

// ---------------------------------------------------------------------------
// Mistral (OpenAI-style chat completions) — text-only fallback, unchanged.
// ---------------------------------------------------------------------------
async function callMistral({ system, prompt, max_tokens, temperature }) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('mistral: missing MISTRAL_API_KEY');
  const model = process.env.MISTRAL_MODEL || 'mistral-large-latest';

  const text = await withRetry(async () => {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens,
        temperature,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 400);
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    const json = await res.json();
    const t = json?.choices?.[0]?.message?.content || '';
    if (!t) throw new Error('mistral: empty content');
    return t;
  }, { attempts: 3, baseDelay: 2000, label: 'mistral', shouldRetry: RETRYABLE });

  return { text, model };
}

/**
 * Call the LLM. Tries the Bedrock model chain first, falls back to Mistral.
 * @param {object} o
 * @param {string[]} [o.imagesB64] optional base64 JPEGs (Bedrock vision only)
 * @returns {Promise<{text:string, provider:'bedrock'|'mistral', model:string}>}
 */
export async function callLLM({ system = '', prompt, max_tokens = 2000, temperature = 0, imagesB64 = [] }) {
  const haveBedrock = !!process.env.BEDROCK_API_KEY;
  const haveMistral = !!process.env.MISTRAL_API_KEY;
  if (!haveBedrock && !haveMistral) {
    throw new Error('no LLM provider configured (set BEDROCK_API_KEY or MISTRAL_API_KEY)');
  }

  if (haveBedrock) {
    try {
      const { text, model } = await callBedrock({ system, prompt, max_tokens, temperature, imagesB64 });
      return { text, provider: 'bedrock', model };
    } catch (err) {
      log(`bedrock failed (${err.message}); ${haveMistral ? 'falling back to mistral' : 'no fallback available'}`);
      if (!haveMistral) throw err;
    }
  }
  if (imagesB64?.length) log('note: Mistral fallback is text-only — images are dropped');
  const { text, model } = await callMistral({ system, prompt, max_tokens, temperature });
  return { text, provider: 'mistral', model };
}

/** Convenience: call the LLM and defensively parse JSON from its reply. */
export async function callLLMForJSON(opts) {
  const { text, provider, model } = await callLLM(opts);
  return { data: extractJSON(text), provider, model, raw: text };
}

// --- CLI ------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.selftest) {
    try {
      const { text, provider, model } = await callLLM({
        system: 'You are a terse test endpoint.',
        prompt: 'Reply with exactly one word: pong',
        max_tokens: 10,
      });
      log(`self-test OK — provider=${provider}, model=${model}, reply=${JSON.stringify(text.trim())}`);
    } catch (err) {
      log(`self-test FAILED: ${err.message}`);
      process.exit(1);
    }
  } else {
    log('usage: node scripts/llm.mjs --selftest');
  }
}
