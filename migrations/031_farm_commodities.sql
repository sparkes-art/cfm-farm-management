-- Migration 031: Farm-level commodity visibility
-- Commodities are global (no farm_id). This table lets each farm hide
-- commodities that are irrelevant to it without deleting the master record.
--
-- Default behaviour: a commodity with no row here is treated as active.
-- A row with active = false hides the commodity from that farm's dropdowns.
--
-- Run in Supabase SQL editor for project cfm-prod (nqvfuqvindsgnogejaei)

CREATE TABLE IF NOT EXISTS farm_commodities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id      TEXT NOT NULL,
  commodity_id UUID NOT NULL REFERENCES commodities(id) ON DELETE CASCADE,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, commodity_id)
);

CREATE INDEX IF NOT EXISTS farm_commodities_farm
  ON farm_commodities (farm_id);

ALTER TABLE farm_commodities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "farm_commodities_select" ON farm_commodities
  FOR SELECT USING (can_read(farm_id));
CREATE POLICY "farm_commodities_insert" ON farm_commodities
  FOR INSERT WITH CHECK (can_write(farm_id));
CREATE POLICY "farm_commodities_update" ON farm_commodities
  FOR UPDATE USING (can_write(farm_id));
CREATE POLICY "farm_commodities_delete" ON farm_commodities
  FOR DELETE USING (can_write(farm_id));

ALTER PUBLICATION supabase_realtime ADD TABLE farm_commodities;
