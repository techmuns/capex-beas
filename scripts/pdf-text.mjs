// scripts/pdf-text.mjs
// Download a filing PDF and extract its text with pdfjs-dist (legacy build).
// If the PDF is a scanned/image deck (little or no extractable text), we log it
// and leave a hook for a Claude-vision / OCR fallback (implemented in a later
// phase) — we never guess its contents.
//
// CLI:  node scripts/pdf-text.mjs <ATTACHMENTNAME.pdf>
//       node scripts/pdf-text.mjs --url=https://.../AttachHis/<uuid>.pdf

import { downloadPdf } from './lib/bse.mjs';
import { log, parseArgs } from './lib/util.mjs';

// Below this many extracted characters we treat the PDF as "thin" (likely a
// scanned image deck) and defer it to OCR rather than feeding empty text to the LLM.
const THIN_TEXT_CHARS = 220;
const DEFAULT_MAX_PAGES = 80;

/** Extract plain text from a PDF Buffer using pdfjs-dist legacy build. */
export async function extractPdfText(buffer, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  // Imported lazily so the module loads even before `npm install pdfjs-dist`.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0, // errors only — silence noisy font warnings
  });
  const doc = await loadingTask.promise;

  const pageCount = Math.min(doc.numPages, maxPages);
  const parts = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Join text items; pdfjs gives us positioned fragments, space-separated is fine
    // for keyword search + LLM reading.
    parts.push(content.items.map((it) => (it.str || '')).join(' '));
    if (typeof page.cleanup === 'function') page.cleanup();
  }
  // Free resources — API surface varies across pdfjs builds, so guard both.
  try {
    if (typeof doc.destroy === 'function') await doc.destroy();
    else if (typeof loadingTask.destroy === 'function') await loadingTask.destroy();
  } catch { /* non-fatal */ }

  const text = parts.join('\n').replace(/[ \t]+/g, ' ').trim();
  return {
    text,
    numPages: doc.numPages,
    pagesRead: pageCount,
    charCount: text.length,
    thin: text.length < THIN_TEXT_CHARS,
  };
}

/**
 * Placeholder for the OCR / vision fallback used on scanned decks.
 * Phase 2 will send page images to Claude vision (via Bedrock) or an OCR API.
 * For now we log and skip — never fabricate text.
 */
export async function ocrFallback(/* buffer, candidate */) {
  log('  OCR fallback not implemented yet (Phase 2) — skipping scanned/thin PDF');
  return null;
}

/**
 * High-level: given a candidate (needs .attachment), download + extract text.
 * @returns {Promise<{text,numPages,pagesRead,charCount,thin,source_pdf} | null>}
 */
export async function getFilingText(candidate) {
  const dl = await downloadPdf(candidate.attachment);
  if (!dl) {
    log(`  PDF download failed for ${candidate.company} (${candidate.attachment})`);
    return null;
  }
  let extracted;
  try {
    extracted = await extractPdfText(dl.buffer);
  } catch (err) {
    log(`  PDF parse failed for ${candidate.company}: ${err.message}`);
    return null;
  }

  if (extracted.thin) {
    log(`  thin/scanned PDF for ${candidate.company} (${extracted.charCount} chars) — deferring to OCR`);
    await ocrFallback(dl.buffer, candidate);
    return null;
  }
  return { ...extracted, source_pdf: dl.url };
}

// --- CLI ------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const attach = positional[0];

  let buffer, url;
  if (args.url) {
    const res = await fetch(args.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bseindia.com/' },
    });
    buffer = Buffer.from(await res.arrayBuffer());
    url = args.url;
  } else if (attach) {
    const dl = await downloadPdf(attach);
    if (!dl) { log('download failed'); process.exit(1); }
    buffer = dl.buffer; url = dl.url;
  } else {
    log('usage: node scripts/pdf-text.mjs <ATTACHMENTNAME.pdf> | --url=<pdf url>');
    process.exit(1);
  }

  const out = await extractPdfText(buffer);
  log(`source: ${url}`);
  log(`pages: ${out.numPages} (read ${out.pagesRead}) | chars: ${out.charCount} | thin: ${out.thin}`);
  process.stdout.write(out.text + '\n');
}
