-- Migration 018: Consumables costing layer
--
-- Adds the cost side for seed, fertiliser and chemical consumables.
-- The stocktake module deliberately holds no dollar figures (it is a quantity
-- ledger only). This migration keeps that boundary intact by placing all cost
-- information in separate tables that *reference* stock_movements rather than
-- modifying it.
--
-- Design:
--   procurement_invoices  — one row per supplier tax invoice (single source of truth for cost)
--   procurement_lines     — one row per distinct product/unit-cost on that invoice
--   delivery_costs        — links each delivery movement to a procurement line and records
--                           the unit_cost and total_cost at the time of matching
--
-- Once a delivery movement is matched to a procurement line:
--   unit_cost  = procurement_lines.unit_cost
--   total_cost = unit_cost × stock_movements.qty
--
-- WAC (Weighted Average Cost) is computed at read time by the view v_stock_wac below.
-- Opening balances are handled via the ob_unit_cost column on stock_movements rows
-- whose movement_type = 'opening_balance' — these are entered manually by CFM office
-- when migrating a period or carrying stock from prior seasons.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Procurement invoices ───────────────────────────────────────────────────
-- One row = one supplier tax invoice received by CFM office.

CREATE TABLE IF NOT EXISTS procurement_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id         TEXT NOT NULL,            -- matches farms.id convention
  supplier        TEXT NOT NULL,
  invoice_number  TEXT,                     -- supplier's own reference
  invoice_date    DATE NOT NULL,
  due_date        DATE,
  total_amount    NUMERIC(14,4),            -- gross invoice total (informational only; Xero owns payment)
  currency        TEXT NOT NULL DEFAULT 'AUD',
  status          TEXT NOT NULL DEFAULT 'unmatched'
                    CHECK (status IN ('unmatched','partial','matched','approved')),
  xero_bill_id    TEXT,                     -- populated later when Xero integration is built
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS procurement_invoices_farm_status
  ON procurement_invoices (farm_id, status);

CREATE INDEX IF NOT EXISTS procurement_invoices_farm_date
  ON procurement_invoices (farm_id, invoice_date DESC);

-- ── 2. Procurement lines ──────────────────────────────────────────────────────
-- One row per distinct product / unit_cost on a procurement invoice.
-- A single invoice can cover multiple products (e.g. two seed varieties, or
-- seed + treatment chemical on one delivery bill).

CREATE TABLE IF NOT EXISTS procurement_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  procurement_invoice_id UUID NOT NULL REFERENCES procurement_invoices(id) ON DELETE CASCADE,
  farm_id             TEXT NOT NULL,
  item_id             UUID REFERENCES stock_items(id) ON DELETE SET NULL,
  description         TEXT NOT NULL,        -- free text; item_id is optional
  quantity_invoiced   NUMERIC(14,4),        -- qty on the invoice (may differ from delivered qty)
  unit                TEXT,
  unit_cost           NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  line_total          NUMERIC(14,4),        -- quantity_invoiced × unit_cost (informational)
  gst_rate            NUMERIC(5,4) DEFAULT 0.10,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS procurement_lines_invoice
  ON procurement_lines (procurement_invoice_id);

CREATE INDEX IF NOT EXISTS procurement_lines_item
  ON procurement_lines (farm_id, item_id);

-- ── 3. Delivery cost matching ─────────────────────────────────────────────────
-- Links each 'delivery' movement in stock_movements to a procurement line.
-- One delivery movement → one delivery_costs row.
-- Multiple delivery movements can share one procurement_line (one invoice, many dockets).

CREATE TABLE IF NOT EXISTS delivery_costs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id                 TEXT NOT NULL,
  movement_id             UUID NOT NULL UNIQUE REFERENCES stock_movements(id) ON DELETE CASCADE,
  procurement_line_id     UUID NOT NULL REFERENCES procurement_lines(id) ON DELETE RESTRICT,
  -- Snapshot the unit cost at the time of matching so it doesn't drift if the
  -- invoice is later amended.
  unit_cost               NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  total_cost              NUMERIC(14,4) NOT NULL,   -- unit_cost × movement qty at match time
  matched_by              TEXT,
  matched_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                   TEXT
);

CREATE INDEX IF NOT EXISTS delivery_costs_farm
  ON delivery_costs (farm_id);

CREATE INDEX IF NOT EXISTS delivery_costs_movement
  ON delivery_costs (movement_id);

CREATE INDEX IF NOT EXISTS delivery_costs_line
  ON delivery_costs (procurement_line_id);

-- ── 4. Opening balance costs ──────────────────────────────────────────────────
-- When opening balances are loaded (migration or new season start), CFM office
-- also records the unit cost for the on-hand quantity so WAC starts correctly.
-- This is a separate table rather than a column on stock_movements to preserve
-- the stocktake module's money-free design.

