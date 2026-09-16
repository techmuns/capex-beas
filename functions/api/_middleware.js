// functions/api/_middleware.js
// Wraps every /api/* Function: answers CORS preflight and adds CORS headers to
// each response. (Static assets are unaffected — middleware only wraps Functions.)
import { CORS } from '../_lib/util.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  let res;
  try {
    res = await context.next();
  } catch (err) {
    // Any unexpected Function error (e.g. a misconfigured KV binding) degrades to a
    // clean 503 so the front-end shows "not switched on yet" instead of breaking.
    res = new Response(JSON.stringify({ ok: false, error: 'subscriptions temporarily unavailable' }), {
      status: 503, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
