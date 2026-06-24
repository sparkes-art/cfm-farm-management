-- CFM Farm Management System — Supabase Schema
-- Run this in the Supabase SQL editor for project: nqvfuqvindsgnogejaei (cfm-prod)
-- Execute sections in order

-- ============================================================
-- FARMS
-- ============================================================
CREATE TABLE IF NOT EXISTS farms (
  id TEXT PRIMARY KEY,                    -- e.g. 'farm_blackbull'
  name TEXT NOT NULL,
  location TEXT,
  state TEXT,
  settings JSONB DEFAULT '{}',            -- cottonRegion and other farm-level config
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial farms
INSERT INTO farms (id, name, location, state, settings) VALUES
  ('farm_blackbull', 'Blackbull Station', 'Douglas Daly', 'NT', '{"cottonRegion": "northern"}'),
  ('farm_merrowie',  'Merrowie',          NULL,            NULL, '{}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- USER PROFILES  (extends Supabase auth.users)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'operational'
    CHECK (role IN ('operational', 'investor', 'accounting', 'admin')),
  farm_access TEXT[] DEFAULT '{}',        -- array of farm IDs; empty = all farms (admin)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FORWARD CONTRACTS  (referenced by invoices)
-- ============================================================
CREATE TABLE IF NOT EXISTS forward_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id TEXT NOT NULL REFERENCES farms(id),
  commodity TEXT NOT NULL,                -- 'cotton', 'grain', 'pulse', etc.
  contract_number TEXT,
  counterparty TEXT,
  price_per_unit NUMERIC(12,4) NOT NULL,
  unit TEXT NOT NULL DEFAULT 'tonne',
  quantity NUMERIC(12,3),
  season TEXT,                            -- e.g. '2024-25'
  delivery_start DATE,
  delivery_end DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INVOICES  (Outputs module — primary table)
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id TEXT NOT NULL REFERENCES farms(id),
  invoice_number TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  season TEXT,                            -- e.g. '2024-25'

  -- Commodity
  commodity_type TEXT NOT NULL
    CHECK (commodity_type IN ('cotton', 'grain', 'pulse', 'livestock', 'other')),
  commodity_detail TEXT,                  -- variety / breed / grade
  

  -- Counterparty
  buyer TEXT NOT NULL,
  buyer_abn TEXT,

  -- Pricing
  forward_contract_id UUID REFERENCES forward_contracts(id),
  contract_price NUMERIC(12,4),           -- auto-filled from contract, overrideable
  price_per_unit NUMERIC(12,4) NOT NULL,
  unit TEXT NOT NULL DEFAULT 'tonne',
  quantity NUMERIC(12,3) NOT NULL,
  gross_amount NUMERIC(14,2) GENERATED ALWAYS AS (price_per_unit * quantity) STORED,

  -- Deductions / adjustments (JSONB array of {label, amount})
  deductions JSONB DEFAULT '[]',
  net_amount NUMERIC(14,2),              -- updated by trigger or app after deductions

  -- Sale type
  sale_type TEXT DEFAULT 'cash'
    CHECK (sale_type IN ('cash', 'contract', 'pool')),

  -- Cotton-specific
  cotton_region TEXT,                     -- sourced from farms.settings.cottonRegion

  -- Status
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'paid', 'void')),

  -- Xero boundary
  xero_invoice_id TEXT,                  -- populated once pushed to Xero
  xero_synced_at TIMESTAMPTZ,

  -- Audit
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INPUT PURCHASES  (Inputs module)
-- ============================================================
CREATE TABLE IF NOT EXISTS input_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id TEXT NOT NULL REFERENCES farms(id),
  category TEXT NOT NULL
    CHECK (category IN ('fertiliser', 'chemical', 'seed', 'fuel', 'labour', 'other')),
  product_name TEXT NOT NULL,
  supplier TEXT,
  purchase_date DATE NOT NULL,
  season TEXT,
  quantity NUMERIC(12,3),
  unit TEXT,
  unit_cost NUMERIC(12,4),
  total_cost NUMERIC(14,2),
  invoice_reference TEXT,                 -- links back to supplier invoice
  linked_invoice_id UUID REFERENCES invoices(id),  -- cost line link to output invoice
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PADDOCKS  (Agronomy module)
-- ============================================================
CREATE TABLE IF NOT EXISTS paddocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id TEXT NOT NULL REFERENCES farms(id),
  name TEXT NOT NULL,
  area_ha NUMERIC(10,2),
  geometry JSONB,                         -- GeoJSON polygon for mapping
  soil_type TEXT,
  irrigation_type TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- GROSS MARGIN BUDGETS
