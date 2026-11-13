-- Migration 011b: Planting seed weight + replant flag + seed type toggle
-- Adds columns to the planting tables for seed tracking.
--
-- planting_sessions:
--   is_replant   — boolean flag for replant sessions
--   kg_per_bag   — bag weight in kg (default 20), used when seed_type = 'bags'
--   seed_type    — 'bags' or 'bulk' (default 'bags')
--   seed_in_kg   — total kg carried in when seed_type = 'bulk'
--
-- planting_rows:
--   bulk_kg      — seed weight in kg for a bulk fill row (silo/truck)
--   row_seed_type — 'bags' or 'bulk' per row (default 'bags')
--
-- Total kg per session always calculated in app — never stored to avoid staleness.

-- ── planting_sessions ────────────────────────────────────────────────────────
ALTER TABLE planting_sessions
  ADD COLUMN IF NOT EXISTS is_replant  boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kg_per_bag  numeric     NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS seed_type   text        NOT NULL DEFAULT 'bags',
  ADD COLUMN IF NOT EXISTS seed_in_kg  numeric;    -- used when seed_type = 'bulk'

-- ── planting_rows ────────────────────────────────────────────────────────────
ALTER TABLE planting_rows
  ADD COLUMN IF NOT EXISTS bulk_kg       numeric,   -- seed weight kg for bulk fills
  ADD COLUMN IF NOT EXISTS row_seed_type text NOT NULL DEFAULT 'bags';

-- No RLS changes needed — these columns inherit the existing table policies.
-- No trigger changes needed — updated_at trigger on planting_sessions already fires on any UPDATE.
