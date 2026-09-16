# Capex Guidance Change Monitor — Phase 1 Handoff

A source-backed engine that watches **BSE-listed company filings**, uses an LLM to read
out any **capital-expenditure (capex) guidance** figure, remembers it, and flags whenever a
company **changes** its capex plan (e.g. ASK Automotive raising FY27 capex from ₹500 Cr to
₹700 Cr to build a new South-India plant). It emails a digest (Phase 2) and shows everything
on a static dashboard (Phase 2).

**Phase 1 (this repo) = the data engine + automation only.** The page at `public/index.html`
is a minimal placeholder that deploys and shows an honest empty state until real data lands.

---

## 1. Architecture at a glance

```
GitHub Actions (cron)                         Committed JSON = long-term memory
────────────────────                          ─────────────────────────────────
backfill.yml / daily.yml                      public/data/capex-history.json
   │                                          public/data/capex-changes.json
   ▼                                          public/data/processed.json
scripts/run.mjs  ── orchestrates ──►          public/data/metadata.json
   ├─ fetch-announcements.mjs  (BSE feed + cheap prefilter)   public/data/backfill-cursor.json
   ├─ pdf-text.mjs             (download PDF + pdfjs-dist text; VISION_OCR fallback)  public/data/company-enrichment.json
   ├─ extract-capex.mjs        (LLM → strict JSON + anti-hallucination) │ commit back to repo
   ├─ llm.mjs                  (Bedrock Converse chain, Mistral fallback) │
   ├─ detect-changes.mjs       (history + change detection)   ▼
   └─ enrich.mjs               (Screener market context: industry/mktcap/P·E — best-effort)   Cloudflare Pages auto-deploys ./public
functions/api/* + functions/_lib/*  (email subscription API — §11)   → public/index.html + public/js/* (dashboard)
```

- **Static site, no build step.** Everything the browser needs is in `./public` (the dashboard is
  `public/index.html` + `public/js/{ui,app}.js`, using CDN libs — Tailwind, ECharts 5, Lucide).
- **Scripts are Node ES modules (`.mjs`)** run by GitHub Actions on Node 22.
- **Committed JSON under `./public/data/`** is the app's memory across runs (Actions has no
  persistent disk, so state is committed back to the repo).
- **No frontend install** — the dashboard loads CDN libs at runtime; nothing to build.

### Source-backed, non-negotiable
Every number/date/reason/change stored keeps a **`verbatim_quote`** and a **working source PDF
URL**. Enforced *in code* after the LLM answers:
1. an item's amount digits must literally appear in its `verbatim_quote`, else it's dropped;
2. the `verbatim_quote` must be found (whitespace-normalized) in the source text, else dropped;
3. `reason` must itself be traceable to the source text, else it's set to `null` (never inferred);
4. the "old" number in a change is always a **real prior observation** — if there's no real
   prior, we record the new number with `old_cr: null` and `no_prior_on_record: true`. We never
   invent a previous figure.
5. ₹-crore values are computed **deterministically from the verbatim text** (no LLM math trusted
   for INR figures); foreign-currency figures are kept but left un-converted rather than guessed.
6. **Capex means organic spend only** (own plant, equipment, capacity — greenfield/brownfield,
   new lines/machinery, debottlenecking, expansion). **Acquisitions / M&A / stake or equity
   purchases / JV capital / ICDs / buybacks are NOT capex**: they're recorded as
   `type: "acquisition"` (so they still show as context) but **never** produce a capex guidance
   change. A deterministic code-side guard (`isAcquisition`, in `extract-capex.mjs`) flips any
   M&A figure to `acquisition` even if the LLM mis-tagged it — see §13 (Phase 4).

**External market context is separate and clearly labelled "approx".** Industry, market cap and
P/E come from a company's public Screener page, are cached in `company-enrichment.json` (never
mixed into the source-backed capex records), may be **blank** when not found, and are **never
guessed**. An enrichment failure never blocks or corrupts the capex pipeline. See §13.

If there's no real data yet, the files stay empty and the UI shows an honest empty state.

---

## 2. Data files — exact schemas

All live under `public/data/`. Written pretty-printed (2-space) for readable git diffs.

