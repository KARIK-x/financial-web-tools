# IMPORT AND EXPORT FORMATS

---

## 1. What can be imported today

| Import | Status | Entry point |
|---|---|---|
| Bank/wallet statements (CSV, TXT, XLSX) | **Supported** | Reconciliation → Import statement |
| Receipts and invoices (images, PDF) | **Supported as documents** | Receipts → Upload, or claim form |
| OCR extraction of receipts | **Partial** (English/text PDFs) | Automatic on upload, then human review |
| Historical claims (bulk) | **Not implemented** | — |
| Historical sponsor ledger (bulk) | **Not implemented** | — |
| Opening balances | **Supported** (one account at a time, before movements) | Accounts → Opening balance |
| Generic CSV → any table | **Not implemented** | `import_batches`/`import_rows` exist as staging only |

There is deliberately **no generic spreadsheet importer**. Guessing column meanings for financial history is unsafe; the only bulk importer is the constrained statement parser described below.

---

## 2. Bank statement import

### 2.1 Accepted files
- `.csv` and `.txt`: UTF-8, comma-separated, RFC-4180 quoting (`""` escapes a quote; newlines inside quotes are supported).
- `.xlsx`: first worksheet only. Formula cells use their cached result; rich-text cells use their text.
- Maximum size: **10 MB**.
- At least one debit or credit column is required per row; rows with neither are skipped with a warning.

### 2.2 Header detection
The parser scans the first **60 rows** for a header row containing both:
- a date column: `transaction date` or `date`
- a description column: `description`, `narration`, `details`, or `particulars`

Then it maps optional columns by fuzzy name:

| Field | Accepted header names |
|---|---|
| Debit / withdrawal | `withdraw`, `withdrawal`, `debit`, `dr` |
| Credit / deposit | `deposit`, `credit`, `cr` |
| Balance | `balance` |
| Reference | `reference`, `ref no`, `txn id`, `transaction id`, `id` |

Matching is case-insensitive. Short aliases (`dr`, `cr`, `id`) must match the whole cell; longer names may be substrings. Preamble rows (account name, statement period) above the header are ignored.

If no header row is found, the import is rejected with: *“Could not find a statement header row (needs Date and Description columns).”*

### 2.3 Dates
- ISO: `YYYY-MM-DD` (also `YYYY-M-D`).
- `DD/MM/YYYY` or `DD-MM-YYYY` **only when the day is greater than 12**, which makes the order unambiguous.
- Excel date cells are read as dates.
- Ambiguous values such as `03/04/2026` are **rejected**, not guessed. Re-export the statement as ISO or fix the column.

### 2.4 Amounts
- Numeric cells: absolute value × 100, rounded to paisa.
- Text cells: parsed by `parseMoney`, which accepts `Rs.`, `NPR`, `रु`, thousands separators, Nepali digits, trailing `/-`, and lakh/crore shorthand (`2.5 lakh`, `1 lakh 50 thousand`).
- A trailing minus (`500-`) is treated as an absolute amount in that column.
- Debit and credit are stored separately (`debit_paisa`, `credit_paisa`), both non-negative.
- Rows with zero in both columns are skipped.

### 2.5 Example CSV

```csv
Account Name:,LOCUS — IOE Pulchowk Campus
Statement Period:,2026-07-17 to 2027-07-16

Transaction Date,Description,Reference,Withdrawal,Deposit,Balance
2026-09-02,Printing — Imagine Print House,CHK-1042,4500.00,,125000.00
2026-09-05,Reimbursement — Aashish Sharma,PMT-0007,,1200.00,123800.00
2026-09-12,Cash deposit,DEP-11,,15000.00,138800.00
```

### 2.6 Duplicate handling
Each line is fingerprinted as:

```
sha256(account_id | date | trimmed description | debit | credit | balance | occurrence)
```

The `occurrence` counter distinguishes two genuinely identical lines on the same day. Re-importing the same statement skips existing fingerprints (`ON CONFLICT DO NOTHING`) and reports them; the import does **not** abort. Re-importing after editing a description creates a new line — review suggestions rather than bulk re-importing edited files.

