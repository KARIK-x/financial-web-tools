CREATE TABLE IF NOT EXISTS expense_items (
  id text PRIMARY KEY,
  claim_id text NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(12,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit text,
  unit_price_paisa bigint NOT NULL CHECK (unit_price_paisa >= 0),
  discount_paisa bigint NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  tax_paisa bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  line_total_paisa bigint NOT NULL CHECK (line_total_paisa >= 0),
  category_id text REFERENCES expense_categories(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expense_items_claim_idx ON expense_items (claim_id);