### `capex-history.json` — every observation, keyed by BSE scrip code
```jsonc
{
  "544022": [                       // key = SCRIP_CD (string)
    {
      "date": "2026-08-10T10:00:00",// filing datetime (NEWS_DT)
      "week": "10–16 Aug 2026",     // Mon–Sun week label of `date` (Phase 4.1)
      "news_id": "64dee966-…",      // BSE NEWSID (dedupe key)
      "company": "ASK Automotive Ltd",
      "scrip_cd": 544022,
      "fiscal_year": "FY27",        // normalized; null if not stated
      "type": "guidance",           // guidance | actual | plan | cumulative | acquisition
      "event_type": "New Project",  // canonical tag (Phase 4): New Project | Capacity Expansion | Capex ↑ | Capex ↓ | Guidance revision | Quarterly capex | Acquisition (M&A)
      "amount_text": "Rs. 700 crore",// verbatim, as written in the filing
      "currency": "INR",            // INR | USD | EUR | GBP
      "amount_cr": 700,             // ₹ crore used for change detection = the TOP of a stated range
      "amount_cr_low": 700,         // low end of a stated range (== amount_cr for a single value)
      "amount_cr_high": 700,        // high end of a stated range (== amount_cr)
      "comparable": true,           // false for foreign-currency (no FX guess); then amount_cr is null
      // "ocr": true                // present only when the text came from the vision/OCR fallback
      "segment_or_project": "new plant in South", // or null
      "direction": "up",            // up | down | flat | unclear (filing's own framing)
      "reason": null,               // management's own words, or null (never inferred)
      "quote": "…Rs. 700 crore this year.", // verbatim_quote
      "source_pdf": "https://www.bseindia.com/xml-data/corpfiling/AttachLive/64dee966-….pdf",
      "category": "Company Update",
      "subcat": "Earnings Call Transcript"
    }
  ]
}
```

### `capex-changes.json` — guidance changes + first-seen baselines (array)
```jsonc
[
  {
    "company": "ASK Automotive Ltd",
    "scrip_cd": 544022,
    "fiscal_year": "FY27",
    "type": "guidance",
    "event_type": "Capex ↑",       // canonical tag (Phase 4): a real move is Capex ↑/↓; a baseline is by nature (New Project / Capacity Expansion / Guidance revision)
    "old_cr": 500,                 // real prior observation's amount_cr (top of range, ₹ cr)
    "new_cr": 700,
    "delta_cr": 200,
    "pct_change": 40,
    "direction": "up",             // computed from old→new
    "reason": null,                // new observation's reason (mgmt words) or null
    "old_quote": "…Rs. 450 crore to Rs. 500 crore…",
    "new_quote": "…Rs. 700 crore this year.",
    "old_pdf": "https://…/AttachLive/…prior.pdf",
    "new_pdf": "https://…/AttachLive/…new.pdf",
    "old_date": "2026-05-25T10:00:00",
    "new_date": "2026-08-10T10:00:00",
    "old_news_id": "…", "new_news_id": "…",
    "week": "10–16 Aug 2026",      // Mon–Sun week label of new_date (Phase 4.1)
    "no_prior_on_record": false,   // true for a first-sighting baseline (then old_* are null)
    "detected_at": "2026-09-16T…Z" // stable across recomputes
  }
]
```
- A change **fires** when, for the same `(scrip_cd, fiscal_year, type="guidance")`, a new
  observation's `amount_cr` differs from the most-recent prior guidance `amount_cr` by more than
  `CAPEX_CHANGE_PCT`% (default **2%**, to ignore rounding). **The comparison uses the TOP of a
  stated range** (e.g. "₹450–500 cr" compares as 500); a single value has low == high.
- The **first** guidance sighting for a `(company, FY)` is recorded as a baseline
  (`no_prior_on_record: true`, `old_cr: null`).
- Only `type="guidance"` participates — a single-year guidance is never compared against an
  `actual`, a multi-year `cumulative`, or an `acquisition` (M&A is recorded but never a capex change).

### `processed.json` — seen NEWSIDs (dedupe across runs)
```jsonc
{
  "version": 1,
  "processed": {
    "64dee966-…": { "at": "2026-09-16T…Z", "scrip_cd": 544022, "status": "capex", "capex_found": 2 }
    // status: "capex" | "no_capex" | "no_text"   (no_text = download failed / scanned/thin PDF)
  }
}
```

