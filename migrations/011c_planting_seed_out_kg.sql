-- Migration 011c: Add seed_out_kg to planting_sessions
-- Mirrors seed_in_kg for bulk sessions — records kg of seed carried OUT at close.
-- Bag sessions use seed_out_bags (existing); bulk sessions use seed_out_kg.

ALTER TABLE planting_sessions
  ADD COLUMN IF NOT EXISTS seed_out_kg numeric;  -- used when seed_type = 'bulk'
