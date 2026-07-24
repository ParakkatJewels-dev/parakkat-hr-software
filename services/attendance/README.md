# Attendance service

BioTime sync worker + attendance engine + reporting API for Parakkat HRMS.

Attendance comes from ZKTeco face terminals. Those terminals are managed by **ZKTeco BioTime**,
and BioTime's REST API is the only integration surface — this service never touches the terminals
or BioTime's database directly.

```
ZKTeco terminals  ──►  BioTime (REST)  ──►  this service  ──►  Supabase Postgres  ──►  web app
                                             │
                                             ├── sync worker    every 2 min: punches → raw_punches
                                             ├── engine         punches + shift + leave → attendance
                                             └── API            recompute, exports, device mapping
```

## Why this exists as a separate service

The web app talks straight to Supabase, where Row-Level Security enforces the Role × Scope model.
That works for everything a *user* does. It cannot do the three things this service does:

1. **Run continuously.** Polling BioTime every two minutes needs a long-lived process.
2. **Work across all employees.** The engine must read and write every person's attendance, which
   is precisely what RLS is designed to prevent. It connects with the direct Postgres URL and
   bypasses RLS by design — a trusted background process with no user context.
3. **Generate Excel.** A 250 × 31 register with per-cell formatting is not a browser job.

Everything users read still goes through Supabase/PostgREST with RLS applied. The API here is
small, and each route declares the permission it requires (verified against the caller's Supabase
token — there is no second identity system).

## Setup

```bash
cd services/attendance
npm install
cp .env.example .env          # fill in DATABASE_URL and the BIOTIME_* values
npx prisma generate
npm run doctor                # verify everything before starting the worker
```

### Before the first run

Apply migrations `0012`–`0014` from `web/backend/supabase/migrations/`. They create
`raw_punches`, `devices`, `biotime_employees`, `sync_state`, `sync_runs`, the shift and holiday
tables, leave types/balances, and regularizations — with RLS matching the rest of the schema.

```bash
cd ../../web/backend
# add SUPABASE_DB_URL to .env.local (Dashboard -> Connect -> Session pooler, port 5432)
npm run migrate
```

### `npm run doctor` — run this first

It answers, with real data, the two questions that quietly corrupt everything if assumed wrong:

- **What do BioTime `emp_code`s look like, and do they match `employees.employee_code`?**
  Almost certainly not — the roster importer generates employee codes from Excel row numbers
  (`PPI-0001`), while BioTime uses device enrolment numbers (`101`). See *Device code mapping* below.
- **Is the BioTime server's clock on the timezone `BIOTIME_TIMEZONE` claims?** BioTime returns
  naive local datetimes with no offset. If that box is on UTC while we parse as IST, every punch
  lands 5½ hours out and every downstream number is wrong.

## Environment

Full list with commentary in [.env.example](.env.example). The ones that matter:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase **session pooler**, port 5432 (not 6543 — Prisma needs prepared statements) |
| `BIOTIME_BASE_URL` | e.g. `http://192.168.1.50:8090` |
| `BIOTIME_USERNAME` / `BIOTIME_PASSWORD` | BioTime API user |
| `BIOTIME_TIMEZONE` | Timezone the BioTime server reports punch times in. Verify with `npm run doctor` |
| `APP_TIMEZONE` | Business timezone, `Asia/Kolkata`. Timestamps are stored UTC and converted at the edges |
| `SYNC_TRANSACTIONS_CRON` | Punch poll, default every 2 minutes |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Used to verify caller tokens on the API |

## Running

```bash
npm run dev        # worker + API, with reload
npm run build && npm start
```

In production use a supervisor — [ecosystem.config.cjs](ecosystem.config.cjs) for pm2 or
[deploy/parakkat-attendance.service](deploy/parakkat-attendance.service) for systemd.

