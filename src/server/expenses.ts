import { randomUUID } from "node:crypto";
import { z } from "zod";
import { many, money, one, type Db, type Executor } from "./db";
import { recordAudit } from "./audit";
import { claimNumber, paymentNumber, postJournal, ACCOUNTS, accountLedger } from "./journal";
import { approvalTier, getSettings, requiredApprovals, type Settings } from "./settings";
import { parseMoney } from "@/lib/money";
import { adToBs, isValidISODate, todayISO } from "@/lib/nepali-date";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { assertDateOpen } from "./periods";
import { notifyClaimEvent } from "./notifications";
import { lockAndAssertFunds } from "./funds";
import { inferCategoryId } from "./categorization";
import { hasActiveDelegation } from "./delegations";
import { notifyClaimSubmittedInApp } from "./notifications-center";

export class ExpenseError extends Error {}

export const EXPENSE_STATUSES = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "WITHDRAWN",
  "PAYMENT_PENDING", "REIMBURSED", "SETTLED", "VERIFIED", "RECONCILED", "DISPUTED",
] as const;

export type ClaimRow = {
  id: string;
  claim_no: string;
  claimant_user_id: string;
  claimant_name: string;
  paid_by_member_id: string;
  paid_by_name: string;
  date_ad: string;
  date_bs: string | null;
  vendor_name: string | null;
  category_id: string;
  category_name: string;
  category_code: string;
  event_id: string | null;
  event_name: string | null;
  department_id: string | null;
  amount_paisa: number;
  status: string;
  verification_state: string;
  documentation_state: string;
  funding_source: string;
  reimbursement_required: boolean;
  description: string;
  created_at: Date;
  submitted_at: Date | null;
  docs: number;
  paid_paisa: number;
  is_synthetic: boolean;
  source_type: string;
};

function viewerScope(viewer: CurrentUser, params: unknown[], clauses: string[]) {
  if (!can(viewer.role, "expense.view.all", viewer.permissions)) {
    params.push(viewer.id);
    clauses.push(`c.claimant_user_id = $${params.length}`);
  }
}

export type ClaimFilters = {
  status?: string;
  eventId?: string;
  departmentId?: string;
  categoryId?: string;
  memberId?: string;
  claimant?: string;
  from?: string;
  to?: string;
  verification?: string;
  documentation?: string;
  pendingOnly?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
};

export async function listClaims(db: Db, viewer: CurrentUser, filters: ClaimFilters = {}): Promise<ClaimRow[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  viewerScope(viewer, params, clauses);
  if (filters.status) { params.push(filters.status); clauses.push(`c.status = $${params.length}`); }
  if (filters.eventId) { params.push(filters.eventId); clauses.push(`c.event_id = $${params.length}`); }
  if (filters.departmentId) { params.push(filters.departmentId); clauses.push(`c.department_id = $${params.length}`); }
  if (filters.categoryId) { params.push(filters.categoryId); clauses.push(`c.category_id = $${params.length}`); }
  if (filters.memberId) { params.push(filters.memberId); clauses.push(`c.paid_by_member_id = $${params.length}`); }
  if (filters.claimant) { params.push(filters.claimant); clauses.push(`c.claimant_user_id = $${params.length}`); }
  if (filters.from) { params.push(filters.from); clauses.push(`c.date_ad >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); clauses.push(`c.date_ad <= $${params.length}`); }
  if (filters.verification) { params.push(filters.verification); clauses.push(`c.verification_state = $${params.length}`); }
  if (filters.documentation) { params.push(filters.documentation); clauses.push(`c.documentation_state = $${params.length}`); }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    clauses.push(`(lower(c.claim_no) LIKE $${params.length} OR lower(c.description) LIKE $${params.length} OR lower(COALESCE(c.vendor_name_raw,'')) LIKE $${params.length})`);
  }
  if (filters.pendingOnly) {
    clauses.push(`c.status IN ('SUBMITTED','UNDER_REVIEW')`);
  }
  params.push(Math.min(filters.limit ?? 50, 200));
  const limitIdx = params.length;
  params.push(filters.offset ?? 0);
  const offsetIdx = params.length;

  const rows = await many<ClaimRow>(
    db,
    `SELECT c.id, c.claim_no, c.claimant_user_id, cu.name AS claimant_name, c.paid_by_member_id,
            pm.name AS paid_by_name, to_char(c.date_ad,'YYYY-MM-DD') AS date_ad, c.date_bs,
            COALESCE(v.name, c.vendor_name_raw) AS vendor_name,
            c.category_id, cat.name AS category_name, cat.code AS category_code,
            c.event_id, e.name AS event_name, c.department_id, c.amount_paisa, c.status,
            c.verification_state, c.documentation_state, c.funding_source, c.reimbursement_required, c.description,
            c.created_at, c.submitted_at, c.is_synthetic, c.source_type,
            (SELECT COUNT(*)::int FROM documents d WHERE d.claim_id = c.id) AS docs,
            COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.claim_id = c.id AND p.status='RECORDED' AND p.reverses_payment_id IS NULL
              AND p.type IN ('REIMBURSEMENT','EXPENSE_PAYMENT')), 0) AS paid_paisa
       FROM expense_claims c
       JOIN users cu ON cu.id = c.claimant_user_id
       JOIN members pm ON pm.id = c.paid_by_member_id
       JOIN expense_categories cat ON cat.id = c.category_id
       LEFT JOIN vendors v ON v.id = c.vendor_id
       LEFT JOIN events e ON e.id = c.event_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY c.date_ad DESC, c.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return rows.map((row) => ({ ...row, paid_paisa: money(row.paid_paisa) }));
}

