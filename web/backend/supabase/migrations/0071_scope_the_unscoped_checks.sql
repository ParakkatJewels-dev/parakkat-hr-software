-- Five checks that asked "do you hold this permission?" without asking "over whom?", and one
-- trigger that demanded a permission the action never needed.
--
-- None of this is reachable today: there is one login, a super admin, and app.is_super_admin()
-- short-circuits every check below. All of it becomes live the moment real employee logins exist.

-- =================================================================================================
-- 1. Approving leave should not require permission to recompute attendance
-- =================================================================================================
-- The AFTER triggers on leaves / regularizations / shift assignments call public.enqueue_recompute
-- so the engine re-scores the affected days. Since 0033 that function refuses a caller who lacks
-- attendance.manage over the employee — correct for a hand-made RPC call, wrong for a trigger,
-- because the trigger runs only after RLS has already allowed the row change. The result was that
-- RLS permitted the write and the trigger then aborted the transaction:
--
--   employee      holds leave.create        -> could not file their own leave
--   dept_head     holds leave.approve       -> could not approve leave for their own department
--   zonal_manager holds leave.approve       -> same
--   dept_head     holds regularization.*    -> same for regularizations
--
-- attendance.manage is held only by branch_manager, entity_admin, hr_manager and super_admin, so
-- employee self-service and the whole dept_head approval chain were dead on arrival.
--
-- The split below keeps the guard where it protects something and drops it where it never did.
-- The internal function is not granted to anon or authenticated: it is reachable only from the
-- trigger functions that call it, which are themselves security definer.
create or replace function app.enqueue_recompute_internal(
  _employee_id uuid, _from date, _to date, _reason text default 'system'
) returns integer
language plpgsql security definer set search_path = app, public as $$
declare
  _end date := coalesce(_to, _from);
  _n   integer;
begin
  if _employee_id is null then raise exception 'an employee is required'; end if;
  if _from is null then raise exception 'a start date is required'; end if;
  if _end < _from then raise exception 'the end date is before the start date'; end if;
  -- A queue entry per employee-day: an unbounded range is still a denial-of-service vector even
  -- when the caller is a trigger, because the dates come from user-entered leave rows.
  if _end - _from > 366 then raise exception 'range too large (max 366 days)'; end if;

  insert into public.attendance_recompute_queue (employee_id, work_date, reason)
  select _employee_id, d::date, left(coalesce(_reason, 'system'), 200)
    from generate_series(_from, _end, interval '1 day') d
  on conflict do nothing;

  get diagnostics _n = row_count;
  return _n;
end $$;

revoke execute on function app.enqueue_recompute_internal(uuid, date, date, text)
  from public, anon, authenticated;

-- The three trigger functions, unchanged except for the function they queue through.
create or replace function app.tg_leave_recompute()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'Approved' then
      perform app.apply_leave_balance(new.id);
    elsif old.status = 'Approved' then
      perform app.release_leave_balance(new.id);
    end if;
  elsif tg_op = 'INSERT' and new.status = 'Approved' then
    perform app.apply_leave_balance(new.id);
  end if;

  if tg_op = 'DELETE' then
    perform app.enqueue_recompute_internal(old.employee_id, old.start_date, old.end_date, 'leave deleted');
    return old;
  end if;

  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date
     or new.day_fraction is distinct from old.day_fraction
     or new.type is distinct from old.type then
    perform app.enqueue_recompute_internal(new.employee_id, new.start_date, new.end_date, 'leave ' || new.status);
    if tg_op = 'UPDATE' and (new.start_date is distinct from old.start_date
                             or new.end_date is distinct from old.end_date) then
      perform app.enqueue_recompute_internal(old.employee_id, old.start_date, old.end_date, 'leave dates changed');
    end if;
  end if;

  return new;
end $$;

create or replace function app.tg_regularization_recompute()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'DELETE' then
    perform app.enqueue_recompute_internal(old.employee_id, old.work_date, old.work_date, 'regularization deleted');
    return old;
  end if;

  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.check_in is distinct from old.check_in
     or new.check_out is distinct from old.check_out then
    perform app.enqueue_recompute_internal(new.employee_id, new.work_date, new.work_date,
                                           'regularization ' || new.status);
  end if;

  return new;
end $$;

create or replace function app.tg_shift_assignment_recompute()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _from date;
  _to   date;
begin
  if tg_op = 'DELETE' then
    perform app.enqueue_recompute_internal(old.employee_id, old.effective_from,
                                           coalesce(old.effective_to, current_date), 'shift assignment removed');
    return old;
  end if;

  _from := least(new.effective_from, coalesce(old.effective_from, new.effective_from));
  _to   := greatest(coalesce(new.effective_to, current_date), coalesce(old.effective_to, current_date));
  perform app.enqueue_recompute_internal(new.employee_id, _from, _to, 'shift assignment changed');
  return new;
