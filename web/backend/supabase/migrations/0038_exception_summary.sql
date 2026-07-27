-- 0038_exception_summary.sql
-- The dashboard's "Attendance Health / Payroll Readiness" card pulled every exception row for the
-- month — measured at 1,370-2,750 rows (1.2-2.5 MB of JSON) by month end — purely to display six
-- integers. Same shape as report_attendance_summary (0037): resolve the caller's scope once, then
-- aggregate in Postgres. Payload drops to a single row.
-- Idempotent: safe to re-run.

create or replace function public.report_attendance_exceptions(_from date, _to date)
returns table (
  missing_punches bigint,
  late_marks      bigint,
  absences        bigint,
  no_shift        bigint,
  early_exits     bigint,
  half_days       bigint
)
language plpgsql stable security definer set search_path = app, public as $$
declare
  _all      boolean;
  _ents     uuid[];
  _zones    uuid[];
  _brs      uuid[];
  _depts    uuid[];
  _has_self boolean;
  _self     uuid;
begin
  if _from is null or _to is null then
    raise exception 'a date range is required';
  end if;

  if auth.uid() is not null
     and not (app.has_perm_any_scope('report.read') or app.has_perm_any_scope('attendance.read')) then
    raise exception 'not authorized to view attendance data';
  end if;

  _all := auth.uid() is null or app.is_super_admin();

  if not _all then
    select
      bool_or(ra.scope_type = 'global'),
      coalesce(array_agg(distinct ra.scope_id) filter (where ra.scope_type = 'entity'),     '{}'),
      coalesce(array_agg(distinct ra.scope_id) filter (where ra.scope_type = 'zone'),       '{}'),
      coalesce(array_agg(distinct ra.scope_id) filter (where ra.scope_type = 'branch'),     '{}'),
      coalesce(array_agg(distinct ra.scope_id) filter (where ra.scope_type = 'department'), '{}'),
      bool_or(ra.scope_type = 'self')
      into _all, _ents, _zones, _brs, _depts, _has_self
      from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
     where ra.user_id = auth.uid()
       and p.key in ('report.read', 'attendance.read');

    _all := coalesce(_all, false);
    _self := case when coalesce(_has_self, false) then app.current_employee_id() else null end;
  end if;

  return query
    select
      count(*) filter (where a.is_missing_punch),
      count(*) filter (where a.is_late),
      count(*) filter (where a.status = 'Absent'),
      count(*) filter (where a.status = 'No Shift'),
      count(*) filter (where a.is_early_exit),
      count(*) filter (where a.status = 'Half Day')
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
end $$;

grant execute on function public.report_attendance_exceptions(date, date) to authenticated;
