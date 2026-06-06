# Bedspace Manager

Web app for managing a bedspace / dormitory: bed map, tenants, utility meter
readings, per-day (Method B) billing, printable Statements of Account, utility
P&L, and monthly/quarterly owner reports.

**Stack:** React + Vite (frontend) · Supabase / Postgres (database + API) · React Router.

---

## 1. Project layout

```
bedspace-web/
├─ src/
│  ├─ pages/        Dashboard, BedMap, Tenants, Utilities, Billing,
│  │                Reports, Activity, PrintRentWater, PrintElectricity
│  ├─ components/   Statement, Toast, MoveInModal, MoveOutModal
│  ├─ lib/          supabase.js (data layer), billing.js, pnl.js, snapshot.js
│  └─ App.jsx       routes + nav
├─ database/        SQL migrations (run in Supabase SQL Editor, in order)
├─ scripts/         one-time data migration from Google Sheets (Node)
├─ public/          logo, SPA redirect for Netlify
├─ .env.example     copy to .env for local dev
├─ vercel.json      build + SPA rewrite config for Vercel
└─ package.json
```

---

## 2. Run locally

```bash
npm install
cp .env.example .env        # then edit .env with your Supabase URL + anon key
npm run dev                 # http://localhost:5173
```

Build / preview a production bundle:

```bash
npm run build               # outputs to dist/
npm run preview
```

---

## 3. Database setup (Supabase)

Create a free project at <https://supabase.com>, then open **SQL Editor** and run
these files **in this order** (each is idempotent / safe to re-run):

| # | File | Purpose |
|---|------|---------|
| 1 | `database/schema.sql`             | rooms, beds, tenants, payments, activity_log, views |
| 2 | `database/seed_rooms_beds.sql`    | seed the rooms + beds |
| 3 | `database/fix_404_602_beds.sql`   | 404 & 602 → 2 beds each |
| 4 | `database/utilities_schema.sql`   | cutoffs + meter_readings + bill view |
| 5 | `database/utilities_rates_v2.sql` | dual provider/bedspace rates + open_cutoff RPC |
| 6 | `database/billing_schema.sql`     | interim (move-out) readings |
| 7 | `database/utilities_pnl.sql`      | provider master line + common-area readings |
| 8 | `database/tenant_splits.sql`      | custom per-room utility split |
| 9 | `database/addons_special.sql`     | add-ons + special/commercial tenant fields |
| 10 | `database/monthly_reports.sql`   | monthly snapshot table |
| 11 | `database/monthly_reports_manual.sql` | manual-backfill column |

Get your **Project URL** and **anon public key** from
**Project Settings → API** and put them in `.env` (local) and in your host's
environment variables (deploy — see below).

### (Optional) migrate existing data from Google Sheets

```bash
node scripts/migrate.mjs            # tenants + bed statuses
node scripts/migrate_utilities.mjs  # meter readings for the active cutoff
```
Edit the sheet ID / GID constants at the top of each script first.

---

## 4. Deploy

The app is a static SPA — any static host works. Two easy options below.
Both need these two **environment variables**:

```
VITE_SUPABASE_URL        = https://YOUR-ref.supabase.co
VITE_SUPABASE_ANON_KEY   = your-anon-public-key
```

### Option A — Vercel (recommended)

1. Push this repo to GitHub (see §5).
2. Go to <https://vercel.com> → **Add New… → Project** → import the repo.
3. Vercel auto-detects Vite. Confirm:
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - (`vercel.json` already sets these + the SPA rewrite so deep links like
     `/billing` don't 404.)
4. **Environment Variables** → add the two `VITE_…` vars above → **Deploy**.
5. You get a `https://<project>.vercel.app` URL. Every `git push` redeploys.

CLI alternative:
```bash
npm i -g vercel
vercel            # first run links the project + prompts login
vercel --prod     # production deploy
```

### Option B — Netlify

1. Push to GitHub. On <https://netlify.com> → **Add new site → Import**.
2. Build command `npm run build`, publish directory `dist`.
3. Add the two `VITE_…` env vars. (`public/_redirects` handles SPA routing.)

---

## 5. Push to GitHub

```bash
git init
git add .
git commit -m "Bedspace Manager"
git branch -M main
git remote add origin https://github.com/<you>/bedspace-web.git
git push -u origin main
```
`.gitignore` already excludes `node_modules/`, `dist/`, and `.env`.

---

## 6. ⚠️ Security note (read before going public)

This app uses Supabase **Row Level Security disabled** and ships the **anon key**
in the browser bundle. That means **anyone who has the site URL + key can read and
write the whole database.** That is fine for a private internal tool, but if you
put it on the public internet you should add at least one of:

- **Supabase Auth login** (email/password) + re-enable RLS with policies that
  require an authenticated user. (Most robust.)
- **Host-level password protection** (Vercel/Netlify password, paid tiers).
- Keep the URL private and treat it as obscure-but-not-secure.

Rotate the anon key in Supabase if it was ever committed to a public repo.
