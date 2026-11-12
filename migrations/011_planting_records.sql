-- Migration 011: Planting Records
-- Creates planting_sessions and planting_rows tables.
-- Planting sessions = one per field planting run (header data).
-- Planting rows     = each planter fill/pass within a session.
-- Chemical treatments stored as JSONB array on each row: [{name, litres}]
-- Paddock stored as plain text (follows CFM denormalisation rule — no FK to paddocks).

-- ── planting_sessions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planting_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id             text NOT NULL,
  season_label        text NOT NULL,
  field_name          text NOT NULL,          -- paddock name as plain text
  sub_block           text,                   -- nullable; created at planting if splitting variety
  commodity           text,                   -- e.g. 'Cotton'
  variety             text,
  auslot_default      text,                   -- default lot # for rows; overrideable per row
  operator_default    text,                   -- default operator; overrideable per row
  seed_in_bags        numeric,
  water_in_litres     numeric,
  previous_field      text,
  notes               text,
  -- end-of-session fields (populated on close)
  seed_out_bags       numeric,
  water_out_litres    numeric,
  next_field          text,
  closing_notes       text,
  -- crop plan link (informational only — no auto-write back to crop_plan_entries)
  crop_plan_entry_id  uuid,                   -- references crop_plan_entries.id if matched
  -- status
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by          uuid,                   -- references auth.users.id
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ── planting_rows ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planting_rows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES planting_sessions(id) ON DELETE CASCADE,
  row_date        date,
  row_time        text,                       -- stored as HH:MM text — simple, no TZ issues
  operator        text,                       -- nullable; falls back to session operator_default
  hectares        numeric,
  cotton_bags     integer,
  auslot_override text,                       -- nullable; falls back to session auslot_default
  chemicals       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name: "Telstar", litres: 3.5}, ...]
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS planting_sessions_farm_season
  ON planting_sessions (farm_id, season_label);

CREATE INDEX IF NOT EXISTS planting_rows_session
  ON planting_rows (session_id);

-- ── updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS planting_sessions_updated_at ON planting_sessions;
CREATE TRIGGER planting_sessions_updated_at
  BEFORE UPDATE ON planting_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE planting_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE planting_rows     ENABLE ROW LEVEL SECURITY;

-- Sessions: authenticated users can read all; operational/admin can write
CREATE POLICY "planting_sessions_select" ON planting_sessions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "planting_sessions_insert" ON planting_sessions
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "planting_sessions_update" ON planting_sessions
  FOR UPDATE TO authenticated USING (true);

-- Rows: same pattern
CREATE POLICY "planting_rows_select" ON planting_rows
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "planting_rows_insert" ON planting_rows
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "planting_rows_update" ON planting_rows
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "planting_rows_delete" ON planting_rows
  FOR DELETE TO authenticated USING (true);
