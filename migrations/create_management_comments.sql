-- Migration: create management_comments table
-- Run this in the Supabase SQL editor for project cfm-prod (nqvfuqvindsgnogejaei)

CREATE TABLE IF NOT EXISTS management_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id     text NOT NULL REFERENCES farms(id),
  season      text NOT NULL,          -- e.g. '2025-26'
  month       text,                   -- 'YYYY-MM' or null = season-level note
  row_key     text,                   -- null = season-level note
  comment     text NOT NULL,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE management_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mgmt_comments_read"  ON management_comments FOR SELECT USING (can_read(farm_id));
CREATE POLICY "mgmt_comments_write" ON management_comments FOR ALL    USING (can_write(farm_id));