### `metadata.json` — run summary (drives the placeholder page stats)
```jsonc
{
  "last_run": "2026-09-16T…Z",
  "mode": "daily",                 // daily | backfill | manual
  "window": { "from": "20260914", "to": "20260916" },
  "counts": { "companies_tracked": 0, "observations": 0, "changes": 0, "baselines": 0, "processed_news_ids": 0 },
  "provider_used": "bedrock",      // which LLM answered last
  "generated_at": "2026-09-16T…Z"
}
```

### `company-enrichment.json` — external market context, keyed by scrip (Phase 4)
```jsonc
{
  "544022": {                       // key = SCRIP_CD (string)
    "company": "ASK Automotive Ltd",
    "industry": "Auto Ancillaries", // may be null (blank is fine — never guessed)
    "sector": "Automobile",         // may be null
    "market_cap_cr": 12500,         // ₹ crore; may be null
    "pe": 34.2,                     // Stock P/E; may be null
    "as_of": "2026-09-14T…Z",       // when fetched (drives the 7-day staleness re-fetch)
    "source_url": "https://www.screener.in/company/544022/"
  }
}
```
- **Not** source-backed capex data — auxiliary market context read from the company's public
  Screener page. Always shown as **"approx"** in the UI, cached separately, **blanks allowed**,
  never fabricated. Filled incrementally by `enrich.mjs` (≤15 companies/run; re-fetched after 7
  days). See §13.

### `backfill-cursor.json` — resumable 90-day backfill state
```jsonc
{
  "initialized": true,
  "done": false,                   // true once caught up (runs then no-op)
  "start_date": "20260320",        // today − BACKFILL_DAYS
  "end_date": "20260916",          // today (fixed at init)
  "cursor_date": "20260402",       // next day to process (advances oldest→newest)
  "updated_at": "2026-09-16T…Z"
}
```

---

## 3. The BSE data source (what we learned)

- **Announcements API** (public JSON, works from cloud IPs, no cookie handshake):
  `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=1&strCat=-1&subcategory=-1&strPrevDate=YYYYMMDD&strToDate=YYYYMMDD&strSearch=P&strscrip=&strType=C`
  Headers: browser `User-Agent`, `Accept: application/json, text/plain, */*`,
  `Referer: https://www.bseindia.com/`, `Origin: https://www.bseindia.com`.
  - **It is a PER-DAY query**: `strPrevDate` **must equal** `strToDate`. A real multi-day range
    returns `{}`. Volume within a day is handled by **pagination** (`pageno=1,2,…`, 50/page);
    `Table1[0].ROWCNT` is the day's total. Records are under `Table[]`.
  - Useful fields: `NEWSID` (dedupe), `SCRIP_CD`, `SLONGNAME`, `HEADLINE`, `NEWSSUB`,
    `CATEGORYNAME`, `SUBCATNAME`, `ATTACHMENTNAME` (`uuid.pdf`), `NEWS_DT`/`DT_TM`/`DissemDT`,
    `Investor_Presentation` (flag).
