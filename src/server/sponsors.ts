import { randomUUID } from "node:crypto";
import { z } from "zod";
import { many, money, one, type Db } from "./db";
import { recordAudit } from "./audit";
import { ACCOUNTS, accountLedger, agreementNumber, paymentNumber, postJournal } from "./journal";
import { parseMoney } from "@/lib/money";
import { isValidISODate } from "@/lib/nepali-date";
import type { CurrentUser } from "./auth";
import { can } from "@/lib/permissions";
import { ExpenseError } from "./expenses";

export const AGREEMENT_STATES = [
  "LEAD", "PROPOSED", "NEGOTIATING", "COMMITTED", "INVOICED", "PARTIALLY_RECEIVED",
  "RECEIVED", "DELIVERABLES_PENDING", "CLOSED", "DECLINED",
] as const;

export type AgreementRow = {
  id: string;
  ref: string;
  sponsor_id: string;
  sponsor_name: string;
  title: string;
  package_tier: string | null;
  state: string;
  promised_paisa: number;
  invoiced_paisa: number;
  received_paisa: number;
  outstanding_paisa: number;
  in_kind: boolean;
  in_kind_value_paisa: number | null;
  in_kind_description: string | null;
  event_id: string | null;
  event_name: string | null;
  earmark_note: string | null;
  signed_on: string | null;
  is_synthetic: boolean;
  pending_deliverables: number;
};

export async function listAgreements(db: Db, filters: { state?: string; sponsorId?: string; eventId?: string } = {}): Promise<AgreementRow[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (filters.state) { params.push(filters.state); clauses.push(`a.state = $${params.length}`); }
  if (filters.sponsorId) { params.push(filters.sponsorId); clauses.push(`a.sponsor_id = $${params.length}`); }
  if (filters.eventId) { params.push(filters.eventId); clauses.push(`a.event_id = $${params.length}`); }
  return many<AgreementRow>(
    db,
    `SELECT a.id, a.ref, a.sponsor_id, s.name AS sponsor_name, a.title, a.package_tier, a.state,
            a.promised_paisa, a.invoiced_paisa, a.in_kind, a.in_kind_value_paisa, a.in_kind_description,
            a.event_id, e.name AS event_name, a.earmark_note, to_char(a.signed_on,'YYYY-MM-DD') AS signed_on,
            a.is_synthetic,
            COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.agreement_id=a.id AND p.type='SPONSOR_RECEIPT' AND p.status='RECORDED'),0) AS received_paisa,
            GREATEST(0, a.promised_paisa - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.agreement_id=a.id AND p.type='SPONSOR_RECEIPT' AND p.status='RECORDED'),0)) AS outstanding_paisa,
            (SELECT COUNT(*)::int FROM sponsor_deliverables d WHERE d.agreement_id=a.id AND d.status='PENDING') AS pending_deliverables
       FROM sponsorship_agreements a JOIN sponsors s ON s.id=a.sponsor_id
       LEFT JOIN events e ON e.id=a.event_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC`,
    params,
  );
}

export async function getAgreement(db: Db, id: string) {
  const row = (await listAgreements(db)).find((a) => a.id === id);
  if (!row) return null;
  const [receipts, deliverables, documents] = await Promise.all([
    many<{ id: string; ref: string; amount_paisa: number; date_ad: string; method: string | null; reference: string | null; account_name: string | null; status: string }>(
      db,
      `SELECT p.id, p.ref, p.amount_paisa, to_char(p.date_ad,'YYYY-MM-DD') AS date_ad, p.method, p.reference,
              fa.name AS account_name, p.status
         FROM payments p LEFT JOIN financial_accounts fa ON fa.id=p.account_id
        WHERE p.agreement_id=$1 ORDER BY p.date_ad`,
      [id],
    ),
    many<{ id: string; description: string; due_on: string | null; status: string }>(
      db,
      `SELECT id, description, to_char(due_on,'YYYY-MM-DD') AS due_on, status FROM sponsor_deliverables WHERE agreement_id=$1 ORDER BY due_on NULLS LAST`,
      [id],
    ),
    many<{ id: string; filename: string; doc_type: string; uploaded_at: Date }>(
      db, `SELECT id, filename, doc_type, uploaded_at FROM documents WHERE agreement_id=$1 ORDER BY uploaded_at DESC`, [id],
    ),
  ]);
  return { ...row, receipts, deliverables, documents };
}

