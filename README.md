# CFM Farm Management System

Customised Farm Management — multi-farm management system for the CFM portfolio.

## Stack

- **Frontend**: Vanilla JS ES modules, no build step, hosted on Netlify
- **Backend**: Netlify Functions (Node 18+)
- **Database + Auth**: Supabase (project: `nqvfuqvindsgnogejaei` / cfm-prod)
- **Realtime**: Supabase Realtime WebSocket subscriptions

## Setup

### 1. Supabase schema

Run `supabase-schema.sql` in the Supabase SQL editor. This creates all tables, RLS policies, and enables Realtime for live sync across all clients.

### 2. Netlify environment variables

In **Netlify → Site Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://nqvfuqvindsgnogejaei.supabase.co` |
| `SUPABASE_ANON_KEY` | Your project anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service role key (for admin functions, future use) |

### 3. Anon key in HTML

In `index.html`, replace `YOUR_SUPABASE_ANON_KEY` with your actual anon key.
The anon key is safe to expose — it's protected by Row Level Security.

### 4. Deploy

Push to GitHub. Netlify auto-deploys from the repository root.

For local dev: `npm install && npx netlify dev`

---

## Architecture decisions

### No localStorage — ever
All state lives in Supabase. Local storage caused sync failures in the prototype and is never used. Every write goes to Supabase immediately. Every connected session receives changes via Realtime subscriptions.

### Multi-farm from day one
All tables include `farm_id`. RLS policies enforce farm-level access control. Farm switching is a top-level UI control.

### System boundary with Xero
The invoice is the handoff point. Once an invoice is issued, the `xero_invoice_id` field is populated and payment tracking moves entirely to Xero. CFM does not track payments.

### Commodity-first invoice flow
The commodity type is the first field in every invoice form. This gates the form — livestock hides the forward contract section, cotton auto-reads `cottonRegion` from `farms.settings`.

---

## Module status

| Module | Status |
|---|---|
| **Outputs** | ✅ Full — invoice list, new/edit modal, realtime sync, stats |
| **Inputs** | ✅ Full — all categories incl. fertiliser, realtime sync |
| **Gross Margin** | 🔜 Stub — in development |
| **Agronomy** | 🔜 Stub — paddocks and mapping in development |
| **Weather** | 🔜 Stub — BOM integration in development |

---

## File structure

```
cfm/
├── index.html                  # App shell + login page
├── netlify.toml               # Netlify config
├── package.json
├── supabase-schema.sql        # Run once in Supabase SQL editor
├── .env.example
├── css/
│   └── design-system.css      # Full design system — palette, type, components
├── js/
│   ├── main.js                # App bootstrap, auth gate, module routing
│   ├── supabase-client.js     # All Supabase REST + Realtime (no localStorage)
│   ├── app-state.js           # In-memory session state, farm context
│   └── ui.js                  # Toast, modal, formatters, DOM helpers
├── modules/
│   ├── outputs/outputs.js     # Invoice management
│   ├── inputs/inputs.js       # Input purchases (fertiliser section within)
│   ├── gross-margin/          # Budgeting (stub)
│   ├── agronomy/              # Paddocks + mapping (stub)
│   └── weather/               # Weather (stub)
└── netlify/
    └── functions/
        └── auth.js            # Email/password auth via Netlify function
```

## Adding a new farm

```sql
INSERT INTO farms (id, name, location, state, settings)
VALUES ('farm_yourname', 'Station Name', 'Region', 'QLD', '{"cottonRegion": "central"}');
```

Then assign users to the farm via `user_profiles.farm_access`.
