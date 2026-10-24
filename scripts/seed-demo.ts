/**
 * Seed a fully synthetic demonstration dataset.
 *
 *   npm run db:seed-demo
 *
 * Safety rules:
 *  - Refuses to run if the database already contains any users or claims.
 *  - Every created row is flagged is_synthetic = true.
 *  - Demo identities use @locus.demo addresses and obviously synthetic names.
 *  - Receipt images are generated locally and stamped "SYNTHETIC".
 *  - The shared demo password is written to .data/demo-credentials.txt (0600)
 *    and never printed to the terminal.
 *
 * The script exercises the same server functions as the UI (claim creation,
 * approval, payment, verification, statement import, matching, reconciliation),
 * so the seeded data also acts as an end-to-end smoke test.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createDatabase, many, money, one } from "../src/server/db";
import { hashPassword } from "../src/server/password";
import { recordAudit } from "../src/server/audit";
import {
  createExpense, decideClaim, flagDispute, recordClaimPayment, verifyClaim,
} from "../src/server/expenses";
import { createAdvance, disburseAdvance } from "../src/server/advances";
import { createSponsorship, recordSponsorReceipt } from "../src/server/sponsors";
import { createBudget } from "../src/server/budgets";
import { uploadOne } from "../src/server/documents";
import {
  accountBalanceAsOf, confirmStatementMatch, createReconciliation, importStatement, statementLines,
} from "../src/server/accounts";
import { paymentNumber, postJournal, ACCOUNTS, accountLedger } from "../src/server/journal";
import { currentFiscalPeriod } from "../src/server/reports";
import { fiscalYearBsFor, todayISO } from "../src/lib/nepali-date";
import { paisaToDecimal } from "../src/lib/money";
import type { CurrentUser } from "../src/server/auth";
import type { Permission, Role } from "../src/lib/permissions";

const DEMO_DOMAIN = "locus.demo";
const DEMO_PASSWORD = `${randomBytes(18).toString("base64url")}9a`;

type DemoAccount = {
  key: string;
  name: string;
  email: string;
  role: Role;
  title: string;
  memberId: string;
  userId: string;
  user: CurrentUser;
};

function isoDaysAgo(days: number, notBefore: string): string {
  const floor = Date.parse(`${notBefore}T00:00:00Z`);
  const target = Date.now() - days * 86_400_000;
  return new Date(Math.max(floor, target)).toISOString().slice(0, 10);
}

function xml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

/** Generate a clearly-marked synthetic receipt image. Never a real document. */
async function syntheticReceipt(input: {
  merchant: string; date: string; total: string; receiptNo: string; category: string; payer: string;
}): Promise<Buffer> {
  const lines = [
    ["Travel fare — airport to campus", "1", "650.00"],
    ["Local transport", "1", "600.00"],
    ["Service charge", "1", "0.00"],
  ];
  const itemRows = lines
    .map((l, i) => `<text x="48" y="${330 + i * 34}" font-family="Helvetica" font-size="16" fill="#222">${xml(l[0]!)}</text>
      <text x="430" y="${330 + i * 34}" font-family="Helvetica" font-size="16" fill="#222" text-anchor="end">Rs ${xml(l[2]!)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="720">
    <rect width="520" height="720" fill="#fbfaf6"/>
    <rect x="18" y="18" width="484" height="684" fill="#ffffff" stroke="#d9d3c4" stroke-width="2"/>
    <text x="48" y="70" font-family="Helvetica" font-size="24" font-weight="bold" fill="#1d1c19">${xml(input.merchant)}</text>
    <text x="48" y="98" font-family="Helvetica" font-size="13" fill="#6b665b">Kathmandu, Nepal · Demo merchant</text>
    <rect x="48" y="116" width="424" height="30" fill="#f3e7c9"/>
    <text x="260" y="136" font-family="Helvetica" font-size="14" font-weight="bold" fill="#7a4b00" text-anchor="middle">SYNTHETIC — NOT A REAL TRANSACTION</text>
    <text x="48" y="180" font-family="Helvetica" font-size="14" fill="#444">Receipt no: ${xml(input.receiptNo)}</text>
    <text x="48" y="204" font-family="Helvetica" font-size="14" fill="#444">Date: ${xml(input.date)} (AD)</text>
    <text x="48" y="228" font-family="Helvetica" font-size="14" fill="#444">Paid by: ${xml(input.payer)}</text>
    <text x="48" y="252" font-family="Helvetica" font-size="14" fill="#444">Category: ${xml(input.category)}</text>
    <line x1="48" y1="272" x2="472" y2="272" stroke="#c9c3b5"/>
    <text x="48" y="300" font-family="Helvetica" font-size="13" font-weight="bold" fill="#333">Description</text>
    <text x="430" y="300" font-family="Helvetica" font-size="13" font-weight="bold" fill="#333" text-anchor="end">Amount</text>
    ${itemRows}
    <line x1="48" y1="440" x2="472" y2="440" stroke="#c9c3b5"/>
    <text x="48" y="478" font-family="Helvetica" font-size="18" font-weight="bold" fill="#1d1c19">TOTAL</text>
    <text x="430" y="478" font-family="Helvetica" font-size="18" font-weight="bold" fill="#1d1c19" text-anchor="end">NPR ${xml(input.total)}</text>
    <text x="48" y="512" font-family="Helvetica" font-size="12" fill="#6b665b">Payment method: demo card</text>
    <text x="48" y="534" font-family="Helvetica" font-size="12" fill="#6b665b">This image was generated by scripts/seed-demo.ts</text>
    <text x="48" y="556" font-family="Helvetica" font-size="12" fill="#6b665b">to exercise the document pipeline. It is not evidence.</text>
    <g fill="#1d1c19">${Array.from({ length: 44 }, (_, i) => `<rect x="${48 + i * 9.6}" y="596" width="${i % 3 === 0 ? 4 : 2}" height="56"/>`).join("")}</g>
    <text x="48" y="682" font-family="Helvetica" font-size="11" fill="#8a8478">DEMO · DO NOT FILE · NO FINANCIAL VALUE</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  const dataDir = process.env.DATABASE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  const db = await createDatabase({ dataDir });

  try {
    const existing = await one<{ users: number; claims: number; documents: number }>(
      db,
      `SELECT (SELECT COUNT(*)::int FROM users) AS users,
              (SELECT COUNT(*)::int FROM expense_claims) AS claims,
              (SELECT COUNT(*)::int FROM documents) AS documents`,
    );
    if ((existing?.users ?? 0) > 0 || (existing?.claims ?? 0) > 0 || (existing?.documents ?? 0) > 0) {
      console.error("This database already contains accounts, claims or documents.");
      console.error("Run `npm run db:reset-demo` first (it refuses to delete non-synthetic data),");
      console.error("or start from a separate DATABASE_DIR.");
      process.exitCode = 1;
      return;
    }

    const org = await one<{ id: string; name: string }>(db, `SELECT id, name FROM organizations ORDER BY created_at LIMIT 1`);
    if (!org) {
      console.error("Reference data is missing. Run `npm run db:migrate` first.");
      process.exitCode = 1;
      return;
    }

    const today = todayISO();
    const fiscal = await currentFiscalPeriod(db);
    if (today < fiscal.from) throw new Error("System date is outside the reported fiscal period.");
    const dateAt = (days: number) => isoDaysAgo(days, fiscal.from);

    const passwordHash = await hashPassword(DEMO_PASSWORD);

    // -----------------------------------------------------------------------
    // People
    // -----------------------------------------------------------------------
    const roster: Array<{ key: string; name: string; role: Role; title: string }> = [
      { key: "admin", name: "Aarav Sharma (Demo)", role: "ADMIN", title: "Finance Manager" },
      { key: "finance", name: "Nisha Karki (Demo)", role: "FINANCE", title: "Treasurer" },
      { key: "executive", name: "Rohan Basnet (Demo)", role: "EXECUTIVE", title: "President" },
      { key: "events", name: "Priya Gurung (Demo)", role: "EVENT_HEAD", title: "Events Lead" },
      { key: "member", name: "Suman Thapa (Demo)", role: "MEMBER", title: "General Member" },
      { key: "auditor", name: "Anisha Rai (Demo)", role: "AUDITOR", title: "Internal Auditor" },
    ];
    const people: Record<string, DemoAccount> = {};

    for (const person of roster) {
      const memberId = randomUUID();
      const userId = randomUUID();
      const email = `${person.key}@${DEMO_DOMAIN}`;
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO members (id, name, email, program, batch, role_title, user_id, notes, is_synthetic)
           VALUES ($1,$2,$3,'Demo programme','Demo batch',$4,NULL,'Synthetic demo member created by seed-demo.ts',true)`,
          [memberId, person.name, email, person.title],
        );
        await tx.query(
          `INSERT INTO users (id, email, name, password_hash, role, member_id, is_active, is_synthetic)
           VALUES ($1,$2,$3,$4,$5,$6,true,true)`,
          [userId, email, person.name, passwordHash, person.role, memberId],
        );
        await tx.query(`UPDATE members SET user_id=$2 WHERE id=$1`, [memberId, userId]);
      });
      const perms = await many<{ permission: string }>(
        db, `SELECT permission FROM role_permissions WHERE role=$1 ORDER BY permission`, [person.role],
      );
      people[person.key] = {
        key: person.key, name: person.name, email, role: person.role, title: person.title,
        memberId, userId,
        user: {
          id: userId, name: person.name, email, role: person.role, roleLabel: person.role,
          memberId, isSynthetic: true, mustChangePassword: false, sessionId: "seed-session", permissions: perms.map((p) => p.permission as Permission),
        },
      };
    }
    const admin = people.admin!.user;
    const finance = people.finance!.user;
    const executive = people.executive!.user;
    const eventHead = people.events!.user;
    const member = people.member!.user;
    const memberPerson = people.member!;

    // -----------------------------------------------------------------------
    // Accounts and departments
    // -----------------------------------------------------------------------
    const bankId = randomUUID();
    const cashOpening = 5_000_000; // NPR 50,000
    const bankOpening = 25_000_000; // NPR 250,000
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE financial_accounts SET opening_balance_paisa=$1, opened_on=$2, is_synthetic=true, notes=$3 WHERE id='acct_cash'`,
        [cashOpening, fiscal.from, "Synthetic demo opening count (not a real cash verification)."],
      );
      await tx.query(
        `INSERT INTO financial_accounts (id, name, type, institution, identifier_masked, opening_balance_paisa, opened_on, notes, is_synthetic)
         VALUES ($1,$2,'BANK',$3,$4,$5,$6,$7,true)`,
        [
          bankId, "Demo Bank — Current Account", "Demo Bank Ltd.", "XXXX-XXXX-4821", bankOpening,
          fiscal.from, "Synthetic demo account. The statement is generated, not supplied by a bank.",
        ],
      );
      await postJournal(tx, {
        date: fiscal.from,
        memo: "Opening balances — synthetic demo",
        sourceType: "OPENING_BALANCE",
        sourceId: null,
        createdBy: admin.id,
        lines: [
          { accountCode: ACCOUNTS.CASH.code, accountName: `${ACCOUNTS.CASH.name} — Cash box`, debit: cashOpening },
          { accountCode: ACCOUNTS.BANK.code, accountName: `${ACCOUNTS.BANK.name} — Demo Bank`, debit: bankOpening },
          { accountCode: ACCOUNTS.OPENING_EQUITY.code, accountName: ACCOUNTS.OPENING_EQUITY.name, credit: cashOpening + bankOpening },
        ],
      });
    });

    const departments = [
      { id: randomUUID(), name: "Technical", code: "TECH" },
      { id: randomUUID(), name: "Operations", code: "OPS" },
    ];
    for (const d of departments) {
      await db.query(`INSERT INTO departments (id, name, code, description) VALUES ($1,$2,$3,$4)`, [
        d.id, d.name, d.code, "Synthetic demo department",
      ]);
    }

    // -----------------------------------------------------------------------
    // Events and budgets
    // -----------------------------------------------------------------------
    const hackathonId = randomUUID();
    const workshopId = randomUUID();
    await db.query(
      `INSERT INTO events (id, name, code, starts_on, ends_on, owner_member_id, status, notes, is_synthetic)
       VALUES ($1,$2,'DEMO-HACK',$3,$4,$5,'ACTIVE',$6,true)`,
      [
        hackathonId, "LOCUS Hackathon 2026 (Demo)", dateAt(40), dateAt(39), memberPerson.memberId,
        "Synthetic demo event. Dates and figures are illustrative only.",
      ],
    );
    await db.query(
      `INSERT INTO events (id, name, code, starts_on, ends_on, owner_member_id, status, notes, is_synthetic)
       VALUES ($1,$2,'DEMO-WORKSHOP',$3,$4,$5,'COMPLETED',$6,true)`,
      [
        workshopId, "Financial Literacy Workshop (Demo)", dateAt(70), dateAt(70), eventHead.memberId,
        "Synthetic demo workshop.",
      ],
    );

    const budgetId = await createBudget(db, finance, {
      name: "Hackathon 2026 budget (Demo)",
      scope: "EVENT",
      eventId: hackathonId,
      fiscalYear: fiscalYearBsFor(fiscal.from),
      lines: [
        { categoryId: "cat_travel", amount: "50000" },
        { categoryId: "cat_food", amount: "80000" },
        { categoryId: "cat_venue", amount: "150000" },
        { categoryId: "cat_prizes", amount: "100000" },
        { categoryId: "cat_marketing", amount: "40000" },
        { categoryId: "cat_printing", amount: "30000" },
        { categoryId: "cat_equipment", amount: "60000" },
        { categoryId: "cat_software", amount: "25000" },
        { categoryId: "cat_utilities", amount: "10000" },
      ],
    });
    await db.query(`UPDATE budgets SET is_synthetic=true, notes=$2 WHERE id=$1`, [
      budgetId, "Synthetic demo budget. Utilisation is measured from seeded claims.",
    ]);

    // -----------------------------------------------------------------------
    // Document batch
    // -----------------------------------------------------------------------
    const batchId = randomUUID();
    await db.query(
      `INSERT INTO document_batches (id, kind, source_label, notes, created_by, is_synthetic)
       VALUES ($1,'DEMO',$2,$3,$4,true)`,
      [batchId, "Synthetic demo documents", "Generated receipt images and a generated bank statement. Not real evidence.", admin.id],
    );

    async function attachReceipt(
      owner: CurrentUser, tag: string, merchant: string, date: string, total: string, category: string,
    ): Promise<string> {
      const bytes = await syntheticReceipt({
        merchant, date, total, receiptNo: `DEMO-${tag}-${randomBytes(3).toString("hex").toUpperCase()}`,
        category, payer: owner.name,
      });
      const result = await uploadOne(db, owner, {
        filename: `synthetic-receipt-${tag.toLowerCase()}.png`,
        mime: "image/png",
        bytes,
        batchId,
        docType: "RECEIPT",
      });
      if (result.duplicate) throw new Error(`Synthetic receipt ${tag} collided with an existing document hash.`);
      await db.query(
        `UPDATE documents SET is_synthetic=true, status='REVIEWED', review_status='ACCEPTED', reviewed_by=$2, reviewed_at=now(),
                extracted=$3::jsonb, field_sources=$4::jsonb, notes=$5
          WHERE id=$1`,
        [
          result.documentId, finance.id,
          JSON.stringify({ merchant, date, total, totalPaisa: Math.round(Number(total) * 100), synthetic: true }),
          JSON.stringify({ source: "seed-demo", synthetic: true }),
          "Synthetic demo receipt generated by scripts/seed-demo.ts. Not financial evidence.",
        ],
      );
      return result.documentId;
    }

    type ClaimSpec = {
      tag: string; owner: DemoAccount; date: string; vendor: string; description: string;
      amount: string; categoryId: string; eventId: string | null; fundingSource: "PERSONAL" | "LOCUS_CASH" | "LOCUS_BANK";
      receipt: boolean; declaration?: string; advanceId?: string | null; committeeRef?: string | null;
      submitNow?: boolean; paymentMethod?: string; purpose?: string;
    };

    const created: Record<string, { id: string; claimNo: string }> = {};

    async function addClaim(spec: ClaimSpec) {
      const docIds: string[] = [];
      if (spec.receipt) {
        docIds.push(await attachReceipt(
          spec.owner.user, spec.tag, spec.vendor, spec.date, spec.amount,
          spec.categoryId.replace("cat_", ""),
        ));
      }
      const result = await createExpense(db, spec.owner.user, {
        date: spec.date,
        vendorName: spec.vendor,
        description: spec.description,
        businessPurpose: spec.purpose ?? "Synthetic demo expense for workflow validation.",
        amount: spec.amount,
        categoryId: spec.categoryId,
        eventId: spec.eventId,
        fundingSource: spec.fundingSource,
        paymentMethod: spec.paymentMethod ?? "Demo card",
        submitNow: spec.submitNow ?? true,
        missingReceiptDeclaration: spec.declaration ?? null,
        advanceId: spec.advanceId ?? null,
        committeeRef: spec.committeeRef ?? null,
      }, docIds);
      await db.query(`UPDATE expense_claims SET is_synthetic=true WHERE id=$1`, [result.id]);
      created[spec.tag] = { id: result.id, claimNo: result.claimNo };
      if (!spec.receipt) {
        await db.query(`UPDATE expense_claims SET documentation_state='MISSING_DECLARED' WHERE id=$1`, [result.id]);
      }
      return result;
    }

    // -----------------------------------------------------------------------
    // Advance
    // -----------------------------------------------------------------------
    const advance = await createAdvance(db, finance, {
      memberId: memberPerson.memberId,
      purpose: "Demo: hackathon logistics cash float",
      amount: "8000",
      eventId: hackathonId,
      dueOn: dateAt(20),
      notes: "Synthetic demo advance.",
    });
    await disburseAdvance(db, finance, {
      advanceId: advance.id, accountId: "acct_cash", date: dateAt(62), method: "Cash", reference: "DEMO-ADV",
    });
    await db.query(`UPDATE advances SET is_synthetic=true WHERE id=$1`, [advance.id]);

    // -----------------------------------------------------------------------
    // Claims across the lifecycle
    // -----------------------------------------------------------------------
    // Reconciled reimbursement (personal funds, bank payment).
    await addClaim({
      tag: "C1", owner: memberPerson, date: dateAt(56), vendor: "Demo Airport Cabs",
      description: "Airport transfer for visiting judges",
      amount: "1250", categoryId: "cat_travel", eventId: hackathonId, fundingSource: "PERSONAL", receipt: true,
      purpose: "Ground transport for two external judges.",
    });
    // Executive-tier operating payment from the bank.
    await addClaim({
      tag: "C2", owner: people.events!, date: dateAt(42), vendor: "Demo Print House",
      description: "Banners, standees and participant badges",
      amount: "3200", categoryId: "cat_printing", eventId: hackathonId, fundingSource: "LOCUS_BANK", receipt: true,
      purpose: "Event branding and participant identification.",
    });
    // Awaiting first approval (executive tier).
    await addClaim({
      tag: "C3", owner: memberPerson, date: dateAt(58), vendor: "Demo Catering Collective",
      description: "Refreshments for volunteer briefing",
      amount: "4500", categoryId: "cat_food", eventId: hackathonId, fundingSource: "PERSONAL", receipt: true,
    });
    // Committee-tier venue commitment, approved but unpaid.
    await addClaim({
      tag: "C4", owner: people.events!, date: dateAt(38), vendor: "Demo Convention Hall",
      description: "Two-day venue hire including AV",
      amount: "125000", categoryId: "cat_venue", eventId: hackathonId, fundingSource: "PERSONAL", receipt: true,
      committeeRef: "DEMO-COMMITTEE-2083-04", purpose: "Main venue for the 36-hour hackathon.",
    });
    // Rejected claim.
    await addClaim({
      tag: "C5", owner: memberPerson, date: dateAt(52), vendor: "Demo Internet Provider",
      description: "Home internet bill (not an event cost)",
      amount: "600", categoryId: "cat_utilities", eventId: workshopId, fundingSource: "PERSONAL", receipt: true,
    });
    // Missing receipt with declaration, changes requested.
    await addClaim({
      tag: "C6", owner: memberPerson, date: dateAt(54), vendor: "Demo Design Tools",
      description: "Annual design software subscription",
      amount: "2400", categoryId: "cat_software", eventId: null, fundingSource: "PERSONAL", receipt: false,
      declaration: "The vendor emailed an invoice but no downloadable receipt was issued. Bank statement line will be supplied.",
    });
    // Advance-funded equipment purchase.
    await addClaim({
      tag: "C7", owner: memberPerson, date: dateAt(33), vendor: "Demo Electronics",
      description: "Wi-Fi router and cables for the venue",
      amount: "5000", categoryId: "cat_equipment", eventId: hackathonId, fundingSource: "LOCUS_CASH", receipt: true,
      advanceId: advance.id, purpose: "Temporary network equipment purchased from the cash float.",
    });
    // Draft, never submitted.
    await addClaim({
      tag: "C8", owner: people.events!, date: dateAt(60), vendor: "Demo Social Studio",
      description: "Social media creatives (draft)",
      amount: "950", categoryId: "cat_marketing", eventId: hackathonId, fundingSource: "PERSONAL", receipt: true,
      submitNow: false,
    });
    // Paid, then evidence disputed.
    await addClaim({
      tag: "C9", owner: memberPerson, date: dateAt(50), vendor: "Demo City Taxi",
      description: "Late-night volunteer transport",
      amount: "700", categoryId: "cat_travel", eventId: hackathonId, fundingSource: "PERSONAL", receipt: true,
    });

    // Approvals and money movement.
    await decideClaim(db, finance, created.C1!.id, "APPROVE", "Synthetic demo approval — standard tier.");
    await recordClaimPayment(db, finance, {
      claimId: created.C1!.id, accountId: bankId, amount: "1250", date: dateAt(51),
      method: "Bank transfer", reference: "DEMO-REIMB-C1", notes: "Synthetic demo reimbursement.",
    });
    await verifyClaim(db, admin, created.C1!.id, "Demo: receipt and bank transfer agree.");

    await decideClaim(db, finance, created.C2!.id, "APPROVE", "Finance review complete (demo).");
    await decideClaim(db, executive, created.C2!.id, "APPROVE", "Executive approval (demo).");
    await recordClaimPayment(db, finance, {
      claimId: created.C2!.id, accountId: bankId, amount: "3200", date: dateAt(40),
      method: "Bank transfer", reference: "DEMO-PRINT-C2", notes: "Synthetic demo supplier payment.",
    });

    await decideClaim(db, finance, created.C4!.id, "APPROVE", "Finance review complete (demo).");
    await decideClaim(db, executive, created.C4!.id, "APPROVE", "Committee reference on file (demo).");

    await decideClaim(db, finance, created.C5!.id, "REJECT", "Synthetic demo rejection: household utility, not an event cost.");

    await decideClaim(db, finance, created.C6!.id, "REQUEST_CHANGES", "Attach the invoice or a signed missing-receipt declaration.");

    await decideClaim(db, finance, created.C7!.id, "APPROVE", "Finance review complete (demo).");
    await decideClaim(db, executive, created.C7!.id, "APPROVE", "Executive approval (demo).");

    await decideClaim(db, finance, created.C9!.id, "APPROVE", "Synthetic demo approval — standard tier.");
    await recordClaimPayment(db, finance, {
      claimId: created.C9!.id, accountId: "acct_cash", amount: "700", date: dateAt(50),
      method: "Cash", reference: "DEMO-CASH-C9", notes: "Synthetic demo cash reimbursement.",
    });
    await flagDispute(db, admin, created.C9!.id, "Synthetic demo dispute: fare amount needs confirmation from the volunteer.");

    // The C6 declaration was intentionally not stored as a document; reflect that state.
    await db.query(
      `UPDATE expense_claims SET documentation_state='MISSING_DECLARED' WHERE id=$1 AND documentation_state='MISSING_UNDECLARED'`,
      [created.C6!.id],
    );

    // -----------------------------------------------------------------------
    // Sponsorships
    // -----------------------------------------------------------------------
    const sponsorOne = await createSponsorship(db, finance, {
      sponsorName: "Sagarmatha Tech (Demo)",
      title: "Hackathon title sponsorship (demo)",
      packageTier: "Title",
      state: "COMMITTED",
      promised: "100000",
      inKind: false,
      eventId: hackathonId,
      earmarkNote: "Demo earmark: prize pool.",
      signedOn: dateAt(55),
      contactName: "Demo Contact",
      email: `sponsor.one@${DEMO_DOMAIN}`,
      deliverables: "Logo on main stage backdrop\nLogo and link on event page\nSocial media announcement",
    });
    await recordSponsorReceipt(db, finance, {
      agreementId: sponsorOne.id, accountId: bankId, amount: "100000", date: dateAt(45),
      method: "Bank transfer", reference: "DEMO-SPN-ONE", notes: "Synthetic demo sponsor receipt.",
    });

    const sponsorTwo = await createSponsorship(db, finance, {
      sponsorName: "Himalayan Foods (Demo)",
      title: "Refreshment partner (demo)",
      packageTier: "Community",
      state: "COMMITTED",
      promised: "120000",
      inKind: false,
      eventId: hackathonId,
      signedOn: dateAt(58),
      deliverables: "Logo on menu cards\nOne social post",
    });
    await recordSponsorReceipt(db, finance, {
      agreementId: sponsorTwo.id, accountId: bankId, amount: "40000", date: dateAt(49),
      method: "Bank transfer", reference: "DEMO-SPN-TWO", notes: "Synthetic demo partial receipt.",
    });

    await createSponsorship(db, finance, {
      sponsorName: "Patan Coffee Roasters (Demo)",
      title: "In-kind coffee sponsorship (demo)",
      state: "COMMITTED",
      promised: "0",
      inKind: true,
      inKindDescription: "40 litres of brewed coffee and cups for the 36-hour event",
      inKindValue: "30000",
      eventId: workshopId,
      signedOn: dateAt(30),
    });
    await db.query(`UPDATE sponsors SET is_synthetic=true`);
    await db.query(`UPDATE sponsorship_agreements SET is_synthetic=true`);
    await db.query(`UPDATE sponsor_deliverables SET status='DONE', completed_at=now() WHERE id = (SELECT id FROM sponsor_deliverables ORDER BY id LIMIT 1)`);

    // -----------------------------------------------------------------------
    // Bank fee (posted directly because the UI has no non-claim payment form)
    // -----------------------------------------------------------------------
    const feeDate = dateAt(21);
    const feeAmount = 25_000; // NPR 250
    const feeId = randomUUID();
    const feeRef = await paymentNumber(db);
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO payments (id, ref, type, direction, account_id, payee_name, amount_paisa, date_ad, method, reference, notes, status, created_by, is_synthetic)
         VALUES ($1,$2,'BANK_FEE','OUT',$3,'Demo Bank Ltd.',$4,$5,'Bank charge','DEMO-FEE',$6,'RECORDED',$7,true)`,
        [feeId, feeRef, bankId, feeAmount, feeDate, "Synthetic demo monthly account fee.", finance.id],
      );
      const journalId = await postJournal(tx, {
        date: feeDate,
        memo: "Bank charges — synthetic demo",
        sourceType: "BANK_FEE",
        sourceId: feeId,
        createdBy: finance.id,
        lines: [
          { accountCode: ACCOUNTS.BANK_FEES.code, accountName: ACCOUNTS.BANK_FEES.name, debit: feeAmount },
          { accountCode: ACCOUNTS.BANK.code, accountName: `${ACCOUNTS.BANK.name} — Demo Bank — Current Account`, credit: feeAmount },
        ],
      });
      await tx.query(`UPDATE payments SET journal_entry_id=$2 WHERE id=$1`, [feeId, journalId]);
    });

    // -----------------------------------------------------------------------
    // Generated bank statement, import, matching and reconciliation
    // -----------------------------------------------------------------------
    const bankAccount = await one<{ id: string; name: string; type: string; opening_balance_paisa: number }>(
      db, `SELECT id, name, type, opening_balance_paisa FROM financial_accounts WHERE id=$1`, [bankId],
    );
    const ledger = accountLedger(bankAccount?.type ?? "BANK");
    const bankPayments = await many<{
      id: string; ref: string; type: string; direction: string; amount_paisa: number; date_ad: string; label: string | null;
    }>(
      db,
      `SELECT p.id, p.ref, p.type, p.direction, p.amount_paisa, to_char(p.date_ad,'YYYY-MM-DD') AS date_ad,
              COALESCE(p.payee_name, m.name) AS label
         FROM payments p LEFT JOIN members m ON m.id=p.counterparty_member_id
        WHERE p.account_id=$1 AND p.status='RECORDED' AND p.type<>'TRANSFER'
        ORDER BY p.date_ad, p.created_at`,
      [bankId],
    );
    if (!bankPayments.length) throw new Error("Expected bank payments before building the statement.");

    let running = money(bankAccount?.opening_balance_paisa);
    const statementRows: string[] = ["Date,Description,Debit,Credit,Balance,Reference"];
    const txnDates: string[] = [];
    for (const p of bankPayments) {
      const isOut = p.direction === "OUT";
      if (isOut) running -= money(p.amount_paisa);
      else running += money(p.amount_paisa);
      const description = p.type === "SPONSOR_RECEIPT"
        ? `Sponsor receipt — ${p.label ?? "sponsor"}`
        : p.type === "BANK_FEE"
          ? "Monthly account fee"
          : `Outgoing transfer — ${p.label ?? "payee"}`;
      statementRows.push([
        p.date_ad, `"${description.replace(/"/g, '""')}"`,
        isOut ? paisaToDecimal(money(p.amount_paisa)) : "0.00",
        isOut ? "0.00" : paisaToDecimal(money(p.amount_paisa)),
        paisaToDecimal(running), p.ref,
      ].join(","));
      txnDates.push(p.date_ad);
    }
    // A deposit that has not yet been recorded in the ledger — deliberately left unmatched.
    running += 500_000;
    const unknownDepositDate = isoDaysAgo(12, feeDate);
    statementRows.push([
      unknownDepositDate, '"Cash deposit — not yet recorded"', "0.00", "5000.00",
      paisaToDecimal(running), "DEMO-UNRECORDED",
    ].join(","));
    const statementCsv = Buffer.from(statementRows.join("\n"), "utf8");
    const statementFilename = "synthetic-bank-statement.csv";
    const statementDoc = await uploadOne(db, finance, {
      filename: statementFilename, mime: "text/csv", bytes: statementCsv, batchId, docType: "BANK_STATEMENT",
    });
    await db.query(
      `UPDATE documents SET is_synthetic=true, status='REVIEWED', review_status='ACCEPTED', reviewed_by=$2, reviewed_at=now(),
              notes=$3, extracted=$4::jsonb
        WHERE id=$1`,
      [
        statementDoc.documentId, finance.id,
        "Synthetic bank statement generated for the demo. Not a bank document.",
        JSON.stringify({ synthetic: true, rows: bankPayments.length + 1 }),
      ],
    );

    const imported = await importStatement(db, finance, {
      accountId: bankId,
      bytes: statementCsv,
      filename: statementFilename,
      documentId: statementDoc.documentId,
      sourceLabel: "Synthetic demo bank statement",
    });
    const lines = await statementLines(db, imported.importId);
    let matched = 0;
    for (const line of lines) {
      const isOut = Number(line.debit_paisa) > 0;
      const amount = Number(line.debit_paisa) + Number(line.credit_paisa);
      const candidate = bankPayments.find((p) =>
        p.date_ad === line.txn_date && Number(p.amount_paisa) === amount && p.direction === (isOut ? "OUT" : "IN"),
      );
      if (candidate) {
        await confirmStatementMatch(db, finance, line.id, candidate.id);
        matched++;
      }
    }

    const reconcileEnd = feeDate;
    const computed = await accountBalanceAsOf(db, bankId, reconcileEnd);
    await createReconciliation(db, finance, {
      accountId: bankId,
      importId: imported.importId,
      periodStart: txnDates[0] ?? fiscal.from,
      periodEnd: reconcileEnd,
      statementBalance: paisaToDecimal(computed),
      notes: "Synthetic demo reconciliation. The unrecorded 3 September deposit remains unmatched on purpose.",
    });

    // -----------------------------------------------------------------------
    // Synthetic flags and consistency checks
    // -----------------------------------------------------------------------
    await db.query(`UPDATE payments SET is_synthetic=true WHERE is_synthetic=false`);
    await db.query(`UPDATE vendors SET is_synthetic=true WHERE is_synthetic=false`);
    await db.query(`UPDATE events SET is_synthetic=true WHERE is_synthetic=false`);
    await db.query(`UPDATE documents SET is_synthetic=true WHERE is_synthetic=false`);
    await db.query(`UPDATE financial_accounts SET is_synthetic=true WHERE id IN ('acct_cash',$1)`, [bankId]);

    const balance = await one<{ dr: number; cr: number }>(
      db,
      `SELECT COALESCE(SUM(debit_paisa),0) AS dr, COALESCE(SUM(credit_paisa),0) AS cr FROM journal_lines`,
    );
    if (money(balance?.dr) !== money(balance?.cr)) {
      throw new Error(`Journal is out of balance: debit ${balance?.dr} vs credit ${balance?.cr}`);
    }

    const syntheticCheck = await one<{
      claims: number; synthetic_claims: number; payments: number; synthetic_payments: number;
      docs: number; synthetic_docs: number; users: number; synthetic_users: number;
    }>(
      db,
      `SELECT (SELECT COUNT(*)::int FROM expense_claims) AS claims,
              (SELECT COUNT(*)::int FROM expense_claims WHERE is_synthetic) AS synthetic_claims,
              (SELECT COUNT(*)::int FROM payments) AS payments,
              (SELECT COUNT(*)::int FROM payments WHERE is_synthetic) AS synthetic_payments,
              (SELECT COUNT(*)::int FROM documents) AS docs,
              (SELECT COUNT(*)::int FROM documents WHERE is_synthetic) AS synthetic_docs,
              (SELECT COUNT(*)::int FROM users) AS users,
              (SELECT COUNT(*)::int FROM users WHERE is_synthetic) AS synthetic_users`,
    );
    if (
      syntheticCheck?.claims !== syntheticCheck?.synthetic_claims ||
      syntheticCheck?.payments !== syntheticCheck?.synthetic_payments ||
      syntheticCheck?.docs !== syntheticCheck?.synthetic_docs ||
      syntheticCheck?.users !== syntheticCheck?.synthetic_users
    ) {
      throw new Error("Some demo rows were not flagged as synthetic. Aborting before writing credentials.");
    }

    const counts = await one<{ claims: number; documents: number; payments: number; journal: number; matched: number; unmatched: number }>(
      db,
      `SELECT (SELECT COUNT(*)::int FROM expense_claims) AS claims,
              (SELECT COUNT(*)::int FROM documents) AS documents,
              (SELECT COUNT(*)::int FROM payments) AS payments,
              (SELECT COUNT(*)::int FROM journal_entries) AS journal,
              (SELECT COUNT(*)::int FROM bank_statement_lines WHERE match_status='MATCHED') AS matched,
              (SELECT COUNT(*)::int FROM bank_statement_lines WHERE match_status<>'MATCHED') AS unmatched`,
    );

    await recordAudit(db, {
      actorUserId: null, actorName: "SEED",
      action: "DEMO_SEEDED", entityType: "organization", entityId: org.id,
      summary: `Synthetic demo dataset created: ${counts?.claims ?? 0} claims, ${counts?.payments ?? 0} payments, ${counts?.documents ?? 0} documents.`,
      after: { ...counts, fiscalYear: fiscal.label, demoDomain: DEMO_DOMAIN },
    });

    const credentialFile = path.join(process.cwd(), ".data", "demo-credentials.txt");
    await fs.mkdir(path.dirname(credentialFile), { recursive: true });
    await fs.writeFile(
      credentialFile,
      [
        "LOCUS Finance — SYNTHETIC demo credentials",
        "===========================================",
        "",
        "This database contains synthetic demonstration data only.",
        "Do not enter real receipts, sponsor money or member data until you reset",
        "the demo and create a real administrator with `npm run db:create-admin`.",
        "",
        `Shared password: ${DEMO_PASSWORD}`,
        "",
        "Accounts (all use the shared password):",
        ...roster.map((p) => `  ${`${p.key}@${DEMO_DOMAIN}`.padEnd(24)} ${p.role.padEnd(10)} ${p.name}`),
        "",
        "Sign in at http://localhost:3000/login",
        "",
        "The password in this file is generated per seed run. Delete the file after",
        "signing in, or run `npm run db:reset-demo` to remove the demo entirely.",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await fs.chmod(credentialFile, 0o600);

    console.log("Synthetic demo dataset created.");
    console.log(`  Claims:        ${counts?.claims ?? 0}`);
    console.log(`  Payments:      ${counts?.payments ?? 0}`);
    console.log(`  Documents:     ${counts?.documents ?? 0}`);
    console.log(`  Journal:       ${counts?.journal ?? 0} entries (balanced)`);
    console.log(`  Bank lines:    ${counts?.matched ?? 0} matched, ${counts?.unmatched ?? 0} open`);
    console.log(`  Fiscal period: ${fiscal.label}`);
    console.log("");
    console.log("Sign-in details were written to .data/demo-credentials.txt (mode 0600).");
    console.log("Open the file to read them; they are deliberately not printed here.");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