- **Filing PDF**: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/<ATTACHMENTNAME>` —
  if that 404s, fall back to `.../AttachHis/<ATTACHMENTNAME>` (older filings). Add UA + Referer.
- **Fallbacks** (optional, only if a direct fetch fails): `SCRAPE_DO_API_KEY`, then
  `FIRECRAWL_API_KEY`. Built into `scripts/lib/bse.mjs`.

### Prefilter (before downloading any PDF)
`fetch-announcements.mjs` keeps a filing if **any** of:
- its `HEADLINE`/`NEWSSUB` hits a capex keyword (capex, capital expenditure/outlay/investment,
  capacity expansion/addition, greenfield/brownfield, debottlenecking, new plant, expansion,
  MTPA, `<n> MW`, commissioning, capital work-in-progress, …);
- its `SUBCATNAME` is a high-signal type (Investor Presentation, Analyst/Investor Meet,
  Con-call / Earnings Call Transcript, Press/Media Release, Financial Results);
- its `CATEGORYNAME` is `Result` or `Board Meeting`;
- the `Investor_Presentation` flag is set.
Only filings with a `.pdf` attachment are kept (Phase 1 needs the filing text). Set
`CAPEX_BROAD=1` to also keep every Result / Board Meeting filing and the Financial Results
subcat (max recall, much higher LLM cost).

**Measured volume (real days):** a busy results-season day (2026-08-14, ~3,000 filings) yields
**287 candidates** with the default tight filter (vs 1,511 if Result/Board-Meeting/Financial-
Results were kept broadly); a quiet day is ~30–80. Verified that the tight filter keeps exactly
the capex-bearing ASK Automotive filings (both earnings-call transcripts + both investor
presentations + analyst meets + press releases) and drops the AGM/ESG/newspaper/dividend noise.
The 90-day backfill is therefore roughly 7–10k LLM calls total, drained across many capped
runs — tune `MAX_ANNOUNCEMENTS_PER_RUN` / cron cadence / `CAPEX_BROAD` to your budget.

---

## 4. How to run locally

```bash
# One-time: install the PDF parser (kept out of package.json on purpose; CI uses --no-save)
npm install pdfjs-dist --no-save

# Prove the no-key parts on REAL filings (fetch + PDF + text; no LLM, writes nothing):
node scripts/run.mjs --prove=2 --from=20260810 --to=20260812

# Individual stages:
node scripts/fetch-announcements.mjs --from=20260810 --to=20260810   # prints kept candidates (JSON)
node scripts/pdf-text.mjs <ATTACHMENTNAME.pdf>                        # prints extracted text
node scripts/pdf-text.mjs --url=https://www.bseindia.com/xml-data/corpfiling/AttachLive/<uuid>.pdf

# Full pipeline (needs an LLM key — Bedrock Converse chain, see §5):
BEDROCK_API_KEY=… AWS_REGION=us-east-1 node scripts/run.mjs --mode=daily
node scripts/run.mjs --mode=backfill        # drains one backfill chunk, advances the cursor
node scripts/run.mjs --from=20260804 --to=20260804   # manual explicit window

# Rebuild changes.json deterministically from history.json:
node scripts/detect-changes.mjs

# Enrich market context (Phase 4) — best-effort Screener fetch, blanks allowed:
node scripts/enrich.mjs --scrip=544022 --company="ASK Automotive"   # print one company's context
node scripts/enrich.mjs --all --cap=15                                # enrich uncached/stale companies

# Preview the Munshot-newspaper email locally (writes email-preview*.html):
npm run preview-email            # populated from the demo fixture (git-ignored)
npm run preview-email -- --empty # the "Nothing new today" state
node scripts/llm.mjs --selftest             # one tiny call; logs which provider+model answered
npm install exceljs --no-save               # only needed for the Excel-builder smoke test
npm test                                    # 78 logic tests + Excel smoke test (M&A, event_type, enrichment, week, xlsx)

# Dashboard: it's static — open public/index.html via any static server, e.g.
python3 -m http.server 8123 --directory public   # then visit http://localhost:8123/
#   ?demo=1 loads a local, git-ignored fixture (public/demo/*.json) to preview the POPULATED
#   layout. The shipped public/data/*.json stay empty; nothing fake is ever committed.

