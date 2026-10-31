-- Finance Tracker Platform — initial schema
-- Money is stored as BIGINT paisa (1 NPR = 100 paisa). Never floating point.
-- All timestamps are timestamptz. Business dates are DATE + explicit calendar.

CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  legal_name text,
  currency text NOT NULL DEFAULT 'NPR',
  fiscal_year_start_month int NOT NULL DEFAULT 4 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role text NOT NULL,
  permission text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role, permission)
);

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN','FINANCE','EXECUTIVE','EVENT_HEAD','MEMBER','AUDITOR')),
  member_id text,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  is_synthetic boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE sessions (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE members (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text,
  phone text,
  program text,
  batch text,
  role_title text,
  is_active boolean NOT NULL DEFAULT true,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX members_email_unique ON members (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX members_name_idx ON members (lower(name));

CREATE TABLE departments (
  id text PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  description text,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE events (
  id text PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  starts_on date,
  ends_on date,
  owner_member_id text REFERENCES members(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PLANNED','ACTIVE','COMPLETED','ARCHIVED')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false,
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE expense_categories (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  group_name text NOT NULL DEFAULT 'General',
  ledger_code text NOT NULL DEFAULT '5000',
  requires_receipt boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100
);

CREATE TABLE vendors (
  id text PRIMARY KEY,
  name text NOT NULL,
  normalized_name text NOT NULL,
  pan text,
  contact text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX vendors_normalized_unique ON vendors (normalized_name);

CREATE TABLE financial_accounts (
  id text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('CASH','BANK','WALLET')),
  institution text,
  identifier_masked text,
  opening_balance_paisa bigint NOT NULL DEFAULT 0,
  opened_on date,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false
);

CREATE TABLE document_batches (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('UPLOAD','ZIP_IMPORT','FOLDER_IMPORT','BANK_STATEMENT','SPREADSHEET','DEMO')),
  source_label text NOT NULL,
  notes text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  file_count int NOT NULL DEFAULT 0,
  is_synthetic boolean NOT NULL DEFAULT false
);

CREATE TABLE documents (
  id text PRIMARY KEY,
  batch_id text REFERENCES document_batches(id) ON DELETE SET NULL,
  sha256 text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key text NOT NULL,
  doc_type text NOT NULL DEFAULT 'UNKNOWN' CHECK (doc_type IN ('RECEIPT','INVOICE','BANK_STATEMENT','PAYMENT_CONFIRMATION','AGREEMENT','SPONSORSHIP','SPREADSHEET','OTHER','UNKNOWN')),
  status text NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED','QUEUED','PROCESSING','EXTRACTED','NEEDS_REVIEW','REVIEWED','FAILED','DUPLICATE')),
  uploaded_by text REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  duplicate_of text REFERENCES documents(id) ON DELETE SET NULL,
  duplicate_score numeric(5,4),
  perceptual_hash text,
  claim_id text,
  agreement_id text,
  statement_import_id text,
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_status text NOT NULL DEFAULT 'UNREVIEWED' CHECK (review_status IN ('UNREVIEWED','IN_REVIEW','ACCEPTED','CORRECTED','REJECTED')),
  reviewed_by text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  notes text,
  is_synthetic boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX documents_sha256_unique ON documents (sha256);
CREATE INDEX documents_status_idx ON documents (status, uploaded_at DESC);
CREATE INDEX documents_claim_idx ON documents (claim_id);

CREATE TABLE ocr_extractions (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  engine text NOT NULL,
  engine_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  raw_text text,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  duration_ms int,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ocr_document_idx ON ocr_extractions (document_id, started_at DESC);

CREATE TABLE advances (
  id text PRIMARY KEY,
  ref text NOT NULL UNIQUE,
  member_id text NOT NULL REFERENCES members(id),
  requester_user_id text REFERENCES users(id) ON DELETE SET NULL,
  event_id text REFERENCES events(id) ON DELETE SET NULL,
  purpose text NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  disbursed_on date,
  due_on date,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','OUTSTANDING','PARTIALLY_SETTLED','SETTLED','WRITTEN_OFF','REJECTED')),
  notes text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false,
  CHECK (due_on IS NULL OR disbursed_on IS NULL OR due_on >= disbursed_on)
);

CREATE TABLE expense_claims (
  id text PRIMARY KEY,
  claim_no text NOT NULL UNIQUE,
  claimant_user_id text NOT NULL REFERENCES users(id),
  paid_by_member_id text NOT NULL REFERENCES members(id),
  date_ad date NOT NULL,
  date_bs text,
  calendar text NOT NULL DEFAULT 'AD' CHECK (calendar IN ('AD','BS')),
  vendor_id text REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name_raw text,
  category_id text NOT NULL REFERENCES expense_categories(id),
  event_id text REFERENCES events(id) ON DELETE SET NULL,
  department_id text REFERENCES departments(id) ON DELETE SET NULL,
  advance_id text REFERENCES advances(id) ON DELETE SET NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  currency text NOT NULL DEFAULT 'NPR',
  original_currency text,
  original_amount_paisa bigint,
  fx_rate numeric(14,6),
  description text NOT NULL,
  business_purpose text,
  funding_source text NOT NULL CHECK (funding_source IN ('PERSONAL','FINANCE_TRACKER_CASH','FINANCE_TRACKER_BANK')),
  payment_method text,
  reimbursement_required boolean NOT NULL DEFAULT false,
  receipt_required boolean NOT NULL DEFAULT true,
  missing_receipt_declaration text,
  invoice_no text,
  seller_pan text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED','WITHDRAWN','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED','DISPUTED')),
  verification_state text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_state IN ('UNVERIFIED','VERIFIED','DISPUTED')),
  documentation_state text NOT NULL DEFAULT 'MISSING_UNDECLARED' CHECK (documentation_state IN ('COMPLETE','MISSING_DECLARED','MISSING_UNDECLARED')),
  source_type text NOT NULL DEFAULT 'LIVE' CHECK (source_type IN ('LIVE','HISTORICAL_IMPORT','OCR_CANDIDATE')),
  rejected_reason text,
  submitted_at timestamptz,
  approved_at timestamptz,
  paid_at timestamptz,
  verified_at timestamptz,
  notes text,
  correction_of text REFERENCES expense_claims(id) ON DELETE SET NULL,
  committee_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  is_synthetic boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX claims_claimant_idx ON expense_claims (claimant_user_id, status);
CREATE INDEX claims_status_idx ON expense_claims (status, submitted_at DESC);
CREATE INDEX claims_date_idx ON expense_claims (date_ad DESC);
CREATE INDEX claims_event_idx ON expense_claims (event_id);
CREATE INDEX claims_category_idx ON expense_claims (category_id);
CREATE INDEX claims_paid_by_idx ON expense_claims (paid_by_member_id);
CREATE INDEX claims_advance_idx ON expense_claims (advance_id);

CREATE TABLE expense_allocations (
  id text PRIMARY KEY,
  claim_id text NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id) ON DELETE SET NULL,
  department_id text REFERENCES departments(id) ON DELETE SET NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id IS NOT NULL OR department_id IS NOT NULL OR true)
);
CREATE INDEX allocations_claim_idx ON expense_allocations (claim_id);
CREATE INDEX allocations_event_idx ON expense_allocations (event_id);
CREATE INDEX allocations_dept_idx ON expense_allocations (department_id);

CREATE TABLE approvals (
  id text PRIMARY KEY,
  claim_id text NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  approver_user_id text NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT','REQUEST_CHANGES','VERIFY')),
  reason text,
  tier text NOT NULL DEFAULT 'STANDARD' CHECK (tier IN ('STANDARD','EXECUTIVE','COMMITTEE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'REJECT' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);
CREATE UNIQUE INDEX approvals_unique_decision ON approvals (claim_id, approver_user_id, decision);
CREATE INDEX approvals_claim_idx ON approvals (claim_id, created_at);

CREATE TABLE payments (
  id text PRIMARY KEY,
  ref text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('EXPENSE_PAYMENT','REIMBURSEMENT','ADVANCE_DISBURSEMENT','ADVANCE_RETURN','SPONSOR_RECEIPT','OTHER_INCOME','TRANSFER','BANK_FEE','ADJUSTMENT')),
  direction text NOT NULL CHECK (direction IN ('IN','OUT')),
  claim_id text REFERENCES expense_claims(id) ON DELETE SET NULL,
  advance_id text REFERENCES advances(id) ON DELETE SET NULL,
  agreement_id text,
  account_id text REFERENCES financial_accounts(id) ON DELETE SET NULL,
  from_account_id text REFERENCES financial_accounts(id) ON DELETE SET NULL,
  to_account_id text REFERENCES financial_accounts(id) ON DELETE SET NULL,
  counterparty_member_id text REFERENCES members(id) ON DELETE SET NULL,
  payee_name text,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  date_ad date NOT NULL,
  method text,
  reference text,
  notes text,
  status text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','VOID')),
  reverses_payment_id text REFERENCES payments(id) ON DELETE SET NULL,
  journal_entry_id text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false,
  CHECK (type <> 'TRANSFER' OR (from_account_id IS NOT NULL AND to_account_id IS NOT NULL AND from_account_id <> to_account_id))
);
CREATE INDEX payments_claim_idx ON payments (claim_id);
CREATE INDEX payments_account_idx ON payments (account_id, date_ad);
CREATE INDEX payments_advance_idx ON payments (advance_id);
CREATE INDEX payments_agreement_idx ON payments (agreement_id);
CREATE INDEX payments_date_idx ON payments (date_ad DESC);

CREATE TABLE advance_settlements (
  id text PRIMARY KEY,
  advance_id text NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
  claim_id text REFERENCES expense_claims(id) ON DELETE SET NULL,
  returned_paisa bigint NOT NULL DEFAULT 0 CHECK (returned_paisa >= 0),
  settled_paisa bigint NOT NULL DEFAULT 0 CHECK (settled_paisa >= 0),
  settled_on date NOT NULL,
  notes text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (returned_paisa > 0 OR settled_paisa > 0 OR claim_id IS NOT NULL)
);
CREATE INDEX settlements_advance_idx ON advance_settlements (advance_id);

CREATE TABLE sponsors (
  id text PRIMARY KEY,
  name text NOT NULL,
  normalized_name text NOT NULL,
  sector text,
  website text,
  contact_name text,
  email text,
  phone text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX sponsors_normalized_unique ON sponsors (normalized_name);

CREATE TABLE sponsorship_agreements (
  id text PRIMARY KEY,
  ref text NOT NULL UNIQUE,
  sponsor_id text NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  title text NOT NULL,
  package_tier text,
  state text NOT NULL DEFAULT 'LEAD' CHECK (state IN ('LEAD','PROPOSED','NEGOTIATING','COMMITTED','INVOICED','PARTIALLY_RECEIVED','RECEIVED','DELIVERABLES_PENDING','CLOSED','DECLINED')),
  promised_paisa bigint NOT NULL DEFAULT 0 CHECK (promised_paisa >= 0),
  invoiced_paisa bigint NOT NULL DEFAULT 0 CHECK (invoiced_paisa >= 0),
  in_kind boolean NOT NULL DEFAULT false,
  in_kind_description text,
  in_kind_value_paisa bigint,
  event_id text REFERENCES events(id) ON DELETE SET NULL,
  earmark_note text,
  signed_on date,
  notes text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false,
  CHECK (in_kind = false OR in_kind_description IS NOT NULL),
  CHECK (promised_paisa > 0 OR in_kind = true)
);
CREATE INDEX agreements_sponsor_idx ON sponsorship_agreements (sponsor_id);
CREATE INDEX agreements_state_idx ON sponsorship_agreements (state);

CREATE TABLE sponsor_deliverables (
  id text PRIMARY KEY,
  agreement_id text NOT NULL REFERENCES sponsorship_agreements(id) ON DELETE CASCADE,
  description text NOT NULL,
  due_on date,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','WAIVED')),
  completed_at timestamptz,
  notes text
);

CREATE TABLE budgets (
  id text PRIMARY KEY,
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('ORG','EVENT','DEPARTMENT')),
  event_id text REFERENCES events(id) ON DELETE CASCADE,
  department_id text REFERENCES departments(id) ON DELETE CASCADE,
  fiscal_year text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','CLOSED')),
  notes text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_synthetic boolean NOT NULL DEFAULT false,
  CHECK (scope <> 'EVENT' OR event_id IS NOT NULL),
  CHECK (scope <> 'DEPARTMENT' OR department_id IS NOT NULL)
);
CREATE UNIQUE INDEX budgets_scope_unique ON budgets (scope, coalesce(event_id,''), coalesce(department_id,''), fiscal_year);

CREATE TABLE budget_lines (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id text NOT NULL REFERENCES expense_categories(id),
  amount_paisa bigint NOT NULL CHECK (amount_paisa >= 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, category_id)
);

CREATE TABLE budget_revisions (
  id text PRIMARY KEY,
  budget_line_id text NOT NULL REFERENCES budget_lines(id) ON DELETE CASCADE,
  old_paisa bigint NOT NULL,
  new_paisa bigint NOT NULL,
  reason text NOT NULL,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE statement_imports (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  document_id text REFERENCES documents(id) ON DELETE SET NULL,
  source_label text NOT NULL,
  period_start date,
  period_end date,
  opening_balance_paisa bigint,
  closing_balance_paisa bigint,
  status text NOT NULL DEFAULT 'IMPORTED' CHECK (status IN ('IMPORTED','PARTIALLY_MATCHED','MATCHED','RECONCILED')),
  imported_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_statement_lines (
  id text PRIMARY KEY,
  statement_import_id text NOT NULL REFERENCES statement_imports(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  txn_date date NOT NULL,
  description text NOT NULL,
  debit_paisa bigint NOT NULL DEFAULT 0 CHECK (debit_paisa >= 0),
  credit_paisa bigint NOT NULL DEFAULT 0 CHECK (credit_paisa >= 0),
  balance_paisa bigint,
  external_ref text,
  fingerprint text NOT NULL UNIQUE,
  match_status text NOT NULL DEFAULT 'UNMATCHED' CHECK (match_status IN ('UNMATCHED','SUGGESTED','MATCHED','IGNORED')),
  matched_payment_id text REFERENCES payments(id) ON DELETE SET NULL,
  match_confidence numeric(5,4),
  notes text,
  CHECK (debit_paisa > 0 OR credit_paisa > 0)
);
CREATE INDEX bank_lines_account_idx ON bank_statement_lines (account_id, txn_date DESC);
CREATE INDEX bank_lines_status_idx ON bank_statement_lines (match_status);

CREATE TABLE reconciliations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  statement_import_id text REFERENCES statement_imports(id) ON DELETE SET NULL,
  computed_balance_paisa bigint NOT NULL,
  statement_balance_paisa bigint,
  difference_paisa bigint,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RECONCILED','DISPUTED')),
  notes text,
  reconciled_by text REFERENCES users(id) ON DELETE SET NULL,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE TABLE import_batches (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('SPONSORSHIP','EXPENSES','BANK_STATEMENT','DOCUMENTS','OTHER')),
  filename text NOT NULL,
  sha256 text,
  status text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','COMMITTED','FAILED','ABANDONED')),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE TABLE import_rows (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no int NOT NULL,
  raw jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('VALID','INVALID','IMPORTED','SKIPPED','DUPLICATE')),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  entity_type text,
  entity_id text,
  UNIQUE (batch_id, row_no)
);

CREATE TABLE journal_entries (
  id text PRIMARY KEY,
  entry_no text NOT NULL UNIQUE,
  entry_date date NOT NULL,
  memo text NOT NULL,
  source_type text NOT NULL,
  source_id text,
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT','POSTED','REVERSED')),
  reverses_id text REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_date_idx ON journal_entries (entry_date DESC);

CREATE TABLE journal_lines (
  id text PRIMARY KEY,
  entry_id text NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code text NOT NULL,
  account_name text NOT NULL,
  debit_paisa bigint NOT NULL DEFAULT 0 CHECK (debit_paisa >= 0),
  credit_paisa bigint NOT NULL DEFAULT 0 CHECK (credit_paisa >= 0),
  memo text,
  CHECK ((debit_paisa > 0 AND credit_paisa = 0) OR (credit_paisa > 0 AND debit_paisa = 0))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  actor_name text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  summary text NOT NULL,
  before jsonb,
  after jsonb,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX audit_actor_idx ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_created_idx ON audit_events (created_at DESC);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE OR REPLACE FUNCTION prevent_self_approval() RETURNS trigger AS $$
DECLARE claimant text;
BEGIN
  SELECT claimant_user_id INTO claimant FROM expense_claims WHERE id = NEW.claim_id;
  IF claimant = NEW.approver_user_id THEN
    RAISE EXCEPTION 'A claimant cannot approve or verify their own claim';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approvals_no_self BEFORE INSERT ON approvals
  FOR EACH ROW EXECUTE FUNCTION prevent_self_approval();

CREATE OR REPLACE FUNCTION protect_finalized_claim() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('APPROVED','PAYMENT_PENDING','REIMBURSED','SETTLED','VERIFIED','RECONCILED') THEN
    IF NEW.amount_paisa <> OLD.amount_paisa
       OR NEW.currency <> OLD.currency
       OR NEW.claimant_user_id <> OLD.claimant_user_id
       OR NEW.paid_by_member_id <> OLD.paid_by_member_id
       OR NEW.date_ad <> OLD.date_ad
       OR NEW.category_id <> OLD.category_id
       OR NEW.funding_source <> OLD.funding_source THEN
      RAISE EXCEPTION 'Finalized financial fields cannot be edited. Create a correction record instead.';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_protect_finalized BEFORE UPDATE ON expense_claims
  FOR EACH ROW EXECUTE FUNCTION protect_finalized_claim();

CREATE OR REPLACE FUNCTION claims_require_allocations() RETURNS trigger AS $$
DECLARE total bigint; cnt int;
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    SELECT COALESCE(SUM(amount_paisa),0), COUNT(*) INTO total, cnt FROM expense_allocations WHERE claim_id = NEW.id;
    IF cnt = 0 THEN
      RAISE EXCEPTION 'A submitted claim must have at least one allocation line';
    END IF;
    IF total <> NEW.amount_paisa THEN
      RAISE EXCEPTION 'Allocations (%) must equal the claim amount (%)', total, NEW.amount_paisa;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_allocations_required BEFORE UPDATE OF status ON expense_claims
  FOR EACH ROW EXECUTE FUNCTION claims_require_allocations();

CREATE OR REPLACE FUNCTION claims_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Expense claims cannot be deleted; withdraw or correct them instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER claims_no_delete BEFORE DELETE ON expense_claims
  FOR EACH ROW EXECUTE FUNCTION claims_no_delete();

CREATE OR REPLACE FUNCTION allocations_balance() RETURNS trigger AS $$
DECLARE claim_amount bigint; alloc_total bigint; target text;
BEGIN
  target := COALESCE(NEW.claim_id, OLD.claim_id);
  SELECT amount_paisa INTO claim_amount FROM expense_claims WHERE id = target;
  SELECT COALESCE(SUM(amount_paisa),0) INTO alloc_total FROM expense_allocations WHERE claim_id = target;
  IF claim_amount IS NOT NULL AND alloc_total <> 0 AND alloc_total <> claim_amount THEN
    RAISE EXCEPTION 'Allocation total (%) must equal claim amount (%)', alloc_total, claim_amount;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER allocations_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON expense_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION allocations_balance();

CREATE OR REPLACE FUNCTION journal_must_balance() RETURNS trigger AS $$
DECLARE dr bigint; cr bigint;
BEGIN
  IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(debit_paisa),0), COALESCE(SUM(credit_paisa),0)
    INTO dr, cr FROM journal_lines WHERE entry_id = NEW.id;
  IF dr <> cr THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: debits % / credits %', NEW.entry_no, dr, cr;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_must_balance();

CREATE OR REPLACE FUNCTION journal_lines_guard() RETURNS trigger AS $$
DECLARE entry_status text;
BEGIN
  SELECT status INTO entry_status FROM journal_entries WHERE id = NEW.entry_id;
  IF entry_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Posted journal entries are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_lines_immutable BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard();

CREATE OR REPLACE FUNCTION payment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payments cannot be deleted; void and replace them';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'RECORDED' AND NEW.amount_paisa <> OLD.amount_paisa THEN
    RAISE EXCEPTION 'Recorded payment amounts cannot be changed; record a reversal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payment_guard();

CREATE OR REPLACE FUNCTION document_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Documents cannot be deleted; supersede them instead';
  END IF;
  IF NEW.sha256 <> OLD.sha256 OR NEW.storage_key <> OLD.storage_key THEN
    RAISE EXCEPTION 'Original document bytes are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER documents_immutable BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION document_guard();

CREATE OR REPLACE FUNCTION bank_line_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.fingerprint <> OLD.fingerprint OR NEW.debit_paisa <> OLD.debit_paisa OR NEW.credit_paisa <> OLD.credit_paisa THEN
    RAISE EXCEPTION 'Imported statement lines are immutable apart from matching fields';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bank_lines_guard BEFORE UPDATE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION bank_line_guard();

CREATE OR REPLACE FUNCTION agent_claim_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status IN ('REJECTED','WITHDRAWN','RECONCILED') THEN
      RAISE EXCEPTION 'Cannot transition out of terminal state %', OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER claims_terminal_state BEFORE UPDATE ON expense_claims
  FOR EACH ROW EXECUTE FUNCTION agent_claim_transition();

CREATE SEQUENCE claim_seq START 1;
CREATE SEQUENCE payment_seq START 1;
CREATE SEQUENCE advance_seq START 1;
CREATE SEQUENCE agreement_seq START 1;
CREATE SEQUENCE journal_seq START 1;
