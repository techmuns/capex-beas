// GET /api/unsubscribe?token=…  — one-click unsubscribe (link in every email).
import { html, getSubByKey, landingPage, siteOrigin } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const site = siteOrigin(env, request);
  const token = new URL(request.url).searchParams.get('token');
  if (!env.SUBS || !token) return html(landingPage('Link not valid', 'This unsubscribe link is missing or invalid.', site), 400);

  const key = await env.SUBS.get(`unsub:${token}`);
  if (key) {
    const sub = await getSubByKey(env, key);
    if (sub) {
      await env.SUBS.delete(key);
      await env.SUBS.delete(`unsub:${sub.unsubToken}`);
      if (sub.confirmToken) await env.SUBS.delete(`confirm:${sub.confirmToken}`);
    }
  }
  // Always show success (don't reveal whether the token existed).
  return html(landingPage('Unsubscribed', 'You won’t get the Capex Brief anymore. Changed your mind? You can re-subscribe any time from the dashboard.', site));
}