export async function summarizeClaims(
  db: Db,
  viewer: CurrentUser,
  filters: ClaimFilters = {},
): Promise<{ n: number; total: number; verified: number }> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  viewerScope(viewer, params, clauses);
  if (filters.status) { params.push(filters.status); clauses.push(`c.status = $${params.length}`); }
  if (filters.eventId) { params.push(filters.eventId); clauses.push(`c.event_id = $${params.length}`); }
  if (filters.departmentId) { params.push(filters.departmentId); clauses.push(`c.department_id = $${params.length}`); }
  if (filters.categoryId) { params.push(filters.categoryId); clauses.push(`c.category_id = $${params.length}`); }
  if (filters.memberId) { params.push(filters.memberId); clauses.push(`c.paid_by_member_id = $${params.length}`); }
  if (filters.claimant) { params.push(filters.claimant); clauses.push(`c.claimant_user_id = $${params.length}`); }
  if (filters.from) { params.push(filters.from); clauses.push(`c.date_ad >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); clauses.push(`c.date_ad <= $${params.length}`); }
  if (filters.verification) { params.push(filters.verification); clauses.push(`c.verification_state = $${params.length}`); }
  if (filters.documentation) { params.push(filters.documentation); clauses.push(`c.documentation_state = $${params.length}`); }
  if (filters.pendingOnly) clauses.push(`c.status IN ('SUBMITTED','UNDER_REVIEW')`);
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    clauses.push(`(lower(c.claim_no) LIKE $${params.length} OR lower(c.description) LIKE $${params.length} OR lower(COALESCE(c.vendor_name_raw,'')) LIKE $${params.length})`);
  }
  const row = await one<{ n: number; total: string | number | bigint; verified: string | number | bigint }>(
    db,
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(c.amount_paisa),0) AS total,
            COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.verification_state='VERIFIED'),0) AS verified
       FROM expense_claims c
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`,
    params,
  );
  return { n: Number(row?.n ?? 0), total: money(row?.total), verified: money(row?.verified) };
}

