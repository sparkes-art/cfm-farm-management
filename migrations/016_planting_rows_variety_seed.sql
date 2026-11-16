-- Migration 016: Add variety, commodity, kg_per_bag to planting_rows
-- bulk_kg and row_seed_type were added in 011b.
-- These columns support per-row variety/crop tracking and seed stock linking.

ALTER TABLE planting_rows
  ADD COLUMN IF NOT EXISTS variety    text,
  ADD COLUMN IF NOT EXISTS commodity  text,
  ADD COLUMN IF NOT EXISTS kg_per_bag numeric;

-- Index for variety lookups (e.g. crop plan updates on session close)
CREATE INDEX IF NOT EXISTS planting_rows_variety
  ON planting_rows (session_id, variety) WHERE variety IS NOT NULL;
