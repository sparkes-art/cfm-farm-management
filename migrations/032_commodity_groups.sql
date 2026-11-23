-- Migration 032: Commodity grouping
-- Adds group_name to commodities so related commodities (e.g. Cotton Lint +
-- Cotton Seed) roll up under a single display group in reports and UI.
-- A null group_name means the commodity stands alone.
--
-- Run in Supabase SQL editor for project cfm-prod (nqvfuqvindsgnogejaei)

ALTER TABLE commodities
  ADD COLUMN IF NOT EXISTS group_name TEXT DEFAULT NULL;

-- Index for fast group lookups
CREATE INDEX IF NOT EXISTS commodities_group_name
  ON commodities (group_name)
  WHERE group_name IS NOT NULL;

-- Set Cotton Lint and Cotton Seed to the 'Cotton' group
UPDATE commodities
  SET group_name = 'Cotton'
  WHERE name IN ('Cotton Lint', 'Cotton Seed');