### 2.7 After import
1. The importer stores a `statement_imports` row with detected columns, skipped count, and up to 20 warnings.
2. `suggestMatches` proposes payments by amount and proximity, preferring references:
   - strong match → confidence 0.8, status `SUGGESTED`
   - date-only candidate → confidence 0.4
3. A finance user confirms or ignores each line. Confirming links `matched_payment_id`; ignoring clears it.
4. Reconciling a period compares the computed ledger balance with the statement balance and stores a snapshot.

**Statement lines never create payments or journal entries.** They are evidence to match against.

---

## 3. Document uploads

| Property | Rule |
|---|---|
| Max size | 10 MB per file |
| Accepted types | Images (JPEG/PNG/WebP/HEIC where Sharp supports), PDF, common office documents; unknown types stored as `UNKNOWN` |
| Storage | `.data/documents/<sha[0:2]>/<sha[2:4]>/<sha256><ext>` |
| Exact duplicate | Blocked; existing document returned; audited as `DOCUMENT_DUPLICATE_BLOCKED` |
| Near duplicate | 64-bit average hash, Hamming distance ≤ 6 → `NEEDS_REVIEW` with `duplicate_of` |
| Deletion | Blocked by trigger; supersede instead |
| Download | `/api/documents/[id]` with authorisation; `Content-Disposition: attachment` |

### OCR
- Images: Tesseract (`eng`, `osd`, `snum` installed on this machine).
- PDFs: embedded text layer via `pdfjs-dist`.
- Output: candidate merchant, date, total, tax, invoice number, seller PAN, with per-field confidence and raw text. Stored in `ocr_extractions`; the document moves to `EXTRACTED` or `NEEDS_REVIEW`.
- A human must accept/correct fields; OCR never writes a claim or a journal.
- **Nepali (`nep`) traineddata is not installed**, and scanned PDFs cannot be rasterised on this machine (no `pdftotext`/rasteriser). See `KNOWN_BUGS.md`.

---

## 4. Exports

### 4.1 Datasets
`claims`, `payments`, `journal`, `trial-balance`, `cashflow`, `categories`, `events`, `sponsors`, `budgets`, `advances`, `accounts`, `audit`, `bank-lines`.

### 4.2 Endpoint
```
GET /api/export/{type}?format=csv|json&from=YYYY-MM-DD&to=YYYY-MM-DD&status=...&documentation=...
```
- Requires `export.run` (ADMIN, FINANCE).
- Defaults to the current BS fiscal period.
- Maximum **20,000 rows**; responses set `truncated: true` in JSON and add a header comment? (CSV contains only data rows; the UI warns when truncated).
- Every export writes an `EXPORT_RUN` audit event with type, format, period, row count, and truncation flag.
- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.

### 4.3 CSV safety
- Header row is always present.
- Values containing `,`, `"`, `\r`, or `\n` are quoted; quotes are doubled.
- Text beginning with `=`, `+`, `-`, `@`, tab, or carriage return is prefixed with `'` to prevent spreadsheet formula execution.
- Dates are ISO (`YYYY-MM-DD`); timestamps are ISO 8601.
- Money is emitted **twice**: integer paisa (e.g. `amount_paisa`) and decimal NPR string (e.g. `amount_npr = "1200.00"`). Never treat the decimal string as a float in downstream calculations.

### 4.4 JSON safety
JSON exports are UTF-8, pretty-printed, and contain the same dual money fields. They are intended for archival or migration, not for browser rendering.

---

## 5. Data provenance in exports

Rows include `is_synthetic` and `source_type` where the table supports them. An export mixing demo and real rows is therefore detectable. Do not strip these columns when sharing data.

---

## 6. Round-trip guidance

- **Do not** edit an exported CSV and re-import it as a bank statement; the formats and fingerprints are different.
- To correct a claim, use the UI (withdraw/correct) rather than editing exports.
- To move to another system, export `journal` and `trial-balance` together; they are the authoritative books. `claims`/`payments` explain the operational detail.
- For a full backup, copy `.data/pglite` and `.data/documents`, not CSV exports (see `BACKUP_AND_RESTORE.md`).
