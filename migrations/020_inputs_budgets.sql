-- Migration 020: Inputs & Consumables budgets and forecasts
--
-- Provides the budget and forecast layer for the Inputs & Consumables dashboard.
-- Actual spend flows in from two existing sources:
--   • Variable inputs (fertiliser, chemical, seed, fuel, contract services, selling)
--     → input_purchases (category, total_cost, farm_id, season)
--   • Fixed costs (farm labour, fund management)
--     → input_purchases using category = 'labour' | 'fund_management'
--
-- This migration adds:
--   input_budgets  — annual budget per line_key per farm/season
--   input_forecasts — forecast override per line_key per farm/season
--   input_purchases upgrade — adds category values and line_key column
--
-- Line key conventions
-- ─────────────────────────────────────────────────────────────────────────────
-- Variable cards (category.product_slug):
--   fertiliser.urea  |  fertiliser.map  |  fertiliser.gypsum  | …
--   chemical.roundup | chemical.atrazine | …
--   seed.wheat_spitfire | seed.wheat_mace | …
--   fuel.diesel_cropping | fuel.diesel_irrigation
--   contract.spreading | contract.spraying | contract.harvesting | …
--   selling.grain_commission | selling.storage | selling.freight | …
--
-- Fixed-cost line keys (card_key.line_slug):
--   labour.permanent | labour.casual
--   fund_mgmt.cfm_fee | fund_mgmt.lease | fund_mgmt.licencing |
--   fund_mgmt.consulting | fund_mgmt.accounting
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Extend input_purchases with line_key ───────────────────────────────────
-- line_key ties a purchase to a budget row for aggregation.
-- For existing rows it defaults to category (acceptable approximation).

ALTER TABLE input_purchases
  ADD COLUMN IF NOT EXISTS line_key TEXT;

-- Back-fill: use category as the line_key for rows that don't have one yet.
UPDATE input_purchases SET line_key = category WHERE line_key IS NULL;

CREATE INDEX IF NOT EXISTS input_purchases_farm_season_lk
  ON input_purchases (farm_id, season, line_key);

-- ── 2. input_budgets ─────────────────────────────────────────────────────────
-- One row per farm / season / card / line_key.
-- card_key groups line_keys under a display card (e.g. 'fertiliser', 'labour').

CREATE TABLE IF NOT EXISTS input_budgets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id     TEXT NOT NULL,
  season_id   TEXT NOT NULL,       -- e.g. '2025-26'
  card_key    TEXT NOT NULL,       -- fertiliser | chemical | seed | fuel | contract | selling | labour | fund_mgmt
  line_key    TEXT NOT NULL,       -- see conventions above
  label       TEXT NOT NULL,       -- human-readable display name
  budget_amt  NUMERIC(14,2) NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (farm_id, season_id, line_key)
);

CREATE INDEX IF NOT EXISTS input_budgets_farm_season
  ON input_budgets (farm_id, season_id);

CREATE INDEX IF NOT EXISTS input_budgets_card
  ON input_budgets (farm_id, season_id, card_key);

-- ── 3. input_forecasts ───────────────────────────────────────────────────────
-- Forecast override per line_key per farm/season.
-- When no row exists the UI falls back to budget_amt as the forecast.
-- The user enters a forecast when they know actual spend will differ from budget.

CREATE TABLE IF NOT EXISTS input_forecasts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id       TEXT NOT NULL,
  season_id     TEXT NOT NULL,
  line_key      TEXT NOT NULL,
  forecast_amt  NUMERIC(14,2) NOT NULL,
  note          TEXT,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (farm_id, season_id, line_key)
);

CREATE INDEX IF NOT EXISTS input_forecasts_farm_season
  ON input_forecasts (farm_id, season_id);

-- ── 4. RLS policies ──────────────────────────────────────────────────────────

ALTER TABLE input_budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "input_budgets_select" ON input_budgets;
DROP POLICY IF EXISTS "input_budgets_insert" ON input_budgets;
DROP POLICY IF EXISTS "input_budgets_update" ON input_budgets;
DROP POLICY IF EXISTS "input_budgets_delete" ON input_budgets;

CREATE POLICY "input_budgets_select" ON input_budgets
  FOR SELECT USING (can_read(farm_id));
CREATE POLICY "input_budgets_insert" ON input_budgets
  FOR INSERT WITH CHECK (can_write(farm_id));
CREATE POLICY "input_budgets_update" ON input_budgets
  FOR UPDATE USING (can_write(farm_id));
CREATE POLICY "input_budgets_delete" ON input_budgets
  FOR DELETE USING (can_write(farm_id));

ALTER TABLE input_forecasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "input_forecasts_select" ON input_forecasts;
DROP POLICY IF EXISTS "input_forecasts_insert" ON input_forecasts;
DROP POLICY IF EXISTS "input_forecasts_update" ON input_forecasts;
DROP POLICY IF EXISTS "input_forecasts_delete" ON input_forecasts;

