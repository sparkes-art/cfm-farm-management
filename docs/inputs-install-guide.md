# Inputs & Consumables Module — Install Guide

**Who this is for:** CFM office staff running the database migration.  
**What this does:** Adds the Inputs & Consumables dashboard to the CFM system — the collapsible card view showing variable input costs and fixed costs (Farm Labour, Fund Management) with Budget vs Actual vs Forecast tracking.

---

## What gets installed

| File | What it is |
|------|------------|
| `migrations/020_inputs_budgets.sql` | New database tables and seed data |
| `modules/inputs/inputs.js` | Rebuilt inputs module (replaces old procurement view) |
| `css/design-system.css` | Updated with collapsible card styles |

---

## Step 1 — Run the database migration

1. Open the **Supabase dashboard** → project **cfm-prod**
2. Click **SQL Editor** in the left menu
3. Click **+ New query**
4. Open the file `migrations/020_inputs_budgets.sql` from the CFM codebase and copy its entire contents
5. Paste into the SQL editor
6. Click **Run**

✅ You should see a success message. If you see an error, copy the error text and send to the CFM team.

**What this migration creates:**

- `input_budgets` table — stores the annual budget for each input line item (Urea, MAP, Diesel, etc.) per farm and season
- `input_forecasts` table — stores forecast overrides when you know spend will differ from budget
- Adds a `line_key` column to `input_purchases` (existing table) to link purchases to budget lines
- Pre-fills default budget rows of $0 for Blackbull Station and Merrowie for the 2025-26 season — you'll update these amounts once the module is live

---

## Step 2 — Deploy the updated files

**If you use Netlify auto-deploy from GitHub:**

The code files are already in the repository. Push or merge to main and Netlify will deploy automatically. No manual step needed.

**If you deploy manually:**

Upload these three files to Netlify (replacing existing files):
- `modules/inputs/inputs.js`
- `css/design-system.css`

---

## Step 3 — Set your budgets

Once deployed:

1. Open the CFM app and go to **Inputs & Consumables**
2. Click **⚙ Manage Budgets** (top right — only visible if you have write access)
3. Enter annual budget amounts for each line item
4. Click **Save All**

The module comes pre-loaded with these line items:

| Card | Line items |
|------|-----------|
| Fertiliser | Urea, MAP, Gypsum, Other |
| Chemicals | Herbicide, Fungicide, Insecticide, Other |
| Seed & Seed Dressing | Wheat seed, Sorghum seed, Seed dressing |
| Fuel & Lubricants | Diesel — cropping, Diesel — irrigation, Lubricants |
| Contract Services | Spreading, Spraying, Harvesting, Other |
| Selling / Storage / Other | Grain commission, Storage, Freight, Other |
| Farm Labour (fixed) | Permanent staff, Casual labour |
| Fund Management (fixed) | CFM management fee, Lease, Licencing, Consulting, Accounting |

---

## Step 4 — Enter actual purchases

For each input purchase received:

1. Open the relevant card (e.g. **Fertiliser**)
2. Click the **Products & Rates** tab
3. Click **+ Add Purchase**
4. Fill in: Date, Product name, Supplier, Quantity, Unit, Unit cost, Total cost, Invoice reference
5. The Total cost field auto-fills when you enter Quantity × Unit cost — you can override it

---

## Step 5 — Set forecasts (optional)

Forecasts default to the budget amount. If you know a line item will be over or under budget:

1. Click the **Summary** tab on a card
2. Click **Edit fcst** next to the relevant line item
3. Enter the revised forecast amount and an optional note
4. Click **Save Forecast**

The Variance column shows Forecast − Actual (green = under forecast, red = over).

---

## Understanding the dashboard

### Variable input cards (Fertiliser, Chemicals, Seed, Fuel, Contract, Selling)

Each card shows three tabs:

- **Summary** — table of line items with Actual | Budget | Forecast | Variance to Forecast, plus a 4-cell strip at the top
- **Products & Rates** — full list of individual purchases with dates, suppliers and invoice references
- **On Hand / To Order** — current stock quantities from the Stocktake module (Fertiliser, Chemicals, Seed and Fuel only)

### Fixed cost cards (Farm Labour, Fund Management)

These work like the R&M card — a simple Budget vs Actual table with variance and % used. No forecast column (budgets are fixed).

### Top summary strip

The four cells across the top show totals across **all** cards:

| Cell | What it shows |
|------|--------------|
| YTD Actual | Money spent this season so far |
| Budget | Total annual budget |
| Forecast | Expected full-season spend |
| Var to Forecast | Forecast minus Actual (▲ = over forecast) |

---

## Adding a new line item to a card

New line items (e.g. a new fertiliser product) need to be added to the `input_budgets` table first:

1. Open **Supabase SQL Editor**
2. Run:

```sql
INSERT INTO input_budgets (farm_id, season_id, card_key, line_key, label, budget_amt, sort_order)
VALUES
  ('farm_blackbull', '2025-26', 'fertiliser', 'fertiliser.dap', 'DAP', 25000, 25);
```

Replace values as needed. The `line_key` must be unique and follow the pattern `card_key.slug`.

Then when entering a purchase, select the new line item from the **Line item** dropdown in the Add Purchase form.

---

## Notes

- **On-hand quantities** in the On Hand tab come from the Stocktake module. Use Stocktake to record deliveries and applications — these figures update automatically here.
- **Invoice matching** (linking purchases to supplier invoices via the Procurement tab) still exists in the database. The new Inputs dashboard is the primary view; the Procurement matching workflow will be re-exposed in a future release.
- **Farm Labour and Fund Management** amounts should be entered as actual monthly payments in the **Products & Rates** concept — use the **+ Add Purchase** flow on those fixed cards with the relevant line_key selected.
- Budgets and forecasts are **per season**. When a new season starts, run a new seed of `input_budgets` rows for that season (copy the SQL from Migration 020, change `'2025-26'` to the new season ID).
