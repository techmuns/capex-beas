// functions/_lib/email-render.js
// The "Munshot newspaper" email renderer — ONE pure, dependency-free module
// importable by both the Pages Function (server) and the local preview script.
// Email-safe: table layout, ALL CSS inline, 640px max, web-safe fonts, no external
// CSS/JS/required images. Every style value below is fixed per the brand spec;
// only text content and the category colours are data-driven.

import { istFull, istDMon, splitFrontAndRest } from './digest.js';

// Fixed fonts + palette (verbatim).
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = 'Arial,Helvetica,sans-serif';
const INK = '#1a1712', PAPER = '#fbf9f3', CREAM = '#f2eee3', RULE = '#d9d2c2', META = '#8a8272', LINK = '#b4531f';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cadenceText = (c) => (c === 'daily' ? 'every day' : 'every weekday');

const dot = (color, size = 9, round = true) =>
  `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:${round ? '50%' : '2px'};background:${color};margin-right:6px;vertical-align:middle"></span>`;

/**
 * Subject line. Pass the mapped items array to count real changes and first
 * readings SEPARATELY: "Munshot · 2 capex changes · 7 new readings — 17 Sept".
 * Backward-compatible: a bare number is treated as a legacy change count and
 * renders "Munshot · N capex changes — D Mon".
 */
export function digestSubject(itemsOrCount, now = new Date()) {
  if (typeof itemsOrCount === 'number') {
    const n = itemsOrCount;
    return `Munshot · ${n} ${n === 1 ? 'capex change' : 'capex changes'} — ${istDMon(now)}`;
  }
  const items = Array.isArray(itemsOrCount) ? itemsOrCount : [];
  const changes = items.filter((i) => !i.baseline).length;
  const readings = items.filter((i) => i.baseline).length;
  const cWord = changes === 1 ? 'capex change' : 'capex changes';
  const rWord = readings === 1 ? 'new reading' : 'new readings';
  return `Munshot · ${changes} ${cWord} · ${readings} ${rWord} — ${istDMon(now)}`;
}

// ---- item renderers ------------------------------------------------------
function frontItem(it) {
  const link = it.link || '#';
  return `
  <div style="padding:16px 0 14px;border-bottom:1px solid ${RULE}">
    <div style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${it.categoryColor};font-weight:bold">${esc(it.category)}</div>
    <a href="${esc(link)}" style="font-family:${SERIF};font-size:23px;line-height:1.24;font-weight:bold;color:${INK};text-decoration:none;display:block;margin-top:4px">${esc(it.headline)}</a>
    <div style="font-family:${SERIF};font-size:15px;font-style:italic;color:#4a4438;margin-top:6px">${esc(it.summary)}</div>
    <div style="font-family:${SANS};font-size:11px;color:${META};margin-top:7px"><b>${esc(it.entity)}</b> &middot; ${esc(it.source)} &middot; ${esc(istDMon(it.date))} &middot; <a href="${esc(link)}" style="color:${LINK};font-weight:bold;text-decoration:none">Open &rarr;</a></div>
  </div>`;
}

function sectionRow(it) {
  const link = it.link || '#';
  const statusBit = it.status ? `${dot(it.status.color, 8)}${esc(it.status.label)} &middot; ` : '';
  return `
    <div style="padding:11px 0;border-bottom:1px solid ${RULE}">
      <div style="font-family:${SANS};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${META};font-weight:bold">${dot(it.categoryColor, 8, false)}${esc(it.entity)}</div>
      <a href="${esc(link)}" style="font-family:${SERIF};font-size:15px;font-weight:bold;color:${INK};text-decoration:none;display:block;margin-top:3px">${esc(it.headline)}</a>
      <div style="font-family:${SANS};font-size:12px;color:#5c5445;margin-top:3px">${esc(it.summary)}</div>
      <div style="font-family:${SANS};font-size:11px;color:${META};margin-top:4px">${statusBit}${esc(it.source)} &middot; ${esc(istDMon(it.date))}</div>
    </div>`;
}