# Vision/OCR fallback for scanned decks (optional; costs vision tokens):
npm install @napi-rs/canvas --no-save
VISION_OCR=1 node scripts/run.mjs --mode=daily
```

---

## 5. Secrets & variables each workflow needs

Put **keys** under GitHub → Settings → **Secrets** → Actions, and **non-secret config** under
GitHub → Settings → **Variables** → Actions (the workflows read those as `vars.*`).

**Secrets (keys):**

| Secret | Used by | Purpose |
|---|---|---|
| `BEDROCK_API_KEY` | backfill, daily | Claude via Bedrock (**primary** LLM) — Bearer token |
| `AWS_REGION` | backfill, daily | Bedrock region (default `us-east-1` if unset) |
| `MISTRAL_API_KEY` | backfill, daily | **Fallback** LLM (OpenAI-style), used only if every Bedrock model fails |
| `FIRECRAWL_API_KEY` | backfill, daily | optional BSE fetch fallback |
| `SCRAPE_DO_API_KEY` | backfill, daily | optional BSE fetch fallback |
| `DIGEST_KEY` | digests.yml **+** Pages env | shared secret locking `POST /api/run-digests` (`x-digest-key`). Set the SAME value as a GitHub secret and a Pages env var. |
| `MUNS_TOKEN` | Pages env | Bearer token for the Munshot email API. Unset → nothing is sent (no crash). |

(Email keys live on the **Cloudflare Pages** project — Settings → Environment variables — since the sending happens in the Function; see §11.)

**Variables (non-secret config, all optional):**

| Variable | Default | Purpose |
|---|---|---|
| `BEDROCK_MODEL_IDS` | `anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-4-5-20250929-v1:0` | comma-separated **model fallback chain** tried in order via the Bedrock **Converse** endpoint |
| `BEDROCK_MODEL` | — | a single id prepended to the chain (back-compat) — can be a Secret or Variable |
| `BEDROCK_RETRY_ROUNDS` | 8 (backfill sets 12) | patient-retry rounds across the chain (60s wait between rounds when all models are busy) |
| `MISTRAL_MODEL` | `mistral-large-latest` | fallback model id |
| `SITE_URL` | — | the live site origin (e.g. `https://capex-beas.pages.dev`). Used by `digests.yml` to reach `/api/run-digests`, and by the Functions for links. |
| `VISION_OCR` | — | `1` = enable the Claude-vision OCR fallback for scanned decks (also installs `@napi-rs/canvas`) |
| `VISION_MAX_PAGES` / `VISION_SCALE` | 5 / 2.0 | OCR page cap and raster scale |

The LLM step uses the **Bedrock Converse** endpoint
(`…/model/<id>/converse`, `Authorization: Bearer …`) and walks the model chain with patient retry
(429/5xx → next model; 400/403/404 → skip that model; after a full busy round, wait 60s and retry).
It runs with **either** Bedrock or Mistral; if neither is set, `run.mjs` exits cleanly without
touching state (and `--prove` still validates fetch + PDF + text). **Email** is handled entirely by
the subscription system (§11), not by this pipeline.

The two workflows share a `concurrency` group so they never commit to `public/data` at the same
time, and each commits with a **fetch + rebase + push retry loop** (4 attempts, exponential
backoff — see `scripts/ci-commit.sh`).

- **`.github/workflows/backfill.yml`** — `workflow_dispatch` + cron `9,39 * * * *` (twice hourly,
  off the marks). Drains the 90-day baseline via the cursor, then no-ops. **Disable it once
  `backfill-cursor.json` shows `"done": true`** (Actions → workflow → ⋯ → Disable). Dispatch
  inputs let you tune `days_per_run` / `max_per_run`.
- **`.github/workflows/daily.yml`** — `workflow_dispatch` + cron `23 1 * * *` (01:23 UTC daily,
  off the marks). Forward run over the last ~2 days, then commit. (No email here anymore.)
- **`.github/workflows/digests.yml`** — `workflow_dispatch` + cron `5 * * * *` (hourly). POSTs
  `SITE_URL/api/run-digests` with the `x-digest-key` header; the Function emails everyone due.
  Skips cleanly if `SITE_URL`/`DIGEST_KEY` aren't set. See §11.

Env knobs (optional): `BACKFILL_DAYS` (90), `DAILY_LOOKBACK_DAYS` (2), `BACKFILL_DAYS_PER_RUN`
(3), `MAX_ANNOUNCEMENTS_PER_RUN` (backfill 150), `DAILY_MAX` (400), `CAPEX_CHANGE_PCT` (2).
Enrichment (Phase 4, all optional): `ENRICH_CAP` (15 companies/run), `ENRICH_STALE_DAYS` (7),
`ENRICH_DELAY_MS` (1500), `ENRICH_DISABLE=1` (skip the Screener step entirely).

---

## 6. Cloudflare Pages — one-time setup (then it's automatic forever)

You only do this **once**. After that, **every push to the default branch — including the
automated data commits from GitHub Actions — auto-deploys**. You never deploy by hand.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Pick this GitHub repo and authorize access.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty — there is no build step)*
   - **Build output directory:** `public`
