// functions/_lib/util.js
// Cloudflare-Worker-side helpers for the Pages Functions: JSON responses, hashing,
// tokens, KV subscription storage, soft rate-limiting, and the Munshot email send.
// Uses only Workers globals (Web Crypto, fetch, KV binding).

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-digest-key',
};

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });
}

export function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });
}

/** A tiny on-brand landing page for confirm / unsubscribe responses. */
export function landingPage(title, msg, siteUrl = '/') {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f2eee3;font-family:Arial,Helvetica,sans-serif;color:#1a1712">
  <div style="max-width:520px;margin:12vh auto;padding:34px;background:#fbf9f3;border:1px solid #d9d2c2;border-radius:6px;text-align:center">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:bold;letter-spacing:6px">MUNSHOT</div>
    <div style="border-top:3px double #1a1712;margin:12px 0 18px"></div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold">${esc(title)}</div>
    <p style="font-size:14px;color:#4a4438;line-height:1.6;margin:12px 0 20px">${esc(msg)}</p>
    <a href="${esc(siteUrl)}" style="display:inline-block;background:#b4531f;color:#fff;text-decoration:none;font-size:14px;font-weight:bold;padding:11px 22px;border-radius:4px">Open the dashboard &rarr;</a>
  </div>
</body></html>`;
}

// ---- crypto / tokens -----------------------------------------------------
export async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

// ---- KV: subscriptions ---------------------------------------------------
// Keys: sub:<sha256(email)> -> record ; unsub:<token> -> subKey ; confirm:<token> -> subKey
export const subKeyFor = async (email) => `sub:${await sha256hex(email)}`;

export async function getSub(env, email) {
  if (!env.SUBS) return null;
  return env.SUBS.get(await subKeyFor(email), 'json');
}
export async function getSubByKey(env, key) {
  if (!env.SUBS || !key) return null;
  return env.SUBS.get(key, 'json');
}
export async function putSub(env, sub) {
  const key = await subKeyFor(sub.email);
  await env.SUBS.put(key, JSON.stringify(sub));
  if (sub.unsubToken) await env.SUBS.put(`unsub:${sub.unsubToken}`, key);
  if (sub.confirmToken) await env.SUBS.put(`confirm:${sub.confirmToken}`, key);
  return key;
}

/** Iterate every subscription record (paginates the KV list). */
export async function listSubs(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const k of res.keys) {
      const v = await env.SUBS.get(k.name, 'json');
      if (v) out.push(v);
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}

// ---- soft rate limit (KV, best-effort; fine for abuse-blunting) ----------
export async function rateLimit(env, id, limit, windowSec = 3600) {
  if (!env.SUBS) return { ok: true, count: 0 };
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `rate:${id}:${bucket}`;
  const count = Number((await env.SUBS.get(key)) || 0);
  if (count >= limit) return { ok: false, count };
  await env.SUBS.put(key, String(count + 1), { expirationTtl: windowSec + 60 });
  return { ok: true, count: count + 1 };
}

export async function ipHash(request) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  return (await sha256hex(ip)).slice(0, 24);
}

// ---- data + links --------------------------------------------------------
export function siteOrigin(env, request) {
  return (env.SITE_URL && String(env.SITE_URL).replace(/\/$/, '')) || new URL(request.url).origin;
}

/** Read the committed change data from the site's own static asset. */
export async function fetchChanges(env, request) {
  try {
    const res = await fetch(`${siteOrigin(env, request)}/data/capex-changes.json`, { cf: { cacheTtl: 0 }, headers: { 'cache-control': 'no-store' } });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

// ---- Munshot email send --------------------------------------------------
export async function sendMunshotEmail(env, { email, subject, html: body }) {
  if (!env.MUNS_TOKEN) return { sent: false, reason: 'no MUNS_TOKEN' };
  const endpoint = env.MUNS_EMAIL_ENDPOINT || 'https://devde.muns.io/email/send/raw';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.MUNS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, subject, html: body }), // recipient field is `email`, content is `html`, no `from`
    });
    if (!res.ok) return { sent: false, reason: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
    return { sent: true };
  } catch (e) { return { sent: false, reason: e.message }; }
}