end $$;

-- =================================================================================================
-- 2. HR could approve leave but never file it
-- =================================================================================================
-- hr_manager holds leave.approve but not leave.create, so the leaves INSERT policy refused them
-- outright — HR could not enter a leave request on behalf of an employee, which is most of what HR
-- does with leave. Only entity_admin and super_admin could.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'leave.create'
where r.key = 'hr_manager'
on conflict do nothing;

-- =================================================================================================
-- 3. The salary component catalog ignored scope entirely
-- =================================================================================================
-- pay_components_select used app.has_perm_any_scope('payroll.manage'), and that helper has no scope
-- predicate at all — it asks only whether you hold the permission SOMEWHERE. Measured: an hr_manager
-- scoped to one department read every component in the company, including ones scoped to other
-- departments. The write policy on the same table was already scoped correctly, so read and write
-- disagreed about who owns a component.
--
-- Now: rows that carry a scope are visible only inside that scope, and rows that carry none —
-- Basic, HRA, PF, the company-wide catalog everyone calculates against — stay readable to anyone
-- who may run payroll at all.
--
-- The second clause deliberately uses has_perm_any_scope rather than the has_perm_org_wide used by
-- the write policy. Editing company-wide configuration should need company-wide authority; reading
-- it should not, or a department-scoped payroll run could not see the components it is made of.
-- Verified: a department-scoped hr_manager now sees the company-wide component and NOT the one
-- scoped to another department. With has_perm_org_wide here they saw neither.
drop policy if exists pay_components_select on public.pay_components;
create policy pay_components_select on public.pay_components for select to authenticated
  using (app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, null)
         or (entity_id is null and app.has_perm_any_scope('payroll.manage')));

