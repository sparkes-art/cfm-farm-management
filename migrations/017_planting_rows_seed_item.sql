-- Migration 017: Link planting_rows to seed stocktake item
-- Adds seed_item_id FK so each planting fill references a specific seed stock item,
-- enabling direct stocktake deduction without fuzzy matching on variety text.

ALTER TABLE planting_rows
  ADD COLUMN IF NOT EXISTS seed_item_id uuid REFERENCES stock_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS planting_rows_seed_item
  ON planting_rows (seed_item_id) WHERE seed_item_id IS NOT NULL;
