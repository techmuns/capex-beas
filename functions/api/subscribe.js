// POST /api/subscribe  — { email, cadence:'weekday'|'daily', time:'HH:MM', filter:'all'|'increases'|'decreases' }
// Stores the subscription as PENDING and sends a double-opt-in confirm email.
// Re-subscribe keeps the existing unsubToken + lastSentDate; an already-active
// sub just has its preferences updated (no re-confirm). IP-capped. Open (no login).
import { json, normEmail, getSub, putSub, randomToken, rateLimit, ipHash, sendMunshotEmail, siteOrigin } from '../_lib/util.js';
import { renderConfirmEmail } from '../_lib/email-render.js';
import { editionLabel } from '../_lib/digest.js';

const CADENCE = new Set(['weekday', 'daily']);
const FILTER = new Set(['all', 'increases', 'decreases']);

export async function onRequestPost({ request, env }) {
  if (!env.SUBS) return json({ ok: false, error: 'subscriptions are not configured yet' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad request' }, 400); }
  const email = normEmail(body.email);
  if (!email) return json({ ok: false, error: 'Please enter a valid email address.' }, 400);

  const cadence = CADENCE.has(body.cadence) ? body.cadence : 'weekday';
  const filter = FILTER.has(body.filter) ? body.filter : 'all';
  const timeHHMM = /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) ? body.time : '08:00';

  const rl = await rateLimit(env, `subip:${await ipHash(request)}`, 10, 3600);
  if (!rl.ok) return json({ ok: false, error: 'Too many sign-ups from your network — try again in a bit.' }, 429);

  const existing = await getSub(env, email);
  const nowISO = new Date().toISOString();
  const sub = {
    email, cadence, filter, timeHHMM, tz: 'IST',
    status: existing?.status === 'active' ? 'active' : 'pending',
    unsubToken: existing?.unsubToken || randomToken(),      // keep on re-subscribe
    confirmToken: existing?.confirmToken || randomToken(),
    lastSentDate: existing?.lastSentDate || null,           // keep on re-subscribe
    lastSentAt: existing?.lastSentAt || null,
    createdAt: existing?.createdAt || nowISO,
    confirmedAt: existing?.confirmedAt || null,
    updatedAt: nowISO,
  };
  await putSub(env, sub);

  if (sub.status === 'active') {
    return json({ ok: true, status: 'active', note: 'Your brief preferences were updated.' });
  }
  // Double opt-in — email a confirm link; only confirmed subs ever receive digests.
  const confirmUrl = `${siteOrigin(env, request)}/api/confirm?token=${sub.confirmToken}`;
  const send = await sendMunshotEmail(env, {
    email,
    subject: 'Confirm your Munshot Capex Brief',
    html: renderConfirmEmail({ confirmUrl, edition: editionLabel(filter), cadence, timeHHMM }),
  });
  return json({
    ok: true, status: 'pending', confirmationEmailSent: send.sent,
    note: send.sent ? 'Almost there — check your inbox and tap Confirm.'
      : 'Saved. A confirmation email will go out once email is configured on the server.',
  });
}
