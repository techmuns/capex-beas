// scripts/llm.mjs
// callLLM(): Claude via Amazon Bedrock as PRIMARY, Mistral as FALLBACK.
// Model + region are env-driven. Includes a defensive JSON extractor and a tiny
// self-test that logs which provider actually answered.
//
// Env:
//   BEDROCK_API_KEY   Bearer token for Bedrock runtime
//   AWS_REGION        e.g. us-east-1
//   BEDROCK_MODEL     a current Claude model / inference-profile id
//   MISTRAL_API_KEY   fallback provider key
//   MISTRAL_MODEL     optional (default: mistral-large-latest)
//
// CLI:  node scripts/llm.mjs --selftest

import { withRetry, log, extractJSON, parseArgs } from './lib/util.mjs';

// Re-export so callers can `import { extractJSON } from './llm.mjs'`.
export { extractJSON };

const RETRYABLE = (err) => /HTTP (429|5\d\d)|fetch failed|network|timeout|ECONN|ETIMEDOUT/i.test(err?.message || '');

// ---------------------------------------------------------------------------
// Bedrock (Anthropic Messages API over the /invoke REST endpoint).
// ---------------------------------------------------------------------------
async function callBedrock({ system, prompt, max_tokens, temperature }) {
  const region = process.env.AWS_REGION;
  const model = process.env.BEDROCK_MODEL;
  const key = process.env.BEDROCK_API_KEY;
  if (!key || !region || !model) throw new Error('bedrock: missing BEDROCK_API_KEY / AWS_REGION / BEDROCK_MODEL');

  // Model id may be an inference profile (dots/colons) — encode the path segment.
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens,
    temperature,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };

  return withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 400);
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    const json = await res.json();
    const text = Array.isArray(json.content)
      ? json.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      : '';
    if (!text) throw new Error('bedrock: empty content');
    return text;
  }, { attempts: 4, baseDelay: 2000, label: 'bedrock', shouldRetry: RETRYABLE });
}

// ---------------------------------------------------------------------------
// Mistral (OpenAI-style chat completions).
// ---------------------------------------------------------------------------
async function callMistral({ system, prompt, max_tokens, temperature }) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('mistral: missing MISTRAL_API_KEY');
  const model = process.env.MISTRAL_MODEL || 'mistral-large-latest';

  return withRetry(async () => {
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
    const text = json?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('mistral: empty content');
    return text;
  }, { attempts: 3, baseDelay: 2000, label: 'mistral', shouldRetry: RETRYABLE });
}

/**
 * Call the LLM. Tries Bedrock first, falls back to Mistral.
 * @returns {Promise<{text:string, provider:'bedrock'|'mistral'}>}
 */
export async function callLLM({ system = '', prompt, max_tokens = 2000, temperature = 0 }) {
  const haveBedrock = !!process.env.BEDROCK_API_KEY;
  const haveMistral = !!process.env.MISTRAL_API_KEY;
  if (!haveBedrock && !haveMistral) {
    throw new Error('no LLM provider configured (set BEDROCK_API_KEY or MISTRAL_API_KEY)');
  }

  if (haveBedrock) {
    try {
      const text = await callBedrock({ system, prompt, max_tokens, temperature });
      return { text, provider: 'bedrock' };
    } catch (err) {
      log(`bedrock failed (${err.message}); ${haveMistral ? 'falling back to mistral' : 'no fallback available'}`);
      if (!haveMistral) throw err;
    }
  }
  const text = await callMistral({ system, prompt, max_tokens, temperature });
  return { text, provider: 'mistral' };
}

/** Convenience: call the LLM and defensively parse JSON from its reply. */
export async function callLLMForJSON(opts) {
  const { text, provider } = await callLLM(opts);
  return { data: extractJSON(text), provider, raw: text };
}

// --- CLI ------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.selftest) {
    try {
      const { text, provider } = await callLLM({
        system: 'You are a terse test endpoint.',
        prompt: 'Reply with exactly one word: pong',
        max_tokens: 10,
      });
      log(`self-test OK — provider=${provider}, reply=${JSON.stringify(text.trim())}`);
    } catch (err) {
      log(`self-test FAILED: ${err.message}`);
      process.exit(1);
    }
  } else {
    log('usage: node scripts/llm.mjs --selftest');
  }
}
