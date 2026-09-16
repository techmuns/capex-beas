// scripts/send-digest.mjs
// Compose an HTML email digest of capex GUIDANCE changes from capex-changes.json
// and send it via a PLUGGABLE provider chosen from env. If no email secret is
// set, it runs DRY (prints/writes the HTML) — recipient + provider are supplied
// in a later phase.
//
// Providers (auto-detected, or force with EMAIL_PROVIDER=smtp|resend|sendgrid|dryrun):
//   SMTP     : SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   (uses nodemailer, install --no-save)
//   Resend   : RESEND_API_KEY
//   SendGrid : SENDGRID_API_KEY
//   (from/to): EMAIL_FROM, EMAIL_TO (comma-separated)
//
// CLI:
//   node scripts/send-digest.mjs            # last 7 days of real changes
//   node scripts/send-digest.mjs --days=30
//   node scripts/send-digest.mjs --all --with-baselines
//   node scripts/send-digest.mjs --out=digest-preview.html

import { writeFile } from 'node:fs/promises';
import { FILES, readJSON, log, parseArgs, nowISO } from './lib/util.mjs';

const args = parseArgs();
const DAYS = args.all ? Infinity : Number(args.days || 7);
const WITH_BASELINES = !!args['with-baselines'];

const fmtCr = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')} Cr`);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function withinWindow(c) {
  if (DAYS === Infinity) return true;
  const t = new Date(c.detected_at || c.new_date).getTime();
  return Number.isFinite(t) && t >= Date.now() - DAYS * 86400_000;
}

/** Build the HTML email body. Inline styles only (email clients are picky). */
export function composeDigest(changes, meta) {
  const real = changes.filter((c) => !c.no_prior_on_record && withinWindow(c));
  const baselines = WITH_BASELINES ? changes.filter((c) => c.no_prior_on_record && withinWindow(c)) : [];
  const companies = new Set(real.map((c) => c.scrip_cd)).size;

  const row = (c) => {
    const up = (c.pct_change ?? 0) >= 0;
    const arrow = c.no_prior_on_record ? '•' : up ? '▲' : '▼';
    const color = c.no_prior_on_record ? '#64748b' : up ? '#16a34a' : '#dc2626';
    const move = c.no_prior_on_record
      ? `<span style="color:#64748b">new (no prior on record)</span>`
      : `${fmtCr(c.old_cr)} <span style="color:${color}">→</span> <strong>${fmtCr(c.new_cr)}</strong>`;
    const pct = c.no_prior_on_record ? '' :
      `<span style="color:${color};font-weight:700">${arrow} ${Math.abs(c.pct_change)}%</span>` +
      ` <span style="color:#64748b">(${c.delta_cr > 0 ? '+' : ''}${fmtCr(c.delta_cr).replace('₹', '₹')})</span>`;
    const links = [
      c.old_pdf ? `<a href="${esc(c.old_pdf)}" style="color:#2563eb">old filing</a>` : '',
      c.new_pdf ? `<a href="${esc(c.new_pdf)}" style="color:#2563eb">new filing</a>` : '',
    ].filter(Boolean).join(' · ');
    return `
      <tr style="border-bottom:1px solid #e5e7eb">
        <td style="padding:10px 8px;vertical-align:top">
          <strong>${esc(c.company)}</strong><br>
          <span style="color:#64748b;font-size:12px">${esc(c.fiscal_year || '')} · scrip ${esc(c.scrip_cd)}</span>
        </td>
        <td style="padding:10px 8px;vertical-align:top">${move}<br>${pct}</td>
        <td style="padding:10px 8px;vertical-align:top;color:#334155">${esc(c.reason || '—')}</td>
        <td style="padding:10px 8px;vertical-align:top;font-size:12px">${fmtDate(c.new_date)}<br>${links}</td>
      </tr>`;
  };

  const table = (title, rows) => rows.length ? `
    <h2 style="font-size:16px;margin:22px 0 8px;color:#0f172a">${title}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="text-align:left;color:#64748b;font-size:12px;text-transform:uppercase">
        <th style="padding:6px 8px">Company</th><th style="padding:6px 8px">Guidance</th>
        <th style="padding:6px 8px">Reason (mgmt words)</th><th style="padding:6px 8px">When / source</th>
      </tr></thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table>` : '';

  const heading = companies
    ? `${companies} ${companies === 1 ? 'company' : 'companies'} changed capex guidance`
    : `No capex guidance changes in the last ${DAYS === Infinity ? 'window' : DAYS + ' days'}`;

  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
    <div style="max-width:760px;margin:0 auto;padding:24px">
      <div style="background:linear-gradient(90deg,#5b8cff,#2dd4bf);border-radius:14px;padding:20px 22px;color:#fff">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.9">Capex Change Monitor</div>
        <div style="font-size:22px;font-weight:800;margin-top:4px">${heading}</div>
      </div>
      <div style="background:#fff;border-radius:14px;padding:8px 18px 18px;margin-top:14px;box-shadow:0 10px 30px rgba(2,6,23,.06)">
        ${table('Capex guidance changes', real)}
        ${WITH_BASELINES ? table('Newly tracked (first sighting)', baselines) : ''}
        ${(!real.length && !baselines.length) ? `<p style="color:#64748b;padding:16px 8px">Nothing to report — the engine keeps scanning BSE filings. Every figure shown here is backed by a verbatim quote and the source PDF; we never show estimated or sample data.</p>` : ''}
      </div>
      <p style="color:#94a3b8;font-size:12px;margin-top:14px">
        Source-backed only. Generated ${fmtDate(meta?.generated_at || nowISO())}.
        Tracking ${meta?.counts?.companies_tracked ?? 0} companies · ${meta?.counts?.observations ?? 0} observations.
      </p>
    </div>
  </body></html>`;

  return { html, subject: `Capex Monitor — ${heading}`, companies, count: real.length, baselines: baselines.length };
}

// ---------------------------------------------------------------------------
// Pluggable send
// ---------------------------------------------------------------------------
function pickProvider() {
  if (process.env.EMAIL_PROVIDER) return process.env.EMAIL_PROVIDER;
  if (process.env.SMTP_HOST) return 'smtp';
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  return 'dryrun';
}

async function sendViaResend({ html, subject }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: (process.env.EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
      subject, html,
    }),
  });
  if (!res.ok) throw new Error(`resend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  log('digest sent via Resend');
}

