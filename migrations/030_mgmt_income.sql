-- Migration 030: Management Report Income
-- Provides the income layer for the management report.
-- Three section types: farming | other | carryover
--
-- FARMING INCOME
--   mgmt_income row  → commodity (e.g. "Cotton")
--   mgmt_crop_types  → crop type rows (e.g. "Dryland 400ha", "Irrigated 200ha")
--   KPIs: price is at commodity level; area/yield/production at crop type level
--
-- OTHER INCOME
--   mgmt_income row only — name + budgeted amount + expected timing
--   No KPI breakdown
--
-- CARRYOVER INCOME
--   mgmt_income row  → commodity (e.g. "Wheat — prior season")
--   mgmt_crop_types  → one or more lot rows (units + price, no area/yield)
--   KPIs: total units and price only — disconnected from farming income
--
-- Run in Supabase SQL editor for project cfm-prod (nqvfuqvindsgnogejaei)

-- ── 1. mgmt_income ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mgmt_income (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id         TEXT        NOT NULL,
  season          TEXT        NOT NULL,   -- e.g. '2025-26'
  section         TEXT        NOT NULL,   -- 'farming' | 'other' | 'carryover'
  name            TEXT        NOT NULL,   -- commodity name or other income name
  unit            TEXT        NOT NULL DEFAULT 't',  -- t, bales, hd, $
  -- Commodity-level fields (farming + carryover)
  budget_price    NUMERIC(12,4),          -- $/unit at commodity level
  -- Other income fields
  budget_amount   NUMERIC(14,2),          -- total budget for 'other' rows
  expected_month  INT,                    -- month income expected (1–12); null = spread
  notes           TEXT,
  sort_order      INT         NOT NULL DEFAULT 0,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT section_check CHECK (section IN ('farming','other','carryover'))
);

CREATE INDEX IF NOT EXISTS mgmt_income_farm_season
  ON mgmt_income (farm_id, season);

-- ── 2. mgmt_crop_types ───────────────────────────────────────────────────────
-- One row per crop type under a farming or carryover commodity.
-- For farming: area_ha + yield give production; price comes from parent.
-- For carryover: units + price_override (may differ from parent commodity price).
CREATE TABLE IF NOT EXISTS mgmt_crop_types (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  income_id       UUID        NOT NULL REFERENCES mgmt_income(id) ON DELETE CASCADE,
  farm_id         TEXT        NOT NULL,
  season          TEXT        NOT NULL,
  crop_type       TEXT        NOT NULL,   -- e.g. 'Dryland', 'Irrigated', 'Lot 1'
  -- Farming income KPIs (area + yield → production)
  area_ha         NUMERIC(10,2),
  budget_yield    NUMERIC(10,4),          -- units per ha
  budget_production NUMERIC(12,2),        -- computed or manual override
  -- Carryover: direct unit + price (yield/area not applicable)
  budget_units    NUMERIC(12,2),          -- for carryover rows
  price_override  NUMERIC(12,4),          -- overrides parent budget_price if set
  -- Timing
  expected_month  INT,                    -- month income expected for this type
  notes           TEXT,
  sort_order      INT         NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (income_id, crop_type)
);

CREATE INDEX IF NOT EXISTS mgmt_crop_types_income
  ON mgmt_crop_types (income_id);

CREATE INDEX IF NOT EXISTS mgmt_crop_types_farm_season
  ON mgmt_crop_types (farm_id, season);

-- ── 3. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE mgmt_income     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mgmt_crop_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mgmt_income_select" ON mgmt_income
  FOR SELECT USING (can_read(farm_id));
CREATE POLICY "mgmt_income_insert" ON mgmt_income
  FOR INSERT WITH CHECK (can_write(farm_id));
CREATE POLICY "mgmt_income_update" ON mgmt_income
  FOR UPDATE USING (can_write(farm_id));
CREATE POLICY "mgmt_income_delete" ON mgmt_income
  FOR DELETE USING (can_write(farm_id));

CREATE POLICY "mgmt_crop_types_select" ON mgmt_crop_types
  FOR SELECT USING (can_read(farm_id));
CREATE POLICY "mgmt_crop_types_insert" ON mgmt_crop_types
  FOR INSERT WITH CHECK (can_write(farm_id));
CREATE POLICY "mgmt_crop_types_update" ON mgmt_crop_types
  FOR UPDATE USING (can_write(farm_id));
CREATE POLICY "mgmt_crop_types_delete" ON mgmt_crop_types
  FOR DELETE USING (can_write(farm_id));

-- ── 4. Realtime ───────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE mgmt_income;
ALTER PUBLICATION supabase_realtime ADD TABLE mgmt_crop_types;
