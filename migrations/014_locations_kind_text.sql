-- Migration 014: Convert stock_locations.kind from enum to text
-- Allows any free-text location type without schema changes.

ALTER TABLE stock_locations
  ALTER COLUMN kind TYPE text USING kind::text;
