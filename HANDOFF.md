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
   ├─ pdf-text.mjs             (download PDF + pdfjs-dist text; VISION_OCR fallback) │
   ├─ extract-capex.mjs        (LLM → strict JSON + anti-hallucination) │ commit back to repo
   ├─ llm.mjs                  (Bedrock Converse chain, Mistral fallback) ▼
   └─ detect-changes.mjs       (history + change detection)   Cloudflare Pages auto-deploys ./public
scripts/send-digest.mjs        (HTML email digest)              → public/index.html + public/js/* (dashboard)
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
      "news_id": "64dee966-…",      // BSE NEWSID (dedupe key)
      "company": "ASK Automotive Ltd",
      "scrip_cd": 544022,
      "fiscal_year": "FY27",        // normalized; null if not stated
      "type": "guidance",           // guidance | actual | plan | cumulative
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
  `actual` or a multi-year `cumulative`.

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

### `backfill-cursor.json` — resumable 180-day backfill state
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
The 180-day backfill is therefore roughly 15–20k LLM calls total, drained across many capped
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

# Email digest (dry-run prints HTML unless email secrets are set):
node scripts/send-digest.mjs --days=7
node scripts/llm.mjs --selftest             # one tiny call; logs which provider+model answered
npm test                                    # 29 logic unit tests (incl. Bedrock chain, mocked)

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
| `RESEND_API_KEY` **or** `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE` **or** `SENDGRID_API_KEY` | daily | email digest send — pick one provider |
| `EMAIL_FROM`, `EMAIL_TO` | daily | digest sender + recipients (comma-separated) |

**Variables (non-secret config, all optional):**

| Variable | Default | Purpose |
|---|---|---|
| `BEDROCK_MODEL_IDS` | `anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-4-5-20250929-v1:0` | comma-separated **model fallback chain** tried in order via the Bedrock **Converse** endpoint |
| `BEDROCK_MODEL` | — | a single id prepended to the chain (back-compat) — can be a Secret or Variable |
| `BEDROCK_RETRY_ROUNDS` | 8 (backfill sets 12) | patient-retry rounds across the chain (60s wait between rounds when all models are busy) |
| `MISTRAL_MODEL` | `mistral-large-latest` | fallback model id |
| `EMAIL_PROVIDER` | auto | force `resend` \| `smtp` \| `sendgrid` \| `dryrun` |
| `DIGEST_DAYS` | 7 | digest window |
| `DIGEST_ALWAYS` | — | `1` = send even when there are zero changes |
| `DASHBOARD_URL` | — | link target for the “Open the live dashboard” button in the email |
| `VISION_OCR` | — | `1` = enable the Claude-vision OCR fallback for scanned decks (also installs `@napi-rs/canvas`) |
| `VISION_MAX_PAGES` / `VISION_SCALE` | 5 / 2.0 | OCR page cap and raster scale |

The LLM step uses the **Bedrock Converse** endpoint
(`…/model/<id>/converse`, `Authorization: Bearer …`) and walks the model chain with patient retry
(429/5xx → next model; 400/403/404 → skip that model; after a full busy round, wait 60s and retry).
It runs with **either** Bedrock or Mistral; if neither is set, `run.mjs` exits cleanly without
touching state (and `--prove` still validates fetch + PDF + text). **Email is dry-run** (logs the
HTML, workflow stays green) until `EMAIL_FROM`/`EMAIL_TO` + a provider are set.

The two workflows share a `concurrency` group so they never commit to `public/data` at the same
time, and each commits with a **fetch + rebase + push retry loop** (4 attempts, exponential
backoff — see `scripts/ci-commit.sh`).

- **`.github/workflows/backfill.yml`** — `workflow_dispatch` + cron `9,39 * * * *` (twice hourly,
  off the marks). Drains the 180-day baseline via the cursor, then no-ops. **Disable it once
  `backfill-cursor.json` shows `"done": true`** (Actions → workflow → ⋯ → Disable). Dispatch
  inputs let you tune `days_per_run` / `max_per_run`.
- **`.github/workflows/daily.yml`** — `workflow_dispatch` + cron `23 1 * * *` (01:23 UTC daily,
  off the marks). Forward run over the last ~2 days, commit, then compose + send the digest.

Env knobs (optional): `BACKFILL_DAYS` (180), `DAILY_LOOKBACK_DAYS` (2), `BACKFILL_DAYS_PER_RUN`
(3), `MAX_ANNOUNCEMENTS_PER_RUN` (backfill 150), `DAILY_MAX` (400), `CAPEX_CHANGE_PCT` (2).

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
- `npm test` — 29 logic unit tests pass (normalization incl. top-of-range, FY parsing, gates,
  change detection, JSON extractor, and the Bedrock Converse model-chain fallback with fetch mocked).

`capex-history.json` / `capex-changes.json` ship **empty** — they fill only with real results
once the workflows run with an LLM key in Actions. No sample/demo data, ever.

---

## 8. The dashboard (`public/index.html` + `public/js/*`)

Static, CDN-only (Tailwind + ECharts 5 + Lucide + Google Fonts) — no build step. It reads the
committed JSON with `cache: "no-store"` and degrades to a friendly on-brand **empty state** on
every tab until real data lands (verified). Three tabs:

- **Overview** — one hero sentence + two small stat chips (no KPI wall), a diverging bar of the
  biggest ₹ changes (green up / red down), an up-vs-down donut, and a “biggest mover” card.
- **Changes** — the hero feed, newest first, with dropdown filters (time window, direction,
  company search) and a **Cards ⇄ Table** toggle. Each card shows the plain-English
  “Old plan → New plan”, the % badge, the reason, an expandable **exact quote from the filing**,
  and a **See the official filing** link. Baselines render as a subtle “first reading” card.
- **By Company** — a searchable company picker → a step chart of that company’s capex plan over
  time (per fiscal year) + a table of all its observations with source links.

`public/js/ui.js` holds the design system (colors, formatters, the ECharts registry);
`public/js/app.js` holds data-loading, tabs and rendering. To preview the populated layout locally
use `?demo=1` (loads the git-ignored `public/demo/` fixture) — see §4.

## 9. What shipped in Phase 2 (this update)

- **Bedrock via the Converse endpoint** with an env-driven **model fallback chain**
  (`BEDROCK_MODEL_IDS`) and patient retry — the pattern proven on the account. Vision (image)
  support added for OCR.
- **Top-of-range comparison** — change detection compares on the high end of a stated range.
- The **colorful dashboard** (§8) and the **live email digest** (§ Email — dry-run until secrets).
- **Vision/OCR fallback** for scanned decks (`VISION_OCR=1`): renders capex pages to JPEG, has
  Claude transcribe them, and runs that transcription through the **same** anti-hallucination gates.

## 10. Phase 3 ideas (next)

- Wider prefilter / server-side subcategory filtering to cut backfill cost.
- Per-company alerting, sector rollups, and a “needs review” queue for low-confidence extractions.