4. **Save and Deploy.**

`wrangler.jsonc` already declares `pages_build_output_dir: "./public"`. That's it — from now on
the site (and the JSON the Actions write) redeploy on every commit, with zero manual steps.

---

## 7. What's proven in Phase 1 (real filings, no seed data)

Validated live against BSE (see `docs/PHASE1-PROOF.md` for the full run):
- The BSE feed + pagination work from a cloud IP (908 records on a busy day).
- Real PDFs download (AttachLive, with AttachHis fallback) and parse with `pdfjs-dist`.
- **ASK Automotive's real Q1 FY27 earnings-call transcript** (2026-08-10) contains the exact
  scenario from the brief: management "revised the guidance" for FY27 capex from *"Rs. 450 crore
  to Rs. 500 crore"* to *"Rs. 700 crore this year."* The verbatim quotes pass the real
  anti-hallucination gates, a fabricated figure is correctly rejected, and the change detector
  emits **FY27 guidance ₹500 Cr → ₹700 Cr (+40%, up)** with both source PDFs.
- `npm test` — 78 logic unit tests pass (normalization incl. top-of-range, FY parsing, gates,
  change detection, JSON extractor, the Bedrock Converse model-chain fallback with fetch mocked,
  the digest mapping/selection for the email Brief, and the Phase 4 additions: M&A/acquisition
  detection + exclusion end-to-end, `event_type` derivation, Screener enrichment parsing, and the
  Mon–Sun `weekOf` labels) — plus an Excel-builder smoke test (`scripts/test/excel-test.mjs`) that
  builds the real workbook on a fixture and checks the title band, headers, hyperlink, freeze,
  auto-filter, the 2nd sheet, and the CSV fallback.

`capex-history.json` / `capex-changes.json` ship **empty** — they fill only with real results
once the workflows run with an LLM key in Actions. No sample/demo data, ever.

---

## 8. The dashboard (`public/index.html` + `public/js/*`)

Static, CDN-only (Tailwind + ECharts 5 + Lucide + Google Fonts) — no build step. It reads the
committed JSON with `cache: "no-store"` and degrades to a friendly on-brand **empty state** on
every tab until real data lands (verified). Three tabs:

- **Overview** — one hero sentence + two small stat chips (no KPI wall), a diverging bar of the
  biggest ₹ changes (green up / red down), an up-vs-down donut, and a “biggest mover” card.
- **Changes** — the hero feed, newest first, with dropdown filters (**Week**, time window,
  direction, **Type**, **Industry**, company search) and a **Cards ⇄ Table** toggle. Picking a
  **Week** (a Mon–Sun label, newest-first, or "All time") is authoritative — it overrides the
  rolling time window and drives the **Download Excel** export too. Each card shows the
  plain-English “Old plan → New plan”, the % badge, an **Industry** chip, a colored **Type** chip
  (New Project / Capacity Expansion / Capex ↑↓ / …), the reason, small muted **APPROX** market
  cap · P/E context, an expandable **exact quote from the filing**, and a **See the official
  filing** link. The table view adds **Industry, Type, Mkt Cap (~), P/E (~)** columns. Baselines
  render as a subtle “first reading” card.
- **By Company** — a searchable company picker → the company header shows its **Industry ·
  Market Cap · P/E** (approx), a step chart of that company’s capex plan over time (per fiscal
  year, guidance only — acquisitions are excluded from the line), and a table of all its
  observations with a **Type** column and source links.

The market-context values (industry / market cap / P/E) are always rendered visually distinct —
italic, muted, with an **APPROX** badge and a "source" link — so they can never be mistaken for
the bold, filing-verified capex figures.

`public/js/ui.js` holds the design system (colors, formatters, the ECharts registry);
`public/js/app.js` holds data-loading, tabs and rendering. To preview the populated layout locally
use `?demo=1` (loads the git-ignored `public/demo/` fixture) — see §4.

## 9. What shipped in Phase 2 (this update)

- **Bedrock via the Converse endpoint** with an env-driven **model fallback chain**
  (`BEDROCK_MODEL_IDS`) and patient retry — the pattern proven on the account. Vision (image)
  support added for OCR.