-- =================================================================================================
-- 4. A recompute is an org-wide action, so it needs an org-wide permission
-- =================================================================================================
-- request_service_command('recompute') was gated on has_perm_any_scope('attendance.manage'), which
-- let a department-scoped holder with 16 staff queue a rebuild of all 58,344 attendance rows. The
-- command itself takes no scope, so the permission has to carry it.
create or replace function public.request_service_command(_kind text, _params jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare
  _id      uuid;
  _pending integer;
begin
  if _kind = 'recompute' then
    if not app.has_perm_org_wide('attendance.manage') then
      raise exception 'You do not have permission to recompute attendance.' using errcode = '42501';
    end if;
  elsif not app.has_perm_org_wide('device.manage') then
    raise exception 'You do not have permission to run sync operations.' using errcode = '42501';
  end if;

  select count(*) into _pending from public.service_commands
   where kind = _kind and status in ('pending', 'running');

  if _pending > 0 then
    raise exception 'A % is already queued or running.', replace(_kind, '_', ' ')
      using errcode = '55006';
  end if;

  insert into public.service_commands (kind, params, requested_by)
  values (_kind, coalesce(_params, '{}'::jsonb), auth.uid())
  returning id into _id;

  return _id;
end $$;

-- =================================================================================================
-- 5. Devices were invisible to zone-scoped holders, and orphaned devices to everyone
-- =================================================================================================
-- The devices table carries entity_id and branch_id but no zone_id or department_id, and the policy
-- passed NULL for both. A zone-scoped holder therefore saw nothing, even for a device sitting in a
-- branch inside their own zone. The zone is derivable from the branch, so derive it.
--
-- The second clause covers a device with neither entity nor branch set — a terminal that has been
-- enrolled but not yet assigned. Previously it matched nobody below super_admin, so it silently
-- vanished from the entity admin's console rather than showing up as needing attention.
drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices for select to authenticated
  using (app.has_perm('attendance.read', entity_id,
                      (select b.zone_id from public.branches b where b.id = devices.branch_id),
                      branch_id, null, null)
         or (entity_id is null and branch_id is null
             and app.has_perm_org_wide('attendance.read')));

drop policy if exists devices_write on public.devices;
create policy devices_write on public.devices for all to authenticated
  using (app.has_perm('device.manage', entity_id,
                      (select b.zone_id from public.branches b where b.id = devices.branch_id),
                      branch_id, null, null)
         or (entity_id is null and branch_id is null
             and app.has_perm_org_wide('device.manage')))
  with check (app.has_perm('device.manage', entity_id,
                           (select b.zone_id from public.branches b where b.id = devices.branch_id),
                           branch_id, null, null)
              or (entity_id is null and branch_id is null
                  and app.has_perm_org_wide('device.manage')));

-- =================================================================================================
-- 6. link_device_code could point a device code at anyone in the company
-- =================================================================================================
-- Recreated below with a scope check on the target employee. Everything else is unchanged.
CREATE OR REPLACE FUNCTION public.link_device_code(_emp_code text, _employee_id uuid DEFAULT NULL::uuid, _ignore boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  _existing   uuid;
  _status     text;
  _adopted    integer := 0;
  _queued     integer := 0;
  _target     record;
  _first      date;
  _last       date;
begin
  if not app.has_perm_org_wide('device.manage') then
    raise exception 'You do not have permission to map device codes.'
      using errcode = '42501';
  end if;

  select employee_id into _existing
    from public.biotime_employees
   where emp_code = _emp_code;

  if not found then
    raise exception 'Device code % is not enrolled on any terminal.', _emp_code
      using errcode = 'P0002';
  end if;

  -- Two device codes pointing at one person would merge two people's days into one.
  if _employee_id is not null and not _ignore then
    if exists (
      select 1 from public.biotime_employees
       where employee_id = _employee_id and emp_code <> _emp_code
    ) then
      raise exception 'That employee is already mapped to another device code.'
        using errcode = '23505';
    end if;

    select * into _target from public.employees where id = _employee_id;
    if _target.id is null then
      raise exception 'That employee no longer exists.' using errcode = 'P0002';
    end if;

    -- has_perm_org_wide above only asks "do you hold device.manage at global or entity scope
    -- ANYWHERE" — it never asks whether this employee is yours. Without the check below an
    -- entity-scoped holder could point a device code at somebody in another entity, which
    -- reassigns that person's punches and queues recomputes against them.
    if not app.has_perm('device.manage', _target.entity_id, _target.zone_id, _target.branch_id,
                        _target.department_id, _target.id) then
      raise exception 'That employee is outside the scope you may map device codes for.'
        using errcode = '42501';
    end if;
  end if;

  _status := case
               when _ignore then 'ignored'
               when _employee_id is null then 'unmatched'
               else 'manual'
             end;

  update public.biotime_employees
     set employee_id = case when _ignore then null else _employee_id end,
         link_status = _status,
         linked_at   = case when _employee_id is null or _ignore then null else now() end,
         linked_by   = case when _employee_id is null or _ignore then null else auth.uid() end,
         updated_at  = now()
   where emp_code = _emp_code;

  -- Unlinking: hand the punches back rather than leaving them credited to the wrong person, and
  -- rebuild the days they used to affect so the attendance disappears with the link.
  if _employee_id is null or _ignore then
    if _existing is not null then
      select min((punch_time at time zone 'Asia/Kolkata')::date),
             max((punch_time at time zone 'Asia/Kolkata')::date)
        into _first, _last
        from public.raw_punches
       where emp_code = _emp_code and employee_id = _existing;

      update public.raw_punches set employee_id = null
       where emp_code = _emp_code and employee_id = _existing;
      _adopted := -1;  -- signals "released", not "adopted"

      if _first is not null then
        insert into public.attendance_recompute_queue (employee_id, work_date, reason)
        select _existing, d::date, format('device code %s unlinked', _emp_code)
          from generate_series(_first, _last, interval '1 day') d;
        _queued := (_last - _first) + 1;
      end if;
    end if;

    return jsonb_build_object(
      'emp_code', _emp_code, 'link_status', _status,
      'punches_released', case when _adopted = -1 then true else false end,
      'days_queued', _queued
    );
  end if;

  -- Linking: adopt every punch under this code that has no owner yet.
  select min((punch_time at time zone 'Asia/Kolkata')::date),
         max((punch_time at time zone 'Asia/Kolkata')::date)
    into _first, _last
    from public.raw_punches
   where emp_code = _emp_code and employee_id is null;

  update public.raw_punches
     set employee_id = _employee_id
   where emp_code = _emp_code and employee_id is null;
  _adopted := coalesce((select count(*)::integer from public.raw_punches
                         where emp_code = _emp_code and employee_id = _employee_id), 0);

  -- One queue row per day touched. The engine is idempotent, so a day queued twice is harmless.
  if _first is not null then
    insert into public.attendance_recompute_queue (employee_id, work_date, reason)
    select _employee_id, d::date, format('device code %s mapped', _emp_code)
      from generate_series(_first, _last, interval '1 day') d;
    _queued := (_last - _first) + 1;
  end if;

  return jsonb_build_object(
    'emp_code', _emp_code,
    'employee_id', _employee_id,
    'link_status', _status,
    'punches_linked', _adopted,
    'first_date', _first,
    'last_date', _last,
    'days_queued', _queued
  );
end;
$function$;
