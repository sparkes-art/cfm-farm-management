-- Migration: add section column to budgets table
-- Run in Supabase SQL editor for project cfm-prod (nqvfuqvindsgnogejaei)

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS section TEXT DEFAULT 'farming';

-- Back-fill existing rows: mixed-case commodity names are carry-over convention
-- (budget-import sorts ALL CAPS = new-season, mixed-case = carry-over/other)
UPDATE budgets
SET section = 'carry_over'
WHERE section IS NULL OR section = 'farming'
  AND commodity != upper(commodity)
  AND commodity !~* 'cattle|livestock|agistment|interest|rent|lease|royalt';

COMMENT ON COLUMN budgets.section IS 'Income section: farming | carry_over | other (matches budget-import.js incomeSection)';
