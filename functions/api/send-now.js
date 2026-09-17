// POST /api/send-now  — { email, filter } — instant one-off digest to the given
// address. Rate-limited to 3 per email per hour. Sends the last 90 days of capex
// changes (so there's something to show). No subscription is created. Open (no login).
import { json, normEmail, rateLimit, sha256hex, fetchChanges, sendMunshotEmail, siteOrigin } from '../_lib/util.js';
import { selectItems, editionLabel } from '../_lib/digest.js';
import { renderDigestEmail, digestSubject } from '../_lib/email-render.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad request' }, 400); }
  const email = normEmail(body.email);
  if (!email) return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  const filter = ['all', 'increases', 'decreases'].includes(body.filter) ? body.filter : 'all';

  if (!env.MUNS_TOKEN) return json({ ok: false, error: 'Email isn’t configured on the server yet.' }, 503);

  const rl = await rateLimit(env, `sendnow:${await sha256hex(email)}`, 3, 3600);
  if (!rl.ok) return json({ ok: false, error: 'You’ve requested this a few times already — try again in an hour.' }, 429);

  const changes = await fetchChanges(env, request);
  const cutoffISO = new Date(Date.now() - 90 * 86400_000).toISOString(); // one-off window: last 90 days
  const items = selectItems(changes, { cutoffISO, filter });
  const sendEmpty = String(env.SEND_EMPTY || '').toLowerCase() === 'true';
  if (!items.length && !sendEmpty) {
    return json({ ok: true, sent: false, note: 'No capex changes in the last 90 days to send right now.' });
  }

  const origin = siteOrigin(env, request);
  const res = await sendMunshotEmail(env, {
    email,
    subject: digestSubject(items),
    html: renderDigestEmail({
      items, edition: editionLabel(filter), cadence: 'daily', timeHHMM: '—',
      unsubUrl: origin, siteUrl: origin, brandLogoUrl: env.BRAND_LOGO_URL || '', now: new Date(), oneOff: true,
    }),
  });
  return json({ ok: res.sent, sent: res.sent, note: res.sent ? 'Sent — check your inbox.' : `Could not send: ${res.reason}` });
}
