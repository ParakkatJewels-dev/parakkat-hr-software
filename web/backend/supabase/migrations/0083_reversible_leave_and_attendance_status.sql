-- Managers can revisit a leave decision and can explicitly correct the headline attendance status.
--
-- Attendance remains derived from punches. A manual status override changes only the status and
-- payable-day credit; the engine may still refresh punches, worked time, lateness and overtime.

-- ---------------------------------------------------------------------------
-- Reversible leave decisions
-- ---------------------------------------------------------------------------

alter table public.leaves drop constraint if exists leaves_status_check;
alter table public.leaves
  add constraint leaves_status_check
  check (status in ('Pending', 'On Hold', 'Approved', 'Rejected', 'Cancelled'));

create or replace function app.tg_stamp_leave_decision()
returns trigger language plpgsql set search_path = app, public as $$
begin
  if new.status is distinct from old.status then
    if new.status in ('Approved', 'Rejected', 'Cancelled') then
      new.decided_at := now();
      new.decided_by := auth.uid();
    else
      new.decided_at := null;
      new.decided_by := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_leaves_stamp_decision on public.leaves;
create trigger trg_leaves_stamp_decision
  before update of status on public.leaves
  for each row execute function app.tg_stamp_leave_decision();

-- A manager still may not approve or reject their own leave after another approver has moved it
-- through a different state. Keep this leave-specific: expenses and regularizations retain their
-- existing decision rules.
create or replace function app.tg_no_self_leave_decision()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status is distinct from old.status
     and new.status in ('Approved', 'Rejected')
     and new.employee_id = app.current_employee_id()
     and not app.is_super_admin()
  then
    raise exception 'You cannot % your own request - someone else has to review it.',
      case new.status when 'Approved' then 'approve' else 'reject' end using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_leaves_no_self_approval on public.leaves;
create trigger trg_leaves_no_self_approval
  before update on public.leaves
  for each row execute function app.tg_no_self_leave_decision();

-- Tell the employee about a hold as well as a final decision.
create or replace function app.tg_notify_leave()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _name text; _emp_user uuid; _range text; _title text; _message text;
begin
  select e.full_name, e.user_id into _name, _emp_user
  from public.employees e where e.id = new.employee_id;
  _range := to_char(new.start_date, 'DD Mon') || ' - ' || to_char(new.end_date, 'DD Mon');

  if tg_op = 'INSERT' and new.status = 'Pending' then
    perform app.notify_perm_holders('leave.approve',
      new.entity_id, new.zone_id, new.branch_id, new.department_id,
      'leave', 'New leave request',
      coalesce(_name, 'An employee') || ' requested ' || coalesce(new.days::text, '?')
        || ' day(s) of ' || new.type || ' leave (' || _range || ').',
      'leave', new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status
        and new.status in ('Pending', 'On Hold', 'Approved', 'Rejected', 'Cancelled') then
    _title := case new.status
      when 'Pending' then 'Leave returned for review'
      when 'On Hold' then 'Leave put on hold'
      else 'Leave ' || lower(new.status)
    end;
    _message := case new.status
      when 'Pending' then 'Your ' || new.type || ' leave (' || _range || ') is pending review again.'
      when 'On Hold' then 'Your ' || new.type || ' leave (' || _range || ') is now on hold.'
      else 'Your ' || new.type || ' leave (' || _range || ') was ' || lower(new.status) || '.'
    end;
    perform app.notify_user(_emp_user, 'leave', _title, _message, 'leave', new.id);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Persistent manual attendance status
-- ---------------------------------------------------------------------------

alter table public.attendance
  add column if not exists status_override       text,
  add column if not exists status_override_note  text,
  add column if not exists status_overridden_at  timestamptz,
  add column if not exists status_overridden_by  uuid references auth.users(id) on delete set null;

alter table public.attendance drop constraint if exists attendance_status_override_check;
alter table public.attendance
  add constraint attendance_status_override_check
  check (
    status_override is null
    or status_override in (
      'Present', 'Absent', 'Half Day', 'Weekly Off',
      'Holiday', 'On Leave', 'Missing Punch', 'No Shift'
    )
  );

comment on column public.attendance.status_override is
  'HR-selected headline status. The attendance engine preserves it while continuing to recompute punches and metrics.';

create table if not exists public.attendance_status_history (
  id             uuid primary key default gen_random_uuid(),
  attendance_id  uuid not null references public.attendance(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  entity_id      uuid,
  zone_id        uuid,
  branch_id      uuid,
  department_id  uuid,
  work_date      date not null,
  old_status     text,
  new_status     text not null,
  note           text,
  changed_by     uuid references auth.users(id) on delete set null,
  changed_at     timestamptz not null default now()
);

create index if not exists idx_attendance_status_history_row
  on public.attendance_status_history(attendance_id, changed_at desc);

alter table public.attendance_status_history enable row level security;
drop policy if exists attendance_status_history_select on public.attendance_status_history;
create policy attendance_status_history_select
  on public.attendance_status_history for select to authenticated
  using (app.has_perm(
    'attendance.read', entity_id, zone_id, branch_id, department_id, employee_id
  ));

grant select on public.attendance_status_history to authenticated;

create or replace function public.set_attendance_status(
  _attendance_id uuid,
  _status text,
  _note text default null
) returns void
language plpgsql security definer set search_path = app, public as $$
declare
  _row public.attendance%rowtype;
  _credit numeric(3,2);
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if _status not in (
    'Present', 'Absent', 'Half Day', 'Weekly Off',
    'Holiday', 'On Leave', 'Missing Punch', 'No Shift'
  ) then
    raise exception 'unsupported attendance status';
  end if;

  select * into _row
    from public.attendance
   where id = _attendance_id
   for update;

  if not found then raise exception 'attendance row not found'; end if;

  if not app.has_perm(
    'attendance.manage',
    _row.entity_id, _row.zone_id, _row.branch_id, _row.department_id, _row.employee_id
  ) then
    raise exception 'not authorized to change this attendance status' using errcode = '42501';
  end if;

  if _row.is_locked then
    raise exception 'attendance is locked by finalized payroll' using errcode = '55000';
  end if;

  _credit := case _status
    when 'Present'       then 1
    when 'Weekly Off'    then 1
    when 'Holiday'       then 1
    when 'On Leave'      then 1
    when 'Half Day'      then 0.5
    when 'Missing Punch' then 0.5
    else 0
  end;

  insert into public.attendance_status_history (
    attendance_id, employee_id, entity_id, zone_id, branch_id, department_id,
    work_date, old_status, new_status, note, changed_by
  ) values (
    _row.id, _row.employee_id, _row.entity_id, _row.zone_id, _row.branch_id, _row.department_id,
    _row.work_date, _row.status, _status, nullif(left(trim(coalesce(_note, '')), 500), ''), auth.uid()
  );

  update public.attendance
     set status                 = _status,
         status_override        = _status,
         status_override_note   = nullif(left(trim(coalesce(_note, '')), 500), ''),
         status_overridden_at   = now(),
         status_overridden_by   = auth.uid(),
         day_fraction           = _credit,
         is_lop                 = case when _status = 'On Leave' then is_lop else false end,
         source                 = 'manual',
         remarks                = coalesce(
           nullif(left(trim(coalesce(_note, '')), 500), ''),
           'Status manually set to ' || _status
         )
   where id = _attendance_id;
end $$;

revoke all on function public.set_attendance_status(uuid, text, text)
  from public, anon;
grant execute on function public.set_attendance_status(uuid, text, text)
  to authenticated;
