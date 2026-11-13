-- Migration 011b: Planting seed weight + replant flag
-- Adds three columns to the planting tables:
--   planting_sessions.is_replant   — boolean flag for replant sessions
--   planting_sessions.kg_per_bag   — bag weight in kg (default 20)
--   planting_rows.bulk_kg          — bulk seed fill kg for silo/truck deliveries
--
-- Total kg per session = SUM(cotton_bags × kg_per_bag) + SUM(bulk_kg)
-- Always calculated in the app — never stored to avoid staleness.

-- ── planting_sessions ────────────────────────────────────────────────────────
ALTER TABLE planting_sessions
  ADD COLUMN IF NOT EXISTS is_replant  boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kg_per_bag  numeric     NOT NULL DEFAULT 20;

-- ── planting_rows ────────────────────────────────────────────────────────────
ALTER TABLE planting_rows
  ADD COLUMN IF NOT EXISTS bulk_kg  numeric;    -- nullable; for silo/truck fills only

-- No RLS changes needed — these columns inherit the existing table policies.
-- No trigger changes needed — updated_at trigger on planting_sessions already fires on any UPDATE.