async function sendViaSendgrid({ html, subject }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: (process.env.EMAIL_TO || '').split(',').map((s) => ({ email: s.trim() })).filter((x) => x.email) }],
      from: { email: process.env.EMAIL_FROM },
      subject,
      content: [{ type: 'text/html', value: html }],
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
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: process.env.EMAIL_FROM, to: process.env.EMAIL_TO, subject, html });
  log('digest sent via SMTP');
}

export async function sendDigest({ html, subject }) {
  const provider = pickProvider();
  if (provider === 'dryrun') {
    log('DRY RUN (no email provider configured) — not sending. Set SMTP_* / RESEND_API_KEY / SENDGRID_API_KEY + EMAIL_FROM/EMAIL_TO to enable.');
    return { provider, sent: false };
  }
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_TO) {
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
  const [changes, meta] = await Promise.all([
    readJSON(FILES.changes, []),
    readJSON(FILES.metadata, {}),
  ]);
  const digest = composeDigest(changes, meta);
  log(`digest: ${digest.companies} companies, ${digest.count} real changes, ${digest.baselines} baselines (window=${DAYS === Infinity ? 'all' : DAYS + 'd'})`);

  const outPath = args.out || (pickProvider() === 'dryrun' ? null : null);
  if (outPath) { await writeFile(outPath, digest.html, 'utf8'); log(`wrote HTML preview -> ${outPath}`); }

  const result = await sendDigest(digest);
  if (!result.sent && !outPath) {
    // In a dry run with no --out, print the HTML so it's visible in the Actions log.
    process.stdout.write(digest.html + '\n');
  }
}
