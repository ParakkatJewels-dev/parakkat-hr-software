# Parakkat HRMS

Multi-entity HR software for the Parakkat group. Access is **centralized in admin but scoped by branch and department** — a Role × Scope model enforced by Postgres Row-Level Security on Supabase.

## Repo layout

```
HR_Software/
├── web/          React 19 + Vite + Tailwind v4 web app (the UI, builds to web/dist)
│   ├── src/      components, auth/, lib/, pages/, data/  ·  .env.local (public Supabase keys)
│   └── backend/  Supabase schema + tooling (no running server; Supabase is hosted)
│       ├── supabase/migrations/   ordered SQL: schema, RBAC, RLS, seed (0001–0014)
│       ├── supabase/functions/    invite-user Edge Function
│       ├── scripts/               import_employees.py, create_user.py, migrate.js
│       ├── CompanyDetails/        source employee rosters (.xlsx)
│       └── .env.local             service_role secret (never shipped; dev server blocks it)
├── services/
│   └── attendance/   Node + TypeScript service: BioTime sync worker, attendance engine,
│                     reporting API. The one long-running process in the system
├── android/      native Android app (Capacitor shell around the web build)
├── ios/          native iOS app (Capacitor shell; build on a Mac)
├── capacitor.config.json   mobile config (appId, webDir -> web/dist)
├── package.json  root: mobile build scripts (cap:sync / android / ios) + Capacitor toolchain
├── MOBILE.md     mobile build/run guide
├── featuresList  product brief
└── README.md
```

Web app: `cd web && npm run dev`. Attendance service: `cd services/attendance && npm run dev`.
Mobile: from the repo root, `npm run android` / `npm run ios` (see [MOBILE.md](MOBILE.md)).

## Attendance

Attendance is sourced from **ZKTeco face-recognition terminals via BioTime**, not from a punch
button in the app. [services/attendance/](services/attendance/) polls BioTime's REST API every two
minutes, stores raw punches, and derives a daily attendance record per employee against their
assigned shift, the holiday calendar, and any approved leave or regularization.

```
ZKTeco terminals ─► BioTime (REST) ─► attendance service ─► Supabase ─► web + mobile app
```

Everything that changes an attendance outcome — approving leave, deciding a regularization,
reassigning a shift, mapping a device code — queues an automatic recompute of the affected dates,
so figures never drift from the rules that produced them.

Full setup, commands and troubleshooting: **[services/attendance/README.md](services/attendance/README.md)**.

## Access model

Every user gets a **role** (super_admin, entity_admin, hr_manager, zonal_manager, branch_manager, dept_head, employee) granted at a **scope** (global / entity / zone / branch / department / self). The same `hr_manager` role granted at different scopes gives you per-branch or per-department HR. The org hierarchy (Entity → Zone → Branch → Department → Designation) is admin-editable at runtime. RLS is the real gate; the client-side permission checks only shape the UI.

## Setup

### 1. Backend (Supabase)
1. Create a project at [supabase.com](https://supabase.com). From **Project Settings → API** note the Project URL, anon key, and service_role secret.
2. `cp web/backend/.env.local.example web/backend/.env.local` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_DB_URL` (Dashboard → Connect → *Session pooler*, port 5432).
3. Apply the migrations **in order**: `cd web/backend && npm install && npm run migrate`.
   (Or paste `supabase/migrations/0001` … `0014` into the dashboard SQL Editor by hand.)
4. Create the admin login (**Authentication → Users → Add user**: `prteam@parakkatjewels.com`), then in the SQL Editor:
   `select public.bootstrap_super_admin('prteam@parakkatjewels.com');`
5. Load the real staff: `python web/backend/scripts/import_employees.py` (use `--dry-run` to preview without keys).

### 2. Web app
```bash
cd web
npm install
cp .env.local.example .env.local   # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev
```

Open the app, sign in with the admin login, and you'll have full (Super Admin) access.

### 3. Attendance service
```bash
cd services/attendance
npm install
cp .env.example .env               # DATABASE_URL + BIOTIME_* values
npx prisma generate
npm run doctor                     # verify BioTime, the clock, and code mapping BEFORE syncing
npm run dev
```

`npm run doctor` is not optional politeness — it checks two things that silently corrupt every
downstream number if they are wrong: whether the BioTime server's clock matches the timezone we
parse its punch times as, and whether BioTime's device codes correspond to `employees.employee_code`
(they almost certainly do not, which is why there is a mapping screen).

No BioTime connection yet? `npm run seed` generates a month of realistic fake punches so the
frontend can be developed against real-looking data.
