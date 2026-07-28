-- Map a device enrolment to an employee without needing the sync service.
--
-- WHY
-- Mapping was only possible through the service's own HTTP API, which lives on the HR laptop's LAN.
-- That works from a browser on the office network talking to an http:// page, and nowhere else:
-- the hosted app is served over HTTPS, and a browser refuses outright to let an HTTPS page call
-- http://192.168.1.45:8091 (mixed active content). No CORS setting or firewall rule can change
-- that. So the one screen HR needs every time somebody new is enrolled was unreachable in normal
-- use, and the failure surfaced as a vague "cannot reach the attendance service".
--
-- Linking never needed the service. All three steps are database work:
--   1. point biotime_employees at the employee
--   2. adopt the punches already collected under that code
--   3. queue the affected days for recompute
-- The running service drains that queue every five minutes, so attendance follows within minutes
-- exactly as it did before — the only thing that changes is who issues the write.
--
-- Gated on device.manage org-wide, matching the RLS already on biotime_employees. SECURITY DEFINER
-- is required because it writes raw_punches and the recompute queue, which are not writable by the
-- caller — so the permission check below is the real boundary and runs first, every time.

create or replace function public.link_device_code(
  _emp_code    text,
  _employee_id uuid default null,
  _ignore      boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  _existing   uuid;
  _status     text;
  _adopted    integer := 0;
  _queued     integer := 0;
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

    if not exists (select 1 from public.employees where id = _employee_id) then
      raise exception 'That employee no longer exists.' using errcode = 'P0002';
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
$$;

comment on function public.link_device_code(text, uuid, boolean) is
  'Map/unmap a terminal enrolment to an employee, adopt its punches and queue the affected days. Requires device.manage org-wide. Replaces the service POST /api/mapping/link so mapping works without LAN access to the HR laptop.';

revoke all on function public.link_device_code(text, uuid, boolean) from public;
grant execute on function public.link_device_code(text, uuid, boolean) to authenticated;