CREATE POLICY "input_forecasts_select" ON input_forecasts
  FOR SELECT USING (can_read(farm_id));
CREATE POLICY "input_forecasts_insert" ON input_forecasts
  FOR INSERT WITH CHECK (can_write(farm_id));
CREATE POLICY "input_forecasts_update" ON input_forecasts
  FOR UPDATE USING (can_write(farm_id));
CREATE POLICY "input_forecasts_delete" ON input_forecasts
  FOR DELETE USING (can_write(farm_id));

-- ── 5. Seed default budget rows (Blackbull 2025-26) ──────────────────────────
-- These are placeholder rows so the UI renders with $0 budgets rather than
-- empty cards. CFM office should update amounts via the Budget modal.

INSERT INTO input_budgets (farm_id, season_id, card_key, line_key, label, sort_order) VALUES
  -- Fertiliser
  ('farm_blackbull','2025-26','fertiliser','fertiliser.urea',         'Urea',              10),
  ('farm_blackbull','2025-26','fertiliser','fertiliser.map',          'MAP',               20),
  ('farm_blackbull','2025-26','fertiliser','fertiliser.gypsum',       'Gypsum',            30),
  ('farm_blackbull','2025-26','fertiliser','fertiliser.other',        'Other',             40),
  -- Chemicals
  ('farm_blackbull','2025-26','chemical',  'chemical.herbicide',      'Herbicide',         10),
  ('farm_blackbull','2025-26','chemical',  'chemical.fungicide',      'Fungicide',         20),
  ('farm_blackbull','2025-26','chemical',  'chemical.insecticide',    'Insecticide',       30),
  ('farm_blackbull','2025-26','chemical',  'chemical.other',          'Other',             40),
  -- Seed & Seed Dressing
  ('farm_blackbull','2025-26','seed',      'seed.wheat',              'Wheat seed',        10),
  ('farm_blackbull','2025-26','seed',      'seed.sorghum',            'Sorghum seed',      20),
  ('farm_blackbull','2025-26','seed',      'seed.dressing',           'Seed dressing',     30),
  -- Fuel & Lubricants (variable — cropping/irrigation only)
  ('farm_blackbull','2025-26','fuel',      'fuel.diesel_cropping',    'Diesel — cropping', 10),
  ('farm_blackbull','2025-26','fuel',      'fuel.diesel_irrigation',  'Diesel — irrigation',20),
  ('farm_blackbull','2025-26','fuel',      'fuel.lubricants',         'Lubricants',        30),
  -- Contract Services
  ('farm_blackbull','2025-26','contract',  'contract.spreading',      'Spreading',         10),
  ('farm_blackbull','2025-26','contract',  'contract.spraying',       'Spraying',          20),
  ('farm_blackbull','2025-26','contract',  'contract.harvesting',     'Harvesting',        30),
  ('farm_blackbull','2025-26','contract',  'contract.other',          'Other',             40),
  -- Selling / Storage / Other
  ('farm_blackbull','2025-26','selling',   'selling.grain_commission','Grain commission',  10),
  ('farm_blackbull','2025-26','selling',   'selling.storage',         'Storage',           20),
  ('farm_blackbull','2025-26','selling',   'selling.freight',         'Freight',           30),
  ('farm_blackbull','2025-26','selling',   'selling.other',           'Other',             40),
  -- Farm Labour (fixed)
  ('farm_blackbull','2025-26','labour',    'labour.permanent',        'Permanent staff',   10),
  ('farm_blackbull','2025-26','labour',    'labour.casual',           'Casual labour',     20),
  -- Fund Management (fixed)
  ('farm_blackbull','2025-26','fund_mgmt', 'fund_mgmt.cfm_fee',       'CFM management fee',10),
  ('farm_blackbull','2025-26','fund_mgmt', 'fund_mgmt.lease',         'Lease',             20),
  ('farm_blackbull','2025-26','fund_mgmt', 'fund_mgmt.licencing',     'Licencing',         30),
  ('farm_blackbull','2025-26','fund_mgmt', 'fund_mgmt.consulting',    'Consulting',        40),
  ('farm_blackbull','2025-26','fund_mgmt', 'fund_mgmt.accounting',    'Accounting',        50)
ON CONFLICT (farm_id, season_id, line_key) DO NOTHING;

-- Duplicate for farm_merrowie (same structure, adjust to taste)
INSERT INTO input_budgets (farm_id, season_id, card_key, line_key, label, sort_order)
  SELECT 'farm_merrowie', season_id, card_key, line_key, label, sort_order
  FROM input_budgets WHERE farm_id = 'farm_blackbull'
ON CONFLICT (farm_id, season_id, line_key) DO NOTHING;