function sectionBlock(category, color, rows) {
  return `
  <div style="margin-top:22px">
    <span style="display:inline-block;background:${color};color:#ffffff;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:4px 12px">${esc(category)}</span>
    ${rows.map(sectionRow).join('')}
  </div>`;
}

// ---- main renderer -------------------------------------------------------
/**
 * @param {object} o
 *  items: mapped items (from digest.selectItems); edition, cadence, timeHHMM;
 *  unsubUrl, siteUrl, brandLogoUrl?, product?, now?
 */
export function renderDigestEmail(o) {
  const { items = [], edition = 'All changes', cadence = 'weekday', timeHHMM = '08:00',
    unsubUrl = '#', siteUrl = '#', brandLogoUrl = '', product = 'Capex Change Monitor', now = new Date(),
    oneOff = false } = o;

  const total = items.length;
  const inc = items.filter((i) => i.category === 'Increased').length;
  const dec = items.filter((i) => i.category === 'Decreased').length;
  // Count real capex changes vs first readings (baselines) separately.
  const realChanges = items.filter((i) => !i.baseline).length;
  const readings = items.filter((i) => i.baseline).length;

  const { front, rest } = splitFrontAndRest(items, 3);
  const restByCat = {};
  for (const i of rest) (restByCat[i.category] ||= []).push(i);
  const catOrder = ['Increased', 'Decreased', 'First reading'];

  const masthead = brandLogoUrl
    ? `<img src="${esc(brandLogoUrl)}" alt="Munshot" height="34" style="height:34px;border:0;display:inline-block" />`
    : `<div style="font-family:${SERIF};font-size:34px;font-weight:bold;letter-spacing:7px;color:${INK}">MUNSHOT</div>`;

  // 3 — by-the-numbers strip: real changes (with up/down split) then first readings
  const numbers = total ? `
      <tr><td style="padding:16px 34px 6px">
        <div style="font-family:${SANS};font-size:12px;color:#4a4438;line-height:1.9">
          ${dot(META)}${realChanges} ${realChanges === 1 ? 'change' : 'changes'} &nbsp;&middot;&nbsp;
          ${dot('#10b981')}${inc} up &nbsp;&middot;&nbsp;
          ${dot('#f43f5e')}${dec} down &nbsp;&middot;&nbsp;
          ${dot('#64748b')}${readings} new ${readings === 1 ? 'reading' : 'readings'}
        </div>
      </td></tr>` : '';

  // 4 — front page
  const frontHtml = front.length ? `
      <tr><td style="padding:2px 34px 0">${front.map(frontItem).join('')}</td></tr>` : '';

  // 5 — sections (remaining grouped by category)
  const sectionsHtml = rest.length ? `
      <tr><td style="padding:6px 34px 8px">
        ${catOrder.filter((c) => restByCat[c]?.length).map((c) => sectionBlock(c, restByCat[c][0].categoryColor, restByCat[c])).join('')}
      </td></tr>` : '';

  // 6 — empty state
  const emptyHtml = total === 0 ? `
      <tr><td style="padding:34px 34px 30px;text-align:center">
        <div style="font-family:${SERIF};font-size:20px;font-style:italic;color:#4a4438">Nothing new today.</div>
        <div style="font-family:${SANS};font-size:12px;color:${META};margin-top:8px">No BSE-filed capex changes matched your brief. We'll be back the moment a company revises its plan.</div>
      </td></tr>` : '';

  const subj = digestSubject(items, now);

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:${CREAM};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM};font-size:1px;line-height:1px">${esc(subj)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM};">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:${PAPER};border:1px solid ${RULE};">

        <!-- 2 · masthead -->
        <tr><td style="padding:30px 34px 0;text-align:center">
          ${masthead}
          <div style="border-top:3px double ${INK};margin:12px 0 7px"></div>
          <div style="font-family:${SANS};font-size:11px;letter-spacing:4px;color:${META};text-transform:uppercase">${esc(product)} &mdash; Daily Brief</div>
        </td></tr>
        <!-- date / edition bar -->
        <tr><td style="border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};padding:7px 34px;text-align:center;font-family:${SANS};font-size:11px;letter-spacing:1px;color:${META};text-transform:uppercase">
          ${esc(istFull(now))} &middot; Edition: ${esc(edition)}
        </td></tr>

        ${numbers}
        ${frontHtml}
        ${sectionsHtml}
        ${emptyHtml}

        <!-- 7 · footer -->
        <tr><td style="background:${INK};padding:22px 34px">
          ${oneOff
      ? `<div style="font-family:${SANS};font-size:12px;color:#d8d0be">You asked Munshot to email you this <span style="color:#f2ead6">${esc(edition)}</span> brief once.</div>
          <div style="font-family:${SANS};font-size:12px;margin-top:8px"><a href="${esc(siteUrl)}" style="color:#e0b48c;text-decoration:underline">Subscribe for these automatically</a><span style="color:#6b6455"> &middot; </span><span style="color:#a89f8b">Powered by </span><span style="color:#e8dfca;letter-spacing:1px">Munshot</span><span style="color:#a89f8b"> &middot; muns.io</span></div>`
      : `<div style="font-family:${SANS};font-size:12px;color:#d8d0be">You're subscribed to <span style="color:#f2ead6">${esc(edition)}</span>, ${esc(cadenceText(cadence))} at <span style="color:#f2ead6">${esc(timeHHMM)} IST</span>.</div>
          <div style="font-family:${SANS};font-size:12px;margin-top:8px"><a href="${esc(unsubUrl)}" style="color:#e0b48c;text-decoration:underline">Unsubscribe</a><span style="color:#6b6455"> &middot; </span><span style="color:#a89f8b">Powered by </span><span style="color:#e8dfca;letter-spacing:1px">Munshot</span><span style="color:#a89f8b"> &middot; muns.io</span></div>`}
          <div style="font-family:${SANS};font-size:10px;color:#6b6455;margin-top:8px">Every figure is drawn from a company's official BSE filing &mdash; information, not investment advice.</div>
        </td></tr>
      </table>

      <!-- 8 · below the card -->
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px"><tr><td style="padding-top:12px;text-align:center;font-family:${SANS};font-size:10px;color:#a49b88">${esc(product)} by Munshot</td></tr></table>
    </td></tr>
  </table>
