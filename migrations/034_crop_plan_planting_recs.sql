-- Migration 034: Planting recommendations on crop_plan_entries
-- Adds seed rate, variety (already exists), and JSONB placeholders for
-- chemicals and fertilisers at planting. Chemicals and fertilisers are
-- stored as JSONB arrays for now — full input module integration TBD.
--
-- rec_chemicals  — [{name, rate, unit, notes}]
-- rec_fertilisers — [{name, rate, unit, notes}]

ALTER TABLE crop_plan_entries
  ADD COLUMN IF NOT EXISTS seed_rate_kg_ha  NUMERIC(8,3),   -- target seeding rate kg/ha
  ADD COLUMN IF NOT EXISTS rec_chemicals    JSONB,           -- placeholder [{name,rate,unit,notes}]
  ADD COLUMN IF NOT EXISTS rec_fertilisers  JSONB;           -- placeholder [{name,rate,unit,notes}]

-- variety column already exists (added previously) — no-op if already present
ALTER TABLE crop_plan_entries
  ADD COLUMN IF NOT EXISTS variety TEXT;

COMMENT ON COLUMN crop_plan_entries.seed_rate_kg_ha IS 'Target seeding rate in kg/ha for this paddock';
COMMENT ON COLUMN crop_plan_entries.rec_chemicals    IS 'Placeholder: chemicals recommended at planting [{name,rate,unit,notes}]';
COMMENT ON COLUMN crop_plan_entries.rec_fertilisers  IS 'Placeholder: fertilisers recommended at planting [{name,rate,unit,notes}]';
