# Parakkat HRMS — Backend

This is the **Supabase backend**: there is no long-running server to deploy — Supabase hosts the
Postgres database, auth, and (optionally) Edge Functions. This folder holds everything that defines
and populates that backend.

## Structure

```
backend/
├── README.md                     this file
├── .env.local.example            copy -> .env.local (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
├── CompanyDetails/               source employee rosters (.xlsx) used by the importer
├── scripts/
│   ├── import_employees.py        load rosters -> entities/branches/designations/employees (idempotent)
│   └── create_user.py             provision a login (admin API); optional --super-admin
└── supabase/
    ├── migrations/                ordered SQL — run these in the dashboard SQL editor, in order
    │   ├── 0001_init.sql          extensions, scope_type enum, app schema
    │   ├── 0002_org.sql           entities/zones/branches/departments/designations
    │   ├── 0003_identity.sql      employees + profiles (+ auth trigger, ancestry trigger)
    │   ├── 0004_rbac.sql          roles/permissions/role_permissions/role_assignments
    │   ├── 0005_functions.sql     app.has_perm + helpers + guards + get_my_access
    │   ├── 0006_modules.sql       leaves/expenses/attendance/tickets/assets (+ ancestry stamp)
    │   ├── 0007_rls.sql           RLS policies + grants for every table
    │   ├── 0008_seed_rbac.sql     seed the 7 roles + permission catalog
    │   ├── 0009_admin_rpcs.sql    list_managed_users + link_user_to_employee
    │   ├── 0010_modules2.sql      payslips/documents/jobs/candidates/onboarding/exits (+ RLS)
    │   ├── 0011_audit.sql         audit_log + triggers on the security-relevant tables
    │   ├── 0012_biotime.sql       BioTime ingest: devices, biotime_employees, raw_punches,
    │   │                          sync_state, sync_runs (+ code-linking functions)
    │   ├── 0013_attendance_engine.sql  shifts, shift assignments, holiday calendars, and
    │   │                          public.attendance extended into the engine's daily record
    │   ├── 0014_leave_regularization.sql  leave types/balances with LOP, regularizations,
    │   │                          and the triggers that queue an attendance recompute
    │   └── 0015_repair_attendance_fks.sql  idempotent: adds any attendance FK that a partial
    │                              0013/0014 run left out, then reloads the PostgREST cache
    └── functions/                 Edge Functions (deployed with the Supabase CLI)
        └── invite-user/           service-role user invitation (optional; script is the no-CLI path)
```

## Setup order (run once)

1. Create a Supabase project; copy the **Project URL**, **anon** key, **service_role** key.
2. `cp .env.local.example .env.local` and fill `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
   (The web app uses `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in `web/.env.local`.)
3. Apply the migrations in `supabase/migrations/` **in numeric order**. Two ways:
   - **Recommended (no CLI):** add `SUPABASE_DB_URL` to `.env.local` (dashboard → Connect →
     *Session pooler*, port 5432), then `npm install && npm run migrate`. The script applies
     each file once inside its own transaction and tracks progress in `_migrations.applied`,
     so it is safe to re-run. If the schema was already created by hand, run
     `npm run migrate -- --baseline` once to sync the tracker.
   - **Manual:** paste each file into the dashboard SQL Editor in order.
4. `python scripts/import_employees.py` to load the real staff.
5. `python scripts/create_user.py admin@parakkat.com --super-admin` to make the first admin.

> `npm run dev` here just prints these commands — the backend is hosted, so there is no local
> server to start. (It used to run `supabase start`, which this project doesn't use.)

## Design notes

- **Security is in the database.** Every table has Row-Level Security; the single function
  `app.has_perm(perm, entity, zone, branch, dept, employee)` decides access. Scope inheritance is
  implicit because each row carries its full ancestry (entity/zone/branch/department ids).
- **Roles × Scope.** A role (e.g. `hr_manager`) is granted at a scope (branch=CDA), giving
  branch/department-level HR without extra roles.
- **Module rows** carry `employee_id` + ancestry stamped by a trigger, so RLS filters without joins.
  Note: PostgREST embeds must disambiguate tables with two FKs to `employees` (e.g.
  `employee:employees!leaves_employee_id_fkey(...)` because of `employee_id` + `approver_id`).
