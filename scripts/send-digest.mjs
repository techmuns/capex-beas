// scripts/send-digest.mjs
// Compose a colorful HTML digest of capex GUIDANCE changes over a window (default
// 7 days) and send it via a PLUGGABLE provider chosen from env. Only REAL changes
// go in the email (baselines/first-sightings are skipped). If there are zero
// changes, nothing is sent unless DIGEST_ALWAYS=1. If no email provider is
// configured it runs DRY (logs the HTML) so the daily workflow stays green.
//
// Providers (auto-detected; force with EMAIL_PROVIDER=resend|smtp|sendgrid|dryrun):
//   Resend (default) : RESEND_API_KEY                 — plain fetch, no dependency
//   SMTP             : SMTP_HOST, SMTP_USER, SMTP_PASS — nodemailer (install --no-save)
//   SendGrid         : SENDGRID_API_KEY               — plain fetch
// Recipients: EMAIL_TO (comma-separated), EMAIL_FROM. Window: DIGEST_DAYS or --days.
// Dashboard button: DASHBOARD_URL (optional).
//
// CLI:  node scripts/send-digest.mjs [--days=7] [--out=preview.html]

import { writeFile } from 'node:fs/promises';
import { FILES, readJSON, log, parseArgs, nowISO } from './lib/util.mjs';

const args = parseArgs();
const DAYS = args.days ? Number(args.days) : Number(process.env.DIGEST_DAYS || 7);
const WINDOW = Number.isFinite(DAYS) && DAYS > 0 ? DAYS : 7;
const DASHBOARD_URL = process.env.DASHBOARD_URL || '';
const ALWAYS = process.env.DIGEST_ALWAYS === '1';

const fmtCr = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`);
const fmtPct = (n) => (n == null ? '' : `${n > 0 ? '+' : ''}${n}%`);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Real changes (not baselines) within the window, newest first. */
export function selectChanges(changes, days = WINDOW) {
  const cutoff = Date.now() - days * 86400_000;
  return changes
    .filter((c) => !c.no_prior_on_record)
    .filter((c) => {
      const t = new Date(c.new_date || c.detected_at).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => new Date(b.new_date || b.detected_at) - new Date(a.new_date || a.detected_at));
}

/** Build the HTML email. Inline styles only (email clients are picky). */
export function composeDigest(rows, { days = WINDOW, dashboardUrl = DASHBOARD_URL, meta = null } = {}) {
  const companies = new Set(rows.map((c) => c.scrip_cd)).size;
  const period = days === 7 ? 'this week' : `in the last ${days} days`;
  const headline = companies
    ? `${companies} ${companies === 1 ? 'company' : 'companies'} changed their capex plans ${period}`
    : `No capex plan changes ${period}`;

  const row = (c) => {
    const up = c.direction === 'up';
    const color = up ? '#059669' : '#e11d48';
    return `
      <tr style="border-bottom:1px solid #ECEAF6">
        <td style="padding:12px 10px;vertical-align:top">
          <div style="font-weight:700;color:#14152A">${esc(c.company)}</div>
          <div style="color:#8b8fa3;font-size:12px">scrip ${esc(c.scrip_cd)} · ${fmtDate(c.new_date)}</div>
        </td>
        <td style="padding:12px 10px;vertical-align:top;color:#6D28D9;font-weight:600;white-space:nowrap">${esc(c.fiscal_year || '—')}</td>
        <td style="padding:12px 10px;vertical-align:top;font-family:'JetBrains Mono',monospace;white-space:nowrap">
          <span style="color:#8b8fa3">${fmtCr(c.old_cr)}</span>
          <span style="color:${color}">&nbsp;→&nbsp;</span>
          <b style="color:${color}">${fmtCr(c.new_cr)}</b>
        </td>
        <td style="padding:12px 10px;vertical-align:top;font-family:'JetBrains Mono',monospace;color:${color};font-weight:700;white-space:nowrap">${fmtPct(c.pct_change)}</td>
        <td style="padding:12px 10px;vertical-align:top;color:#3d3f57;max-width:260px">${c.reason ? esc(c.reason) : '<span style="color:#9aa0b4;font-style:italic">not stated</span>'}</td>
        <td style="padding:12px 10px;vertical-align:top;white-space:nowrap">${c.new_pdf ? `<a href="${esc(c.new_pdf)}" style="color:#4f46e5;font-weight:600;text-decoration:none">See filing →</a>` : '—'}</td>
      </tr>`;
  };

  const table = rows.length ? `
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:6px">
      <thead>
        <tr style="text-align:left;color:#8b8fa3;font-size:11px;text-transform:uppercase;letter-spacing:.04em">
          <th style="padding:8px 10px">Company</th><th style="padding:8px 10px">Year</th>
          <th style="padding:8px 10px">Old plan → New plan</th><th style="padding:8px 10px">Change</th>
          <th style="padding:8px 10px">Why</th><th style="padding:8px 10px">Filing</th>
        </tr>
      </thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table>`
    : `<p style="color:#6b7280;padding:16px 4px">Nothing changed ${period}. The monitor keeps scanning BSE filings — every figure it shows is backed by the company's own words and the source PDF.</p>`;

  const button = dashboardUrl ? `
    <div style="margin-top:22px">
      <a href="${esc(dashboardUrl)}" style="display:inline-block;background:linear-gradient(90deg,#6366F1,#8B5CF6 55%,#EC4899);color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:12px">Open the live dashboard →</a>
    </div>` : '';

  const html = `<!doctype html><html><body style="margin:0;background:#F4F3FB;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#14152A">
    <div style="max-width:820px;margin:0 auto;padding:26px">
      <div style="background:linear-gradient(90deg,#6366F1,#8B5CF6 55%,#EC4899);border-radius:18px;padding:24px 26px;color:#fff">
        <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.9">Capex Change Monitor</div>
        <div style="font-size:24px;font-weight:800;margin-top:6px;line-height:1.25">${esc(headline)}</div>
        <div style="font-size:13px;opacity:.9;margin-top:4px">Money companies plan to spend on new plants &amp; machines — straight from their filings.</div>
      </div>
      <div style="background:#fff;border-radius:18px;padding:16px 18px;margin-top:16px;box-shadow:0 12px 34px rgba(20,21,42,.07)">
        ${table}
        ${button}
      </div>
      <p style="color:#9aa0b4;font-size:12px;margin-top:16px;line-height:1.6">
        Source-backed only — every figure comes from a real BSE filing, with the exact quote and a link to the original PDF.
        We never send sample or estimated data.${meta?.generated_at ? ` Generated ${fmtDate(meta.generated_at)}.` : ''}
      </p>
    </div>
  </body></html>`;

  return { html, subject: `Capex Monitor — ${headline}`, companies, count: rows.length };
}