CREATE TABLE IF NOT EXISTS opening_balance_costs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id         TEXT NOT NULL,
  movement_id     UUID NOT NULL UNIQUE REFERENCES stock_movements(id) ON DELETE CASCADE,
  season_id       TEXT NOT NULL,            -- matches seasons.id (e.g. '2026-27')
  item_id         UUID REFERENCES stock_items(id) ON DELETE SET NULL,
  unit_cost       NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  total_value     NUMERIC(14,4) NOT NULL,   -- unit_cost × opening qty
  source_note     TEXT,                     -- e.g. 'Carried from 2025-26 WAC $1.42/kg'
  entered_by      TEXT,
  entered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS opening_balance_costs_farm_season
  ON opening_balance_costs (farm_id, season_id);

-- ── 5. WAC view ───────────────────────────────────────────────────────────────
-- Computes weighted average cost per item per farm per season at read time.
-- Uses: opening balance costs + matched delivery costs, weighted by quantity.
-- Excludes: sale movements (they consume stock at WAC, not at cost).
-- Excludes: unmatched deliveries (they appear in an 'uncosted' CTE so the UI
--   can flag them).
--
-- WAC formula:
--   WAC = (Σ opening_value + Σ delivery_value) / (Σ opening_qty + Σ delivery_qty)
--
-- Season boundary: a movement row's occurred_on determines which season it belongs
-- to by joining on seasons (year_start ≤ occurred_on year ≤ year_end).

CREATE OR REPLACE VIEW v_stock_wac AS
WITH season_boundaries AS (
  -- Map each season to a date range (Australian financial year: 1 Jul → 30 Jun)
  SELECT
    id              AS season_id,
    label,
    make_date(year_start, 7, 1)  AS season_start,
    make_date(year_end,   6, 30) AS season_end
  FROM seasons
),

-- Opening balance values
ob AS (
  SELECT
    obc.farm_id,
    obc.season_id,
    sm.item_id,
    SUM(sm.qty)             AS ob_qty,
    SUM(obc.total_value)    AS ob_value
  FROM opening_balance_costs obc
  JOIN stock_movements sm ON sm.id = obc.movement_id
  WHERE sm.movement_type = 'opening_balance'
  GROUP BY obc.farm_id, obc.season_id, sm.item_id
),

-- Matched delivery values
deliveries AS (
  SELECT
    dc.farm_id,
    sb.season_id,
    sm.item_id,
    SUM(sm.qty)             AS del_qty,
    SUM(dc.total_cost)      AS del_value
  FROM delivery_costs dc
  JOIN stock_movements sm  ON sm.id = dc.movement_id
  JOIN season_boundaries sb
    ON sm.occurred_on BETWEEN sb.season_start AND sb.season_end
  WHERE sm.movement_type = 'delivery'
    AND sm.direction = 'in'
  GROUP BY dc.farm_id, sb.season_id, sm.item_id
),

-- Unmatched deliveries (movements with no delivery_costs row)
unmatched AS (
  SELECT
    sm.farm_id,
    sb.season_id,
    sm.item_id,
    SUM(sm.qty)             AS unmatched_qty,
    COUNT(*)                AS unmatched_count
  FROM stock_movements sm
  JOIN season_boundaries sb
    ON sm.occurred_on BETWEEN sb.season_start AND sb.season_end
  LEFT JOIN delivery_costs dc ON dc.movement_id = sm.id
  WHERE sm.movement_type = 'delivery'
    AND sm.direction = 'in'
    AND dc.id IS NULL
  GROUP BY sm.farm_id, sb.season_id, sm.item_id
)

SELECT
  COALESCE(ob.farm_id, d.farm_id)     AS farm_id,
  COALESCE(ob.season_id, d.season_id) AS season_id,
  COALESCE(ob.item_id, d.item_id)     AS item_id,
  si.name                             AS item_name,
  si.category,
  si.default_unit                     AS unit,
  COALESCE(ob.ob_qty,    0)           AS ob_qty,
  COALESCE(ob.ob_value,  0)           AS ob_value,
  COALESCE(d.del_qty,    0)           AS del_qty,
  COALESCE(d.del_value,  0)           AS del_value,
  COALESCE(ob.ob_qty, 0) + COALESCE(d.del_qty, 0)      AS total_costed_qty,
  COALESCE(ob.ob_value, 0) + COALESCE(d.del_value, 0)  AS total_costed_value,
  CASE
    WHEN COALESCE(ob.ob_qty, 0) + COALESCE(d.del_qty, 0) > 0
    THEN ROUND(
           (COALESCE(ob.ob_value, 0) + COALESCE(d.del_value, 0)) /
           (COALESCE(ob.ob_qty, 0)   + COALESCE(d.del_qty, 0)),
           4
         )
    ELSE NULL
  END                                                   AS wac_per_unit,
  COALESCE(u.unmatched_qty,   0)      AS unmatched_del_qty,
  COALESCE(u.unmatched_count, 0)      AS unmatched_del_count
