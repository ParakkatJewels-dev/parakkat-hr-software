-- 0035_config_scope_and_polish.sql
-- Closes the remaining audit findings. The first group are FUNCTIONAL bugs, not just hardening:
-- several config policies check the permission with an all-NULL ancestry, which only a GLOBAL
-- grant can satisfy — and nobody holds these permissions globally (0008/0013/0014 grant them at
-- entity scope to entity_admin / hr_manager). Net effect today:
--   * the seeded default shift (entity_id is null) is uneditable by anyone but a super admin,
--     even though Attendance Setup is where HR is told to set shift timings;
--   * leave types cannot be created or edited by HR at all;
--   * the recompute queue is invisible to the people who manage attendance.
-- These are org-wide configuration tables with no per-employee ancestry, so the correct test is
-- "holds the permission at any scope" (plus the entity match where the row has one).
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- shifts / holidays / leave types / recompute queue
-- ---------------------------------------------------------------------------
drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts for all to authenticated
  using (
    app.has_perm('shift.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_any_scope('shift.manage'))
  )
  with check (
    app.has_perm('shift.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_any_scope('shift.manage'))
  );

drop policy if exists holcal_write on public.holiday_calendars;
create policy holcal_write on public.holiday_calendars for all to authenticated
  using (
    app.has_perm('holiday.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_any_scope('holiday.manage'))
  )
  with check (
    app.has_perm('holiday.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_any_scope('holiday.manage'))
  );

-- holidays hang off a calendar and carry no ancestry of their own.
drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays for all to authenticated
  using (app.has_perm_any_scope('holiday.manage'))
  with check (app.has_perm_any_scope('holiday.manage'));

-- leave_types are company-wide (no entity column).
drop policy if exists leave_types_write on public.leave_types;
create policy leave_types_write on public.leave_types for all to authenticated
  using (app.has_perm_any_scope('leave.manage'))
  with check (app.has_perm_any_scope('leave.manage'));

drop policy if exists recompute_select on public.attendance_recompute_queue;
create policy recompute_select on public.attendance_recompute_queue for select to authenticated
  using (app.has_perm_any_scope('attendance.manage'));

-- ---------------------------------------------------------------------------
-- org_settings: keep the generic key/value store from becoming a future leak
-- ---------------------------------------------------------------------------
drop policy if exists org_settings_select on public.org_settings;
create policy org_settings_select on public.org_settings for select to authenticated
  using (key = 'workspace' or app.is_super_admin());

-- ---------------------------------------------------------------------------
-- update_my_profile: validate the one field it writes
-- ---------------------------------------------------------------------------
create or replace function public.update_my_profile(_phone text)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  _emp   uuid;
  _clean text := nullif(btrim(coalesce(_phone, '')), '');
begin
  _emp := app.current_employee_id();
  if _emp is null then
    raise exception 'no employee record is linked to this login';
  end if;
  if _clean is not null then
    if length(_clean) > 20 then
      raise exception 'phone number is too long';
    end if;
    -- digits, spaces and the usual separators only — this value is rendered all over the app.
    if _clean !~ '^[0-9+()\-\s]+$' then
      raise exception 'phone number may contain only digits and + ( ) - characters';
    end if;
  end if;
  update public.employees set phone = _clean where id = _emp;
end $$;

-- ---------------------------------------------------------------------------
-- report_attendance_summary: RLS already scopes the rows, but the permission should be real
-- ---------------------------------------------------------------------------
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
language plpgsql stable security invoker set search_path = public as $$
begin
  if auth.uid() is not null
     and not (app.has_perm_any_scope('report.read') or app.has_perm_any_scope('attendance.read')) then
    raise exception 'not authorized to view attendance reports';
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
    group by a.branch_id, b.code, b.name
    order by coalesce(b.code, '—');
end $$;

grant execute on function public.report_attendance_summary(date, date) to authenticated;