export async function createSponsorship(
  db: Db, user: CurrentUser,
  raw: {
    sponsorName: string; title: string; packageTier?: string; state: string;
    promised: string; inKind: boolean; inKindDescription?: string; inKindValue?: string;
    eventId?: string; earmarkNote?: string; signedOn?: string; contactName?: string; email?: string; phone?: string;
    deliverables?: string;
  },
) {
  if (!can(user.role, "sponsor.manage", user.permissions)) throw new ExpenseError("You cannot manage sponsorships.");
  if (!raw.sponsorName.trim() || !raw.title.trim()) throw new ExpenseError("Sponsor and agreement title are required.");
  if (!AGREEMENT_STATES.includes(raw.state as (typeof AGREEMENT_STATES)[number])) throw new ExpenseError("Invalid sponsorship state.");
  if (raw.signedOn && !isValidISODate(raw.signedOn)) throw new ExpenseError("Signature date is invalid.");
  const promised = raw.inKind ? { ok: true as const, paisa: 0 } : parseMoney(raw.promised);
  if (!promised.ok) throw new ExpenseError(promised.error);
  if (!raw.inKind && promised.paisa <= 0) throw new ExpenseError("A cash commitment needs a positive amount. Use an in-kind record for non-cash support.");
  if (raw.inKind && !raw.inKindDescription?.trim()) throw new ExpenseError("Describe the in-kind contribution.");

  const normalized = raw.sponsorName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let sponsor = await one<{ id: string }>(db, `SELECT id FROM sponsors WHERE normalized_name=$1`, [normalized]);
  if (!sponsor) {
    const sponsorId = randomUUID();
    await db.query(
      `INSERT INTO sponsors (id, name, normalized_name, contact_name, email, phone, is_synthetic) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sponsorId, raw.sponsorName.trim(), normalized, raw.contactName ?? null, raw.email ?? null, raw.phone ?? null, user.isSynthetic],
    );
    sponsor = { id: sponsorId };
  }
  const ref = await agreementNumber(db);
  const id = randomUUID();
  const inKindValue = raw.inKind && raw.inKindValue ? parseMoney(raw.inKindValue) : null;
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO sponsorship_agreements
        (id, ref, sponsor_id, title, package_tier, state, promised_paisa, in_kind, in_kind_description,
         in_kind_value_paisa, event_id, earmark_note, signed_on, created_by, is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, ref, sponsor.id, raw.title.trim(), raw.packageTier ?? null, raw.state, promised.paisa,
        raw.inKind, raw.inKindDescription ?? null, inKindValue?.ok ? inKindValue.paisa : null,
        raw.eventId ?? null, raw.earmarkNote ?? null, raw.signedOn ?? null, user.id, user.isSynthetic,
      ],
    );
    if (raw.deliverables?.trim()) {
      for (const line of raw.deliverables.split("\n").map((l) => l.trim()).filter(Boolean)) {
        await tx.query(
          `INSERT INTO sponsor_deliverables (id, agreement_id, description) VALUES ($1,$2,$3)`,
          [randomUUID(), id, line.slice(0, 300)],
        );
      }
    }
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "SPONSORSHIP_CREATED",
    entityType: "sponsorship_agreement", entityId: id,
    summary: `${ref} — ${raw.sponsorName} — ${raw.state}${raw.inKind ? " (in-kind)" : ` — NPR ${(promised.paisa / 100).toFixed(2)}`}`,
    after: { promised_paisa: promised.paisa, state: raw.state, in_kind: raw.inKind },
  });
  return { id, ref };
}

export async function recordSponsorReceipt(
  db: Db, user: CurrentUser,
  input: { agreementId: string; accountId: string; amount: string; date: string; method?: string; reference?: string; notes?: string },
) {
  if (!can(user.role, "sponsor.manage", user.permissions)) throw new ExpenseError("You cannot record sponsor receipts.");
  const amount = parseMoney(input.amount);
  if (!amount.ok) throw new ExpenseError(amount.error);
  if (!isValidISODate(input.date)) throw new ExpenseError("Receipt date is invalid.");
  const agreement = await one<{
    id: string; ref: string; state: string; in_kind: boolean; promised_paisa: number; sponsor_name: string;
  }>(
    db,
    `SELECT a.id, a.ref, a.state, a.in_kind, a.promised_paisa, s.name AS sponsor_name
       FROM sponsorship_agreements a JOIN sponsors s ON s.id=a.sponsor_id WHERE a.id=$1`,
    [input.agreementId],
  );
  if (!agreement) throw new ExpenseError("Sponsorship agreement not found.");
  if (agreement.in_kind) throw new ExpenseError("In-kind sponsorship cannot be recorded as cash received.");
  const account = await one<{ id: string; name: string; type: string }>(db, `SELECT id, name, type FROM financial_accounts WHERE id=$1`, [input.accountId]);
  if (!account) throw new ExpenseError("Select a valid account.");

  const paymentId = randomUUID();
  const ref = await paymentNumber(db);
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO payments (id, ref, type, direction, agreement_id, account_id, payee_name, amount_paisa,
                             date_ad, method, reference, notes, created_by, status, is_synthetic)
       VALUES ($1,$2,'SPONSOR_RECEIPT','IN',$3,$4,$5,$6,$7,$8,$9,$10,$11,'RECORDED',$12)`,
      [
        paymentId, ref, agreement.id, account.id, agreement.sponsor_name, amount.paisa,
        input.date, input.method ?? null, input.reference ?? null, input.notes ?? null, user.id, user.isSynthetic,
      ],
    );
    const ledger = accountLedger(account.type);
    await postJournal(tx, {
      date: input.date,
      memo: `Sponsorship receipt ${agreement.ref} — ${agreement.sponsor_name}`,
      sourceType: "SPONSOR_RECEIPT",
      sourceId: paymentId,
      createdBy: user.id,
      lines: [
        { accountCode: ledger.code, accountName: `${ledger.name} — ${account.name}`, debit: amount.paisa },
        { accountCode: ACCOUNTS.SPONSOR_INCOME.code, accountName: ACCOUNTS.SPONSOR_INCOME.name, credit: amount.paisa },
      ],
    });
    const receivedRow = await tx.query<{ received: number }>(
      `SELECT COALESCE(SUM(amount_paisa),0) AS received FROM payments
        WHERE agreement_id=$1 AND type='SPONSOR_RECEIPT' AND status='RECORDED'`,
      [agreement.id],
    );
    const received = money(receivedRow.rows[0]?.received);
    const nextState = received >= agreement.promised_paisa && agreement.promised_paisa > 0 ? "RECEIVED" : "PARTIALLY_RECEIVED";
    if (!["CLOSED", "DELIVERABLES_PENDING"].includes(agreement.state)) {
      await tx.query(`UPDATE sponsorship_agreements SET state=$2 WHERE id=$1`, [agreement.id, nextState]);
    }
  });
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "SPONSOR_RECEIPT_RECORDED",
    entityType: "sponsorship_agreement", entityId: agreement.id,
    summary: `${agreement.ref}: NPR ${(amount.paisa / 100).toFixed(2)} received from ${agreement.sponsor_name}`,
    after: { amount_paisa: amount.paisa },
  });
  return { paymentId, ref };
}