export async function countClaims(db: Db, viewer: CurrentUser, filters: ClaimFilters = {}): Promise<number> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  viewerScope(viewer, params, clauses);
  if (filters.status) { params.push(filters.status); clauses.push(`c.status = $${params.length}`); }
  if (filters.pendingOnly) clauses.push(`c.status IN ('SUBMITTED','UNDER_REVIEW')`);
  if (filters.eventId) { params.push(filters.eventId); clauses.push(`c.event_id = $${params.length}`); }
  if (filters.departmentId) { params.push(filters.departmentId); clauses.push(`c.department_id = $${params.length}`); }
  if (filters.categoryId) { params.push(filters.categoryId); clauses.push(`c.category_id = $${params.length}`); }
  if (filters.memberId) { params.push(filters.memberId); clauses.push(`c.paid_by_member_id = $${params.length}`); }
  if (filters.claimant) { params.push(filters.claimant); clauses.push(`c.claimant_user_id = $${params.length}`); }
  if (filters.from) { params.push(filters.from); clauses.push(`c.date_ad >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); clauses.push(`c.date_ad <= $${params.length}`); }
  if (filters.verification) { params.push(filters.verification); clauses.push(`c.verification_state = $${params.length}`); }
  if (filters.documentation) { params.push(filters.documentation); clauses.push(`c.documentation_state = $${params.length}`); }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    clauses.push(`(lower(c.claim_no) LIKE $${params.length} OR lower(c.description) LIKE $${params.length} OR lower(COALESCE(c.vendor_name_raw,'')) LIKE $${params.length})`);
  }
  const row = await one<{ n: number }>(
    db,
    `SELECT COUNT(*)::int AS n FROM expense_claims c ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`,
    params,
  );
  return row?.n ?? 0;
}

export async function getClaim(db: Db, viewer: CurrentUser, id: string) {
  const claim = await one<ClaimRow & {
    description: string; business_purpose: string | null; payment_method: string | null;
    invoice_no: string | null; seller_pan: string | null; notes: string | null;
    missing_receipt_declaration: string | null; advance_id: string | null;
    approved_at: Date | null; paid_at: Date | null; verified_at: Date | null; rejected_reason: string | null;
    committee_ref: string | null; original_currency: string | null; fx_rate: string | null;
    claimant_email: string;
  }>(
    db,
    `SELECT c.*, to_char(c.date_ad,'YYYY-MM-DD') AS date_ad, cu.name AS claimant_name, cu.email AS claimant_email,
            pm.name AS paid_by_name, COALESCE(v.name, c.vendor_name_raw) AS vendor_name,
            cat.name AS category_name, cat.code AS category_code, e.name AS event_name,
            (SELECT COUNT(*)::int FROM documents d WHERE d.claim_id = c.id) AS docs,
            COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.claim_id = c.id AND p.status='RECORDED' AND p.reverses_payment_id IS NULL
              AND p.type IN ('REIMBURSEMENT','EXPENSE_PAYMENT')), 0) AS paid_paisa
       FROM expense_claims c
       JOIN users cu ON cu.id = c.claimant_user_id
       JOIN members pm ON pm.id = c.paid_by_member_id
       JOIN expense_categories cat ON cat.id = c.category_id
       LEFT JOIN vendors v ON v.id = c.vendor_id
       LEFT JOIN events e ON e.id = c.event_id
      WHERE c.id = $1`,
    [id],
  );
  if (!claim) return null;
  if (claim.claimant_user_id !== viewer.id && !can(viewer.role, "expense.view.all", viewer.permissions)) {
    throw new ExpenseError("You do not have access to this claim.");
  }
  const [allocations, approvals, payments, documents, advance, items] = await Promise.all([
    many<{ id: string; event_id: string | null; event_name: string | null; department_id: string | null; department_name: string | null; amount_paisa: number }>(
      db,
      `SELECT a.id, a.event_id, e.name AS event_name, a.department_id, d.name AS department_name, a.amount_paisa
         FROM expense_allocations a LEFT JOIN events e ON e.id = a.event_id LEFT JOIN departments d ON d.id = a.department_id
        WHERE a.claim_id = $1 ORDER BY a.created_at`,
      [id],
    ),
    many<{ id: string; approver_user_id: string; approver_name: string; approver_role: string; decision: string; reason: string | null; tier: string; created_at: Date }>(
      db,
      `SELECT ap.id, ap.approver_user_id, u.name AS approver_name, u.role AS approver_role,
              ap.decision, ap.reason, ap.tier, ap.created_at
         FROM approvals ap JOIN users u ON u.id = ap.approver_user_id
        WHERE ap.claim_id = $1 ORDER BY ap.created_at`,
      [id],
    ),
    many<{ id: string; ref: string; type: string; amount_paisa: number; date_ad: string; method: string | null; reference: string | null; status: string; account_name: string | null; created_at: Date }>(
      db,
      `SELECT p.id, p.ref, p.type, p.amount_paisa, to_char(p.date_ad,'YYYY-MM-DD') AS date_ad,
              p.method, p.reference, p.status, a.name AS account_name, p.created_at
         FROM payments p LEFT JOIN financial_accounts a ON a.id = p.account_id
        WHERE p.claim_id = $1 ORDER BY p.created_at`,
      [id],
    ),
    many<{
      id: string; filename: string; mime: string; doc_type: string; status: string; extracted: Record<string, unknown>;
      review_status: string; uploaded_at: Date; size_bytes: number;
    }>(
      db,
      `SELECT id, filename, mime, doc_type, status, extracted, review_status, uploaded_at, size_bytes
         FROM documents WHERE claim_id = $1 ORDER BY uploaded_at`,
      [id],
    ),
    claim.advance_id
      ? one<{ id: string; ref: string; amount_paisa: number; status: string }>(db, `SELECT id, ref, amount_paisa, status FROM advances WHERE id=$1`, [claim.advance_id])
      : Promise.resolve(null),
    many<{ id: string; description: string; quantity: string; unit: string | null; unit_price_paisa: number; discount_paisa: number; tax_paisa: number; line_total_paisa: number; category_id: string | null }>(
      db,
      `SELECT id, description, quantity::text AS quantity, unit, unit_price_paisa, discount_paisa, tax_paisa, line_total_paisa, category_id
         FROM expense_items WHERE claim_id = $1 ORDER BY created_at`,
      [id],
    ),
  ]);
  return { ...claim, paid_paisa: money(claim.paid_paisa), allocations, approvals, payments, documents, advance, items };
}

const createSchema = z.object({
  date: z.string().refine(isValidISODate, "Expense date is invalid."),
  dateBs: z.string().optional().nullable(),
  calendar: z.enum(["AD", "BS"]).default("AD"),
  vendorName: z.string().trim().min(2, "Payee or merchant is required.").max(160),
  description: z.string().trim().min(3, "Describe what was purchased.").max(300),
  businessPurpose: z.string().trim().max(500).optional().nullable(),
  amount: z.string().min(1, "Amount is required."),
  categoryId: z.string().optional().nullable(),
  eventId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  fundingSource: z.enum(["PERSONAL", "FINANCE_TRACKER_CASH", "FINANCE_TRACKER_BANK"]),
  paymentMethod: z.string().trim().max(60).optional().nullable(),
  invoiceNo: z.string().trim().max(80).optional().nullable(),
  sellerPan: z.string().trim().max(20).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  missingReceiptDeclaration: z.string().trim().max(1000).optional().nullable(),
  advanceId: z.string().optional().nullable(),
  committeeRef: z.string().trim().max(120).optional().nullable(),
  submitNow: z.boolean().default(true),
  allocations: z.array(z.object({
    eventId: z.string().optional().nullable(),
    departmentId: z.string().optional().nullable(),
    amount: z.string(),
  })).optional().nullable(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(200),
    quantity: z.string().min(1),
    unit: z.string().trim().max(20).optional().nullable(),
    unitPrice: z.string().min(1),
    discount: z.string().optional().nullable(),
    tax: z.string().optional().nullable(),
    categoryId: z.string().optional().nullable(),
  })).optional().nullable(),
});

export type CreateExpenseInput = z.input<typeof createSchema>;

export async function createExpense(
  db: Db,
  user: CurrentUser,
  raw: CreateExpenseInput,
  documentIds: string[] = [],
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ id: string; claimNo: string; status: string }> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) throw new ExpenseError(parsed.error.issues.map((i) => i.message).join(" "));
  const input = parsed.data;
  if (!can(user.role, "expense.submit", user.permissions)) throw new ExpenseError("You cannot submit expense claims.");
  const amount = parseMoney(input.amount);
  if (!amount.ok) throw new ExpenseError(amount.error);
  await assertDateOpen(db, input.date, "This expense date");
  if (!user.memberId) throw new ExpenseError("Your login is not linked to a member record. Ask the Finance Manager to link it.");

  const settings = await getSettings(db);
  const resolvedCategoryId = input.categoryId && input.categoryId !== "auto"
    ? input.categoryId
    : await inferCategoryId(db, `${input.vendorName} ${input.description}`);
  const category = await one<{ id: string; requires_receipt: boolean; name: string }>(
    db, `SELECT id, requires_receipt, name FROM expense_categories WHERE id = $1 AND is_active = true`, [resolvedCategoryId],
  );
  if (!category) throw new ExpenseError("Expense category not found.");

  const needsReceipt = category.requires_receipt;
  const hasDoc = documentIds.length > 0;
  const declaration = input.missingReceiptDeclaration?.trim() || null;
  if (needsReceipt && !hasDoc && settings.documentation.missingReceiptRequiresDeclaration && !declaration) {
    throw new ExpenseError("A receipt is required. Upload the receipt or provide a missing-receipt declaration.");
  }

  if (input.advanceId) {
    if (input.fundingSource === "PERSONAL") {
      throw new ExpenseError("An advance-funded claim cannot be marked as paid from personal funds. Use the advance funding source.");
    }
    const adv = await one<{
      id: string; member_id: string; status: string; outstanding: number;
    }>(
      db,
      `SELECT a.id, a.member_id, a.status,
              GREATEST(0, a.amount_paisa
                - COALESCE((SELECT SUM(c.amount_paisa) FROM expense_claims c
                    WHERE c.advance_id=a.id AND c.status NOT IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','WITHDRAWN')),0)
                - COALESCE((SELECT SUM(s.returned_paisa) FROM advance_settlements s WHERE s.advance_id=a.id),0)) AS outstanding
         FROM advances a WHERE a.id = $1`,
      [input.advanceId],
    );
    if (!adv || adv.status !== "OUTSTANDING") throw new ExpenseError("The selected advance is not outstanding.");
    if (adv.member_id !== user.memberId) throw new ExpenseError("You can only account expenses against your own advance.");
    if (amount.paisa > money(adv.outstanding)) {
      throw new ExpenseError(`This claim exceeds the outstanding advance balance of NPR ${(money(adv.outstanding) / 100).toFixed(2)}.`);
    }
  }

  const reimbursementRequired = input.fundingSource === "PERSONAL";
  const documentationState = hasDoc ? "COMPLETE" : declaration ? "MISSING_DECLARED" : "MISSING_UNDECLARED";

  // Validate every supplied document and block re-use across claims. A receipt
  // may support one claim; a genuinely different copy must be uploaded and reviewed.
  for (const docId of documentIds) {
    const doc = await one<{ id: string; uploaded_by: string | null; claim_id: string | null; claim_no: string | null; claim_status: string | null }>(
      db,
      `SELECT d.id, d.uploaded_by, d.claim_id, c.claim_no, c.status AS claim_status
         FROM documents d LEFT JOIN expense_claims c ON c.id = d.claim_id
        WHERE d.id = $1`,
      [docId],
    );
    if (!doc) throw new ExpenseError("A selected document no longer exists. Upload it again.");
    if (doc.uploaded_by !== user.id && !can(user.role, "document.review", user.permissions)) {
      throw new ExpenseError("You can only attach documents you uploaded.");
    }
    if (doc.claim_id && !["REJECTED", "WITHDRAWN"].includes(doc.claim_status ?? "")) {
      throw new ExpenseError(`This receipt is already attached to claim ${doc.claim_no ?? "another claim"}.`);
    }
  }

  // Near-record duplicate: surface it on the claim instead of silently accepting it.
  const near = await one<{ claim_no: string }>(
    db,
    `SELECT claim_no FROM expense_claims
      WHERE claimant_user_id = $1 AND amount_paisa = $2 AND status NOT IN ('REJECTED','WITHDRAWN')
        AND date_ad BETWEEN $3::date - 3 AND $3::date + 3 LIMIT 1`,
    [user.id, amount.paisa, input.date],
  );
  const duplicateNote = near ? `[Possible duplicate of ${near.claim_no} — same amount within 3 days]` : null;
  const combinedNotes = [input.notes, duplicateNote].filter(Boolean).join("\n") || null;

  const vendorId = await resolveVendor(db, input.vendorName);
  const claimNo = await claimNumber(db);
  const id = randomUUID();
  const dateBs = input.dateBs || adToBs(input.date);
  const allocations = input.allocations?.length
    ? input.allocations.map((a) => ({ eventId: a.eventId ?? null, departmentId: a.departmentId ?? null, amount: parseMoney(a.amount) }))
    : [{ eventId: input.eventId ?? null, departmentId: input.departmentId ?? null, amount: { ok: true as const, paisa: amount.paisa } }];
  let allocationTotal = 0;
  for (const alloc of allocations) {
    if (!alloc.amount.ok) throw new ExpenseError("A split allocation amount is invalid.");
    allocationTotal += alloc.amount.paisa;
  }
  if (allocationTotal !== amount.paisa) throw new ExpenseError("Split allocations must add up to the expense total.");

  // Item-level details must reconcile with the declared total.
  const items = (input.items ?? []).map((item) => {
    const qty = Number(item.quantity);
    const unitPrice = parseMoney(item.unitPrice);
    const discount = item.discount && item.discount.trim() && item.discount.trim() !== "0"
      ? parseMoney(item.discount) : { ok: true as const, paisa: 0 };
    const tax = item.tax && item.tax.trim() && item.tax.trim() !== "0"
      ? parseMoney(item.tax) : { ok: true as const, paisa: 0 };
    if (!Number.isFinite(qty) || qty <= 0) throw new ExpenseError("Item quantity must be greater than zero.");
    if (!unitPrice.ok) throw new ExpenseError(unitPrice.error);
    if (!discount.ok) throw new ExpenseError(discount.error);
    if (!tax.ok) throw new ExpenseError(tax.error);
    const lineTotal = Math.max(0, qty * unitPrice.paisa - discount.paisa + tax.paisa);
    return {
      description: item.description,
      quantity: qty,
      unit: item.unit ?? null,
      unitPricePaisa: unitPrice.paisa,
      discountPaisa: discount.paisa,
      taxPaisa: tax.paisa,
      lineTotalPaisa: Math.round(lineTotal),
      categoryId: item.categoryId && item.categoryId !== "auto" ? item.categoryId : resolvedCategoryId,
    };
  });
  if (items.length) {
    const itemTotal = items.reduce((s, i) => s + i.lineTotalPaisa, 0);
    if (itemTotal !== amount.paisa) {
      throw new ExpenseError(`Item totals (${(itemTotal / 100).toFixed(2)}) do not match the expense total (${(amount.paisa / 100).toFixed(2)}).`);
    }
  }

  const status = input.submitNow ? "SUBMITTED" : "DRAFT";

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO expense_claims
        (id, claim_no, claimant_user_id, paid_by_member_id, date_ad, date_bs, calendar, vendor_id, vendor_name_raw,
         category_id, event_id, department_id, advance_id, amount_paisa, description, business_purpose, funding_source,
         payment_method, reimbursement_required, receipt_required, missing_receipt_declaration, invoice_no, seller_pan,
         status, verification_state, documentation_state, submitted_at, notes, committee_ref, created_by, source_type,
         is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
               'UNVERIFIED',$25,$26,$27,$28,$29,'LIVE',$30)`,
      [
        id, claimNo, user.id, user.memberId, input.date, dateBs, input.calendar, vendorId, input.vendorName,
        resolvedCategoryId, input.eventId ?? null, input.departmentId ?? null, input.advanceId ?? null,
        amount.paisa, input.description, input.businessPurpose ?? null, input.fundingSource,
        input.paymentMethod ?? null, reimbursementRequired, needsReceipt, declaration,
        input.invoiceNo ?? null, input.sellerPan ?? null, status, documentationState,
        input.submitNow ? new Date() : null, combinedNotes, input.committeeRef ?? null, user.id, user.isSynthetic,
      ],
    );
    if (vendorId && user.isSynthetic) {
      await tx.query(`UPDATE vendors SET is_synthetic=true WHERE id=$1`, [vendorId]);
    }
    for (const alloc of allocations) {
      await tx.query(
        `INSERT INTO expense_allocations (id, claim_id, event_id, department_id, amount_paisa)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), id, alloc.eventId, alloc.departmentId, alloc.amount.ok ? alloc.amount.paisa : 0],
      );
    }
    if (documentIds.length) {
      for (const docId of documentIds) {
        await tx.query(
          `UPDATE documents SET claim_id = $1, doc_type = CASE WHEN doc_type='UNKNOWN' THEN 'RECEIPT' ELSE doc_type END WHERE id = $2`,
          [id, docId],
        );
      }
    }
    for (const item of items) {
      await tx.query(
        `INSERT INTO expense_items (id, claim_id, description, quantity, unit, unit_price_paisa, discount_paisa, tax_paisa, line_total_paisa, category_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(), id, item.description, item.quantity, item.unit, item.unitPricePaisa, item.discountPaisa, item.taxPaisa, item.lineTotalPaisa, item.categoryId],
      );
    }
  });

  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: input.submitNow ? "EXPENSE_SUBMITTED" : "EXPENSE_DRAFTED",
    entityType: "expense_claim", entityId: id,
    summary: `${claimNo} — ${category.name} — NPR ${(amount.paisa / 100).toFixed(2)} (${input.fundingSource})`,
    after: { amount_paisa: amount.paisa, vendor: input.vendorName, status },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });

  if (input.submitNow) {
    const recipients = await many<{ id: string }>(db, `SELECT id FROM users WHERE role IN ('ADMIN','FINANCE','EXECUTIVE') AND is_active=true`);
    await notifyClaimSubmittedInApp(db, { id, claim_no: claimNo, amount_paisa: amount.paisa }, recipients.map((r) => r.id));
  }

  return { id, claimNo, status };
}

