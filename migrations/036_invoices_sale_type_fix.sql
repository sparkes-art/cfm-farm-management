-- Migration 036: Fix invoices sale_type check constraint
-- The original constraint allowed ('cash', 'contract', 'pool')
-- but the app uses ('cash', 'against_contract', 'seed_transfer').
-- This migration drops the old constraint and adds the correct one.
--
-- Run in Supabase SQL editor for project cfm-prod (nqvfuqvindsgnogejaei)

-- ── 1. Drop the old constraint ───────────────────────────────────────────────
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_sale_type_check;

-- ── 2. Add the correct constraint ────────────────────────────────────────────
ALTER TABLE invoices
  ADD CONSTRAINT invoices_sale_type_check
  CHECK (sale_type IN ('cash', 'against_contract', 'seed_transfer', 'pool'));

-- ── 3. Update any legacy 'contract' rows to 'against_contract' ───────────────
-- (In case any old rows used 'contract' as the value)
UPDATE invoices
  SET sale_type = 'against_contract'
  WHERE sale_type = 'contract';

-- ── 4. Verify ─────────────────────────────────────────────────────────────────
-- SELECT sale_type, COUNT(*) FROM invoices GROUP BY sale_type ORDER BY sale_type;