export async function updateAgreementState(db: Db, user: CurrentUser, agreementId: string, state: string) {
  if (!can(user.role, "sponsor.manage", user.permissions)) throw new ExpenseError("You cannot manage sponsorships.");
  if (!AGREEMENT_STATES.includes(state as (typeof AGREEMENT_STATES)[number])) throw new ExpenseError("Invalid state.");
  const before = await one<{ state: string; ref: string }>(db, `SELECT state, ref FROM sponsorship_agreements WHERE id=$1`, [agreementId]);
  if (!before) throw new ExpenseError("Agreement not found.");
  await db.query(`UPDATE sponsorship_agreements SET state=$2 WHERE id=$1`, [agreementId, state]);
  await recordAudit(db, {
    actorUserId: user.id, actorName: user.name, action: "SPONSORSHIP_STATE_CHANGED",
    entityType: "sponsorship_agreement", entityId: agreementId,
    summary: `${before.ref}: ${before.state} → ${state}`, before: { state: before.state }, after: { state },
  });
}

export async function sponsorshipSummary(db: Db) {
  const row = await one<{
    committed_paisa: number; received_paisa: number; outstanding_paisa: number; in_kind_count: number;
    pipeline_count: number; active_count: number;
  }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN in_kind=false AND state NOT IN ('LEAD','PROPOSED','NEGOTIATING','DECLINED') THEN promised_paisa ELSE 0 END),0) AS committed_paisa,
       COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.type='SPONSOR_RECEIPT' AND p.status='RECORDED'),0) AS received_paisa,
       COALESCE(SUM(CASE WHEN in_kind=false AND state NOT IN ('LEAD','PROPOSED','NEGOTIATING','DECLINED') THEN promised_paisa ELSE 0 END),0)
         - COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.type='SPONSOR_RECEIPT' AND p.status='RECORDED'),0) AS outstanding_paisa,
       COUNT(*) FILTER (WHERE in_kind)::int AS in_kind_count,
       COUNT(*) FILTER (WHERE state IN ('LEAD','PROPOSED','NEGOTIATING'))::int AS pipeline_count,
       COUNT(*) FILTER (WHERE state IN ('COMMITTED','INVOICED','PARTIALLY_RECEIVED','RECEIVED','DELIVERABLES_PENDING'))::int AS active_count
     FROM sponsorship_agreements`,
  );
  return {
    committed: money(row?.committed_paisa),
    received: money(row?.received_paisa),
    outstanding: Math.max(0, money(row?.outstanding_paisa)),
    inKindCount: row?.in_kind_count ?? 0,
    pipelineCount: row?.pipeline_count ?? 0,
    activeCount: row?.active_count ?? 0,
  };
}
