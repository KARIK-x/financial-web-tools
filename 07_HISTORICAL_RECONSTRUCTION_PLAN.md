# Historical Financial Reconstruction Plan

**Date:** 2026-10-24 · The most important component of the project.

## 1. Objective

Produce a **declared historical financial baseline** — the best-supported statement of LOCUS's past finances given available evidence — with explicit completeness and confidence indicators. It is acceptable for the baseline to say "NPR X ± uncertainty, with Y% of expected documentation located." It is not acceptable to fabricate precision.

## 2. Inputs (support any subset)

Receipt photos, scans, PDF invoices, digital invoices, spreadsheets (expense registers, sponsorship trackers), bank statements (PDF/Excel/CSV), payment confirmations (eSewa/Khalti/bank), sponsorship records, member-submitted claims, handwritten notes. **The pipeline must not assume any particular source exists.**

## 3. Pipeline Stages

**S0 — Evidence intake.** Bulk upload (drag-drop folder / ZIP), mobile capture, email-in (P2). Every file: UUID, SHA-256, original bytes preserved immutably, intake timestamp, source (uploader/import), batch id. Nothing is ever deleted; supersession creates new versions.

**S1 — Classification.** Classify each document: receipt / tax-invoice / bank-statement / statement-line / agreement / payment-confirmation / identity-photo / unknown / non-financial. Method: heuristic rules (PDF text patterns, aspect ratio, keywords like "VAT"/"PAN"/"Invoice No"/BS-date regexes) → PaddleOCR text pass → lightweight classifier. Human can override; overrides feed back as labeled samples (future fine-tuning, P4).

**S2 — Extraction.** Per document type, template:
- Receipts/invoices: date (BS+AD aware), merchant, total amount, tax amount, invoice no., seller PAN. NPR parsing: handle "Rs.", "NPR", "रु", lakh/crore grouping, comma styles, and Devanagari digits.
- Bank statements: statement-level (bank, account, period) + line-level (date, narration, amount, direction) → `bank_statement_line` rows.
- Payment confirmations: payer, payee, amount, reference, timestamp.
- Output: `ocr_extraction` with **field-level confidence** and bounding boxes/page references (provenance: every value traces to source region).

**S3 — Duplicate detection.** Three layers: (a) exact — SHA-256 match; (b) near-image — perceptual hash (pHash) for re-photographed/scanned duplicates; (c) near-record — same amount ±2%, date ±3 days, same/alias merchant, fuzzy merchant name (edit distance). Duplicates never auto-delete: they are linked as `duplicate_of` with score; reviewer confirms. **Guard against false merges:** two identical NPR 500 tea purchases by different people on the same day must remain two records — matching requires ≥2 strong keys (e.g., amount+date+merchant+distinct document) and never merges across different claimant/payer evidence without human sign-off.

**S4 — Candidate generation.** Each un-duplicated receipt-class document with sufficient fields → `expense_candidate` (status CANDIDATE). Missing mandatory fields (date/amount) → "needs info" queue. Statement lines and payment confirmations generate `payment_candidate`s.

**S5 — Matching & relationship detection.**
- Receipt ↔ bank statement line: exact amount + date ±3d; then fuzzy (amount ±1% for fees/rounding, narration token overlap via TF-IDF/cosine on merchant aliases).
- Receipt ↔ member claim: claimant-stated fields vs extracted.
- Payment confirmation ↔ payment candidate: reference numbers, amounts.
- Output: match proposals with confidence + method tag; all proposals reviewed.

**S6 — Reviewer queue (human-in-the-loop).** Prioritized by value × (1−confidence). Reviewer actions per candidate: confirm → promote to `expense_claim` (state=VERIFIED after evidence check) / link to existing claim / mark duplicate / mark non-financial / request info. Conflicts (OCR says 3,500, member said 3,050) surfaced side-by-side; resolution stored as the claim value with the discrepancy preserved in notes. Reviewer identity + timestamp on every decision.

**S7 — Reconciliation pass.** Matched payments vs statements vs cash records; differences listed explicitly (timing, missing, amount mismatch). Unmatched statement lines = "unexplained outflows/inflows" list — potentially LOCUS expenses with lost receipts (member asked) or transfers.

**S8 — Baseline declaration.** FM publishes baseline snapshot: total verified historical expenditure; claimed-but-unverified; documented incompleteness (e.g., "bank statements available 2078–2080 only; expected document coverage ~82%"); confidence histogram. Snapshot is immutable; later corrections are new baseline versions (v2, v3...) with diffs.

## 4. Throughput & cost estimate (backlog scenario: ~5,000 documents)

- PaddleOCR self-hosted on a small VPS/CPU worker: ~2–4 s/page CPU → 5,000 receipts ≈ 8–20 worker-hours — run overnight batches, no API cost.
- Cloud escalation for worst 10% (500 docs × $0.10) ≈ **$50 one-time** — optional, FM-approved.
- Review effort: assume 60–120 reviews/hour for confirm-only candidates, slower for conflicts; 5,000 docs ≈ 60–100 human-hours total. Schedule across finance team + volunteers per event year (people remember their events).

## 5. Failure modes & safeguards

| Failure | Safeguard |
|---|---|
| OCR misreads amount/date | Field confidence + reviewer confirm before promotion; amounts cross-checked against statement lines where available |
| Backlog abandoned | Progress dashboard + milestone: "Event-year 2080 reconstructed" as acceptance unit |
| Over-merging distinct transactions | Never auto-merge candidates; merge = human decision with visible evidence pair |
| Fabricated "completeness" | Baseline report mandates completeness statement; UI always shows verification filters |
| Personal data exposure | Documents private by default; exports FM-only; see doc 09 |