export async function resolveVendor(db: Db, name: string): Promise<string> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9\u0900-\u097F]+/g, " ").trim().replace(/\s+/g, " ");
  const existing = await one<{ id: string }>(db, `SELECT id FROM vendors WHERE normalized_name = $1`, [normalized]);
  if (existing) return existing.id;
  const id = randomUUID();
  await db.query(
    `INSERT INTO vendors (id, name, normalized_name) VALUES ($1,$2,$3) ON CONFLICT (normalized_name) DO NOTHING`,
    [id, name.trim(), normalized],
  );
  const created = await one<{ id: string }>(db, `SELECT id FROM vendors WHERE normalized_name = $1`, [normalized]);
  return created!.id;
}

export async function submitClaim(db: Db, user: CurrentUser, claimId: string) {
  const claim = await one<{ id: string; claimant_user_id: string; status: string; claim_no: string; approved_at: Date | null; date_ad: string }>(
    db, `SELECT id, claimant_user_id, status, claim_no, approved_at, to_char(date_ad,'YYYY-MM-DD') AS date_ad
           FROM expense_claims WHERE id=$1`, [claimId],
  );
  if (!claim) throw new ExpenseError("Claim not found.");
  if (claim.claimant_user_id !== user.id) throw new ExpenseError("Only the claimant can submit this draft.");
  if (claim.status !== "DRAFT") throw new ExpenseError("Only drafts can be submitted.");
  await assertDateOpen(db, claim.date_ad, "This claim date");
  await db.query(`UPDATE expense_claims SET status='SUBMITTED', submitted_at=now() WHERE id=$1`, [claimId]);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "EXPENSE_SUBMITTED",
    entityType: "expense_claim", entityId: claimId, summary: `${claim.claim_no} submitted for approval`,
  });
  await notifyClaimEvent(db, claimId, "SUBMITTED", { actorName: user.name });
}

