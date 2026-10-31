# Market and Technology Research

**Research date:** 2026-10-24. All prices/capabilities verified against sources on that date; re-verify before budgeting.

## A. Expense-Management Products (buy-vs-build analysis)

### Zoho Expense
- Strengths verified: Autoscan OCR with line-item extraction, autoscan accepts JPG/PNG and PDF/DOC/XLS via upload, custom approval statuses, receipt-declaration (lost-receipt affidavit) feature, mobile approvals, per-transaction history/audit trail, multi-currency, vendor dashboards. Sources: zoho.com whats-new docs; productowl.io feature audit (2026-01-16).
- Model fit: **partial**. The lost-receipt declaration, approval chains, and audit-trail concepts map well to FINANCE TRACKER needs and informed our design. But corporate-card matching, GST/IRS tax logic, and per-user pricing are dead weight, and there is **no historical-backlog reconstruction**.

### Expensify
- Strengths verified: SmartScan zero-entry capture, realtime policy checks flagging non-reimbursable spend before submission, SMS receipt intake (US-number only — not usable in Nepal), Gmail/outlook receipt forwarding. Sources: use.expensify.com resource center (2025-10-08); expensent.com troubleshooting guide (2026-04-01).
- Notable limitation surfaced: SmartScan blocks report submission while scans are pending, and email-signature images can confuse OCR — evidence that even mature OCR needs a human review layer. FINANCE TRACKER design adopts the same principle (OCR output ≠ accounting data).
- Pricing: per-user monthly (verify current rate at expensify.com/pricing before any decision; not quoted here to avoid stale figures).

### SAP Concur
- Enterprise travel-and-expense suite. Verified general positioning: powerful but implementation-heavy, priced for enterprises. **Rejected**: cost and complexity orders of magnitude beyond a student organization's needs; no Nepal-specific student relevance.

### QuickBooks
- General accounting, not expense management. FINANCE TRACKER does not need full US-centric SMB accounting. **Rejected** as primary platform; its chart-of-accounts concepts inform the data model only.

**Buy-vs-build verdict:** Build custom (see 01). Rationale in one line: Finance Tracker's highest-value problem is reconstructing a dirty past, and no commercial product addresses that; commercial products optimize corporate spend present-tense.

## B. OCR / Document Intelligence (verified findings)

| Engine | Nepali/Devanagari | Cost | Notes |
|---|---|---|---|
| **PaddleOCR PP-OCRv5** (open source) | ✅ Devanagari model explicitly lists **Nepali** + Hindi + Marathi + Newari + Sanskrit + English (github.com/PaddlePaddle/PaddleOCR PP-OCRv5 multilingual docs) | Free (self-host; CPU-capable) | Mobile-sized model (~2M params); v5 added Devanagari/Cyrillic/Arabic; 109-language VL variant | 
| **Tesseract 4/5** | ✅ `nep` + `eng` language data (tesseract-ocr-nep Debian package) | Free (self-host) | Academic benchmark (Prajapati & Joshi 2017, semanticscholar.org): 96% train / **69% test** accuracy on printed Devanagari — weak on real-world photos. Preprocessing pipeline study (2020): accuracy 90.69%→94.84% high-quality, **38.45%→51.21% low-quality** — image quality is the dominant factor. Good fallback, not primary. |
| **Google Document AI** | English-strong; Devanagari OCR supported via Enterprise Document OCR | Invoice Parser: **$0.10 per document (≤10 pages)**; Form Parser $30/1k pages; Enterprise OCR $1.50/1k pages (first 1k free); sync requests capped at 10 pages for invoice parser — long docs need batch pipeline (invoicedataextraction.com, verified Oct 2026 against Google pricing page) | Best structured invoice extraction; real cost 3–5× API rate after storage/orchestration; sends documents to external cloud |
| **AWS Textract** | English-centric | Expense analysis **$0.01/page**; Detect Document Text $1.50/1k pages | AnalyzeExpense gives key-value receipt extraction; Devanagari weak vs Google for Nepali text |
| **Azure Document Intelligence** | Read OCR + prebuilt invoice/receipt models | $1.50/1k pages raw OCR; prebuilt models ~$10/1k | Comparable to Google; 500 free pages/mo |

**Industry accuracy reality check (thinklytics.com, 2026-09-25, citing arXiv:2603.22651):** field-level F1 0.90–0.94, but whole-document strict accuracy only **63–76%**; manual invoice processing costs ~$9.84 each at 18.4% exception rate — i.e., the human exception queue is the real cost and the real control point. Conclusion: design for review queues, not straight-through automation.

**FINANCE TRACKER OCR decision:** Primary = PaddleOCR PP-OCRv5 Devanagari+English self-hosted workers (free, private, CPU-friendly). Escalation path = Google Document AI Invoice Parser for low-confidence scans, gated on FM opt-in per batch due to data leaving premises. Tesseract retained as a second engine for vote/ensemble on critical fields.

## C. Storage

- **Object storage (Supabase Storage or S3-compatible)** for original files: content-addressed (SHA-256), immutable once written, thumbnails generated for UI.
- **Postgres** holds structured data + document metadata + provenance. Never binary files in DB rows.
- Estimated volume: 5 years × ~1,500 receipts × ~300KB ≈ 450MB — trivial; even Supabase Free 1GB storage nearly fits, Pro (100GB) is abundant headroom.

## D. Hosting (verified pricing, 2026)

| Option | Cost | Fit |
|---|---|---|
| **Supabase Pro** | $25/mo base: Postgres 8GB, Auth 100k MAU, Storage 100GB, Edge Functions 2M, daily backups 7-day; never pauses (free tier auto-pauses after 7 days) | ✅ Recommended backend |
| Supabase Free | $0 but pauses after 1 week idle, 500MB DB, no backups | Dev only |
| Neon / Xata | ~$14–26/mo, DB-only | Viable alt if self-managing auth/storage |
| VPS (Hetzner/DigitalOcean) + self-hosted Postgres + MinIO | ~$5–10/mo + maintenance burden | Cheapest, but FINANCE TRACKER has no dedicated sysadmin; rejected for v1, viable fallback |
| AWS RDS + full AWS stack | $80–120/mo equivalent | Overkill (makerkit.dev Supabase pricing analysis, 2026-06; metacto.com 2026-05) |

## E. Frontend / Backend candidates

- **Next.js + TypeScript + Tailwind**: standard, fast, mobile-responsive via responsive design, single framework for dashboard + member forms. Selected.
- **Backend**: Supabase (Postgres + RLS + Auth + Storage) + **Python (FastAPI) worker service** for OCR pipeline. Python chosen over Edge Functions because PaddleOCR/Tesseract/OpenCV tooling is Python-native; a small FastAPI service is simpler than forcing OCR into JS edge runtime.
- **Background jobs**: Celery/RQ + Redis, or simpler — `pg-boss` (Postgres-native job queue, no extra infra). Recommendation: pg-boss to keep the stack minimal.
- **Notifications**: in-app (DB-driven) first; email via Supabase Auth hooks / Resend. SMS later (Nepal SMS costs money; email is free).
- **Avoid:** microservices, Kubernetes, event buses. A monolith + one worker is correct for this scale.
