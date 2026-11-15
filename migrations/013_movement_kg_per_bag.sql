-- Migration 013: Add kg_per_bag to stock_movements
-- Records the bag size AT THE TIME of each movement, so historical
-- kg calculations remain correct even if bag size changes later.
-- Falls back to stock_items.attributes->>'kg_per_bag' for older records.

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS kg_per_bag numeric CHECK (kg_per_bag > 0);

COMMENT ON COLUMN stock_movements.kg_per_bag IS
  'Kg per bag at time of this movement. Overrides item-level kg_per_bag for accurate historical kg display.';
