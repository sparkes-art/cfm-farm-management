-- Migration 033: Add payment_schedule column to mgmt_income
-- Purpose: Store monthly payment timing weights for YTD budget vs actual calculations
-- Format: [{month: 3, pct: 40}, {month: 4, pct: 60}]
--   month = calendar month (1=Jan, 2=Feb ... 12=Dec)
--   pct   = percentage of total income expected that month (all pcts should sum to 100)

ALTER TABLE mgmt_income
  ADD COLUMN IF NOT EXISTS payment_schedule JSONB DEFAULT NULL;

COMMENT ON COLUMN mgmt_income.payment_schedule IS
  'Payment timing weights: [{month: 3, pct: 40}, {month: 4, pct: 60}]. '
  'month is 1–12 (calendar month). pct values should sum to 100. '
  'NULL means no schedule defined — YTD budget falls back to even distribution.';
