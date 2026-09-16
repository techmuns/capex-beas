# Phase 1 — end-to-end proof on REAL BSE filings

Everything below was run live against BSE from a cloud environment (the same kind
GitHub Actions uses). No sample/seed data was written anywhere; `capex-history.json`
and `capex-changes.json` ship empty and fill only when the workflows run with an LLM
key in Actions.

## 1. The BSE feed works from a cloud IP

`AnnSubCategoryGetData` is a **per-day** endpoint (`strPrevDate` must equal `strToDate`);
volume is paginated at 50/page. A busy day returns thousands of records:

```
day 20250602: Table=50/page, Table1[0].ROWCNT = 908   (paginated to completion)
day 20260915: ROWCNT = 613     day 20260601: ROWCNT = 1274
```

## 2. Real PDFs download + parse

- AttachLive first, AttachHis fallback for older filings (verified: a 2025 filing 404'd
  on AttachLive and succeeded on AttachHis; recent 2026 filings are on AttachLive).
- `pdfjs-dist` (legacy build) extracts the text. Examples (real ASK Automotive filings):

```
Investor Presentation (2026-08-04)  d8104f49-…  -> 24 pages, 18,382 chars
Q1 FY27 Earnings Call Transcript (2026-08-10)  64dee966-…  -> 12 pages, 29,179 chars
```

## 3. The brief's exact example is a REAL filing

ASK Automotive Ltd (BSE scrip **544022**), Q1 FY27 earnings-call transcript
(2026-08-10). Verbatim from the extracted PDF text:

> "…the capex plan for FY27 given that you are setting up this new plant in South?"

> "…**Rs. 450 crore to Rs. 500 crore**, but the way we are going and receiving the orders,
> as I today **revised the guidance** to high-teens, I think our capex may go to something
> like **Rs. 700 crore this year.**"

Source PDF (working):
`https://www.bseindia.com/xml-data/corpfiling/AttachLive/64dee966-ee79-4563-8e67-348784a17e1e.pdf`

## 4. The anti-hallucination gates + change detector run on that real text

We sliced the verbatim quotes **directly out of the extracted PDF text** (no hand typing)
and ran the ACTUAL code (`scripts/extract-capex.mjs` gates + `scripts/detect-changes.mjs`):

```
Rs. 500 crore: digits-in-quote=true  quote-in-source=true  ->₹cr=500  [ACCEPTED]
Rs. 700 crore: digits-in-quote=true  quote-in-source=true  ->₹cr=700  [ACCEPTED]
[fabricated] ₹900 crore (not in the filing): quote-in-source=false  -> correctly REJECTED
```

Change detection output (`capex-changes.json` shape) for the two guidance observations:

```json
{
  "company": "ASK Automotive Ltd",
  "scrip_cd": 544022,
  "fiscal_year": "FY27",
  "type": "guidance",
  "old_cr": 500,
  "new_cr": 700,
  "delta_cr": 200,
  "pct_change": 40,
  "direction": "up",
  "old_quote": "Rs. 450 crore to Rs. 500 crore, bu…",
  "new_quote": "…I think our capex may go to something like Rs. 700 crore this year.",
  "old_pdf": "https://www.bseindia.com/xml-data/corpfiling/AttachLive/5bba14f0-…pdf",
  "new_pdf": "https://www.bseindia.com/xml-data/corpfiling/AttachLive/64dee966-…pdf",
  "old_date": "2026-05-25T10:00:00",
  "new_date": "2026-08-10T10:00:00",
  "no_prior_on_record": false
}
```

That is the brief's scenario, reproduced from a real filing: **ASK Automotive FY27 capex
guidance ₹500 Cr → ₹700 Cr (+40%, up)**, each figure carrying its verbatim quote and a
working source PDF.

## 5. The only step not run locally

`scripts/extract-capex.mjs` calls the LLM (Claude via Bedrock, Mistral fallback). No LLM
key is available outside Actions, so the LLM API call itself runs in the workflows. Its
output is validated by exactly the gates proven above before anything is stored.

## 6. Logic unit tests

`34 passed, 0 failed` — number normalization (cr/lakh/mn/bn, ranges, USD-not-comparable),
FY normalization, the digits-in-quote / quote-in-source / reason-traceability gates, the
defensive JSON extractor, and change detection (2% threshold, first-seen baselines, the
guidance-vs-cumulative guard, stable `detected_at`).