```bash
npm run build
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

Run exactly **one** instance. Two would both run the cron schedule and double every sync.

## Commands

| Command | What it does |
|---|---|
| `npm run doctor` | Connectivity, timezone and code-mapping check. Start here |
| `npm run sync:once` | Pull new punches once |
| `npm run sync:employees` | Pull the BioTime roster + terminals, refresh match suggestions |
| `npm run sync:once -- --catchup --days 7` | Re-scan the trailing window for late uploads |
| `npm run backfill -- --from 2026-01-01 --to 2026-03-31` | Historical punches, in weekly chunks |
| `npm run backfill -- --from … --recompute` | …and run the engine over the range afterwards |
| `npm run recompute -- --month 2026-07` | Re-derive a month |
| `npm run recompute -- --from … --to … --employee <uuid>` | Re-derive one person |
| `npm run recompute -- --queue` | Drain pending corrections |
| `npm run seed` | Realistic fake punches so the frontend works without BioTime |
| `npm run test` | Engine rule tests (no database needed) |

## How the sync stays correct

**Nothing is lost and nothing is duplicated**, which comes from three things working together:

- `raw_punches` has `unique (emp_code, punch_time)`, and every insert is `ON CONFLICT DO NOTHING`.
  Re-reading a window is therefore free.
- Each poll re-queries with a **5-minute overlap** before the cursor. Punches sharing a boundary
  second with the previous batch cannot fall through the gap.
- The cursor **advances only after a run completes**. A crash mid-run re-reads; it never skips.

Two failure modes are handled explicitly because they are not obvious:

- **Late uploads.** A terminal that loses its network stores punches locally and uploads them when
  it recovers — with their *original* punch time, already behind the cursor. The incremental poll
  structurally cannot see those, so a nightly catch-up re-scans the last few days.
- **BioTime restarts / 401s.** Both auth schemes are supported (`/api-token-auth/` with
  `Authorization: Token`, and `/jwt-api-token-auth/` with `Authorization: JWT`). The working one is
  probed once and cached. Any 401 triggers one re-authenticate-and-retry; transport failures back
  off exponentially with jitter.

## Device code mapping

**This is the step that makes the pipeline usable, and it needs a human once.**

BioTime `emp_code`s are device enrolment numbers. `employees.employee_code` is generated by the
roster importer from Excel row numbers. They do not correspond, so an exact-code join links
essentially nobody.

The roster sync therefore ranks candidates by name similarity (Dice coefficient over character
bigrams, blended with token overlap, nudged by department/area agreement) and stores them on
`biotime_employees.match_suggestions`. HR confirms them in **Attendance Setup → Devices & mapping**.

Only an exact, unambiguous code match auto-links. A fuzzy name score never does, however confident
it looks: a wrong auto-link files one person's attendance under another's name, which is far worse
than a code sitting in a queue. `manual` and `ignored` decisions are never overwritten by a later
sync.

Punches for an unmapped code are still stored — with a null `employee_id`, so they carry no
ancestry and are visible only to global-scope admins. Confirming the mapping afterwards adopts
every historical punch under that code and queues those dates for recompute.

## The engine

`processDay` is a pure function: no database, no clock, no I/O. That is what makes recomputing a
historical date produce the same answer today as it did last month, and what lets the rules be
tested without infrastructure (`npm run test`, 21 cases).

Given a date's punches, the assigned shift, the holiday calendar and any approved leave or
regularization, it derives check-in (first punch), check-out (last punch), worked minutes,
lateness, early exit, overtime, a status, and `day_fraction` — the payable credit (1, 0.5 or 0)
that payroll sums.

Edge cases handled explicitly:

- **Single punch day** → `Missing Punch`, credited 0.5 pending regularization. Not a zero-hour
  "Present", and not "Absent" either — the person demonstrably came in.
- **Night shift crossing midnight** → the punch window follows the shift into the next calendar
  day, so a 22:00–06:00 worker's morning exit is credited to the day they started.
- **Duplicate punches** → collapsed within `PUNCH_DEDUPE_SECONDS` (default 60). Without this, a
  double-tap on the reader can look like an 8-second working day.
- **No shift assigned** → `No Shift`, surfaced as an exception. Marking someone absent because
  nobody assigned them a shift would be an HR data problem masquerading as an attendance fact.

**Idempotent by contract.** Recomputing a range overwrites those rows cleanly, so rules can change
and history can be re-derived. Rows flagged `is_locked` (finalised payroll) are skipped unless
`--include-locked` is passed.

### Everything that changes an outcome triggers a recompute

Enforced by database triggers, not application code, so an approval from the UI, a script or the
SQL editor all behave identically. Approving leave, deciding a regularization, reassigning a shift,
editing a holiday or mapping a device code queues the affected employee-dates in
`attendance_recompute_queue`; the worker drains it every 5 minutes.

## Reports

Both are generated server-side and stream straight to the browser.

- **Monthly attendance register** — per employee per day status grid, colour-coded, with totals.
  `GET /api/exports/register?year=2026&month=7`
- **Payroll export** — per employee for a month: days present, paid leave, LOP, payable days, OT.
  `GET /api/exports/payroll?year=2026&month=7&columns=employee_code,full_name,payable_days,ot_hours`

The payroll column layout is **configurable** because payroll formats are specific to whoever
processes them. Available columns come from `GET /api/exports/payroll/columns`; the catalog is in
[src/exports/columns.ts](src/exports/columns.ts) and adding a derived column means adding one
entry there.

## API

Every route requires a valid Supabase access token and declares a permission.

| Route | Permission |
|---|---|
| `GET /health` | none — for the supervisor and uptime monitoring |
| `GET /api/status` | `device.manage` / `attendance.manage` |
| `POST /api/sync/transactions`, `/employees`, `/catchup` | `device.manage` |
| `POST /api/backfill` | `device.manage` |
| `POST /api/recompute`, `/api/recompute/queue` | `attendance.manage` |
| `GET /api/mapping`, `POST /api/mapping/link`, `/suggest` | `device.manage` |
| `GET /api/exports/register`, `/payroll` | `report.read` / `attendance.read` |

`/health` returns **503** when the database is unreachable *or* the punch sync has not succeeded
for 30 minutes. The second condition is the one that matters operationally: the process can be
perfectly alive while silently collecting no attendance.

## Backups

[deploy/backup.sh](deploy/backup.sh) takes a verified daily `pg_dump`, keeps 14 dailies and 8
weeklies, and refuses to keep a dump it cannot read back.

**Restore procedure: [deploy/RESTORE.md](deploy/RESTORE.md).** Read it before you need it. The key
point: `public.attendance` is *derived* and can always be rebuilt from `raw_punches` with
`npm run recompute` — and punches themselves can be re-pulled from BioTime with `npm run backfill`.
Restoring from a dump is rarely the right first move.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| No punches arriving | `npm run doctor`, then Attendance Setup → Sync status for the last error |
| Punches arriving, no attendance rows | Codes are probably unmapped — check Devices & mapping |
| Everyone marked Half Day on a shift | `full_day_minutes` exceeds what the shift allows after the break. The DB constraint now rejects this, but check existing shifts |
| Times out by 5½ hours | `BIOTIME_TIMEZONE` does not match the BioTime server's clock |
| Attendance looks stale | Check `attendance_recompute_queue` for a backlog, or run `npm run recompute -- --queue` |
| Worker restarting repeatedly | `pm2 logs parakkat-attendance`. Crash loops are usually bad credentials or an unreachable database |
