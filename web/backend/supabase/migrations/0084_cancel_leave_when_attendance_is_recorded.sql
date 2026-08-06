-- A real terminal punch wins over approved full-day leave for that work date.
--
-- A one-day request becomes Cancelled. For a multi-day request only the punched date is excluded;
-- the remaining dates stay approved and the leave balance is recalculated from the effective days.
-- Half-day leave is deliberately untouched because attendance is expected for the worked half.

alter table public.leaves
  add column if not exists cancelled_dates          date[] not null default '{}'::date[],
  add column if not exists auto_cancelled_at        timestamptz,
  add column if not exists auto_cancellation_note   text;

comment on column public.leaves.cancelled_dates is
  'Dates removed from an otherwise approved leave after a real attendance punch was recorded.';

-- Keep the original four-argument public helper stable. This internal wrapper subtracts only
-- excluded dates that would actually have consumed leave (not weekly offs or holidays).
create or replace function app.leave_effective_working_days(
  _employee_id uuid,
  _from date,
  _to date,
  _fraction numeric,
  _cancelled_dates date[]
) returns numeric
language plpgsql stable security definer set search_path = app, public as $$
declare
  _days numeric;
  _cancelled date;
begin
  _days := public.leave_working_days(_employee_id, _from, _to, _fraction);

  for _cancelled in
    select distinct d
      from unnest(coalesce(_cancelled_dates, '{}'::date[])) d
     where d between _from and _to
  loop
    _days := _days - public.leave_working_days(
      _employee_id, _cancelled, _cancelled, _fraction
    );
  end loop;

  return greatest(coalesce(_days, 0), 0);
end $$;

revoke execute on function app.leave_effective_working_days(uuid, date, date, numeric, date[])
  from public, anon, authenticated;

