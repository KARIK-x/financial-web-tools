# Nepal Financial Compliance Research

**Date:** 2026-10-24. **Important:** This is research, not legal advice. LOCUS's exact legal/institutional status is **unverified** — see Section 5 and document 12. Everything here is configurable in the platform, not hardcoded.

## 1. Verified Regulatory Facts (with sources)

### PAN (Permanent Account Number)
- PAN is the foundational tax ID under the **Income Tax Act, 2058**, administered by the **Inland Revenue Department (IRD)**. PAN is mandatory for entities carrying on business; it is required to open bank accounts and conduct formal transactions. Source: corporatenp.com PAN/VAT/Excise guide (2025-11-14).
- Nepal PAN is a **9-digit numeric** identifier (some sources describe 10-digit alphanumeric for older/individual formats — treat format as configurable; verify LOCUS's own PAN certificate if one exists). VAT registration does not issue a separate number; the PAN serves as the VAT ID. Source: support.devrev.ai IRD registration guide (2026-10-09).

### VAT
- VAT governed by **Value Added Tax Act, 2052**; standard VAT rate **13%** (verified in IRD digital-services procedures, EY Tax Alert 2023-08-28).
- Compulsory VAT registration thresholds (commonly cited): ~NPR 40 lakh annual turnover for goods, ~NPR 20 lakh for services — **thresholds change with each Finance Act; must be re-verified against the current-year budget/IRD notice** (corporatenp.com FAQ, 2025-11-14).
- IRD is rolling out **digital/e-invoicing reporting**; certain VAT-registered and higher-turnover businesses must report sales invoices to the IRD portal (Marg Books IRD setup overview; EY alert).
- **Tax invoice minimum contents** (per IRD procedures, via EY alert): seller name + PAN, buyer name + PAN (if available), transaction date, description, value. This is the reference standard for what a "proper bill" contains — directly relevant to receipt-quality review.

### Tax-exempt entities (potentially applicable — requires verification)
- Under Income Tax Act s.2(dha)/10(ka) "tax exempt entity" framework: donations, corporate sponsorships, and government funding received by a registered exempt entity can be exempt income; fundraising/program income is exempt if declared in charter, used for objectives, and not commercially competitive. **However**, entities supplying VATable services may still need VAT registration; donations are not a "supply" so generally no VAT. Source: sushilparajuli.com tax-exemption analysis (2021). **Whether LOCUS qualifies for any exemption is unknown — it likely has no formal registration at all.**

### Withholding / TDS
- Nepal requires tax withholding on certain payments (rent, services, interest). Applicability to LOCUS depends entirely on its registration status and payment types. **Flagged for accountant verification — see Section 5.**

### Fiscal year and currency
- Nepal fiscal year: Shrawan–Ashadh (mid-July to mid-July). Reports should support both fiscal-year and calendar-year views.
- Currency: NPR only for books of account; foreign-currency receipts converted at Nepal Rastra Bank rate on transaction date (verified in PKF/IR D digital service procedures: "All accounting of the transactions has to be done in Nepalese Rupees... conversion rate published by NRB at the date of such transaction").
- Dates: official dual-calendar usage (Bikram Sambat + AD). Platform must accept and preserve BS dates as entered.

### Number formatting
- Nepali convention: lakh/crore grouping (1,50,000), though comma-style 150,000 is common in banking. UI must be consistent (choose lakh/crore grouping as default for NPR displays; make it a setting).

## 2. Practical implications for the platform (verified facts → design decisions)

| Fact | Design decision |
|---|---|
| Proper tax invoices contain seller PAN, buyer PAN, date, description, value | Receipt review checklist includes "seller PAN present?" as a documentation-quality field; not mandatory for small cash purchases but scored |
| NPR-only books, NRB rate for FX | Single functional currency field + optional original-currency capture with manual rate entry |
| Digital invoice reporting trend | Data model has invoice-number, seller-PAN fields on every expense so future e-invoicing/export is possible without migration |
| BS/AD dual dates | Every date field: `date_value` + `calendar_type` + normalized AD date |
| Sponsorship vs donation distinction matters for exempt entities | Sponsorship module separates cash sponsorship, donations, and in-kind; earmarking tracked |
| Student orgs often have no registration | Nothing in the platform requires a PAN/VAT number; all tax fields optional and settings-driven |

## 3. Privacy and data
- Nepal's **Privacy Act, 2075** and **Individual Privacy Act** framework apply to personal data of members (names, phone numbers, photos of receipts showing personal purchases). Reasonable measures: access controls, minimal PII in exports, no public sharing of financial data, retention policy configurable. (General framework knowledge — flag specifics for legal review.)
- Receipts contain vendor PANs and member PII → treat the document store as confidential; see Security doc 09.

## 4. Banking reality in Nepal
- Direct bank API integrations (open banking) are nascent in Nepal; most banks provide statements via e-banking PDF/Excel download. **Decision: statement-file import + manual reconciliation; no direct bank integration in v1–v3.** Verify LOCUS's actual bank (likely a campus-linked or student-account arrangement at a Nepali commercial bank) and its statement formats during Phase 0.
- eSewa/Khalti/FonePay payment confirmations are common evidence for small payments → accept screenshots/PDFs as payment evidence documents (classified accordingly, lower verification weight than bank statement lines).

## 5. Explicitly flagged for professional verification (NOT resolved here)

1. Does LOCUS have any legal registration (campus registration, NGO registration under NGO Act, or nothing)? → determines everything below.
2. Is LOCUS required to register for PAN? (Most informal student clubs are not, but sponsorships from companies may require PAN for the sponsor's own withholding records.)
3. Does LOCUS meet any VAT registration threshold through event income? (Almost certainly not at ~NPR 20–40 lakh, but must be checked per current Finance Act.)
4. Must LOCUS issue receipts to sponsors in a form the sponsor needs for *their* tax deduction? (Sponsor-side requirement, not LOCUS-side; affects receipt template fields.)
5. Any TDS obligations when paying vendors/venues above threshold amounts?
6. Does IOE/TU campus administration impose financial reporting requirements on student clubs (annual audit, budget approval)?
7. Data retention obligations under Privacy Act 2075 for financial documents of a private association.

**Owner:** Finance Manager to consult a Nepali accountant/CA and, if needed, the campus administration office. Answers recorded in 12.
