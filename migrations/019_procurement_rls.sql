-- migration 019: RLS policies for procurement tables
-- procurement_invoices, procurement_lines, delivery_costs
-- Uses the same can_read / can_write helpers as other tables.

-- ── procurement_invoices ──────────────────────────────────────────────────────
ALTER TABLE procurement_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "procurement_invoices_select" ON procurement_invoices;
DROP POLICY IF EXISTS "procurement_invoices_insert" ON procurement_invoices;
DROP POLICY IF EXISTS "procurement_invoices_update" ON procurement_invoices;
DROP POLICY IF EXISTS "procurement_invoices_delete" ON procurement_invoices;

CREATE POLICY "procurement_invoices_select" ON procurement_invoices
  FOR SELECT USING (can_read(farm_id));

CREATE POLICY "procurement_invoices_insert" ON procurement_invoices
  FOR INSERT WITH CHECK (can_write(farm_id));

CREATE POLICY "procurement_invoices_update" ON procurement_invoices
  FOR UPDATE USING (can_write(farm_id));

CREATE POLICY "procurement_invoices_delete" ON procurement_invoices
  FOR DELETE USING (can_write(farm_id));

-- ── procurement_lines ─────────────────────────────────────────────────────────
ALTER TABLE procurement_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "procurement_lines_select" ON procurement_lines;
DROP POLICY IF EXISTS "procurement_lines_insert" ON procurement_lines;
DROP POLICY IF EXISTS "procurement_lines_update" ON procurement_lines;
DROP POLICY IF EXISTS "procurement_lines_delete" ON procurement_lines;

CREATE POLICY "procurement_lines_select" ON procurement_lines
  FOR SELECT USING (can_read(farm_id));

CREATE POLICY "procurement_lines_insert" ON procurement_lines
  FOR INSERT WITH CHECK (can_write(farm_id));

CREATE POLICY "procurement_lines_update" ON procurement_lines
  FOR UPDATE USING (can_write(farm_id));

CREATE POLICY "procurement_lines_delete" ON procurement_lines
  FOR DELETE USING (can_write(farm_id));

-- ── delivery_costs ────────────────────────────────────────────────────────────
ALTER TABLE delivery_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "delivery_costs_select" ON delivery_costs;
DROP POLICY IF EXISTS "delivery_costs_insert" ON delivery_costs;
DROP POLICY IF EXISTS "delivery_costs_update" ON delivery_costs;
DROP POLICY IF EXISTS "delivery_costs_delete" ON delivery_costs;

CREATE POLICY "delivery_costs_select" ON delivery_costs
  FOR SELECT USING (can_read(farm_id));

CREATE POLICY "delivery_costs_insert" ON delivery_costs
  FOR INSERT WITH CHECK (can_write(farm_id));

CREATE POLICY "delivery_costs_update" ON delivery_costs
  FOR UPDATE USING (can_write(farm_id));

CREATE POLICY "delivery_costs_delete" ON delivery_costs
  FOR DELETE USING (can_write(farm_id));
