-- Migration 035: Harvest Records
-- Stores actual harvested production per farm / season / commodity / crop type.
-- Independent of invoices — harvest tonnes are a production fact;
-- invoiced tonnes are a sales fact. Both appear in the management report.
--
-- Data entry: manual via SQL for now; future API feed from harvest program.
--
-- Run in Supabase SQL editor for project cfm-prod (nqvfuqvindsgnogejaei)

-- ── 1. Table ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harvest_records (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id         TEXT        NOT NULL,
  season          TEXT        NOT NULL,   -- e.g. '2019-20'
  commodity       TEXT        NOT NULL,   -- must match mgmt_income.name exactly
  crop_type       TEXT        NOT NULL,   -- must match mgmt_crop_types.crop_type exactly
  harvested_qty   NUMERIC(14,4) NOT NULL,
  unit            TEXT        NOT NULL DEFAULT 't',  -- t, bales, hd etc
  notes           TEXT,
  source          TEXT        DEFAULT 'manual',  -- 'manual' | 'api'
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (farm_id, season, commodity, crop_type)
);

CREATE INDEX IF NOT EXISTS harvest_records_farm_season
  ON harvest_records (farm_id, season);

CREATE INDEX IF NOT EXISTS harvest_records_farm_season_commodity
  ON harvest_records (farm_id, season, commodity);

-- ── 2. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE harvest_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "harvest_records_select" ON harvest_records
  FOR SELECT USING (can_read(farm_id));
CREATE POLICY "harvest_records_insert" ON harvest_records
  FOR INSERT WITH CHECK (can_write(farm_id));
CREATE POLICY "harvest_records_update" ON harvest_records
  FOR UPDATE USING (can_write(farm_id));
CREATE POLICY "harvest_records_delete" ON harvest_records
  FOR DELETE USING (can_write(farm_id));

-- ── 3. Realtime ───────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE harvest_records;

-- ── 4. Updated-at trigger ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER harvest_records_updated_at
  BEFORE UPDATE ON harvest_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── 5. Seed data: Merrowie 2019-20 ───────────────────────────────────────────
-- Resolves crop type names from mgmt_crop_types via mgmt_income.
-- If crop type names differ in your DB, adjust the crop_type strings below.
--
-- Barley: 614 t (single crop type — will use first crop type found if only one exists)
-- Wheat Dryland: 1,203 t
-- Wheat Irrigated: 7,619 t

INSERT INTO harvest_records (farm_id, season, commodity, crop_type, harvested_qty, unit, source)
VALUES

  -- Barley — resolve crop type name from your mgmt_crop_types
  -- If Barley has only one crop type, use that name below; adjust if needed
  ('farm_merrowie', '2019-20', 'Barley',
   (SELECT crop_type FROM mgmt_crop_types ct
    JOIN mgmt_income i ON i.id = ct.income_id
    WHERE i.farm_id = 'farm_merrowie' AND i.season = '2019-20'
      AND i.name ILIKE 'Barley' AND i.section = 'farming'
    ORDER BY ct.sort_order LIMIT 1),
   614, 't', 'manual'),

  -- Wheat Dryland
  ('farm_merrowie', '2019-20', 'Wheat',
   (SELECT crop_type FROM mgmt_crop_types ct
    JOIN mgmt_income i ON i.id = ct.income_id
    WHERE i.farm_id = 'farm_merrowie' AND i.season = '2019-20'
      AND i.name ILIKE 'Wheat' AND i.section = 'farming'
      AND ct.crop_type ILIKE '%dryland%'
    ORDER BY ct.sort_order LIMIT 1),
   1203, 't', 'manual'),

  -- Wheat Irrigated
  ('farm_merrowie', '2019-20', 'Wheat',
   (SELECT crop_type FROM mgmt_crop_types ct
    JOIN mgmt_income i ON i.id = ct.income_id
    WHERE i.farm_id = 'farm_merrowie' AND i.season = '2019-20'
      AND i.name ILIKE 'Wheat' AND i.section = 'farming'
      AND ct.crop_type ILIKE '%irrigat%'
    ORDER BY ct.sort_order LIMIT 1),
   7619, 't', 'manual')

ON CONFLICT (farm_id, season, commodity, crop_type) DO UPDATE
  SET harvested_qty = EXCLUDED.harvested_qty,
      updated_at    = now();


-- ── 6. Verify ─────────────────────────────────────────────────────────────────
-- Run this after to confirm rows inserted correctly:
--
-- SELECT hr.commodity, hr.crop_type, hr.harvested_qty, hr.unit
-- FROM harvest_records hr
-- WHERE hr.farm_id = 'farm_merrowie' AND hr.season = '2019-20'
-- ORDER BY commodity, crop_type;
