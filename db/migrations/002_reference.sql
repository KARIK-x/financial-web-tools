-- Reference data. Idempotent: safe to apply once via the migration runner.
INSERT INTO organizations (id, name, legal_name, currency, fiscal_year_start_month, is_synthetic)
VALUES ('org_locus', 'LOCUS', 'LOCUS — IOE Pulchowk Campus', 'NPR', 4, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
  ('expense.submit', 'Submit and view own expense claims'),
  ('expense.view.all', 'View all expense claims'),
  ('expense.approve', 'Approve or reject expense claims'),
  ('expense.pay', 'Record payments and reimbursements'),
  ('expense.verify', 'Verify evidence and mark claims verified'),
  ('advance.manage', 'Create, disburse and settle advances'),
  ('document.upload', 'Upload documents'),
  ('document.view.all', 'View all documents'),
  ('document.review', 'Review OCR results and duplicate decisions'),
  ('sponsor.manage', 'Manage sponsors and sponsorship agreements'),
  ('budget.manage', 'Manage events, budgets and revisions'),
  ('account.manage', 'Manage financial accounts'),
  ('recon.manage', 'Import statements and reconcile accounts'),
  ('report.view', 'View financial reports'),
  ('export.run', 'Generate CSV/JSON exports'),
  ('audit.view', 'View the audit log'),
  ('settings.manage', 'Change organization settings and roles'),
  ('member.manage', 'Manage members and user accounts'),
  ('import.run', 'Run spreadsheet and document imports')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role, permission)
SELECT r.role, p.key FROM (VALUES
  ('ADMIN'),('FINANCE'),('EXECUTIVE'),('EVENT_HEAD'),('MEMBER'),('AUDITOR')
) AS r(role) CROSS JOIN permissions p
WHERE
  (r.role = 'ADMIN')
  OR (r.role = 'FINANCE' AND p.key NOT IN ('settings.manage'))
  OR (r.role = 'EXECUTIVE' AND p.key IN ('expense.submit','expense.view.all','expense.approve','report.view','audit.view','document.view.all'))
  OR (r.role = 'EVENT_HEAD' AND p.key IN ('expense.submit','expense.view.all','expense.approve','report.view','document.upload'))
  OR (r.role = 'MEMBER' AND p.key IN ('expense.submit','document.upload'))
  OR (r.role = 'AUDITOR' AND p.key IN ('expense.view.all','document.view.all','report.view','audit.view'))
ON CONFLICT DO NOTHING;

INSERT INTO expense_categories (id, code, name, group_name, ledger_code, requires_receipt, sort_order) VALUES
  ('cat_travel', 'TRAVEL', 'Travel & Transport', 'Programme', '5001', true, 10),
  ('cat_printing', 'PRINTING', 'Printing & Stationery', 'Operations', '5002', true, 20),
  ('cat_food', 'FOOD', 'Food & Refreshments', 'Programme', '5003', true, 30),
  ('cat_venue', 'VENUE', 'Venue & Logistics', 'Programme', '5004', true, 40),
  ('cat_equipment', 'EQUIPMENT', 'Equipment & Hardware', 'Assets', '5005', true, 50),
  ('cat_software', 'SOFTWARE', 'Software & Subscriptions', 'Operations', '5006', true, 60),
  ('cat_prizes', 'PRIZES', 'Prizes & Awards', 'Programme', '5007', true, 70),
  ('cat_marketing', 'MARKETING', 'Marketing & Design', 'Operations', '5008', true, 80),
  ('cat_services', 'SERVICES', 'Professional Services', 'Operations', '5009', true, 90),
  ('cat_utilities', 'UTILITIES', 'Utilities & Internet', 'Operations', '5010', true, 100),
  ('cat_bank', 'BANK', 'Bank Charges & Fees', 'Finance', '5011', false, 110),
  ('cat_other', 'OTHER', 'Miscellaneous', 'General', '5012', true, 120)
ON CONFLICT (id) DO NOTHING;

INSERT INTO financial_accounts (id, name, type, institution, opening_balance_paisa, notes)
VALUES ('acct_cash', 'Cash box', 'CASH', NULL, 0, 'Opening balance not yet verified. Set it in Settings → Accounts once counted.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('approval_thresholds', '{"standard":200000,"executive":2500000,"committee":10000000}'::jsonb),
  ('display', '{"numberGrouping":"lakh","dateCalendar":"AD","timezone":"Asia/Kathmandu"}'::jsonb),
  ('documentation', '{"missingReceiptRequiresDeclaration":true,"secondApprovalAbove":500000}'::jsonb),
  ('compliance', '{"pan":null,"vatRegistered":false,"legalStatus":"UNVERIFIED","note":"LOCUS legal/tax status is unverified. Do not treat tax fields as obligations until confirmed by a Nepali accountant."}'::jsonb),
  ('reconstruction', '{"baselineVersion":0}'::jsonb)
ON CONFLICT (key) DO NOTHING;
