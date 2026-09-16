// scripts/pdf-text.mjs
// Download a filing PDF and extract its text with pdfjs-dist (legacy build).
// If the PDF is a scanned/image deck (little or no extractable text) AND
// VISION_OCR=1, we rasterize the capex-relevant page(s) to JPEG and ask Claude
// (via the Converse image support in llm.mjs) to TRANSCRIBE the visible text.
// That transcription then becomes the "source text" — so the same
// anti-hallucination gates in extract-capex still apply (quotes must match it).
// We never guess a scanned deck's contents.
//
// CLI:  node scripts/pdf-text.mjs <ATTACHMENTNAME.pdf>
//       node scripts/pdf-text.mjs --url=https://.../AttachHis/<uuid>.pdf

import { downloadPdf } from './lib/bse.mjs';
import { callLLM } from './llm.mjs';
import { log, parseArgs } from './lib/util.mjs';

// Below this many extracted characters we treat the PDF as "thin" (likely a
// scanned image deck) and defer it to OCR rather than feeding empty text to the LLM.
const THIN_TEXT_CHARS = 220;
const DEFAULT_MAX_PAGES = 80;

// Vision/OCR fallback is OFF by default (it costs vision tokens). Enable with VISION_OCR=1.
const VISION_OCR = process.env.VISION_OCR === '1';
const VISION_MAX_PAGES = Number(process.env.VISION_MAX_PAGES || 5);
const VISION_SCALE = Number(process.env.VISION_SCALE || 2.0);

const OCR_SYSTEM =
  'You transcribe text from images of an Indian company BSE filing / investor presentation. '
  + 'Transcribe ALL visible text VERBATIM, especially every capital-expenditure (capex) figure, '
  + 'rupee amount, fiscal year (e.g. FY27), capacity number (MTPA, MW), and any stated reason. '
  + 'Preserve numbers and units exactly as shown. Output plain text only — do not summarize, '
  + 'interpret, or invent anything. If a slide has no readable text, skip it.';

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

/** Rasterize the capex-relevant page(s) of a PDF to base64 JPEGs (via @napi-rs/canvas). */
export async function renderCapexPagesToJpeg(buffer, { maxPages = VISION_MAX_PAGES, scale = VISION_SCALE } = {}) {
  let canvasMod;
  try { canvasMod = await import('@napi-rs/canvas'); }
  catch { log('  VISION_OCR: @napi-rs/canvas not installed — run: npm install @napi-rs/canvas --no-save'); return []; }
  // pdfjs' canvas backend expects these globals; provide them from @napi-rs/canvas.
  for (const g of ['DOMMatrix', 'Path2D', 'ImageData']) {
    if (!globalThis[g] && canvasMod[g]) globalThis[g] = canvasMod[g];
  }
  const { createCanvas } = canvasMod;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).promise;

  // Prefer pages whose (thin) text still mentions capex; otherwise take the first pages.
  const hint = /capex|capital expenditure|capacity|expansion|greenfield|brownfield|mtpa|\bmw\b|invest|plant|commission/i;
  const chosen = [];
  for (let i = 1; i <= doc.numPages && chosen.length < maxPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent().catch(() => ({ items: [] }));
    if (hint.test(tc.items.map((it) => it.str || '').join(' '))) chosen.push(i);
  }
  if (!chosen.length) for (let i = 1; i <= Math.min(maxPages, doc.numPages); i++) chosen.push(i);

  const images = [];
  for (const n of chosen) {
    try {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      images.push(canvas.toBuffer('image/jpeg').toString('base64'));
    } catch (e) { log(`  VISION_OCR: could not render page ${n}: ${e.message}`); }
  }
  try { await doc.destroy(); } catch {}
  return images;
}

/**
 * OCR/vision fallback: transcribe a scanned deck's capex text with Claude vision.
 * Returns the transcribed plain text (which becomes the source for the gates), or null.
 */
export async function ocrTranscribe(buffer, candidate) {
  if (!VISION_OCR) {
    log('  thin/scanned PDF — set VISION_OCR=1 to enable Claude-vision transcription (skipping)');
    return null;
  }
  const imagesB64 = await renderCapexPagesToJpeg(buffer);
  if (!imagesB64.length) return null;
  log(`  VISION_OCR: transcribing ${imagesB64.length} page image(s) for ${candidate.company}…`);
  try {
    const { text, provider, model } = await callLLM({
      system: OCR_SYSTEM,
      prompt: `This is a filing from ${candidate.company}. Transcribe all visible text, verbatim.`,
      max_tokens: 3000, temperature: 0, imagesB64,
    });
    log(`  VISION_OCR: got ${text.length} chars [${provider}/${model}]`);
    return text;
  } catch (e) { log(`  VISION_OCR failed: ${e.message}`); return null; }
}

/**
 * High-level: given a candidate (needs .attachment), download + extract text.
 * On a thin/scanned PDF, falls back to Claude-vision OCR when VISION_OCR=1.
 * @returns {Promise<{text,numPages,pagesRead,charCount,thin,source_pdf,ocr?} | null>}
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
    log(`  thin/scanned PDF for ${candidate.company} (${extracted.charCount} chars)`);
    const ocrText = await ocrTranscribe(dl.buffer, candidate);
    if (ocrText && ocrText.trim().length >= THIN_TEXT_CHARS) {
      const text = ocrText.replace(/[ \t]+/g, ' ').trim();
      return { text, numPages: extracted.numPages, pagesRead: extracted.numPages, charCount: text.length, thin: false, source_pdf: dl.url, ocr: true };
    }
    return null; // still nothing usable — skip honestly
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
