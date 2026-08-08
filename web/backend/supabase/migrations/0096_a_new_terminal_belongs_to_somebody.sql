-- 0096_a_new_terminal_belongs_to_somebody.sql
--
-- Three repairs to device-mapping scope, all found auditing what each role can actually do.
--
-- 1. NEW TERMINALS WERE INVISIBLE TO EVERYONE WHO COULD ASSIGN THEM.
--    The sync service enrols a terminal with entity_id and branch_id both null — it cannot know
--    the company; assigning one is the admin's first job. 0071 made that unassigned branch
--    visible to has_perm_org_wide (entity-level authority anywhere), deliberately: a device that
--    belongs to nobody must be visible to somebody, or it can never come to belong to anybody.
--    0088's sweep — correct everywhere else — replaced that with has_perm_globally, which only a
--    super admin passes. Net effect: every newly enrolled terminal was invisible to entity_admin
--    and hr_manager, and the only control that could fix it was behind the same empty list.
--    Restored to 0071's rule for the unassigned branch only; assigned devices keep 0088's strict
--    ancestry check.
--
-- 2. UNLINKING WAS SCOPE-CHECKED ON THE WRONG SIDE.
--    link_device_code checks the caller's authority over the INCOMING employee when linking —
--    0071 added exactly that — but unlink and ignore never look at the employee CURRENTLY linked.
--    An entity-scoped holder could unlink another company's mapping, releasing that person's
--    punches and queueing recomputes against records they hold no authority over. The check now
--    runs whenever the change touches an existing link.
--
-- 3. RECOMPUTE MEANT EVERYTHING, GATED AS SOMETHING.
--    request_service_command('recompute') rebuilds derived attendance for every employee in every
--    entity — the queued worker takes no scope. 0071 gated it on has_perm_org_wide, which 0088
--    taught us reads as "authority over ONE company, held anywhere". A whole-organisation rebuild
--    is a global act and now requires the global permission. Entity-scoped admins keep the
--    backfill window, which is bounded and does carry their scope.

-- ---------------------------------------------------------------- 1. unassigned devices
drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices for select to authenticated
  using (
    app.has_perm('attendance.read', entity_id,
      (select b.zone_id from public.branches b where b.id = devices.branch_id), branch_id, null, null)
    or (entity_id is null and branch_id is null and app.has_perm_org_wide('attendance.read'))
  );

drop policy if exists devices_write on public.devices;
create policy devices_write on public.devices for all to authenticated
  using (
    app.has_perm('device.manage', entity_id,
      (select b.zone_id from public.branches b where b.id = devices.branch_id), branch_id, null, null)
    or (entity_id is null and branch_id is null and app.has_perm_org_wide('device.manage'))
  )
  with check (
    app.has_perm('device.manage', entity_id,
      (select b.zone_id from public.branches b where b.id = devices.branch_id), branch_id, null, null)
    or (entity_id is null and branch_id is null and app.has_perm_org_wide('device.manage'))
  );

-- ---------------------------------------------------------------- 2. unlink checks the held side
-- 0071's function, with one addition marked below. Everything else is unchanged.
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
  _held       record;
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

  -- THE ADDITION. Whenever this call would change an existing link — unlink, ignore, or re-point
  -- at somebody else — the person currently holding the link is the one whose punches are released
  -- and whose days are rebuilt. Authority over THEM is what that requires. The linking branch
  -- below has checked the incoming employee since 0071; this is its mirror image, and without it
  -- an entity-scoped holder could dismantle another company's mapping.
  if _existing is not null and (_employee_id is distinct from _existing or _ignore) then
    select * into _held from public.employees where id = _existing;
    if _held.id is not null
       and not app.has_perm('device.manage', _held.entity_id, _held.zone_id, _held.branch_id,
                            _held.department_id, _held.id) then
      raise exception 'This code is linked to an employee outside the scope you may map device codes for.'
        using errcode = '42501';
    end if;
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
  update public.raw_punches
     set employee_id = _employee_id
   where emp_code = _emp_code and employee_id is null;
  get diagnostics _adopted = row_count;

  if _adopted > 0 then
    select min((punch_time at time zone 'Asia/Kolkata')::date),
           max((punch_time at time zone 'Asia/Kolkata')::date)
      into _first, _last
      from public.raw_punches
     where emp_code = _emp_code and employee_id = _employee_id;

    insert into public.attendance_recompute_queue (employee_id, work_date, reason)
    select _employee_id, d::date, format('device code %s linked', _emp_code)
      from generate_series(_first, _last, interval '1 day') d;
    _queued := (_last - _first) + 1;
  end if;

  return jsonb_build_object(
    'emp_code', _emp_code, 'link_status', _status,
    'punches_adopted', _adopted, 'days_queued', _queued
  );
end $function$;

-- ---------------------------------------------------------------- 3. recompute is global
-- 0082's function verbatim — same signature, or `create or replace` would mint a second overload
-- and leave the permissive original callable — with exactly one change: the recompute gate asks
-- has_perm_globally instead of has_perm_org_wide.
create or replace function public.request_service_command(
  _kind   text,
  _params jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  _id      uuid;
  _pending integer;
begin
  if _kind in ('export_register', 'export_payroll') then
    if not (
      app.has_perm_at_branch_or_wider('report.read')
      or app.has_perm_at_branch_or_wider(
           case when _kind = 'export_register' then 'attendance.read' else 'payslip.read' end)
    ) then
      raise exception
        'Exports cover whole branches, so they need attendance or reporting access over a branch, zone or company — not just your own record.'
        using errcode = '42501';
    end if;

  elsif _kind = 'recompute' then
    -- THE CHANGE. The queued worker rebuilds derived attendance for every employee in every
    -- entity — it takes no scope. 0071 gated this on has_perm_org_wide, which 0088 taught us
    -- reads as "authority over ONE company, held anywhere": an entity admin could rewrite the
    -- whole organisation's attendance. An act with global blast radius needs the global
    -- permission. Entity-scoped admins keep the backfill window, which is bounded.
    if not app.has_perm_globally('attendance.manage') then
      raise exception 'A full recompute rebuilds every company''s attendance, so it needs organisation-wide permission. Use a backfill for your own range instead.'
        using errcode = '42501';
    end if;

  elsif not app.has_perm_org_wide('device.manage') then
    raise exception 'You do not have permission to run sync operations.' using errcode = '42501';
  end if;

  -- Sync and backfill hammer the one on-prem BioTime box, so only one may be in flight at a time
  -- for the whole company. An export reads Postgres and writes a file for one person; two people
  -- exporting two different months is ordinary, and a shared guard would have the second of them
  -- told to wait for work that has nothing to do with them.
  if _kind in ('export_register', 'export_payroll') then
    select count(*) into _pending from public.service_commands
     where kind = _kind and status in ('pending', 'running') and requested_by = auth.uid();
  else
    select count(*) into _pending from public.service_commands
     where kind = _kind and status in ('pending', 'running');
  end if;

  if _pending > 0 then
    raise exception 'A % is already queued or running.', replace(_kind, '_', ' ')
      using errcode = '55006';
  end if;

  insert into public.service_commands (kind, params, requested_by)
  values (_kind, coalesce(_params, '{}'::jsonb), auth.uid())
  returning id into _id;

  return _id;
end $$;
