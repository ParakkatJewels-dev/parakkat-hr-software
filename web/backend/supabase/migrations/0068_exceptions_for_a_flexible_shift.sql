-- Exceptions that mean something on a flexible shift.
--
-- The report counts six things: missing punches, late marks, absences, no-shift days, early exits
-- and half days. Three of those cannot happen any more, and the two that matter most are missing.
--
-- WHAT WENT WRONG
-- 0062 made the shift flexible: there is no fixed start, so lateness and early departure are not
-- recorded, and short hours no longer demote a day. Each of those was the right change on its own.
-- Together they emptied three of the six columns — and because "worked far less than the daily
-- hours" was previously visible AS a half day, removing the demotion also removed the only signal
-- that anybody had gone home early. So:
--
--   4795 days more than an hour short of the daily hours -> flagged as nothing
--    978 days under half the daily hours                 -> flagged as nothing
--   1784 days with a break past the 40-minute allowance   -> flagged as nothing
--    655 days with an unpaired break punch                -> flagged as nothing
--
-- A day where somebody worked three hours and left now reads Present, full credit, no exception.
-- That is the opposite of what an exceptions list is for.
--
-- WHAT REPLACES THEM
-- The three dead columns are kept in the result so nothing breaks, and will read zero on a flexible
-- shift — a non-flexible shift elsewhere would still fill them. Three new ones answer the questions
-- the flexible rule actually raises:
--
--   short_days       worked under the daily hours by more than the tolerance below. The headline
--                    exception now: somebody attended and left early.
--   long_breaks      break beyond the allowance, so time was deducted. Not misconduct — it is the
--                    thing that makes overtime smaller than the clock suggests, and the number
--                    people query.
--   unpaired_punches breaks_incomplete: an odd number of middle punches, so the break could only be
--                    measured in part. The measurement is unreliable and can only UNDER-count, which
--                    means the day may be overpaid. A data-quality exception, not a behaviour one.
--
-- The tolerance keeps this list worth reading. Being four minutes short is not an exception; the
-- median day here runs 8h 31m against a 510-minute requirement, so an exact threshold would flag
-- half the company every day and the list would be ignored within a week. Thirty minutes is wide
-- enough to sit clear of ordinary variation and narrow enough to catch a genuinely short day.
-- Dropped rather than replaced: create or replace cannot add columns to a returned TABLE, and
-- three are being added. The grant is reissued at the bottom because dropping takes it with it.
drop function if exists public.report_attendance_exceptions(date, date);

create function public.report_attendance_exceptions(_from date, _to date)
returns table (
  missing_punches  bigint,
  late_marks       bigint,
  absences         bigint,
  no_shift         bigint,
  early_exits      bigint,
  half_days        bigint,
  short_days       bigint,
  long_breaks      bigint,
  unpaired_punches bigint
)
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  _all    boolean;
  _ents   uuid[];
  _zones  uuid[];
  _brs    uuid[];
  _depts  uuid[];
  _self   uuid;
  -- Minutes short of the daily hours before a day is worth anybody's attention. See above.
  _tolerance constant int := 30;
begin
  if _from is null or _to is null then
    raise exception 'both dates are required';
  end if;

  if auth.uid() is not null
     and not (app.has_perm_any_scope('report.read') or app.has_perm_any_scope('attendance.read')) then
    raise exception 'You do not have permission to read attendance reports.' using errcode = '42501';
  end if;

  _all  := auth.uid() is null or app.is_super_admin();
  _self := app.current_employee_id();

  select
    coalesce(array_agg(distinct ra.scope_id) filter (where ra.scope_type = 'entity'),     '{}'),
    coalesce(array_agg(distinct ra.scope_id) filter (where ra.scope_type = 'zone'),       '{}'),
    coalesce(array_agg(distinct ra.scope_id) filter (where ra.scope_type = 'branch'),     '{}'),
    coalesce(array_agg(distinct ra.scope_id) filter (where ra.scope_type = 'department'), '{}'),
    bool_or(ra.scope_type = 'global')
  into _ents, _zones, _brs, _depts, _all
  from public.role_assignments ra
  join public.roles r              on r.id = ra.role_id
  join public.role_permissions rp  on rp.role_id = r.id
  join public.permissions p        on p.id = rp.permission_id
  where ra.user_id = auth.uid()
    and p.key in ('report.read', 'attendance.read');

  _all := coalesce(_all, false) or auth.uid() is null or app.is_super_admin();

  return query
  select
    count(*) filter (where a.is_missing_punch),
    count(*) filter (where a.is_late),
    count(*) filter (where a.status = 'Absent'),
    count(*) filter (where a.status = 'No Shift'),
    count(*) filter (where a.is_early_exit),
    count(*) filter (where a.status = 'Half Day'),
    -- Only days actually attended and finished: an absence is already its own column, and a day
    -- still in progress is not short, it is unfinished.
    count(*) filter (
      where a.day_type = 'working'
        and a.check_in is not null
        and a.check_out is not null
        and s.full_day_minutes is not null
        and a.worked_minutes < s.full_day_minutes - _tolerance
    ),
    count(*) filter (
      where a.day_type = 'working'
        and s.break_minutes is not null
        and a.break_minutes > s.break_minutes
    ),
    count(*) filter (where a.breaks_incomplete)
  from public.attendance a
  left join public.shifts s on s.id = a.shift_id
  where a.work_date between _from and _to
    and (
      _all
      or a.entity_id     = any (_ents)
      or a.zone_id       = any (_zones)
      or a.branch_id     = any (_brs)
      or a.department_id = any (_depts)
      or (_self is not null and a.employee_id = _self)
    );
end;
$$;

revoke all on function public.report_attendance_exceptions(date, date) from public;
grant execute on function public.report_attendance_exceptions(date, date) to authenticated;

comment on function public.report_attendance_exceptions(date, date) is
  'Attendance exceptions in a range, scoped to what the caller may read. late_marks, early_exits '
  'and half_days read zero on a flexible shift, which records none of them — short_days, '
  'long_breaks and unpaired_punches are the flexible-shift equivalents. See migration 0068.';
