-- Migration 014: Convert stock_locations.kind from enum to text
-- Allows any free-text location type without schema changes.
-- Must drop and recreate v_fuel_tank_reconciliation which depends on the column.

DROP VIEW IF EXISTS v_fuel_tank_reconciliation;

ALTER TABLE stock_locations
  ALTER COLUMN kind TYPE text USING kind::text;

CREATE OR REPLACE VIEW v_fuel_tank_reconciliation AS
 WITH tank AS (
         SELECT l.id,
            l.farm_id,
            l.name,
            l.kind,
            l.sub_property,
            l.has_fuel_tank,
            l.capacity,
            l.capacity_unit,
            l.fuel_type,
            l.has_water_meter,
            l.esid,
            l.aliases,
            l.route_order,
            l.active,
            l.notes,
            l.created_at,
            p.id AS period_id,
            p.period_start,
            p.period_end
           FROM stock_locations l
             JOIN stock_periods p ON p.farm_id = l.farm_id
          WHERE l.has_fuel_tank
        )
 SELECT t.farm_id,
    t.period_id,
    t.id AS location_id,
    t.name AS tank_name,
    t.capacity,
    t.fuel_type,
    open_r.value AS opening_dip,
    COALESCE(mv.moved_in, 0::numeric) AS delivered_in,
    COALESCE(mv.moved_out, 0::numeric) AS used_out,
    COALESCE(open_r.value, 0::numeric) + COALESCE(mv.moved_in, 0::numeric) - COALESCE(mv.moved_out, 0::numeric) AS expected_closing,
    close_r.value AS closing_dip,
    close_r.not_read AS closing_not_read,
    close_r.value - (COALESCE(open_r.value, 0::numeric) + COALESCE(mv.moved_in, 0::numeric) - COALESCE(mv.moved_out, 0::numeric)) AS variance
   FROM tank t
     LEFT JOIN LATERAL ( SELECT r.value,
            r.not_read
           FROM stock_readings r
          WHERE r.location_id = t.id AND r.reading_type = 'fuel_dip'::stock_reading_type AND r.read_on < t.period_start
          ORDER BY r.read_on DESC
         LIMIT 1) open_r ON true
     LEFT JOIN LATERAL ( SELECT r.value,
            r.not_read
           FROM stock_readings r
          WHERE r.location_id = t.id AND r.reading_type = 'fuel_dip'::stock_reading_type AND r.read_on >= t.period_start AND r.read_on <= t.period_end
          ORDER BY r.read_on DESC
         LIMIT 1) close_r ON true
     LEFT JOIN LATERAL ( SELECT sum(
                CASE
                    WHEN m.direction = 1 THEN m.qty
                    ELSE 0::numeric
                END) AS moved_in,
            sum(
                CASE
                    WHEN m.direction = '-1'::integer THEN m.qty
                    ELSE 0::numeric
                END) AS moved_out
           FROM stock_movements m
          WHERE m.location_id = t.id AND m.occurred_on >= t.period_start AND m.occurred_on <= t.period_end) mv ON true;
