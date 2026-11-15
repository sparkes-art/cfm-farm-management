-- Migration 015: Allow item_id to be nullable on stock_movements
--
-- Enables "pending/unallocated" movements from the Operations module:
-- when a planting session is closed, a stub movement is written with
-- item_id = NULL and source_system = 'operations'. An admin or manager
-- then assigns it to a specific seed stock item in the Seed Stocktake
-- module (matching the livestock unallocated-sale pattern).
--
-- Run in Supabase SQL editor.

ALTER TABLE stock_movements
  ALTER COLUMN item_id DROP NOT NULL;

-- Index to efficiently find unallocated movements
CREATE INDEX IF NOT EXISTS stock_movements_unallocated
  ON stock_movements (farm_id, source_system)
  WHERE item_id IS NULL;
