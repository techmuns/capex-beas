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
- **Colorful dashboard** (`public/index.html` + `public/js/*`) — static, CDN-only (Tailwind,
  ECharts 5, Lucide). Tabs: **Overview** (biggest movers + up/down donut), **Changes** (the hero
  feed with filters, cards/table, verbatim quotes + filing links), and **By Company** (a step
  chart of capex over time). Honest empty state until real data lands.
- **Email digest** — a colorful weekly HTML summary of changes (Resend / SMTP / SendGrid), dry-run
  until email secrets are set.
- **Vision/OCR fallback** for scanned decks (`VISION_OCR=1`), routed through the same gates.

## How it works

- **Static site, no build step** — everything served from `./public`, deployed on
  **Cloudflare Pages**.
- **Node ES-module scripts** in `./scripts`, run by **GitHub Actions**.
- **Committed JSON under `./public/data/`** is the long-term memory across runs.

```
run.mjs → fetch-announcements → pdf-text → extract-capex (LLM) → detect-changes → commit JSON
                                                                          ↓
                              public/index.html (dashboard) · send-digest.mjs (email)
```

## Quick start

```bash
npm install pdfjs-dist --no-save
# Prove the no-key parts on real filings (no LLM, writes nothing):
node scripts/run.mjs --prove=2 --from=20260810 --to=20260812
npm test                                            # 29 logic unit tests

# Preview the dashboard locally (?demo=1 shows a git-ignored sample layout):
python3 -m http.server 8123 --directory public      # http://localhost:8123/
```

Full docs — data-file schemas, how to run each stage, the secrets/variables each workflow needs,
the dashboard tabs, and the **one-time Cloudflare Pages setup** — are in **[HANDOFF.md](./HANDOFF.md)**.
The live validation on real filings is in **[docs/PHASE1-PROOF.md](./docs/PHASE1-PROOF.md)**.