FROM ob
FULL OUTER JOIN deliveries d
  ON ob.farm_id = d.farm_id AND ob.season_id = d.season_id AND ob.item_id = d.item_id
LEFT JOIN unmatched u
  ON COALESCE(ob.farm_id, d.farm_id) = u.farm_id
  AND COALESCE(ob.season_id, d.season_id) = u.season_id
  AND COALESCE(ob.item_id, d.item_id) = u.item_id
LEFT JOIN stock_items si
  ON si.id = COALESCE(ob.item_id, d.item_id);

-- ── 6. Costed usage view ──────────────────────────────────────────────────────
-- Joins usage movements to the WAC for that item/farm/season, so the
-- management report can get: qty used × WAC = estimated cost of usage.
-- (Exact cost is WAC at the point of use; this view uses season WAC as an
-- approximation until a more precise rolling-WAC pass is built.)

CREATE OR REPLACE VIEW v_stock_usage_costed AS
WITH season_boundaries AS (
  SELECT
    id              AS season_id,
    make_date(year_start, 7, 1)  AS season_start,
    make_date(year_end,   6, 30) AS season_end
  FROM seasons
)
SELECT
  sm.id               AS movement_id,
  sm.farm_id,
  sb.season_id,
  sm.item_id,
  si.name             AS item_name,
  si.category,
  sm.occurred_on,
  sm.qty,
  sm.unit,
  sm.cost_category,
  sm.project,
  sm.enterprise,
  sm.note,
  sm.source_ref,
  w.wac_per_unit,
  CASE
    WHEN w.wac_per_unit IS NOT NULL
    THEN ROUND(sm.qty * w.wac_per_unit, 2)
    ELSE NULL
  END                 AS estimated_cost,
  w.unmatched_del_qty > 0
                      AS has_unmatched_deliveries
FROM stock_movements sm
JOIN season_boundaries sb
  ON sm.occurred_on BETWEEN sb.season_start AND sb.season_end
JOIN stock_items si ON si.id = sm.item_id
LEFT JOIN v_stock_wac w
  ON  w.farm_id  = sm.farm_id
  AND w.season_id = sb.season_id
  AND w.item_id  = sm.item_id
WHERE sm.movement_type = 'usage'
  AND sm.direction = 'out';

-- ── 7. Trigger: auto-update procurement_invoices.status ───────────────────────
-- After each insert/update/delete on delivery_costs, recalculate whether the
-- linked invoice's lines are fully matched.

CREATE OR REPLACE FUNCTION _refresh_invoice_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_invoice_id UUID;
  v_total_lines INT;
  v_matched_lines INT;
BEGIN
  -- Determine which invoice is affected
  IF TG_OP = 'DELETE' THEN
    SELECT pl.procurement_invoice_id INTO v_invoice_id
    FROM procurement_lines pl WHERE pl.id = OLD.procurement_line_id;
  ELSE
    SELECT pl.procurement_invoice_id INTO v_invoice_id
    FROM procurement_lines pl WHERE pl.id = NEW.procurement_line_id;
  END IF;

  IF v_invoice_id IS NULL THEN RETURN NULL; END IF;

  SELECT COUNT(*)   INTO v_total_lines
  FROM procurement_lines WHERE procurement_invoice_id = v_invoice_id;

  -- A line is "matched" if at least one delivery_costs row references it
  SELECT COUNT(DISTINCT dc.procurement_line_id) INTO v_matched_lines
  FROM delivery_costs dc
  JOIN procurement_lines pl ON pl.id = dc.procurement_line_id
  WHERE pl.procurement_invoice_id = v_invoice_id;

  UPDATE procurement_invoices
  SET status = CASE
        WHEN v_matched_lines = 0            THEN 'unmatched'
        WHEN v_matched_lines < v_total_lines THEN 'partial'
        ELSE                                     'matched'
      END,
      updated_at = NOW()
  WHERE id = v_invoice_id
    AND status != 'approved';  -- never downgrade an approved invoice automatically

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_invoice_status ON delivery_costs;
CREATE TRIGGER trg_refresh_invoice_status
  AFTER INSERT OR UPDATE OR DELETE ON delivery_costs
  FOR EACH ROW EXECUTE FUNCTION _refresh_invoice_status();
