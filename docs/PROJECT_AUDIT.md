# PROJECT AUDIT — LOCUS Finance Intelligence Platform

**Audit date:** 2026-10-24
**Auditor:** implementation agent (autonomous build session)
**Scope:** the 13 research/specification documents in the project root, the original archive, the source data supplied, and the delivered application.

---

## 1. What was supplied

| Input | What it actually contains | Reliability |
|---|---|---|
| `01_EXECUTIVE_SUMMARY.md` … `13_FINAL_RECOMMENDATION.md` | Product research, workflows, Nepal compliance notes, data-model sketch, security guidance, roadmap | **Design intent**, not financial records |
| `KIMI LOCUS FINACNEArchive.zip` | Original copy of the research material | Same as above; preserved untouched |
| Sponsor / tier workbook | 8 tier rows totalling **NPR 150,000** | **Incomplete** — no payer names, dates, receipt references, or full ledger |
| eSewa statement | A **personal** wallet statement, not a LOCUS organisational account | **PII — must not be imported or exposed** |
| Everything else | No bank statements, receipts, invoices, or historical ledger for LOCUS | **Absent** |

### Consequence
No LOCUS financial history can be reconstructed from the supplied material. The system therefore:

1. starts with an **empty, real workspace** (migrations only), and
2. ships a **clearly-labelled synthetic demo dataset** for evaluation, seeded through the same server functions as real data.

Every financial row carries provenance: `is_synthetic`, `source_type`, and (where relevant) `source_ref`. The UI shows a “Synthetic” source tag on demo records. Synthetic data is never mixed silently with real data.

---

## 2. Requirement coverage

The specification was delivered as 24 thematic sections. Coverage is summarised by capability; “Partial” items are explained.

| Capability | Status | Evidence / limits |
|---|---|---|
| Authentication, sessions, roles | **Done** | scrypt hashes, hashed session tokens, 6 roles, 19 permissions, server-side checks |
| Member and user administration | **Done** | create/reset/deactivate accounts, role matrix locked for ADMIN |
| Expense claim capture | **Done** | multi-line allocations, vendors, events, departments, BS/AD dates |
| Receipt / document management | **Done** | private content-addressed store, SHA-256 duplicate block, perceptual near-duplicate flag, OCR candidates |
| Approval workflow | **Done** | tiered thresholds, separation of duties, DB-blocked self-approval, committee reference |
| Payments and reimbursement | **Done** | partial payments, over-payment blocked, immutable recorded payments |
| Advances | **Done** | disbursement, settlement through claims, capped returns |
| Sponsorships | **Done** | pledges, receipts, deliverables, over-receipt allowed (documented) |
| Budgets | **Done** | BS fiscal years, line budgets, committed vs paid, overspend alerts |
| Bank accounts and transfers | **Done** | cash/bank/wallet, internal transfers, opening balances with equity posting |
| Statement import and reconciliation | **Done** | CSV/TXT/XLSX parsing, dedupe, suggestion, manual match, reconciliation snapshot |
| Double-entry accounting | **Done** | auto-posted journals, DB balance trigger, immutable posted lines |
| Reports and analytics | **Done** | dashboard, category/event spend, cashflow, trial balance, budget, sponsor, documentation |
| Exports | **Done** | 13 datasets, CSV + JSON, formula-injection guarded, audited, 20,000-row cap |
| Audit trail | **Done** | append-only table, DB triggers, actor/IP/user-agent, before/after JSON |
| Historical reconstruction | **Partial** | opening balances + reconciliation exist; **no bulk historical claim/sponsor importer** |
| OCR | **Partial** | English receipts and text-layer PDFs; **no Nepali OCR**, **no scanned-PDF rasteriser** |
| Notifications / email | **Not built** | no SMTP provider or credentials |
| Multi-currency / FX | **Not built** | NPR only, by design |
| Multi-organisation | **Not built** | single `org_locus` workspace |
| Native mobile app | **Not built** | responsive web UI only |

---

## 3. Data-quality findings

1. **Sponsor workbook is not a ledger.** 8 tier rows and NPR 150,000 is a plan, not confirmed income. It must not be presented as received sponsorship.
2. **The eSewa statement is personal.** Holder name and account number are PII. It was read only to design the statement parser; it is not copied into the repo or database.
3. **No historical receipts exist.** Any “verified” historical claim would be fabricated, so none were created.
4. **Compliance status is unverified.** `settings.compliance.legalStatus = UNVERIFIED`, PAN empty, VAT false. Tax fields are informational, not obligations.
5. **Fiscal calendar.** The organisation’s fiscal year starts in month 4 (Shrawan). The current period on 2026-10-24 is **BS 2083/84 (2026-07-17 → 2027-07-16)**.

---

## 4. Implementation audit

### Architecture
- Next.js 16.4.3 App Router, React 19.3.1, TypeScript 5.9.3 (`strict`), Tailwind 4.3.3.
- Embedded PostgreSQL via PGlite 0.5.11 at `.data/pglite`; raw SQL; migration runner.
- Money is `BIGINT` **paisa** everywhere; no floating-point arithmetic in storage or aggregation.
- Server Components for reads, Server Actions for writes, two API routes for private document streaming and exports.
- Private document store at `.data/documents` (SHA-256 sharded, outside `public/`).

### Integrity controls verified in the database
- Journal entries must balance (trigger).
- Posted journal lines are immutable.
- Claims cannot be deleted; terminal states cannot be left.
- Finalized financial fields cannot be edited.
- A claimant cannot approve/verify their own claim.
- Submitted claims must have allocations equal to the claim amount.
- Recorded payments cannot be deleted or re-amounted.
- Document bytes and bank statement lines are immutable.
- Audit events are append-only.

### Verification evidence (2026-10-24)
- `npx tsc --noEmit` → exit 0.
- `npm test` → **96/96 tests in 11 files pass**.
- `npm run build` → exit 0, no build warnings.
- `npm run test:e2e` → **6/6 Playwright tests pass**.
- Demo dataset restored after tests: 9 claims, 7 payments, 9 documents, 13 balanced journal entries, 5 matched + 1 open bank line, 51 audit events.

---

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation / status |
|---|---|---|---|
| Someone treats demo figures as real LOCUS finances | Medium | High | Synthetic flags, UI tags, seed/reset guards, docs |
| Personal eSewa data leaks into the app | Low | High | Never imported; parser tested with synthetic fixtures |
| PGlite file corruption / single-writer limits | Medium | High | Documented backup/restore; production requires managed Postgres |
| No Nepali OCR → manual re-keying | High | Medium | Honest capability banner; manual review workflow |
| Over-receipt of sponsorship hides pledge gaps | Low | Medium | Allowed by design; report shows promised vs received |
| Cash balance can go negative | Medium | Medium | Visible on accounts page; no hard block (documented) |
| Single admin lockout | Low | High | ADMIN role matrix is immutable; password reset script |
| In-memory login rate limit resets on restart | Medium | Low | Acceptable single-process; replace with shared store in production |
| Unencrypted database at rest | Medium | High | Disk encryption + file permissions required; documented |

---

## 6. Conclusion

The delivered system is a **working, tested, single-organisation finance application** with real persistence, enforced double-entry accounting, RBAC, document custody, reconciliation, and auditability. It is **not** a reconstruction of LOCUS’s actual history, because that history was not supplied. The remaining work is concentrated in production hardening (managed Postgres, Nepali OCR, notifications, historical import) and is tracked in `TASK_QUEUE.md`.
