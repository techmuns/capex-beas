# Capex Guidance Change Monitor

Watches **BSE-listed company filings**, uses an LLM to read out each company's
**capital-expenditure (capex) guidance** figure, remembers it, and flags whenever a
company **changes** its capex plan — e.g. *ASK Automotive raising FY27 capex from
₹500 Cr to ₹700 Cr to build a new South-India plant* (a real, verified filing).

Every stored number keeps its **verbatim quote** and a **working source PDF link**.
No sample, demo, estimated, or LLM-guessed data — ever. If there's no real data yet,
the files stay empty and the UI shows an honest empty state.

## What's built

- **Data engine + automation** — GitHub Actions read BSE filings, extract capex guidance with
  Claude (via the Bedrock **Converse** endpoint + a model fallback chain), detect changes, and
  commit the results back as JSON. Change detection compares on the **top of a stated range**.
- **Capex precision** — only *organic* spend on the company's own plant/equipment/capacity counts.
  Acquisitions / M&A / stake purchases are tagged `acquisition` and **never** counted as a capex
  guidance change. Each observation & change also carries a plain-English **Type** tag (New
  Project, Capacity Expansion, Capex ↑/↓, Quarterly capex, Acquisition (M&A), …).
- **Company context (approx)** — best-effort **Industry · Market Cap · P/E** per company from its
  public Screener page, cached separately, always labelled "approx", blanks allowed, never
  guessed, and never blocking the source-backed capex pipeline.
- **Colorful dashboard** (`public/index.html` + `public/js/*`) — static, CDN-only (Tailwind,
  ECharts 5, Lucide). Tabs: **Overview** (biggest movers + up/down donut), **Changes** (the hero
  feed with filters incl. **Week**, **Type** & **Industry**, cards/table with Industry/Type chips +
  approx Mkt Cap/P·E, verbatim quotes + filing links), and **By Company** (Industry/Mkt Cap/P·E
  header + a step chart of capex over time). Honest empty state until real data lands.
- **Download Excel** — a top-bar button exports the currently-filtered changes (pick a week →
  download exactly that week) as a polished, client-ready `.xlsx` built client-side with ExcelJS
  (title band, frozen/auto-filtered header, colour-coded types, per-row "Open filing" hyperlinks,
  a second "Guidance Changes" sheet); falls back to CSV if the ExcelJS CDN can't load.
- **Email Brief (self-serve)** — a **"Brief"** button opens a slide-in to subscribe (weekday/daily,
  time in IST, All/Increases/Decreases; double opt-in) or "email me this now". A **Munshot
  newspaper**-style HTML digest is sent by **Cloudflare Pages Functions** + a KV namespace, poked
  hourly by a GitHub Actions cron; sends only on days something changed. Every item links its real
  BSE filing. Sending is via the Munshot email API; degrades gracefully until configured.
- **Vision/OCR fallback** for scanned decks (`VISION_OCR=1`), routed through the same gates.

## How it works

- **Static site, no build step** — everything served from `./public`, deployed on
  **Cloudflare Pages**.
- **Node ES-module scripts** in `./scripts`, run by **GitHub Actions**.
- **Committed JSON under `./public/data/`** is the long-term memory across runs.

```
run.mjs → fetch-announcements → pdf-text → extract-capex (LLM) → detect-changes → enrich → commit JSON
                                                                          ↓
        public/index.html (dashboard)  ·  functions/api/* + KV (email Brief, Munshot newspaper)
```

## Quick start

```bash
npm install pdfjs-dist --no-save
# Prove the no-key parts on real filings (no LLM, writes nothing):
node scripts/run.mjs --prove=2 --from=20260810 --to=20260812
npm test                                            # 78 logic tests + Excel smoke test

# Preview the dashboard locally (?demo=1 shows a git-ignored sample layout):
python3 -m http.server 8123 --directory public      # http://localhost:8123/

# Preview the Munshot-newspaper email in a browser:
npm run preview-email                               # writes email-preview.html
```

Full docs — data-file schemas, how to run each stage, the secrets/variables each workflow needs,
the dashboard tabs, and the **one-time Cloudflare Pages setup** — are in **[HANDOFF.md](./HANDOFF.md)**.
The live validation on real filings is in **[docs/PHASE1-PROOF.md](./docs/PHASE1-PROOF.md)**.