export async function withdrawClaim(db: Db, user: CurrentUser, claimId: string) {
  const claim = await one<{ claimant_user_id: string; status: string; claim_no: string }>(
    db, `SELECT claimant_user_id, status, claim_no FROM expense_claims WHERE id=$1`, [claimId],
  );
  if (!claim) throw new ExpenseError("Claim not found.");
  if (claim.claimant_user_id !== user.id && !can(user.role, "settings.manage", user.permissions)) {
    throw new ExpenseError("Only the claimant can withdraw this claim.");
  }
  if (!["SUBMITTED", "UNDER_REVIEW"].includes(claim.status)) {
    throw new ExpenseError("Only claims awaiting review can be withdrawn.");
  }
  await db.query(`UPDATE expense_claims SET status='WITHDRAWN' WHERE id=$1`, [claimId]);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "EXPENSE_WITHDRAWN",
    entityType: "expense_claim", entityId: claimId, summary: `${claim.claim_no} withdrawn by claimant`,
  });
}

export async function decideClaim(
  db: Db,
  user: CurrentUser,
  claimId: string,
  decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
  reason: string | null,
  ctx: { ip?: string | null } = {},
) {
  if (!can(user.role, "expense.approve", user.permissions) && !(await hasActiveDelegation(db, user.id))) {
    throw new ExpenseError("You cannot approve expenses.");
  }
  const claim = await one<{
    id: string; claim_no: string; claimant_user_id: string; status: string; amount_paisa: number;
    reimbursement_required: boolean; funding_source: string; advance_id: string | null;
    category_id: string; date_ad: string; event_id: string | null; committee_ref: string | null;
  }>(
    db,
    `SELECT id, claim_no, claimant_user_id, status, amount_paisa, reimbursement_required, funding_source,
            advance_id, category_id, to_char(date_ad,'YYYY-MM-DD') AS date_ad, event_id, committee_ref
       FROM expense_claims WHERE id=$1`,
    [claimId],
  );
  if (!claim) throw new ExpenseError("Claim not found.");
  if (claim.claimant_user_id === user.id) throw new ExpenseError("You cannot approve or reject your own claim.");
  if (!["SUBMITTED", "UNDER_REVIEW"].includes(claim.status)) throw new ExpenseError("This claim is not awaiting a decision.");
  if (decision === "REJECT" && !reason?.trim()) throw new ExpenseError("A rejection reason is required.");

  const settings = await getSettings(db);
  const tier = approvalTier(claim.amount_paisa, settings);

  if (decision === "REJECT") {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO approvals (id, claim_id, approver_user_id, decision, reason, tier) VALUES ($1,$2,$3,'REJECT',$4,$5)`,
        [randomUUID(), claimId, user.id, reason!.trim(), tier],
      );
      await tx.query(`UPDATE expense_claims SET status='REJECTED', rejected_reason=$2 WHERE id=$1`, [claimId, reason!.trim()]);
    });
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "EXPENSE_REJECTED",
      entityType: "expense_claim", entityId: claimId,
      summary: `${claim.claim_no} rejected: ${reason}`, ip: ctx.ip,
    });
    await notifyClaimEvent(db, claimId, "DECISION", { actorName: user.name });
    return { status: "REJECTED" };
  }

  if (decision === "REQUEST_CHANGES") {
    await db.query(
      `INSERT INTO approvals (id, claim_id, approver_user_id, decision, reason, tier) VALUES ($1,$2,$3,'REQUEST_CHANGES',$4,$5)`,
      [randomUUID(), claimId, user.id, reason ?? null, tier],
    );
    await db.query(`UPDATE expense_claims SET status='UNDER_REVIEW' WHERE id=$1`, [claimId]);
    await recordAudit(db, {
      actorUserId: user.id, actorName: user.name, action: "EXPENSE_CHANGES_REQUESTED",
      entityType: "expense_claim", entityId: claimId, summary: `${claim.claim_no}: changes requested`,
    });
    await notifyClaimEvent(db, claimId, "DECISION", { actorName: user.name });
    return { status: "UNDER_REVIEW" };
  }

  // Approve: enforce tier requirements.
  const approvals = await many<{ approver_user_id: string; role: string; decision: string }>(
    db,
    `SELECT ap.approver_user_id, u.role, ap.decision FROM approvals ap JOIN users u ON u.id = ap.approver_user_id
      WHERE ap.claim_id = $1 AND ap.decision = 'APPROVE'`,
    [claimId],
  );
  const existing = approvals.find((a) => a.approver_user_id === user.id);
  if (existing) throw new ExpenseError("You have already approved this claim.");

  const merged = [...approvals, { approver_user_id: user.id, role: user.role, decision: "APPROVE" }];
  const finance = merged.some((a) => ["FINANCE", "ADMIN"].includes(a.role));
  const executive = merged.some((a) => ["EXECUTIVE", "ADMIN"].includes(a.role));
  const total = merged.length;
  const committeeRef = claim.committee_ref?.trim();

  let complete = false;
  if (tier === "STANDARD") complete = total >= 1;
  else if (tier === "EXECUTIVE") complete = finance && executive && total >= 2;
  else complete = finance && executive && total >= 2 && Boolean(committeeRef);

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO approvals (id, claim_id, approver_user_id, decision, reason, tier, created_at)
       VALUES ($1,$2,$3,'APPROVE',$4,$5,now())`,
      [randomUUID(), claimId, user.id, reason ?? null, tier],
    );
    await tx.query(
      `UPDATE expense_claims SET status=$2, approved_at = CASE WHEN $2='APPROVED' THEN now() ELSE approved_at END WHERE id=$1`,
      [claimId, complete ? "APPROVED" : "UNDER_REVIEW"],
    );
    if (!complete) return;

    // Accrue the expense: Dr expense category, Cr member payable.
    const cat = await one<{ name: string; ledger_code: string }>(tx, `SELECT name, ledger_code FROM expense_categories WHERE id=$1`, [claim.category_id]);
    if (claim.advance_id) {
      await postJournal(tx, {
        date: claim.date_ad,
        memo: `${claim.claim_no} approved (advance-funded)`,
        sourceType: "EXPENSE_APPROVAL",
        sourceId: claim.id,
        createdBy: user.id,
        lines: [
          { accountCode: cat?.ledger_code ?? "5000", accountName: cat?.name ?? "Expense", debit: claim.amount_paisa },
          { accountCode: ACCOUNTS.ADVANCE.code, accountName: ACCOUNTS.ADVANCE.name, credit: claim.amount_paisa },
        ],
      });
      await tx.query(`UPDATE expense_claims SET status='SETTLED', paid_at=now() WHERE id=$1`, [claimId]);
      await refreshAdvanceStatus(tx, claim.advance_id);
    } else {
      // Personal funds create a member payable; organisation cash/bank claims go to a
      // clearing account until the payment is recorded, so the payable is never overstated.
      const credit = claim.reimbursement_required ? ACCOUNTS.MEMBER_PAYABLE : ACCOUNTS.CLEARING;
      await postJournal(tx, {
        date: claim.date_ad,
        memo: `${claim.claim_no} approved`,
        sourceType: "EXPENSE_APPROVAL",
        sourceId: claim.id,
        createdBy: user.id,
        lines: [
          { accountCode: cat?.ledger_code ?? "5000", accountName: cat?.name ?? "Expense", debit: claim.amount_paisa },
          { accountCode: credit.code, accountName: credit.name, credit: claim.amount_paisa },
        ],
      });
      await tx.query(`UPDATE expense_claims SET status='PAYMENT_PENDING' WHERE id=$1`, [claimId]);
    }
  });

  const final = await one<{ status: string }>(db, `SELECT status FROM expense_claims WHERE id=$1`, [claimId]);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name,
    action: complete ? "EXPENSE_APPROVED" : "EXPENSE_APPROVAL_RECORDED",
    entityType: "expense_claim", entityId: claimId,
    summary: complete
      ? `${claim.claim_no} fully approved (${tier.toLowerCase()} tier)`
      : `${claim.claim_no}: approval recorded; additional approval still required`,
    ip: ctx.ip,
  });
  await notifyClaimEvent(db, claimId, "DECISION", { actorName: user.name });
  return { status: final?.status ?? "UNDER_REVIEW", complete };
}