// ---------------------------------------------------------------------------
// Pluggable send
// ---------------------------------------------------------------------------
function pickProvider() {
  if (process.env.EMAIL_PROVIDER) return process.env.EMAIL_PROVIDER;
  if (process.env.RESEND_API_KEY) return 'resend';      // default
  if (process.env.SMTP_HOST) return 'smtp';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  return 'dryrun';
}
const recipients = () => (process.env.EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);

async function sendViaResend({ html, subject }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: recipients(), subject, html }),
  });
  if (!res.ok) throw new Error(`resend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  log('digest sent via Resend');
}

async function sendViaSendgrid({ html, subject }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: recipients().map((email) => ({ email })) }],
      from: { email: process.env.EMAIL_FROM }, subject, content: [{ type: 'text/html', value: html }],
    }),
  });
  if (!res.ok) throw new Error(`sendgrid HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  log('digest sent via SendGrid');
}

async function sendViaSmtp({ html, subject }) {
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; }
  catch { throw new Error('SMTP selected but nodemailer is not installed (run: npm install nodemailer --no-save)'); }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: process.env.EMAIL_FROM, to: process.env.EMAIL_TO, subject, html });
  log('digest sent via SMTP');
}

export async function sendDigest({ html, subject }) {
  const provider = pickProvider();
  if (provider === 'dryrun') {
    log('DRY RUN — no email provider configured. Set RESEND_API_KEY (or SMTP_*/SENDGRID_API_KEY) + EMAIL_FROM/EMAIL_TO to enable.');
    return { provider, sent: false };
  }
  if (!process.env.EMAIL_FROM || !recipients().length) {
    log(`provider=${provider} selected but EMAIL_FROM / EMAIL_TO not set — skipping send.`);
    return { provider, sent: false };
  }
  if (provider === 'resend') await sendViaResend({ html, subject });
  else if (provider === 'sendgrid') await sendViaSendgrid({ html, subject });
  else if (provider === 'smtp') await sendViaSmtp({ html, subject });
  else { log(`unknown EMAIL_PROVIDER=${provider}`); return { provider, sent: false }; }
  return { provider, sent: true };
}

// --- CLI ------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [changes, meta] = await Promise.all([readJSON(FILES.changes, []), readJSON(FILES.metadata, {})]);
  const rows = selectChanges(Array.isArray(changes) ? changes : [], WINDOW);
  log(`digest window=${WINDOW}d — ${rows.length} real change(s) across ${new Set(rows.map((r) => r.scrip_cd)).size} companies`);

  // Zero changes: send nothing unless DIGEST_ALWAYS=1.
  if (!rows.length && !ALWAYS) {
    log('no changes in window — nothing to send (set DIGEST_ALWAYS=1 to send an empty digest).');
    process.exit(0);
  }

  const digest = composeDigest(rows, { days: WINDOW, meta });
  if (args.out) { await writeFile(args.out, digest.html, 'utf8'); log(`wrote HTML preview -> ${args.out}`); }

  const result = await sendDigest(digest);
  if (!result.sent && !args.out) process.stdout.write(digest.html + '\n'); // visible in the Actions log on dry-run
}
