# Capex Guidance Change Monitor

Watches **BSE-listed company filings**, uses an LLM to read out each company's
**capital-expenditure (capex) guidance** figure, remembers it, and flags whenever a
company **changes** its capex plan — e.g. *ASK Automotive raising FY27 capex from
₹500 Cr to ₹700 Cr to build a new South-India plant* (a real, verified filing).

Every stored number keeps its **verbatim quote** and a **working source PDF link**.
No sample, demo, estimated, or LLM-guessed data — ever. If there's no real data yet,
the files stay empty and the UI shows an honest empty state.

> **This repo is Phase 1: the data engine + automation.**
> `public/index.html` is a minimal placeholder that deploys. Phase 2 builds the
> colorful dashboard and turns on the email digest.

## How it works

- **Static site, no build step** — everything served from `./public`, deployed on
  **Cloudflare Pages**.
- **Node ES-module scripts** in `./scripts`, run by **GitHub Actions**.
- **Committed JSON under `./public/data/`** is the long-term memory across runs.

```
run.mjs → fetch-announcements → pdf-text → extract-capex (LLM) → detect-changes → commit JSON
```

## Quick start

```bash
npm install pdfjs-dist --no-save
# Prove the no-key parts on real filings (no LLM, writes nothing):
node scripts/run.mjs --prove=2 --from=20260810 --to=20260812
```

Full docs — data-file schemas, how to run each stage, the secrets each workflow needs,
and the **one-time Cloudflare Pages setup** — are in **[HANDOFF.md](./HANDOFF.md)**.
The live validation on real filings is in **[docs/PHASE1-PROOF.md](./docs/PHASE1-PROOF.md)**.