-- ============================================================
CREATE TABLE IF NOT EXISTS budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id TEXT NOT NULL REFERENCES farms(id),
  season TEXT NOT NULL,
  commodity TEXT NOT NULL,
  paddock_id UUID REFERENCES paddocks(id),
  area_ha NUMERIC(10,2),
  budgeted_yield_per_ha NUMERIC(10,3),
  budgeted_price NUMERIC(12,4),
  budgeted_gross_revenue NUMERIC(14,2),
  budgeted_inputs_per_ha NUMERIC(12,2),
  budgeted_gross_margin NUMERIC(14,2),
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- REALTIME  — enable for live sync
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE invoices;
ALTER PUBLICATION supabase_realtime ADD TABLE input_purchases;
ALTER PUBLICATION supabase_realtime ADD TABLE forward_contracts;
ALTER PUBLICATION supabase_realtime ADD TABLE budgets;
ALTER PUBLICATION supabase_realtime ADD TABLE paddocks;

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================
ALTER TABLE farms            ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE forward_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE input_purchases  ENABLE ROW LEVEL SECURITY;
ALTER TABLE paddocks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets          ENABLE ROW LEVEL SECURITY;

-- Helper: is the current user operational or admin for this farm?
CREATE OR REPLACE FUNCTION can_write(farm TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
      AND role IN ('operational','admin')
      AND (farm_access = '{}' OR farm = ANY(farm_access))
  );
$$;

-- Helper: can the current user read this farm?
CREATE OR REPLACE FUNCTION can_read(farm TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
      AND (farm_access = '{}' OR farm = ANY(farm_access))
  );
$$;

-- Farms: everyone authenticated can read; only admin can write
CREATE POLICY "farms_read"  ON farms FOR SELECT USING (can_read(id));
CREATE POLICY "farms_write" ON farms FOR ALL    USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
);

-- User profiles: users see own profile; admin sees all
CREATE POLICY "profiles_self"  ON user_profiles FOR SELECT USING (id = auth.uid());
CREATE POLICY "profiles_admin" ON user_profiles FOR ALL    USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Invoices
CREATE POLICY "invoices_read"  ON invoices FOR SELECT USING (can_read(farm_id));
CREATE POLICY "invoices_write" ON invoices FOR ALL    USING (can_write(farm_id));

-- Forward contracts
CREATE POLICY "fc_read"  ON forward_contracts FOR SELECT USING (can_read(farm_id));
CREATE POLICY "fc_write" ON forward_contracts FOR ALL    USING (can_write(farm_id));

-- Inputs
CREATE POLICY "inputs_read"  ON input_purchases FOR SELECT USING (can_read(farm_id));
CREATE POLICY "inputs_write" ON input_purchases FOR ALL    USING (can_write(farm_id));

-- Paddocks
CREATE POLICY "paddocks_read"  ON paddocks FOR SELECT USING (can_read(farm_id));
CREATE POLICY "paddocks_write" ON paddocks FOR ALL    USING (can_write(farm_id));

-- Budgets
CREATE POLICY "budgets_read"  ON budgets FOR SELECT USING (can_read(farm_id));
CREATE POLICY "budgets_write" ON budgets FOR ALL    USING (can_write(farm_id));

-- ============================================================
-- UPDATED_AT trigger helper
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER forward_contracts_updated_at
  BEFORE UPDATE ON forward_contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER input_purchases_updated_at
  BEFORE UPDATE ON input_purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER budgets_updated_at
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
