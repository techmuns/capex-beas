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
   ├─ pdf-text.mjs             (download PDF + pdfjs-dist text)         │
   ├─ extract-capex.mjs        (LLM → strict JSON + anti-hallucination) │ commit back to repo
   ├─ llm.mjs                  (Bedrock primary, Mistral fallback)      ▼
   └─ detect-changes.mjs       (history + change detection)   Cloudflare Pages auto-deploys ./public
scripts/send-digest.mjs        (HTML email digest — dry-run until Phase 2)
```

- **Static site, no build step.** Everything the browser needs is in `./public`.
- **Scripts are Node ES modules (`.mjs`)** run by GitHub Actions on Node 22.
- **Committed JSON under `./public/data/`** is the app's memory across runs (Actions has no
  persistent disk, so state is committed back to the repo).
- **No frontend install** — Phase 2 uses CDN libs (Tailwind, ECharts, Lucide).

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
      "amount_cr": 700,             // ₹ crore (deterministic from amount_text); null if not comparable
      "midpoint_cr": 700,           // midpoint used for change detection (= amount_cr, or range mid)
      "comparable": true,           // false for foreign-currency (no FX guess)
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
    "old_cr": 500,                 // real prior observation midpoint (₹ cr)
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
  observation's `midpoint_cr` differs from the most-recent prior guidance midpoint by more than
  `CAPEX_CHANGE_PCT`% (default **2%**, to ignore rounding).
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

# Full pipeline (needs an LLM key — see secrets below):
BEDROCK_API_KEY=… AWS_REGION=us-east-1 BEDROCK_MODEL=… node scripts/run.mjs --mode=daily
node scripts/run.mjs --mode=backfill        # drains one backfill chunk, advances the cursor
node scripts/run.mjs --from=20260804 --to=20260804   # manual explicit window

# Rebuild changes.json deterministically from history.json:
node scripts/detect-changes.mjs

# Email digest (dry-run prints HTML unless email secrets are set):
node scripts/send-digest.mjs --days=7
node scripts/llm.mjs --selftest             # one tiny call; logs which provider answered
```

---

## 5. Secrets each workflow needs (GitHub → Settings → Secrets → Actions)

| Secret | Used by | Purpose |
|---|---|---|
| `BEDROCK_API_KEY` | backfill, daily | Claude via Bedrock (**primary** LLM) — Bearer token |
| `AWS_REGION` | backfill, daily | Bedrock region, e.g. `us-east-1` |
| `BEDROCK_MODEL` | backfill, daily | Claude model / inference-profile id |
| `MISTRAL_API_KEY` | backfill, daily | **Fallback** LLM (OpenAI-style) |
| `MISTRAL_MODEL` | backfill, daily | optional (default `mistral-large-latest`) |
| `FIRECRAWL_API_KEY` | backfill, daily | optional BSE fetch fallback |
| `SCRAPE_DO_API_KEY` | backfill, daily | optional BSE fetch fallback |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_TO`, `RESEND_API_KEY` / `SENDGRID_API_KEY` / `SMTP_*` | daily (Phase 2) | email digest send (dry-run until set) |

The pipeline runs with **either** Bedrock or Mistral; if neither is set, `run.mjs` exits cleanly
without touching state (and `--prove` still validates fetch + PDF + text).

The two workflows share a `concurrency` group so they never commit to `public/data` at the same
time, and each commits with a **fetch + rebase + push retry loop** (4 attempts, exponential
backoff — see `scripts/ci-commit.sh`).

- **`.github/workflows/backfill.yml`** — `workflow_dispatch` + cron `9,39 * * * *` (twice hourly,
  off the marks). Drains the 180-day baseline via the cursor, then no-ops. **Disable it once
  `backfill-cursor.json` shows `"done": true`** (Actions → workflow → ⋯ → Disable). Dispatch
  inputs let you tune `days_per_run` / `max_per_run`.
- **`.github/workflows/daily.yml`** — `workflow_dispatch` + cron `23 1 * * *` (01:23 UTC daily,
  off the marks). Forward run over the last ~2 days, then composes the digest (dry-run).

Env knobs (optional): `BACKFILL_DAYS` (180), `DAILY_LOOKBACK_DAYS` (2), `BACKFILL_DAYS_PER_RUN`
(2), `MAX_ANNOUNCEMENTS_PER_RUN` (backfill 120), `DAILY_MAX` (250), `CAPEX_CHANGE_PCT` (2).

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
- 34 logic unit tests pass (normalization, FY parsing, gates, change detection, JSON extractor).

`capex-history.json` / `capex-changes.json` ship **empty** — they fill only with real results
once the workflows run with an LLM key in Actions. No sample/demo data, ever.

---

## 8. Phase 2 (next)

- The full **colorful dashboard** (`public/index.html`) — Tailwind + ECharts + Lucide via CDN,
  reading the committed JSON: company cards, old→new change timelines, filters, source links.
- Turn on the **email digest** send (provider + recipient supplied then).
- OCR / Claude-vision fallback for scanned/thin PDF decks (hook already in `pdf-text.mjs`).
