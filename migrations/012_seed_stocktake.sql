-- Migration 012: Seed stocktake link
--
-- Adds an is_seed flag to stock_items so seed commodities can be queried
-- independently from grain/hay commodities (both use category='grain').
-- Also adds source_session_id to stock_movements for direct FK to planting_sessions
-- (source_ref already holds the UUID as text; this adds the typed FK for joins/integrity).

ALTER TABLE stock_items
  ADD COLUMN IF NOT EXISTS is_seed boolean NOT NULL DEFAULT false;

-- Index for fast seed-only queries
CREATE INDEX IF NOT EXISTS stock_items_is_seed
  ON stock_items (farm_id, is_seed)
  WHERE is_seed = true;

-- Backfill: any existing grain item whose subgroup = 'Seed' (from earlier manual entry) becomes is_seed=true
UPDATE stock_items
   SET is_seed = true
 WHERE category = 'grain'
   AND (subgroup = 'Seed' OR attributes->>'item_type' = 'seed');