export async function recordClaimPayment(
  db: Db,
  user: CurrentUser,
  input: { claimId: string; accountId: string; amount: string; date: string; method?: string; reference?: string; notes?: string },
  ctx: { ip?: string | null } = {},
) {
  if (!can(user.role, "expense.pay", user.permissions)) throw new ExpenseError("You cannot record payments.");
  if (!isValidISODate(input.date)) throw new ExpenseError("Payment date is invalid.");
  const amount = parseMoney(input.amount);
  if (!amount.ok) throw new ExpenseError(amount.error);
  await assertDateOpen(db, input.date, "This payment date");

  const claim = await one<{
    id: string; claim_no: string; amount_paisa: number; status: string; funding_source: string;
    reimbursement_required: boolean; paid_by_member_id: string; date_ad: string; advance_id: string | null;
  }>(
    db,
    `SELECT id, claim_no, amount_paisa, status, funding_source, reimbursement_required, paid_by_member_id,
            to_char(date_ad,'YYYY-MM-DD') AS date_ad, advance_id FROM expense_claims WHERE id=$1`,
    [input.claimId],
  );
  if (!claim) throw new ExpenseError("Claim not found.");
  if (claim.advance_id) {
    throw new ExpenseError("This claim is settled through a cash advance. Record the advance return or a separate adjustment instead of a second cash payment.");
  }
  if (!["APPROVED", "PAYMENT_PENDING", "REIMBURSED", "VERIFIED"].includes(claim.status)) {
    throw new ExpenseError("Only approved claims can be paid.");
  }
  const account = await one<{ id: string; name: string; type: string }>(
    db, `SELECT id, name, type FROM financial_accounts WHERE id=$1 AND is_active=true`, [input.accountId],
  );
  if (!account) throw new ExpenseError("Select a valid payment account.");

  const paidRow = await one<{ paid: number }>(
    db,
    `SELECT COALESCE(SUM(amount_paisa),0) AS paid FROM payments
      WHERE claim_id=$1 AND status='RECORDED' AND reverses_payment_id IS NULL AND type IN ('REIMBURSEMENT','EXPENSE_PAYMENT')`,
    [claim.id],
  );
  const paid = money(paidRow?.paid);
  const remaining = claim.amount_paisa - paid;
  if (remaining <= 0) throw new ExpenseError("This claim is already fully paid.");
  if (amount.paisa > remaining) throw new ExpenseError(`Payment exceeds the outstanding balance of NPR ${(remaining / 100).toFixed(2)}.`);

  const type = claim.reimbursement_required ? "REIMBURSEMENT" : "EXPENSE_PAYMENT";
  const ref = await paymentNumber(db);
  const paymentId = randomUUID();
  const newPaid = paid + amount.paisa;
  const nextStatus = newPaid >= claim.amount_paisa
    ? (claim.reimbursement_required ? "REIMBURSED" : "SETTLED")
    : "PAYMENT_PENDING";

  await db.transaction(async (tx) => {
    await lockAndAssertFunds(tx, account.id, input.date, amount.paisa, account.name);
    await tx.query(
      `INSERT INTO payments (id, ref, type, direction, claim_id, account_id, counterparty_member_id, amount_paisa,
                             date_ad, method, reference, notes, created_by, status, is_synthetic)
       VALUES ($1,$2,$3,'OUT',$4,$5,$6,$7,$8,$9,$10,$11,$12,'RECORDED',$13)`,
      [
        paymentId, ref, type, claim.id, account.id, claim.paid_by_member_id, amount.paisa,
        input.date, input.method ?? null, input.reference ?? null, input.notes ?? null, user.id, user.isSynthetic,
      ],
    );
    const ledger = accountLedger(account.type);
    const debit = claim.reimbursement_required ? ACCOUNTS.MEMBER_PAYABLE : ACCOUNTS.CLEARING;
    const journalEntryId = await postJournal(tx, {
      date: input.date,
      memo: `${type === "REIMBURSEMENT" ? "Reimbursement" : "Expense payment"} ${claim.claim_no} from ${account.name}`,
      sourceType: "PAYMENT",
      sourceId: paymentId,
      createdBy: user.id,
      lines: [
        { accountCode: debit.code, accountName: debit.name, debit: amount.paisa },
        { accountCode: ledger.code, accountName: `${ledger.name} — ${account.name}`, credit: amount.paisa },
      ],
    });
    await tx.query(`UPDATE payments SET journal_entry_id=$2 WHERE id=$1`, [paymentId, journalEntryId]);
    await tx.query(`UPDATE expense_claims SET status=$2, paid_at=now() WHERE id=$1`, [claim.id, nextStatus]);
  });

  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "PAYMENT_RECORDED",
    entityType: "expense_claim", entityId: claim.id,
    summary: `${claim.claim_no}: ${type === "REIMBURSEMENT" ? "reimbursement" : "payment"} NPR ${(amount.paisa / 100).toFixed(2)} from ${account.name}`,
    after: { paymentId, amount_paisa: amount.paisa, status: nextStatus }, ip: ctx.ip,
  });
  await notifyClaimEvent(db, claim.id, "PAID", { paymentId, actorName: user.name });
  return { paymentId, status: nextStatus, paid: newPaid };
}

