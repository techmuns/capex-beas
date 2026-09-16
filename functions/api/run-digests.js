// POST /api/run-digests  — LOCKED behind DIGEST_KEY (x-digest-key header).
// The hourly GitHub Actions cron calls this. Idempotent: a once-per-day-per-person
// guard (IST) means a late or double run is harmless. Sends only to CONFIRMED subs
// whose day matches and whose chosen time has passed, and only if there's something
// new since their last send (unless SEND_EMPTY=true). Degrades gracefully with no
// KV binding or no MUNS_TOKEN.
import { json, listSubs, putSub, fetchChanges, sendMunshotEmail, siteOrigin } from '../_lib/util.js';
import { selectItems, istDateStr, istHHMM, istWeekday, editionLabel } from '../_lib/digest.js';
import { renderDigestEmail, digestSubject } from '../_lib/email-render.js';

export async function onRequestPost({ request, env }) {
  if (!env.DIGEST_KEY || request.headers.get('x-digest-key') !== env.DIGEST_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.SUBS) return json({ ok: false, error: 'subscriptions not configured' }, 503);

  const now = new Date();
  const today = istDateStr(now);
  const hhmm = istHHMM(now);
  const isWeekday = istWeekday(now) >= 1 && istWeekday(now) <= 5;
  const sendEmpty = String(env.SEND_EMPTY || '').toLowerCase() === 'true';

  const changes = await fetchChanges(env, request);
  const origin = siteOrigin(env, request);
  const subs = await listSubs(env);

  const stats = { today, hhmm, subs: subs.length, considered: 0, sent: 0, notDue: 0, nothingNew: 0, failed: 0 };

  for (const sub of subs) {
    if (sub.status !== 'active') continue;
    stats.considered++;

    if (sub.cadence === 'weekday' && !isWeekday) { stats.notDue++; continue; }
    if (hhmm < (sub.timeHHMM || '08:00')) { stats.notDue++; continue; }     // not their time yet
    if (sub.lastSentDate === today) { stats.notDue++; continue; }           // once-per-day guard

    const cutoffISO = sub.lastSentAt || sub.confirmedAt || sub.createdAt || null;
    const items = selectItems(changes, { cutoffISO, filter: sub.filter || 'all' });

    if (!items.length && !sendEmpty) { stats.nothingNew++; continue; }      // nothing new -> don't send, don't mark

    const res = await sendMunshotEmail(env, {
      email: sub.email,
      subject: digestSubject(items.length, now),
      html: renderDigestEmail({
        items, edition: editionLabel(sub.filter), cadence: sub.cadence, timeHHMM: sub.timeHHMM,
        unsubUrl: `${origin}/api/unsubscribe?token=${sub.unsubToken}`, siteUrl: origin,
        brandLogoUrl: env.BRAND_LOGO_URL || '', now,
      }),
    });

    if (res.sent) {
      sub.lastSentDate = today;                 // only mark the day after a real send
      sub.lastSentAt = new Date().toISOString();
      sub.updatedAt = sub.lastSentAt;
      await putSub(env, sub);
      stats.sent++;
    } else {
      stats.failed++;                           // leave lastSent* so it retries next hour
    }
  }
  return json({ ok: true, ...stats });
}
