// GET /api/confirm?token=…  — double-opt-in confirmation. Flips a pending sub to active.
import { html, getSubByKey, putSub, landingPage, siteOrigin } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const site = siteOrigin(env, request);
  const token = new URL(request.url).searchParams.get('token');
  if (!env.SUBS || !token) return html(landingPage('Link not valid', 'This confirmation link is missing or invalid.', site), 400);

  const key = await env.SUBS.get(`confirm:${token}`);
  const sub = key ? await getSubByKey(env, key) : null;
  if (!sub) return html(landingPage('Link expired', 'We couldn’t find that subscription. You can subscribe again from the dashboard.', site), 404);

  if (sub.status !== 'active') {
    sub.status = 'active';
    sub.confirmedAt = new Date().toISOString();
    sub.updatedAt = sub.confirmedAt;
    await putSub(env, sub);
  }
  return html(landingPage('You’re in ✓', 'Your Capex Brief is confirmed. You’ll only hear from us on days a company changes its capex plan.', site));
}
