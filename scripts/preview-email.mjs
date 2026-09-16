// scripts/preview-email.mjs
// Render the Munshot-newspaper email to local HTML files so you can eyeball them
// in a browser before anything is sent. Uses the SAME pure renderer the server
// uses (functions/_lib/*), so the preview is faithful.
//
//   node scripts/preview-email.mjs            # digest (from demo fixture if present) + confirm
//   node scripts/preview-email.mjs --empty    # force the "Nothing new today" state
//
// Reads public/demo/capex-changes.json (git-ignored fixture) for a POPULATED
// preview; falls back to the real (empty) public/data file — never invents data.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDigestEmail, renderConfirmEmail } from '../functions/_lib/email-render.js';
import { selectItems } from '../functions/_lib/digest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

async function loadChanges() {
  if (args.has('--empty')) return [];
  const demo = path.join(ROOT, 'public/demo/capex-changes.json');
  const real = path.join(ROOT, 'public/data/capex-changes.json');
  const file = existsSync(demo) ? demo : real;
  try { const j = JSON.parse(await readFile(file, 'utf8')); return { rows: Array.isArray(j) ? j : [], file }; }
  catch { return { rows: [], file }; }
}

const { rows = [], file } = (await loadChanges()) || {};
const items = selectItems(rows, { cutoffISO: null, filter: 'all' }); // show everything for the preview

const digestHtml = renderDigestEmail({
  items,
  edition: 'All changes',
  cadence: 'weekday',
  timeHHMM: '08:00',
  unsubUrl: 'https://capex-beas.pages.dev/api/unsubscribe?token=preview',
  siteUrl: 'https://capex-beas.pages.dev',
  brandLogoUrl: '',
  now: new Date(),
});
const confirmHtml = renderConfirmEmail({
  confirmUrl: 'https://capex-beas.pages.dev/api/confirm?token=preview',
  edition: 'All changes', cadence: 'weekday', timeHHMM: '08:00',
});

const outDigest = path.join(ROOT, 'email-preview.html');
const outConfirm = path.join(ROOT, 'email-preview-confirm.html');
await writeFile(outDigest, digestHtml);
await writeFile(outConfirm, confirmHtml);

console.log(`source: ${file || '(none)'} · items: ${items.length}`);
console.log(`wrote ${path.relative(ROOT, outDigest)} and ${path.relative(ROOT, outConfirm)}`);
