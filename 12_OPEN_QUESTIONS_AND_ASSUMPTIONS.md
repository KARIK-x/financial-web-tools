# Open Questions and Assumptions Register

**Date:** 2026-10-24. Every item below blocks or shapes implementation. Owner for resolution: Finance Manager (FM) unless noted.

## A. Assumptions made (documented, reasonable — correct me if wrong)

| # | Assumption | Basis | Impact if wrong |
|---|---|---|---|
| A1 | LOCUS has no formal legal registration (no PAN, no VAT, no NGO registration) | Brief explicitly says do not assume entity type; typical for campus clubs | Compliance module settings change; sponsor receipts may need PAN (Q3) |
| A2 | Functional currency is exclusively NPR | LOCUS operates in Nepal; no evidence of foreign accounts | FX features postponed; trivial to add later |
| A3 | LOCUS holds one bank account plus petty cash | Brief mentions organizational cash balances and bank statements generally | Account model handles N accounts; none required |
| A4 | Annual transaction volume is low hundreds of receipts/year | Student org scale; 80–90% receipt availability suggests bounded backlog | Capacity planning; stack is over-provisioned anyway |
| A5 | Committee year = fiscal-year-ish handover (roughly Shrawan) | Nepali academic/committee cycle | Period closing defaults adjustable |
| A6 | Members have smartphones; low-end Android dominant | Nepal device market reality | Mobile-first, low-bandwidth design justified |
| A7 | Historical material exists as photos/scans/spreadsheets in members' drives/phones | Brief §1 points 3–4 | Reconstruction plan assumes scattered digital files, not paper-only |

## B. Unresolved questions (must be answered before/within Phase 0–1)

| # | Question | Blocks | Priority |
|---|---|---|---|
| Q1 | What is LOCUS's exact institutional status (campus-registered club? NGO? unregistered?) and does it have a PAN? | Compliance configuration; sponsor receipt format | **Critical** |
| Q2 | Which bank(s) does LOCUS use, and can we obtain historical statements (how far back)? | Reconstruction completeness; P3 design | **Critical** |
| Q3 | Do sponsors require LOCUS to have a PAN or issue specific receipt formats for their own tax purposes? | Sponsorship module fields | High |
| Q4 | Where is the historical material today (drives, phones, papers) and who controls access? | Phase 0 inventory | **Critical** |
| Q5 | Are there existing spreadsheets/registers of expenses or sponsorships? What format? | Import mapping design | High |
| Q6 | Are there outstanding member reimbursements or advances right now, and are they written anywhere? | Opening balances; trust | **Critical** |
| Q7 | Does campus administration (IOE/TU) require any financial reports or audits from student clubs? | Reporting module P3 | High |
| Q8 | What approval authority structure does the committee want (thresholds, who approves FM's own claims)? FM's own claims must be approvable — by whom? | Approval workflow config | High |
| Q9 | Who will operate the platform after the founding developers graduate? (Succession plan) | Hosting/ops model | High |
| Q10 | Any known disputes or sensitive historical transactions the FM wants handled carefully? | Reconstruction review protocol | Medium |
| Q11 | Approximate NPR scale of annual spend and largest single past transaction? | Threshold defaults; infra sizing | Medium |
| Q12 | Consent status: are members okay with receipts (which may show personal items) stored on a cloud service vs. strictly local? | Hosting decision finalization | Medium |

## C. Evidence still required

- Sample bank statement (any format) — needed for parser dev.
- 20–30 representative historical receipts (photos/scans) — needed to tune OCR + classification before batch runs.
- Any existing sponsorship agreement (terms only, redacted) — needed for sponsorship module fields.
- Committee roster + roles — needed for RBAC seeding.

## D. How to use this register
Resolve Critical items in Phase 0. Record answers inline (append a resolution column). Unresolved High items default to the configurable/safe option stated in the relevant document and are revisited at the Phase 1 gate review.