- **Top-of-range comparison** — change detection compares on the high end of a stated range.
- The **colorful dashboard** (§8).
- **Vision/OCR fallback** for scanned decks (`VISION_OCR=1`): renders capex pages to JPEG, has
  Claude transcribe them, and runs that transcription through the **same** anti-hallucination gates.

_(Phase 2's Resend/SMTP email transport has been **retired** and replaced by the subscription
system in §11 — the Munshot API is now the only sender.)_

## 10. What shipped in Phase 3 (this update) — the email Brief

A self-serve **email subscription** system, served as **Cloudflare Pages Functions** on the same
Pages project (one deploy, no new domain):

- A **"Brief" button** in the dashboard top bar opens a slide-in panel: email, **Every weekday /
  Every day**, a **time picker (IST)**, an **All / Increases / Decreases** filter, **Subscribe**
  (double opt-in), and **Email me this now** (one-off). Fully additive — the dashboard is
  unaffected and the panel says "not switched on yet" if the API/KV/token isn't configured.
- **KV** (`SUBS`) holds only subscriptions; the digest reads change data at runtime by fetching
  the site's own `/data/capex-changes.json`.
- The email is the **Munshot newspaper** style (`functions/_lib/email-render.js`) — one pure
  renderer used by both the Function and `npm run preview-email`. Category chips: Increased=green,
  Decreased=rose, First reading=slate; status dots mirror direction; every item links its real BSE
  filing PDF. On days with nothing new, nothing is sent (unless `SEND_EMPTY=true`).

## 11. The email subscription system

**Endpoints (Pages Functions, `functions/api/*`), all open (no login) except run-digests:**

| Route | Method | Purpose |
|---|---|---|
| `/api/subscribe` | POST | `{email,cadence,time,filter}` → stores a **pending** sub + sends a double-opt-in confirm email. IP-capped (10/hr). |
| `/api/confirm?token=` | GET | flips a pending sub to **active**. |
| `/api/unsubscribe?token=` | GET | one-click unsubscribe (link in every email). |
| `/api/send-now` | POST | `{email,filter}` → instant one-off digest (last 30 days). Rate-limited 3/email/hr. |
| `/api/run-digests` | POST | **locked** by `x-digest-key` = `DIGEST_KEY`. Hourly cron target. Idempotent (once-per-day-per-person guard, IST). |

**KV keys:** `sub:<sha256(email)>` → record; `unsub:<token>`/`confirm:<token>` → sub key; plus
best-effort `rate:*` counters. Re-subscribe keeps the existing `unsubToken` + `lastSentDate`.

**Env (all optional; unset → graceful):** on the **Cloudflare Pages** project (Settings →
Environment variables): `MUNS_TOKEN` (Munshot Bearer; unset → no send), `DIGEST_KEY` (must equal
the GitHub secret), `SITE_URL`, optional `MUNS_EMAIL_ENDPOINT` (default
`https://devde.muns.io/email/send/raw`), `BRAND_LOGO_URL` (a logo swaps the MUNSHOT wordmark, 34px),
`SEND_EMPTY=true` (send even with nothing new). On **GitHub**: secret `DIGEST_KEY` + variable
`SITE_URL` (for `digests.yml`). KV binding `SUBS` (see `wrangler.jsonc`).

### One-time setup checklist (done once, then automatic forever)

1. **Create the KV namespace** and bind it as **`SUBS`** — either uncomment + paste its id in
   `wrangler.jsonc`, or in the Pages dashboard → Settings → Functions → KV namespace bindings.
2. On the **Pages project** → Settings → Environment variables (Production), set: `MUNS_TOKEN`,
   `DIGEST_KEY` (pick any long random string), `SITE_URL` (e.g. `https://capex-beas.pages.dev`),
   and optionally `BRAND_LOGO_URL` / `SEND_EMPTY`.
3. On **GitHub** → Settings → Secrets and variables → Actions: add secret **`DIGEST_KEY`** (same
   value as step 2) and variable **`SITE_URL`** (same as step 2).
4. Push / redeploy once so the Functions ship. Done — the hourly `digests.yml` fires from then on,
   and the dashboard's Brief panel is live.