export async function verifyClaim(db: Db, user: CurrentUser, claimId: string, note?: string) {
  if (!can(user.role, "expense.verify", user.permissions)) throw new ExpenseError("You cannot verify claims.");
  const claim = await one<{ id: string; claim_no: string; claimant_user_id: string; status: string; documentation_state: string; verification_state: string }>(
    db, `SELECT id, claim_no, claimant_user_id, status, documentation_state, verification_state FROM expense_claims WHERE id=$1`, [claimId],
  );
  if (!claim) throw new ExpenseError("Claim not found.");
  if (claim.claimant_user_id === user.id) throw new ExpenseError("You cannot verify your own claim.");
  if (!["PAYMENT_PENDING", "REIMBURSED", "SETTLED", "APPROVED", "UNDER_REVIEW"].includes(claim.status)) {
    throw new ExpenseError("This claim cannot be verified in its current state.");
  }
  if (claim.documentation_state === "MISSING_UNDECLARED") {
    throw new ExpenseError("Evidence is missing and no declaration exists. Attach a receipt or record a declaration first.");
  }
  const nextStatus = ["REIMBURSED", "SETTLED"].includes(claim.status) ? "VERIFIED" : claim.status;
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE expense_claims SET verification_state='VERIFIED', verified_at=now(), status=$2 WHERE id=$1`,
      [claimId, nextStatus],
    );
    await tx.query(
      `INSERT INTO approvals (id, claim_id, approver_user_id, decision, reason, tier)
       VALUES ($1,$2,$3,'VERIFY',$4,'STANDARD')`,
      [randomUUID(), claimId, user.id, note ?? null],
    );
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "EXPENSE_VERIFIED",
    entityType: "expense_claim", entityId: claimId, summary: `${claim.claim_no} evidence verified`,
    after: { note: note ?? null },
  });
  await notifyClaimEvent(db, claimId, "VERIFIED", { actorName: user.name });
}

export async function flagDispute(db: Db, user: CurrentUser, claimId: string, reason: string) {
  if (!can(user.role, "expense.verify", user.permissions)) throw new ExpenseError("You cannot dispute claims.");
  if (!reason.trim()) throw new ExpenseError("A dispute reason is required.");
  await db.query(`UPDATE expense_claims SET verification_state='DISPUTED', notes=COALESCE(notes,'') || $2 WHERE id=$1`, [
    claimId, `\n[Disputed] ${reason}`,
  ]);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "EXPENSE_DISPUTED",
    entityType: "expense_claim", entityId: claimId, summary: `Claim disputed: ${reason}`,
  });
}

export async function refreshAdvanceStatus(db: Executor, advanceId: string) {
  const adv = await one<{ amount_paisa: number; status: string }>(db, `SELECT amount_paisa, status FROM advances WHERE id=$1`, [advanceId]);
  if (!adv || !["OUTSTANDING", "PARTIALLY_SETTLED", "SETTLED"].includes(adv.status)) return;
  const usedRow = await one<{ used: number }>(
    db,
    `SELECT COALESCE(SUM(amount_paisa),0) AS used FROM expense_claims
      WHERE advance_id=$1 AND status NOT IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','WITHDRAWN')`,
    [advanceId],
  );
  const returnsRow = await one<{ returned: number }>(
    db,
    `SELECT COALESCE(SUM(returned_paisa),0) AS returned FROM advance_settlements WHERE advance_id=$1`,
    [advanceId],
  );
  const used = money(usedRow?.used) + money(returnsRow?.returned);
  const status = used >= adv.amount_paisa ? "SETTLED" : used > 0 ? "PARTIALLY_SETTLED" : "OUTSTANDING";
  await db.query(`UPDATE advances SET status=$2 WHERE id=$1`, [advanceId, status]);
}

export function approvalRequirementLabel(amountPaisa: number, settings: Settings): string {
  const tier = approvalTier(amountPaisa, settings);
  const req = requiredApprovals(amountPaisa, settings);
  if (tier === "COMMITTEE") return "Finance + executive approval, plus committee resolution reference";
  if (tier === "EXECUTIVE") return `Finance approval + executive approval (${req.join(" + ")})`;
  return "One finance-team approval";
}
