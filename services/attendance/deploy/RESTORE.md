# Restore procedure

Read this **now**, not during an incident. The one step people get wrong under pressure is
restoring into the live database instead of a scratch one — see "Restore to a scratch database
first" below.

## What is backed up

`deploy/backup.sh` takes a `pg_dump --format=custom` of the whole Supabase Postgres database:
schema, data, functions, triggers and RLS policies. Roles and ownership are excluded
(`--no-owner --no-acl`) because Supabase manages those itself.

| | |
|---|---|
| Location | `/var/backups/parakkat/daily/` (and `weekly/` on Sundays) |
| Schedule | 02:45 IST daily, via cron |
| Retention | 14 daily, 8 weekly |
| Format | PostgreSQL custom archive (`pg_restore`) |

Supabase also takes its own automated backups on paid plans (Dashboard → Database → Backups).
Those are the faster path for a full point-in-time restore; this script exists so a copy lives
somewhere you control and can restore from selectively.

## Before restoring anything

1. **Stop the sync worker**, so it does not write into a database you are rebuilding:
   ```bash
   pm2 stop parakkat-attendance     # or: sudo systemctl stop parakkat-attendance
   ```
2. **Establish what actually broke.** Restoring is rarely the right first move:
   - A bad migration → fix forward with a new migration.
   - Wrong attendance figures → `npm run recompute -- --month YYYY-MM`. Attendance is *derived*;
     it can always be rebuilt from `raw_punches` without a restore.
   - Punches missing for a date range → `npm run backfill -- --from … --to …`. BioTime still has
     them; it is the system of record for punches.
   - Genuine data loss (a table dropped, rows deleted) → restore.

That second point is worth dwelling on: everything in `public.attendance` is reproducible from
`raw_punches` plus the shift/leave/holiday configuration. The only truly irreplaceable data is
`raw_punches` itself — and even that exists in BioTime.

## Restore to a scratch database first

Never restore straight over the live database. Restore beside it, verify, then swap or copy across.

```bash
# 1. Create an empty scratch database (locally, or a second Supabase project)
createdb parakkat_restore_test

# 2. Restore into it
pg_restore \
  --dbname="postgresql://postgres:PASSWORD@localhost:5432/parakkat_restore_test" \
  --no-owner --no-acl \
  --jobs=4 \
  /var/backups/parakkat/daily/parakkat-20260723-024500.dump

# 3. Check it is what you expect
psql "postgresql://postgres:PASSWORD@localhost:5432/parakkat_restore_test" -c "
  select 'employees'   as t, count(*) from public.employees
  union all select 'raw_punches',  count(*) from public.raw_punches
  union all select 'attendance',   count(*) from public.attendance
  union all select 'leaves',       count(*) from public.leaves;
"
```

`pg_restore` will print errors about extensions and roles it cannot create (`auth`, `supabase_admin`
and similar). Against a plain Postgres instance those are expected and harmless — the tables and
data still restore. They are only a problem if `public.employees` ends up empty.

## Recovering specific data

Usually only one table needs recovering. Restore just that table into a scratch database, then copy
the rows across — far less disruptive than a whole-database rollback.

```bash
# Restore one table into the scratch database
pg_restore --dbname="$SCRATCH_URL" --no-owner --table=raw_punches backup.dump

# Copy the rows into production, ignoring ones already present
psql "$SCRATCH_URL" -c "\copy (select * from public.raw_punches where punch_time >= '2026-07-01') to '/tmp/punches.csv' csv header"
psql "$PROD_URL"    -c "create temp table incoming (like public.raw_punches including defaults)"
psql "$PROD_URL"    -c "\copy incoming from '/tmp/punches.csv' csv header"
psql "$PROD_URL"    -c "insert into public.raw_punches select * from incoming on conflict do nothing"
```

The `on conflict do nothing` matters: `(emp_code, punch_time)` is unique, so re-importing a range
that overlaps existing data is safe.

Then rebuild the derived attendance for whatever you touched:

```bash
cd /opt/parakkat/services/attendance
npm run recompute -- --from 2026-07-01 --to 2026-07-31
```

## Full production restore

Only when the database is genuinely unrecoverable.

1. Restore to scratch and verify (above).
2. Put the app into maintenance — stop the worker; ideally pause the web deployment too.
3. Take a **fresh dump of the broken database first**. It is evidence, and you may need something
   out of it later.
4. On Supabase, prefer the dashboard's own restore (Database → Backups) — it handles the `auth`
   schema and roles that `pg_dump --no-owner` deliberately skips.
5. If restoring the file by hand into a fresh project:
   ```bash
   pg_restore --dbname="$NEW_DB_URL" --no-owner --no-acl --jobs=4 backup.dump
   ```
6. Re-apply anything newer than the backup:
   ```bash
   npm run migrate                                   # from web/backend — brings the schema up to date
   npm run backfill -- --from <backup date> --to today --recompute
   ```
   Because the backfill re-reads BioTime, punches since the backup are recovered in full.
7. Restart the worker and confirm on the admin status page that a sync succeeds.

## Verifying backups actually work

`backup.sh` checks each dump is a readable archive with a plausible table count, and deletes it if
not. That catches truncated files, not bad data.

**Once a quarter, do a real restore** to a scratch database and run the row-count query above. A
backup regime nobody has ever exercised is the most common way to discover, at the worst possible
moment, that it has been writing 4 KB of error text every night for a year.