_Until steps 1–2 are done, the dashboard works normally and the Brief panel shows "not switched on
yet." Nothing breaks._

## 13. What shipped in Phase 4 (this update)

Goal: match (and beat) a manual weekly "new project / capex tracker" spreadsheet
(Company · Date · Type · Summary · Capex Value · Market Cap · P/E · Industry · Source), while
keeping every capex figure source-backed and not breaking the tabs or the email Brief.

- **Capex precision — M&A is not capex.** `extract-capex.mjs`'s prompt now defines capex as
  organic spend on the company's own plant/equipment/capacity only, and explicitly excludes
  acquisitions, stake/equity purchases, JV capital, financial investments, loans/ICDs and
  buybacks. A new observation `type: "acquisition"` captures M&A capital, and a deterministic
  code-side guard (`isAcquisition`) forces any M&A figure to `acquisition` even if the LLM
  mis-tagged it. `detect-changes.mjs` only ever moves on `type="guidance"`, so **acquisitions are
  recorded but never counted as a capex guidance change** (unit-tested end-to-end with a
  Solar-Industries-style "acquire Omnia Holdings for Rs 11,300 crore").
- **Company enrichment — Industry · Market Cap · P/E.** `scripts/enrich.mjs` reads each company's
  **public Screener page** (`https://www.screener.in/company/<SCRIP_CD>/`, resolves by BSE scrip
  code, no login) and caches `{ company, industry, sector, market_cap_cr, pe, as_of, source_url }`
  in `public/data/company-enrichment.json`. Direct fetch → `SCRAPE_DO_API_KEY` → `FIRECRAWL_API_KEY`
  fallback. Incremental + gentle: only un-cached / >7-day-stale companies, ≤15 per run, with a
  delay. **Blanks are allowed and nothing is ever guessed.** Wired into `run.mjs` inside a
  try/catch so an enrichment failure never blocks or corrupts the capex pipeline.
- **Event `Type` tag.** Every observation and change carries a canonical `event_type` derived
  **in code** (`deriveEventType` in `lib/util.mjs`) from type + direction + segment/keywords:
  `New Project | Capacity Expansion | Capex ↑ | Capex ↓ | Guidance revision | Quarterly capex |
  Acquisition (M&A)`.
- **Dashboard (Part D).** Industry + colored Type chips and muted "approx" Market Cap / P/E on
  every Changes card; Industry / Type / Mkt Cap / P/E columns + Industry & Type dropdown filters
  in the table; Industry · Market Cap · P/E in the By-Company header and a Type column in its
  observations table. Enrichment values are visually distinct (italic, muted, "APPROX" badge) so
  they're never confused with the source-backed capex figures. The email Brief is unchanged.
- **Week concept + filter (Part 4.1).** `weekOf()` (in `lib/util.mjs`, mirrored in `public/js/ui.js`)
  derives a deterministic Mon–Sun label (e.g. "10–16 Aug 2026") from any date; every observation &
  change carries `week`. The Changes tab gains a **Week** dropdown (available weeks newest-first +
  "All time") that filters both the on-screen list and the Excel export.
- **Download Excel (Part 4.2).** A top-bar **Download Excel** button exports the CURRENTLY FILTERED
  rows to a polished, client-ready `.xlsx`, built entirely client-side with **ExcelJS** (loaded from
  a CDN `<script>` in `index.html`; `public/js/excel.js` falls back to CSV if it can't load). Title
  band + subtitle, brand-indigo frozen header with Excel auto-filter, per-column number formats,
  category colour-coding + zebra striping + thin borders, a real "Open filing" **hyperlink** per row,
  and an optional second **"Guidance Changes"** sheet (real ₹old→₹new revisions only). Filename
  `capex_tracker_<from>_<to>.xlsx`. `buildWorkbook()` is pure and unit-tested (`scripts/test/excel-test.mjs`).

## 14. Phase 5 ideas (next)

- Server-side subcategory filtering to cut backfill cost; a "needs review" queue for
  low-confidence extractions.
- Enrichment: sector rollups on the Overview tab; refresh market caps more often than 7 days for
  the most-active names.
- Per-company alerting and a dedicated "Acquisitions (M&A)" view alongside capex changes.
