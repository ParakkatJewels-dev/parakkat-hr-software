-- 0037_report_summary_performance.sql
-- PERFORMANCE. Measured on a synthetic year at real scale (264 employees, 96,360 attendance rows):
--
--   monthly branch report, SECURITY INVOKER + RLS ...... 3,789 ms
--   the same aggregate with RLS bypassed ...................  9 ms
--
-- 99.8% of the time was RLS. app.has_perm() is SECURITY DEFINER, which Postgres can never inline,
-- so an aggregate over 96k rows pays 96k function calls, each running a three-table join plus an
-- auth.uid() parse and a profiles lookup. It gets linearly worse every year.
--
-- Fix: resolve the caller's scope ONCE, then run a plain indexed aggregate — the same pattern the
-- attendance service already uses for its Excel exports. That means SECURITY DEFINER, so the scope
-- filter here IS the security boundary and must cover every scope type explicitly. Measured after:
-- 22 ms (172x faster), verified to exclude another entity's rows.
--
-- Fail-closed: a caller whose grants resolve to nothing matches no rows.
-- Idempotent: safe to re-run.

create or replace function public.report_attendance_summary(_from date, _to date)
returns table (
  branch_id       uuid,
  branch_code     text,
  branch_name     text,
  employees       bigint,
  present_days    bigint,
  half_days       bigint,
  absent_days     bigint,
  leave_days      bigint,
  lop_days        bigint,
  late_marks      bigint,
  missing_punches bigint,
  ot_minutes      bigint
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
    raise exception 'not authorized to view attendance reports';
  end if;

  -- Trusted server-side contexts (no JWT) and super admins see everything, as they do under RLS.
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
    -- 'self' contributes exactly the caller's own employee row, nothing wider.
    _self := case when coalesce(_has_self, false) then app.current_employee_id() else null end;
  end if;

  return query
    select
      a.branch_id,
      coalesce(b.code, '—'),
      coalesce(b.name, 'Unassigned'),
      count(distinct a.employee_id),
      count(*) filter (where a.status = 'Present'),
      count(*) filter (where a.status = 'Half Day'),
      count(*) filter (where a.status = 'Absent'),
      count(*) filter (where a.status = 'On Leave'),
      count(*) filter (where a.is_lop),
      count(*) filter (where a.is_late),
      count(*) filter (where a.is_missing_punch),
      coalesce(sum(a.ot_minutes), 0)::bigint
    from public.attendance a
    left join public.branches b on b.id = a.branch_id
   where a.work_date between _from and _to
     and (
       _all
       or a.entity_id     = any (_ents)
       or a.zone_id       = any (_zones)
       or a.branch_id     = any (_brs)
       or a.department_id = any (_depts)
       or (_self is not null and a.employee_id = _self)
     )
   group by a.branch_id, b.code, b.name
   order by coalesce(b.code, '—');
end $$;

grant execute on function public.report_attendance_summary(date, date) to authenticated;

-- The report always filters on a work_date range; make sure the index that serves it is present
-- (0013 creates idx_attendance_work_date; this is a no-op there but keeps the file self-contained).
create index if not exists idx_attendance_work_date on public.attendance (work_date);
