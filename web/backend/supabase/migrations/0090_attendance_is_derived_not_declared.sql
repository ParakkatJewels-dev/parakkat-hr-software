-- 0090 — Nobody declares their own attendance.
--
-- `attendance_insert` (0007) admits `attendance.punch`:
--
--     with check (app.has_perm('attendance.punch',  entity_id, …, employee_id)
--             or  app.has_perm('attendance.manage', entity_id, …, employee_id))
--
-- Every role holds attendance.punch, including `employee` at self scope. So any signed-in employee
-- could POST a row to /rest/v1/attendance for themselves on any date with no existing row:
--
--     status 'Present', day_fraction 1  →  and payable_days is sum(day_fraction).
--
-- Verified against the live database as the real employee login: the insert SUCCEEDED. A colleague's
-- row was correctly refused, so this was never a way to touch anyone else — only to manufacture
-- one's own paid day.
--
-- WHY attendance.punch IS THE WRONG KEY HERE
-- It was seeded in 0008 as "Check in/out", for an in-app punch button. There is no such button:
-- Attendance.jsx says so in its own header — punching happens at the terminal, and the row is
-- DERIVED from raw_punches by the engine. Confirmed before writing this:
--
--   · the permission appears in exactly ONE policy, this one, and nowhere in the frontend or the
--     attendance service
--   · all four `from('attendance')` call sites in web/src are `.select()`
--   · the engine writes through Prisma on the direct Postgres URL, which bypasses RLS entirely
--     (services/attendance/src/lib/db.ts says so at the top), so it is unaffected by this change
--   · raw_punches already refuses an employee insert, so the punch route was closed anyway
--
-- So this removes a capability nothing uses and nothing needs.
--
-- attendance.manage stays, which leaves HR a manual path and makes the table symmetric: the UPDATE
-- policy has required attendance.manage since 0007. The odd part was never that you could not edit
-- your attendance — it was that you could create it.
--
-- The permission itself is left in place rather than dropped. It is granted to all seven roles and
-- referenced by 0080's monotonic closure; removing it would be a wider change than this needs, and
-- once it is out of this policy it grants nothing.

begin;

drop policy if exists attendance_insert on public.attendance;

create policy attendance_insert on public.attendance
  for insert to authenticated
  with check (
    app.has_perm('attendance.manage', entity_id, zone_id, branch_id, department_id, employee_id)
  );

comment on table public.attendance is
  'Derived from raw_punches by services/attendance. Written by the engine on a connection that bypasses RLS; through PostgREST it takes attendance.manage to insert and to update, so nobody can declare their own day.';

commit;