</body></html>`;
}

/** Small on-brand double opt-in confirmation email. */
export function renderConfirmEmail({ confirmUrl = '#', edition = 'All changes', cadence = 'weekday', timeHHMM = '08:00', product = 'Capex Change Monitor' } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${CREAM};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">Confirm your Munshot Capex Brief subscription.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM}"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:${PAPER};border:1px solid ${RULE}">
      <tr><td style="padding:30px 34px 0;text-align:center">
        <div style="font-family:${SERIF};font-size:34px;font-weight:bold;letter-spacing:7px;color:${INK}">MUNSHOT</div>
        <div style="border-top:3px double ${INK};margin:12px 0 7px"></div>
        <div style="font-family:${SANS};font-size:11px;letter-spacing:4px;color:${META};text-transform:uppercase">${esc(product)} &mdash; Confirm</div>
      </td></tr>
      <tr><td style="padding:26px 34px 8px;text-align:center">
        <div style="font-family:${SERIF};font-size:22px;font-weight:bold;color:${INK}">Confirm your subscription</div>
        <div style="font-family:${SANS};font-size:13px;color:#4a4438;line-height:1.6;margin-top:10px">You'll get the ${esc(edition)} brief ${esc(cadenceText(cadence))} at ${esc(timeHHMM)} IST &mdash; only on days a BSE-listed company changes its capex plan. Tap below to start.</div>
        <div style="margin:22px 0 6px"><a href="${esc(confirmUrl)}" style="display:inline-block;background:${LINK};color:#ffffff;font-family:${SANS};font-size:14px;font-weight:bold;text-decoration:none;padding:12px 26px;border-radius:4px">Confirm subscription &rarr;</a></div>
      </td></tr>
      <tr><td style="background:${INK};padding:18px 34px;text-align:center">
        <div style="font-family:${SANS};font-size:11px;color:#a89f8b">Didn't request this? Just ignore this email &mdash; nothing will be sent. &middot; <span style="color:#e8dfca;letter-spacing:1px">Munshot</span> &middot; muns.io</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
