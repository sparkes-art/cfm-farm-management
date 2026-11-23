-- Migration: report_commodities — user-confirmed commodity config for management report
-- Run in Supabase SQL editor for project cfm-prod (nqvfuqvindsgnogejaei)

CREATE TABLE IF NOT EXISTS report_commodities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id         TEXT NOT NULL,
  season          TEXT NOT NULL,
  commodity       TEXT NOT NULL,           -- e.g. "Cotton", "Wheat"
  unit            TEXT NOT NULL DEFAULT 't', -- t, bales, hd etc.
  sort_order      INT  NOT NULL DEFAULT 0,
  is_livestock    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (farm_id, season, commodity)
);

-- Crop types within a commodity (dryland, irrigated, etc.)
-- Each row is one crop type for one commodity
CREATE TABLE IF NOT EXISTS report_commodity_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity_id    UUID NOT NULL REFERENCES report_commodities(id) ON DELETE CASCADE,
  farm_id         TEXT NOT NULL,
  season          TEXT NOT NULL,
  crop_type       TEXT NOT NULL,           -- e.g. "Dryland", "Irrigated", "Main Season"
  area_ha         NUMERIC,
  budget_yield    NUMERIC,                 -- yield per ha (or per head for livestock)
  budget_price    NUMERIC,                 -- price per unit
  budget_income   NUMERIC,                 -- total budgeted income for this type
  income_month    INT,                     -- expected month of income receipt (1-12)
  sort_order      INT  NOT NULL DEFAULT 0,
  budget_row_ids  TEXT[],                  -- references back to budgets.id rows this was built from
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (commodity_id, crop_type)
);

-- Enable RLS
ALTER TABLE report_commodities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_commodity_types   ENABLE ROW LEVEL SECURITY;

-- RLS: users can see/write rows for farms they have access to
-- (mirrors existing pattern used by budgets, invoices etc.)
CREATE POLICY "farm access" ON report_commodities
  USING (farm_id = ANY(
    SELECT unnest(farms) FROM user_farm_roles
    WHERE user_id = auth.uid()
  ));

CREATE POLICY "farm access" ON report_commodity_types
  USING (farm_id = ANY(
    SELECT unnest(farms) FROM user_farm_roles
    WHERE user_id = auth.uid()
  ));

-- Realtime: allow these tables to publish changes
ALTER PUBLICATION supabase_realtime ADD TABLE report_commodities;
ALTER PUBLICATION supabase_realtime ADD TABLE report_commodity_types;

COMMENT ON TABLE report_commodities IS 'User-confirmed commodity configuration for the management report — one row per commodity per farm per season';
COMMENT ON TABLE report_commodity_types IS 'Crop type breakdown within a commodity — dryland/irrigated split, area, yield, price per type';
