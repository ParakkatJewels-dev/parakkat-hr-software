-- 0036_scope_floor_for_config.sql
-- Corrects an over-broad fix. 0034/0035 replaced an all-NULL app.has_perm(...) check (satisfiable
-- only by a global grant, i.e. super admin) with app.has_perm_any_scope(...), which ignores scope
-- entirely. That repaired a real functional break — HR could not edit shifts, leave types or
-- holidays — but it also handed company-wide write access to BRANCH- and DEPARTMENT-scoped
-- hr_managers, who the role/scope matrix (0019/0033) exists specifically to bound.
--
-- Worst case it allowed: rebinding a biometric emp_code to another person via biotime_employees
-- and then re-stamping their historical punches with resolve_punch_links — attendance identity
-- theft from a department-scoped account.
--
-- Policy now: company-wide configuration requires the permission at GLOBAL or ENTITY scope;
-- entity-owned rows require it at that entity; and anything naming an employee must pass a scope
-- check against that employee. Idempotent: safe to re-run.

-- Org-wide authority: deliberately excludes zone/branch/department/self grants.
create or replace function app.has_perm_org_wide(_perm text)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.is_super_admin()
      or exists (
        select 1
          from public.role_assignments ra
          join public.role_permissions rp on rp.role_id = ra.role_id
          join public.permissions p on p.id = rp.permission_id
         where ra.user_id = auth.uid()
           and p.key = _perm
           and ra.scope_type in ('global', 'entity')
      );
$$;

-- ---------------------------------------------------------------------------
-- shifts / holiday calendars: entity rows by entity; global rows need org-wide authority
-- ---------------------------------------------------------------------------
drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts for all to authenticated
  using (
    app.has_perm('shift.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_org_wide('shift.manage'))
  )
  with check (
    app.has_perm('shift.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_org_wide('shift.manage'))
  );

drop policy if exists holcal_write on public.holiday_calendars;
create policy holcal_write on public.holiday_calendars for all to authenticated
  using (
    app.has_perm('holiday.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_org_wide('holiday.manage'))
  )
  with check (
    app.has_perm('holiday.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_org_wide('holiday.manage'))
  );

-- holidays inherit their calendar's entity instead of being ungated entirely.
drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays for all to authenticated
  using (
    exists (
      select 1 from public.holiday_calendars hc
       where hc.id = calendar_id
         and (app.has_perm('holiday.manage', hc.entity_id, null, null, null, null)
              or (hc.entity_id is null and app.has_perm_org_wide('holiday.manage')))
    )
  )
  with check (
    exists (
      select 1 from public.holiday_calendars hc
       where hc.id = calendar_id
         and (app.has_perm('holiday.manage', hc.entity_id, null, null, null, null)
              or (hc.entity_id is null and app.has_perm_org_wide('holiday.manage')))
    )
  );

-- leave_types and the recompute queue have no entity column: org-wide authority only.
drop policy if exists leave_types_write on public.leave_types;
create policy leave_types_write on public.leave_types for all to authenticated
  using (app.has_perm_org_wide('leave.manage'))
  with check (app.has_perm_org_wide('leave.manage'));

drop policy if exists recompute_select on public.attendance_recompute_queue;
create policy recompute_select on public.attendance_recompute_queue for select to authenticated
  using (app.has_perm_org_wide('attendance.manage'));

-- ---------------------------------------------------------------------------
-- device roster + sync telemetry
-- ---------------------------------------------------------------------------
drop policy if exists sync_state_select on public.sync_state;
create policy sync_state_select on public.sync_state for select to authenticated
  using (app.has_perm_org_wide('device.manage'));

drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs for select to authenticated
  using (app.has_perm_org_wide('device.manage'));

drop policy if exists biotime_employees_select on public.biotime_employees;
create policy biotime_employees_select on public.biotime_employees for select to authenticated
  using (app.has_perm_org_wide('device.manage'));

-- The binding of a device code to a PERSON is an identity decision: the employee being bound
-- must sit inside the caller's own scope, not merely somewhere in the company.
drop policy if exists biotime_employees_update on public.biotime_employees;
create policy biotime_employees_update on public.biotime_employees for update to authenticated
  using (app.has_perm_org_wide('device.manage'))
  with check (
    app.has_perm_org_wide('device.manage')
    and (
      employee_id is null
      or exists (
        select 1 from public.employees e
         where e.id = employee_id
           and app.has_perm('device.manage', e.entity_id, null, null, null, null)
      )
    )
  );

-- Same rule inside the function that stamps historical punches onto an employee.
create or replace function public.resolve_punch_links(_emp_code text)
returns table (punches_linked integer, employee_id uuid, first_date date, last_date date)
language plpgsql security definer set search_path = app, public as $$
declare
  _emp uuid;
  _n   integer := 0;
  e    record;
begin
  if auth.uid() is not null and not app.has_perm_org_wide('device.manage') then
    raise exception 'not authorized to manage device mappings';
  end if;

  select be.employee_id into _emp
    from public.biotime_employees be
   where be.emp_code = _emp_code and be.employee_id is not null;

  if _emp is null then
    return query select 0, null::uuid, null::date, null::date;
    return;
  end if;

  if auth.uid() is not null and not app.is_super_admin() then
    select * into e from public.employees where id = _emp;
    if e.id is null
       or not app.has_perm('device.manage', e.entity_id, null, null, null, null) then
      raise exception 'that device code is mapped to an employee outside your scope';
    end if;
  end if;

  update public.raw_punches rp
     set employee_id = _emp
   where rp.emp_code = _emp_code and rp.employee_id is null;
  get diagnostics _n = row_count;

  return query
    select _n, _emp,
           min((rp.punch_time at time zone 'Asia/Kolkata')::date),
           max((rp.punch_time at time zone 'Asia/Kolkata')::date)
      from public.raw_punches rp
     where rp.emp_code = _emp_code;
end $$;

-- ---------------------------------------------------------------------------
-- Give every entity its own default shift + holiday calendar, so day-to-day config never
-- depends on the shared global rows that now require org-wide authority.
-- ---------------------------------------------------------------------------
create or replace function app.tg_entity_defaults()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  insert into public.shifts (entity_id, code, name, start_time, end_time, grace_in_minutes,
                             grace_out_minutes, break_minutes, weekly_offs, full_day_minutes,
                             half_day_minutes, is_default)
  select new.id, 'GEN', 'General Shift', '09:30', '18:30', 15, 15, 60, '{0}', 420, 240, true
  where not exists (select 1 from public.shifts s where s.entity_id = new.id and s.code = 'GEN');

  insert into public.holiday_calendars (entity_id, code, name, is_default)
  select new.id, 'DEFAULT', 'Company Holidays', true
  where not exists (
    select 1 from public.holiday_calendars c where c.entity_id = new.id and c.code = 'DEFAULT'
  );
  return new;
end $$;

drop trigger if exists trg_entity_defaults on public.entities;
create trigger trg_entity_defaults
  after insert on public.entities
  for each row execute function app.tg_entity_defaults();
