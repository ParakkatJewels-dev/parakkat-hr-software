# Parakkat HRMS

Multi-entity HR software for the Parakkat group. Access is **centralized in admin but scoped by branch and department** — a Role × Scope model enforced by Postgres Row-Level Security on Supabase.

## Repo layout

```
HR_Software/
├── frontend/     React 19 + Vite + Tailwind v4 web app (the UI, builds to frontend/dist)
│   └── src/      components, auth/, lib/, pages/, data/  ·  .env.local (public Supabase keys)
├── backend/      Supabase backend + tooling (no running server; Supabase is hosted)
│   ├── supabase/migrations/   ordered SQL: schema, RBAC, RLS, seed (0001–0011)
│   ├── supabase/functions/    invite-user Edge Function
│   ├── scripts/               import_employees.py, create_user.py
│   ├── CompanyDetails/        source employee rosters (.xlsx)
│   └── .env.local             service_role secret
├── android/      native Android app (Capacitor shell around the web build)
├── ios/          native iOS app (Capacitor shell; build on a Mac)
├── capacitor.config.json   mobile config (appId, webDir -> frontend/dist)
├── package.json  root: mobile build scripts (cap:sync / android / ios) + Capacitor toolchain
├── MOBILE.md     mobile build/run guide
├── featuresList  product brief
└── README.md
```

Web app: `cd frontend && npm run dev`. Mobile: from the repo root, `npm run android` / `npm run ios`
(see [MOBILE.md](MOBILE.md)).

## Access model

Every user gets a **role** (super_admin, entity_admin, hr_manager, zonal_manager, branch_manager, dept_head, employee) granted at a **scope** (global / entity / zone / branch / department / self). The same `hr_manager` role granted at different scopes gives you per-branch or per-department HR. The org hierarchy (Entity → Zone → Branch → Department → Designation) is admin-editable at runtime. RLS is the real gate; the frontend permission checks only shape the UI.

## Setup

### 1. Backend (Supabase)
1. Create a project at [supabase.com](https://supabase.com). From **Project Settings → API** note the Project URL, anon key, and service_role secret.
2. In the dashboard **SQL Editor**, run `backend/supabase/migrations/0001` … `0008` **in order**.
3. `cp backend/.env.local.example backend/.env.local` and fill in `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
4. Create the admin login (**Authentication → Users → Add user**: `prteam@parakkatjewels.com`), then in the SQL Editor:
   `select public.bootstrap_super_admin('prteam@parakkatjewels.com');`
5. Load the real staff: `python backend/scripts/import_employees.py` (use `--dry-run` to preview without keys).

### 2. Frontend
```bash
cd frontend
npm install
cp .env.local.example .env.local   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev
```

Open the app, sign in with the admin login, and you'll have full (Super Admin) access.
