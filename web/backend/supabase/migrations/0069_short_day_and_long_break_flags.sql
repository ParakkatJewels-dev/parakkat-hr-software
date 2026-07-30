-- Flag the two exceptions a flexible shift can actually have.
--
-- The exceptions list on the attendance screen filters the table directly:
--
--   is_late, is_missing_punch, is_early_exit, status = Absent, status = No Shift
--
-- On a flexible shift the first and third are never set, and short hours stopped demoting a day in
-- 0062 — so somebody who worked three hours and went home appears in that list as nothing at all.
-- 7708 such days exist. The list is answering the questions of the old fixed shift.
--
-- 0068 added the counts to the summary report. This adds the flags the LIST needs, because the two
-- conditions cannot be expressed in a PostgREST filter: both compare a row against its own shift,
-- and the client cannot join. The engine already holds both numbers at the moment it decides the
-- day, so it is the only place that can say so without a second copy of the rule.
--
--   is_short_day    attended, finished, and worked more than the tolerance under the daily hours
--   is_long_break   break ran past the allowance, so time was deducted
--
-- breaks_incomplete already exists and covers the third case — an odd number of middle punches, so
-- the break was only partly measurable. That one can only ever UNDER-count, which means the day may
-- be overpaid; it is a data-quality exception rather than a behavioural one.

alter table public.attendance
  add column if not exists is_short_day  boolean not null default false,
  add column if not exists is_long_break boolean not null default false;

comment on column public.attendance.is_short_day is
  'Attended and finished the day, but worked more than shifts.short_day_tolerance_minutes under the '
  'daily hours. The headline exception on a flexible shift, where leaving early is otherwise '
  'invisible: the day is still Present with full credit by policy.';

comment on column public.attendance.is_long_break is
  'Break exceeded the shift allowance, so the excess was deducted from worked time. Not misconduct — '
  'it is what makes overtime smaller than the clock suggests, and the figure people query.';

-- --- the tolerance belongs to the shift, not to whoever is asking ------------------------------
-- Being four minutes short is not an exception. The median day here is 8h 31m against a 510-minute
-- requirement, so an exact threshold would flag half the company every day and the list would be
-- ignored inside a week. Thirty minutes sits clear of ordinary variation.
--
-- On the shift rather than as a constant because the engine and report_attendance_exceptions both
-- need it, and two constants that are supposed to agree eventually do not.
alter table public.attendance drop column if exists short_day_tolerance_minutes;
alter table public.shifts
  add column if not exists short_day_tolerance_minutes int not null default 30
    constraint shifts_short_day_tolerance_check check (short_day_tolerance_minutes between 0 and 240);

comment on column public.shifts.short_day_tolerance_minutes is
  'How far under the daily hours a day may fall before it counts as short. Read by the engine when '
  'setting attendance.is_short_day and by report_attendance_exceptions, so both agree.';

-- Indexed partially: the exceptions list asks for the true rows only, and they are the minority.
create index if not exists idx_attendance_short_day
  on public.attendance(work_date) where is_short_day;
create index if not exists idx_attendance_long_break
  on public.attendance(work_date) where is_long_break;

-- --- keep the report reading the same tolerance ------------------------------------------------
create or replace function public.report_attendance_exceptions(_from date, _to date)
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
    -- Reads the flag the engine set, rather than recomputing the comparison here. One rule, one
    -- place: a summary that disagreed with the list underneath it would be worse than either.
    count(*) filter (where a.is_short_day),
    count(*) filter (where a.is_long_break),
    count(*) filter (where a.breaks_incomplete)
  from public.attendance a
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