-- Recalculate the balance from the leave dates that remain effective.
create or replace function app.apply_leave_balance(_leave_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  _leave        record;
  _type_id      uuid;
  _type_paid    boolean;
  _type_deducts boolean;
  _type_quota   numeric;
  _has_type     boolean;
  _year         integer;
  _requested    numeric;
  _available    numeric := 0;
  _paid         numeric := 0;
  _lop          numeric := 0;
  _balance_id   uuid;
begin
  select * into _leave from public.leaves where id = _leave_id;
  if not found then return; end if;

  select id, is_paid, deducts_balance, annual_quota
    into _type_id, _type_paid, _type_deducts, _type_quota
    from public.leave_types
   where id = _leave.leave_type_id or code = _leave.type
   limit 1;
  _has_type := found;

  _year      := extract(year from _leave.start_date)::integer;
  _requested := app.leave_effective_working_days(
    _leave.employee_id,
    _leave.start_date,
    _leave.end_date,
    coalesce(_leave.day_fraction, 1),
    _leave.cancelled_dates
  );

  if not _has_type or not coalesce(_type_deducts, false) then
    update public.leaves
       set days      = _requested,
           paid_days = case when coalesce(_type_paid, true) then _requested else 0 end,
           lop_days  = case when coalesce(_type_paid, true) then 0 else _requested end,
           is_lop    = not coalesce(_type_paid, true)
     where id = _leave_id;
    return;
  end if;

  insert into public.leave_balances (employee_id, leave_type_id, year, entitled)
  values (_leave.employee_id, _type_id, _year, coalesce(_type_quota, 0))
  on conflict (employee_id, leave_type_id, year) do nothing;

  select id, available into _balance_id, _available
    from public.leave_balances
   where employee_id = _leave.employee_id and leave_type_id = _type_id and year = _year
   for update;

  _available := greatest(coalesce(_available, 0), 0);
  _paid      := least(_requested, _available);
  _lop       := greatest(_requested - _available, 0);

  update public.leave_balances
     set used = used + _paid, updated_at = now()
   where id = _balance_id;

  update public.leaves
     set days      = _requested,
         paid_days = case when _type_paid then _paid else 0 end,
         lop_days  = case when _type_paid then _lop else _requested end,
         is_lop    = (_lop > 0) or not _type_paid
   where id = _leave_id;
end $$;

-- Releasing and reapplying is intentional when an approved leave loses one date. It gives back the
-- old deduction first, then prices the remaining dates using the same balance rules as approval.
create or replace function app.tg_leave_recompute()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'UPDATE'
     and (
       new.status is distinct from old.status
       or new.cancelled_dates is distinct from old.cancelled_dates
     ) then
    if old.status = 'Approved' then
      perform app.release_leave_balance(new.id);
    end if;
    if new.status = 'Approved' then
      perform app.apply_leave_balance(new.id);
    end if;
  elsif tg_op = 'INSERT' and new.status = 'Approved' then
    perform app.apply_leave_balance(new.id);
  end if;

  if tg_op = 'DELETE' then
    perform app.enqueue_recompute_internal(
      old.employee_id, old.start_date, old.end_date, 'leave deleted'
    );
    return old;
  end if;

  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.cancelled_dates is distinct from old.cancelled_dates
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date
     or new.day_fraction is distinct from old.day_fraction
     or new.type is distinct from old.type then
    perform app.enqueue_recompute_internal(
      new.employee_id, new.start_date, new.end_date, 'leave ' || new.status
    );
    if tg_op = 'UPDATE' and (
      new.start_date is distinct from old.start_date
      or new.end_date is distinct from old.end_date
    ) then
      perform app.enqueue_recompute_internal(
        old.employee_id, old.start_date, old.end_date, 'leave dates changed'
      );
    end if;
  end if;

  return new;
end $$;

-- Called only by the attendance service after it has assigned at least one real terminal punch to
-- this employee-date. Returns "leave" when no leave dates remain, "day" for a partial cancellation,
-- "ignored" for a half-day request, and "locked" when finalized payroll protects the attendance.
create or replace function app.cancel_leave_day_for_punch(
  _leave_id uuid,
  _work_date date
) returns text
language plpgsql security definer set search_path = app, public as $$
declare
  _leave public.leaves%rowtype;
  _cancelled_dates date[];
  _remaining numeric;
  _outcome text;
begin
  select * into _leave
    from public.leaves
   where id = _leave_id
   for update;

  if not found
     or _leave.status not in ('Pending', 'On Hold', 'Approved')
  then
    return 'leave';
  end if;
  if _work_date not between _leave.start_date and _leave.end_date then return 'leave'; end if;
  if coalesce(_leave.day_fraction, 1) < 1 then return 'ignored'; end if;
  if exists (
    select 1
      from public.attendance a
     where a.employee_id = _leave.employee_id
       and a.work_date = _work_date
       and a.is_locked
  ) then
    return 'locked';
  end if;

  if _work_date = any(coalesce(_leave.cancelled_dates, '{}'::date[])) then
    return 'day';
  end if;

  select coalesce(array_agg(d order by d), '{}'::date[])
    into _cancelled_dates
    from (
      select distinct d
        from unnest(
          coalesce(_leave.cancelled_dates, '{}'::date[]) || array[_work_date]
        ) d
    ) x;

  _remaining := app.leave_effective_working_days(
    _leave.employee_id,
    _leave.start_date,
    _leave.end_date,
    coalesce(_leave.day_fraction, 1),
    _cancelled_dates
  );
  _outcome := case when _remaining <= 0 then 'leave' else 'day' end;

  update public.leaves
     set cancelled_dates        = _cancelled_dates,
         status                 = case when _remaining <= 0 then 'Cancelled' else status end,
         days                   = _remaining,
         auto_cancelled_at      = now(),
         auto_cancellation_note = 'Attendance punch recorded on '
                                  || to_char(_work_date, 'DD Mon YYYY')
    where id = _leave_id;

  -- A manually selected On Leave value tied to this same request would otherwise keep winning
  -- after the engine recomputes the punched day. Other manual statuses remain deliberate.
  update public.attendance
     set status_override       = null,
         status_override_note  = null,
         status_overridden_at  = null,
         status_overridden_by  = null
   where employee_id = _leave.employee_id
     and work_date = _work_date
     and leave_id = _leave_id
     and status_override = 'On Leave';

  return _outcome;
end $$;

revoke execute on function app.cancel_leave_day_for_punch(uuid, date)
  from public, anon, authenticated;
grant usage on schema app to service_role;
grant execute on function app.cancel_leave_day_for_punch(uuid, date)
  to service_role;

-- Include the automatic reason in the employee notification. A partially cancelled multi-day
-- request keeps Approved status, so cancelled_dates is also a trigger event.
create or replace function app.tg_notify_leave()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _name text;
  _emp_user uuid;
  _range text;
  _title text;
  _message text;
  _cancelled_date date;
begin
  select e.full_name, e.user_id into _name, _emp_user
  from public.employees e where e.id = new.employee_id;
  _range := to_char(new.start_date, 'DD Mon') || ' - ' || to_char(new.end_date, 'DD Mon');

  if tg_op = 'UPDATE' and new.cancelled_dates is distinct from old.cancelled_dates then
    select d into _cancelled_date
      from unnest(new.cancelled_dates) d
     where not (d = any(coalesce(old.cancelled_dates, '{}'::date[])))
     order by d desc
     limit 1;
  end if;

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
    _message := case
      when new.status = 'Cancelled' and _cancelled_date is not null then
        'Your ' || new.type || ' leave was cancelled because attendance was recorded on '
        || to_char(_cancelled_date, 'DD Mon YYYY') || '.'
      when new.status = 'Pending' then
        'Your ' || new.type || ' leave (' || _range || ') is pending review again.'
      when new.status = 'On Hold' then
        'Your ' || new.type || ' leave (' || _range || ') is now on hold.'
      else
        'Your ' || new.type || ' leave (' || _range || ') was ' || lower(new.status) || '.'
    end;
    perform app.notify_user(_emp_user, 'leave', _title, _message, 'leave', new.id);
  elsif tg_op = 'UPDATE'
        and new.cancelled_dates is distinct from old.cancelled_dates
        and _cancelled_date is not null then
    perform app.notify_user(
      _emp_user,
      'leave',
      'Leave day cancelled',
      'Your leave on ' || to_char(_cancelled_date, 'DD Mon YYYY')
        || ' was cancelled because attendance was recorded. The other approved dates are unchanged.',
      'leave',
      new.id
    );
  end if;

  return new;
end $$;

drop trigger if exists trg_leaves_notify on public.leaves;
create trigger trg_leaves_notify
  after insert or update of status, cancelled_dates on public.leaves
  for each row execute function app.tg_notify_leave();
