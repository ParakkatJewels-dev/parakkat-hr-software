-- Shift definitions, dated assignments and punch corrections share one ownership rule.
-- No company schedules are created and no historical attendance is rewritten here.
begin;
create temporary table shift_ownership_upgrade on commit drop as
  select to_regprocedure('app.attendance_day_boundary(uuid,date)') is null as required;

alter table public.shifts add column if not exists break_windows jsonb not null default '[]'::jsonb;

-- Times are shift-local clock values. On an overnight duty, a clock before the shift's
-- start belongs to the following day. Duration arithmetic retains whole-second precision.
create or replace function app.shift_unpaid_break_minutes(_start time,_end time,_windows jsonb)
returns numeric language plpgsql immutable set search_path=pg_catalog as $$
declare _entry jsonb; _start_second numeric:=extract(epoch from _start); _end_second numeric:=extract(epoch from _end);
  _a numeric; _b numeric; _prior_end numeric:=-1; _unpaid numeric:=0; _intervals jsonb:='[]'::jsonb; _range record;
begin
  if _end_second<=_start_second then _end_second:=_end_second+86400; end if;
  if _windows is null or jsonb_typeof(_windows)<>'array' then
    raise exception 'Break windows must be an array with at most 16 entries.' using errcode='23514';
  end if;
  if jsonb_array_length(_windows)>16 then
    raise exception 'Break windows must be an array with at most 16 entries.' using errcode='23514';
  end if;
  for _entry in select value from jsonb_array_elements(_windows) loop
    if jsonb_typeof(_entry)<>'object' then
      raise exception 'Each break needs a label, valid clock times and a paid/unpaid choice.' using errcode='23514';
    end if;
    if not _entry ?& array['label','start_time','end_time','is_paid']
      or exists(select 1 from jsonb_object_keys(_entry) k where k not in ('label','start_time','end_time','is_paid'))
      or jsonb_typeof(_entry->'label')<>'string' or length(btrim(_entry->>'label')) not between 1 and 100
      or jsonb_typeof(_entry->'is_paid')<>'boolean'
      or jsonb_typeof(_entry->'start_time')<>'string' or jsonb_typeof(_entry->'end_time')<>'string'
      or (_entry->>'start_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      or (_entry->>'end_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
      raise exception 'Each break needs a label, valid clock times and a paid/unpaid choice.' using errcode='23514';
    end if;
    _a:=extract(epoch from (_entry->>'start_time')::time); _b:=extract(epoch from (_entry->>'end_time')::time);
    if _a<_start_second then _a:=_a+86400; end if;
    if _b<_start_second then _b:=_b+86400; end if;
    if _b<=_a then _b:=_b+86400; end if;
    if _a<_start_second or _b>_end_second or _b<=_a then
      raise exception 'Every break must fit within its shift, including the next-day part of an overnight shift.' using errcode='23514';
    end if;
    _intervals:=_intervals||jsonb_build_array(jsonb_build_object('a',_a,'b',_b));
    if not (_entry->>'is_paid')::boolean then _unpaid:=_unpaid+(_b-_a)/60; end if;
  end loop;
  for _range in select (value->>'a')::numeric as a,(value->>'b')::numeric as b from jsonb_array_elements(_intervals) order by (value->>'a')::numeric loop
    if _range.a<_prior_end then raise exception 'Break windows cannot overlap; touching boundaries are allowed.' using errcode='23514'; end if;
    _prior_end:=_range.b;
  end loop;
  if _unpaid*60>_end_second-_start_second then raise exception 'Unpaid breaks cannot exceed the shift duration.' using errcode='23514'; end if;
  return _unpaid;
end $$;
alter table public.shifts drop constraint if exists shifts_break_policy_values;
alter table public.shifts add constraint shifts_break_policy_values check (break_policy in ('fixed','actual','actual_over_allowance','excess','scheduled'));
alter table public.shifts drop constraint if exists shifts_break_windows_valid;
alter table public.shifts add constraint shifts_break_windows_valid check (
  app.shift_unpaid_break_minutes(start_time,end_time,break_windows)>=0
  and (break_policy<>'scheduled' or jsonb_array_length(break_windows)>0));
alter table public.shifts drop constraint if exists shifts_full_day_reachable_check;
alter table public.shifts add constraint shifts_full_day_reachable_check check (
  full_day_minutes<=(case when end_time<=start_time then extract(epoch from end_time-start_time)/60+1440 else extract(epoch from end_time-start_time)/60 end)
    -case when break_policy in ('actual','excess') then 0 when break_policy='scheduled'
      then app.shift_unpaid_break_minutes(start_time,end_time,break_windows) else break_minutes end);

create or replace function app.attendance_shift_for_date(_employee uuid,_work_date date)
returns uuid language sql stable security definer set search_path=pg_catalog,public,app as $$
  select coalesce(
    (select a.shift_id from public.employee_shift_assignments a where a.employee_id=e.id
      and a.effective_from<=_work_date and (a.effective_to is null or a.effective_to>=_work_date)
      order by a.effective_from desc,a.id limit 1),
    (select s.id from public.shifts s where s.entity_id=e.entity_id and s.is_default and s.is_active),
    (select s.id from public.shifts s where s.entity_id is null and s.is_default and s.is_active))
  from public.employees e where e.id=_employee;
$$;

create or replace function app.attendance_shift_schedule(_employee uuid,_work_date date)
returns table(shift_id uuid,scheduled_in timestamptz,scheduled_out timestamptz,legacy_window_to timestamptz)
language sql stable security definer set search_path=pg_catalog,public,app as $$
  select s.id,(_work_date+s.start_time) at time zone 'Asia/Kolkata',
    ((_work_date+case when s.end_time<=s.start_time then 1 else 0 end)+s.end_time) at time zone 'Asia/Kolkata',
    case when s.end_time<=s.start_time
      then (((_work_date+1)+s.end_time) at time zone 'Asia/Kolkata')+interval '6 hours'
      else ((_work_date+s.start_time) at time zone 'Asia/Kolkata')+interval '18 hours' end
  from public.shifts s where s.id=app.attendance_shift_for_date(_employee,_work_date);
$$;

-- B(D) is shared by the previous day's exclusive upper bound and today's inclusive lower
-- bound. Keep start-minus-six-hours when it lies after the previous duty; otherwise split
-- the rest gap. Touching/overlapping duties have no unambiguous ownership and are rejected.
create or replace function app.attendance_day_boundary(_employee uuid,_work_date date)
returns timestamptz language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare _previous record; _current record; _preferred timestamptz;
begin
  select * into _previous from app.attendance_shift_schedule(_employee,_work_date-1);
  select * into _current from app.attendance_shift_schedule(_employee,_work_date);
  if (_previous.shift_id is not null and _previous.scheduled_out-_previous.scheduled_in>=interval '24 hours')
    or (_current.shift_id is not null and _current.scheduled_out-_current.scheduled_in>=interval '24 hours') then
    raise exception 'A shift must be shorter than 24 hours. Use distinct start and end times.' using errcode='23514';
  end if;
  if _current.shift_id is null then
    return greatest(_work_date::timestamp at time zone 'Asia/Kolkata',_previous.legacy_window_to);
  end if;
  _preferred:=_current.scheduled_in-interval '6 hours';
  if _previous.shift_id is null then return _preferred; end if;
  if _previous.scheduled_out>=_current.scheduled_in then
    raise exception 'Adjacent shifts overlap or touch on %. Leave a gap between the previous checkout and the next duty.',_work_date using errcode='23514';
  end if;
  if _preferred>_previous.scheduled_out and _preferred<=_current.scheduled_in then return _preferred; end if;
  return _previous.scheduled_out+(_current.scheduled_in-_previous.scheduled_out)/2;
end $$;

create or replace function app.attendance_punch_window(_employee uuid,_work_date date)
returns table(window_from timestamptz,window_to timestamptz,shift_id uuid,scheduled_in timestamptz,scheduled_out timestamptz)
language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
begin
  window_from:=app.attendance_day_boundary(_employee,_work_date);
  window_to:=app.attendance_day_boundary(_employee,_work_date+1);
  if window_to<=window_from then
    raise exception 'These adjacent assignments leave an invalid attendance window. Review the missing or overlapping shift dates.' using errcode='23514';
  end if;
  select s.shift_id,s.scheduled_in,s.scheduled_out into shift_id,scheduled_in,scheduled_out
    from app.attendance_shift_schedule(_employee,_work_date) s;
  return next;
end $$;

-- Check only transition dates; a repeated, sub-24-hour shift cannot overlap itself.
-- Published punch endpoints must also retain ownership when a future assignment is added.
create or replace function app.validate_employee_shift_boundaries(_employee uuid,_from date,_to date)
returns void language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare _date date; _window record;
begin
  for _date in
    with transitions as (
      select _from as d union select _to+1
      union select effective_from from public.employee_shift_assignments where employee_id=_employee
        and effective_from between _from-1 and _to+1
      union select effective_to+1 from public.employee_shift_assignments where employee_id=_employee
        and effective_to between _from-2 and _to
    ) select distinct d+offset_day from transitions cross join generate_series(-1,1) offset_day where d is not null
  loop
    select * into _window from app.attendance_punch_window(_employee,_date);
    if exists(select 1 from public.attendance a where a.employee_id=_employee and a.work_date=_date
      and (a.is_locked or exists(select 1 from public.payslips p where p.employee_id=a.employee_id and p.period=to_char(a.work_date,'YYYY-MM') and p.status='Published'))
      and ((a.check_in is not null and (a.check_in<_window.window_from or a.check_in>=_window.window_to))
        or (a.check_out is not null and (a.check_out<_window.window_from or a.check_out>=_window.window_to)))) then
      raise exception 'This assignment would move punches belonging to finalized payroll. Choose a later effective date or a non-conflicting shift.' using errcode='55000';
    end if;
  end loop;
end $$;

-- Recompute already-calculated history and open payroll months, plus the current month.
-- Do not manufacture years of never-recorded absence or enqueue locked payroll dates.
create or replace function app.queue_shift_recompute(_employee uuid,_from date,_to date,_reason text)
returns integer language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _count integer;
begin
  insert into public.attendance_recompute_queue(employee_id,work_date,reason)
  with employee_window as (
    select e.id,e.entity_id,e.join_date,
      (select min(x.last_day) from public.exits x where x.employee_id=e.id and x.status in ('Cleared','Completed')
        and x.last_day>=coalesce(e.join_date,'0001-01-01'::date)) as last_day
    from public.employees e where e.id=_employee
  ), dates as (
    select a.work_date from public.attendance a where a.employee_id=_employee
    union
    select d::date from employee_window e cross join lateral generate_series(
      greatest(coalesce(e.join_date,date_trunc('month',now() at time zone 'Asia/Kolkata')::date),date_trunc('month',now() at time zone 'Asia/Kolkata')::date),
      least((now() at time zone 'Asia/Kolkata')::date,coalesce(e.last_day,(now() at time zone 'Asia/Kolkata')::date)),interval '1 day') d
    union
    select d::date from employee_window e join public.payroll_runs r on r.entity_id=e.entity_id and r.status='Draft'
      cross join lateral generate_series(greatest(app.payroll_period_start(r.period),coalesce(e.join_date,app.payroll_period_start(r.period))),
        least((app.payroll_period_start(r.period)+interval '1 month - 1 day')::date,coalesce(e.last_day,(app.payroll_period_start(r.period)+interval '1 month - 1 day')::date)),interval '1 day') d
  ) select _employee,d.work_date,left(_reason,200) from dates d join employee_window e on true
    where d.work_date between _from and _to
      and d.work_date>=coalesce(e.join_date,d.work_date) and d.work_date<=coalesce(e.last_day,d.work_date)
      and not exists(select 1 from public.attendance a where a.employee_id=_employee and a.work_date=d.work_date and a.is_locked)
      and not exists(select 1 from public.payslips p where p.employee_id=_employee and p.period=to_char(d.work_date,'YYYY-MM') and p.status='Published')
  on conflict(employee_id,work_date) where processed_at is null do update
    set generation=public.attendance_recompute_queue.generation+1,reason=excluded.reason;
  get diagnostics _count=row_count;
  return _count;
end $$;

create or replace function app.tg_shift_definition_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _old jsonb:=case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  _new jsonb:=case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end; _entity uuid;
begin
  -- Match payroll publication's company lock before changing any calculation dependency.
  for _entity in select id from public.entities where (_old->>'entity_id') is null or (_new->>'entity_id') is null
      or id in ((_old->>'entity_id')::uuid,(_new->>'entity_id')::uuid) order by id loop
    perform app.lock_payroll(_entity);
  end loop;
  if tg_op<>'DELETE' then
    if new.start_time=new.end_time then raise exception 'A shift must be shorter than 24 hours. Use distinct start and end times.' using errcode='23514'; end if;
    if new.break_minutes<0 or new.full_day_minutes<=0 or new.half_day_minutes<0 then
      raise exception 'Shift duty and break minutes must be valid nonnegative durations.' using errcode='23514';
    end if;
  end if;
  if tg_op<>'INSERT' and (tg_op='DELETE' or
      (_old-array['updated_at','is_active','is_default','crosses_midnight']) is distinct from (_new-array['updated_at','is_active','is_default','crosses_midnight'])) then
    if exists(select 1 from public.attendance a where a.shift_id=old.id and (a.is_locked or exists(
      select 1 from public.payslips p where p.employee_id=a.employee_id and p.period=to_char(a.work_date,'YYYY-MM') and p.status='Published')))
      or exists(select 1 from public.payslips p cross join lateral generate_series(
          coalesce((p.payroll_register->>'employment_from')::date,app.payroll_period_start(p.period)),
          coalesce((p.payroll_register->>'employment_to')::date,(app.payroll_period_start(p.period)+interval '1 month - 1 day')::date),interval '1 day') d
        where p.status='Published' and app.attendance_shift_for_date(p.employee_id,d::date)=old.id)
      or exists(select 1 from public.payslips p cross join lateral jsonb_array_elements(
          case when jsonb_typeof(p.payroll_register->'shift_days')='array' then p.payroll_register->'shift_days' else '[]'::jsonb end) d
        where p.status='Published' and d->>'shift_id'=old.id::text) then
      raise exception 'This shift is used by finalized payroll. Create a new shift and assign it from a new effective date.' using errcode='55000';
    end if;
  end if;
  if tg_op='UPDATE' and old.entity_id is distinct from new.entity_id
    and (exists(select 1 from public.employee_shift_assignments where shift_id=old.id) or exists(select 1 from public.attendance where shift_id=old.id)) then
    raise exception 'A shift already in use cannot change company. Create a new shift for that company.' using errcode='23514';
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
drop trigger if exists shift_definition_guard on public.shifts;
create trigger shift_definition_guard before insert or update or delete on public.shifts for each row execute function app.tg_shift_definition_guard();

create or replace function app.tg_shift_definition_recompute()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _old jsonb:=case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  _new jsonb:=case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end; _employee record; _from date; _to date;
begin
  if tg_op='UPDATE' and (_old-'updated_at') is not distinct from (_new-'updated_at') then return new; end if;
  for _employee in select e.id,e.entity_id,e.join_date from public.employees e where
    exists(select 1 from public.employee_shift_assignments a where a.employee_id=e.id and a.shift_id=coalesce((_new->>'id')::uuid,(_old->>'id')::uuid))
    or exists(select 1 from public.attendance a where a.employee_id=e.id and a.shift_id=coalesce((_new->>'id')::uuid,(_old->>'id')::uuid))
    or ((coalesce((_old->>'is_default')::boolean,false) or coalesce((_new->>'is_default')::boolean,false))
      and (e.entity_id in ((_old->>'entity_id')::uuid,(_new->>'entity_id')::uuid)
        or ((_old->>'entity_id' is null or _new->>'entity_id' is null) and not exists(select 1 from public.shifts s where s.entity_id=e.entity_id and s.is_default and s.is_active))))
    order by e.entity_id,e.id
  loop
    _from:=least(coalesce(_employee.join_date,(now() at time zone 'Asia/Kolkata')::date),
      coalesce((select min(effective_from) from public.employee_shift_assignments where employee_id=_employee.id),(now() at time zone 'Asia/Kolkata')::date),
      coalesce((select min(work_date) from public.attendance where employee_id=_employee.id),(now() at time zone 'Asia/Kolkata')::date));
    _to:=greatest((now() at time zone 'Asia/Kolkata')::date,coalesce((select max(effective_from) from public.employee_shift_assignments where employee_id=_employee.id),(now() at time zone 'Asia/Kolkata')::date),
      coalesce((select max(effective_to) from public.employee_shift_assignments where employee_id=_employee.id),(now() at time zone 'Asia/Kolkata')::date));
    perform app.validate_employee_shift_boundaries(_employee.id,_from,_to);
    perform app.queue_shift_recompute(_employee.id,_from-1,_to+1,'Shift definition changed');
    update public.payroll_runs set needs_recalculation=true where entity_id=_employee.entity_id and status='Draft';
  end loop;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
drop trigger if exists shift_definition_recompute on public.shifts;
create trigger shift_definition_recompute after insert or update or delete on public.shifts for each row execute function app.tg_shift_definition_recompute();

-- The existing assignment API closes the previous range before inserting its successor.
-- Published dates are guarded immediately; final schedule compatibility is deferred until
-- the complete replacement exists, and explicitly checked by the public RPC before return.
create or replace function app.tg_shift_assignment_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _employee uuid; _entity uuid;
begin
  for _entity in select distinct e.entity_id from public.employees e where e.id in (
    case when tg_op<>'INSERT' then old.employee_id end,case when tg_op<>'DELETE' then new.employee_id end) order by e.entity_id loop
    perform app.lock_payroll(_entity);
  end loop;
  for _employee in select distinct id from unnest(array[case when tg_op<>'INSERT' then old.employee_id end,case when tg_op<>'DELETE' then new.employee_id end]) id where id is not null order by id loop
    perform pg_advisory_xact_lock(hashtextextended(_employee::text,121));
  end loop;
  if exists(with protected_dates as (
    select employee_id,work_date from public.attendance where is_locked
    union select p.employee_id,d::date from public.payslips p cross join lateral generate_series(
      coalesce((p.payroll_register->>'employment_from')::date,app.payroll_period_start(p.period)),
      coalesce((p.payroll_register->>'employment_to')::date,(app.payroll_period_start(p.period)+interval '1 month - 1 day')::date),interval '1 day') d
      where p.status='Published' and p.employee_id in (case when tg_op<>'INSERT' then old.employee_id end,case when tg_op<>'DELETE' then new.employee_id end)
  ) select 1 from protected_dates a where ((tg_op<>'INSERT' and a.employee_id=old.employee_id and a.work_date between old.effective_from and coalesce(old.effective_to,'9999-12-31'::date)
      and (tg_op='DELETE' or new.employee_id is distinct from old.employee_id or new.shift_id is distinct from old.shift_id
        or a.work_date<new.effective_from or a.work_date>coalesce(new.effective_to,'9999-12-31'::date)))
    or (tg_op<>'DELETE' and a.employee_id=new.employee_id and a.work_date between new.effective_from and coalesce(new.effective_to,'9999-12-31'::date)
      and (tg_op='INSERT' or old.employee_id is distinct from new.employee_id or old.shift_id is distinct from new.shift_id
        or a.work_date<old.effective_from or a.work_date>coalesce(old.effective_to,'9999-12-31'::date))))) then
    raise exception 'A shift assignment cannot change dates used by finalized payroll. Choose a new effective date.' using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
drop trigger if exists shift_assignment_guard on public.employee_shift_assignments;
create trigger shift_assignment_guard before insert or update or delete on public.employee_shift_assignments for each row execute function app.tg_shift_assignment_guard();

create or replace function app.tg_shift_assignment_recompute()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _from date; _to date; _employee uuid;
begin
  _employee:=case when tg_op='DELETE' then old.employee_id else new.employee_id end;
  _from:=case when tg_op='INSERT' then new.effective_from when tg_op='DELETE' then old.effective_from else least(old.effective_from,new.effective_from) end;
  _to:=case when tg_op='INSERT' then coalesce(new.effective_to,(now() at time zone 'Asia/Kolkata')::date)
    when tg_op='DELETE' then coalesce(old.effective_to,(now() at time zone 'Asia/Kolkata')::date)
    else greatest(coalesce(old.effective_to,(now() at time zone 'Asia/Kolkata')::date),coalesce(new.effective_to,(now() at time zone 'Asia/Kolkata')::date)) end;
  _to:=greatest(_from,_to);
  perform app.queue_shift_recompute(_employee,_from-1,_to+1,'Shift assignment changed');
  if tg_op='UPDATE' and old.employee_id<>new.employee_id then
    perform app.queue_shift_recompute(old.employee_id,_from-1,_to+1,'Shift assignment moved');
  end if;
  update public.payroll_runs set needs_recalculation=true where status='Draft' and entity_id in
    (select e.entity_id from public.employees e where e.id in (_employee,case when tg_op='UPDATE' then old.employee_id end));
  if tg_op='DELETE' then return old; end if; return new;
end $$;

create or replace function app.tg_shift_assignment_validate()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _employee uuid; _from date; _to date;
begin
  _from:=case when tg_op='INSERT' then new.effective_from when tg_op='DELETE' then old.effective_from else least(new.effective_from,old.effective_from) end;
  _to:=greatest(_from,case when tg_op='INSERT' then coalesce(new.effective_to,new.effective_from)
    when tg_op='DELETE' then coalesce(old.effective_to,old.effective_from) else greatest(coalesce(new.effective_to,new.effective_from),coalesce(old.effective_to,old.effective_from)) end);
  for _employee in select distinct id from unnest(array[case when tg_op<>'INSERT' then old.employee_id end,case when tg_op<>'DELETE' then new.employee_id end]) id where id is not null loop
    if exists(select 1 from public.employees where id=_employee) then perform app.validate_employee_shift_boundaries(_employee,_from,_to); end if;
  end loop;
  return null;
end $$;
drop trigger if exists shift_assignment_validate on public.employee_shift_assignments;
create constraint trigger shift_assignment_validate after insert or update or delete on public.employee_shift_assignments
  deferrable initially deferred for each row execute function app.tg_shift_assignment_validate();

create or replace function public.assign_employee_shift(
  _employee_id uuid, _shift_id uuid, _effective_from date,
  _effective_to date default null, _note text default null
) returns uuid language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare
  employee public.employees%rowtype;
  shift public.shifts%rowtype;
  assignment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to assign a shift.' using errcode = '42501';
  end if;
  if _employee_id is null or _shift_id is null or _effective_from is null then
    raise exception 'Choose an employee, a shift and a start date.' using errcode = '22023';
  end if;
  if _effective_to is not null and _effective_to < _effective_from then
    raise exception 'The end date cannot be before the start date.' using errcode = '22023';
  end if;

  select * into employee from public.employees where id=_employee_id;
  if employee.id is null then raise exception 'Employee not found.' using errcode='22023'; end if;
  perform app.lock_payroll(employee.entity_id);
  -- Concurrent submissions for the same employee must observe the preceding replacement.
  perform pg_advisory_xact_lock(hashtextextended(_employee_id::text, 121));
  -- Read ancestry privately: shift.manage alone authorizes assignment, without also exposing
  -- the employee's personal record through employee.read. Every write is explicitly scoped below.
  select * into employee from public.employees where id = _employee_id;
  if not found or not app.has_perm('shift.manage', employee.entity_id, employee.zone_id,
      employee.branch_id, employee.department_id, employee.id) then
    raise exception 'You cannot assign a shift to this employee.' using errcode = '42501';
  end if;
  select * into shift from public.shifts where id = _shift_id;
  if not found or not shift.is_active then
    raise exception 'Choose an active shift.' using errcode = '22023';
  end if;
  if shift.entity_id is not null and shift.entity_id <> employee.entity_id then
    raise exception 'The shift must belong to the employee''s company.' using errcode = '22023';
  end if;

  if exists (select 1 from public.employee_shift_assignments a
      where a.employee_id = _employee_id and a.effective_to is null
        and (_effective_to is null or a.effective_from <= _effective_to)
        and not app.has_perm('shift.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)) then
    raise exception 'You cannot replace this employee''s existing assignment.' using errcode = '42501';
  end if;

  delete from public.employee_shift_assignments
   where employee_id = _employee_id and effective_to is null and effective_from >= _effective_from
     and (_effective_to is null or effective_from <= _effective_to);
  update public.employee_shift_assignments set effective_to = _effective_from - 1
   where employee_id = _employee_id and effective_to is null and effective_from < _effective_from;
  insert into public.employee_shift_assignments(employee_id, shift_id, effective_from, effective_to, note)
  values (_employee_id, _shift_id, _effective_from, _effective_to, nullif(btrim(_note), ''))
  returning id into assignment_id;
  perform app.validate_employee_shift_boundaries(_employee_id,_effective_from,
    greatest(_effective_from,coalesce(_effective_to,(now() at time zone 'Asia/Kolkata')::date),
      coalesce((select max(effective_from) from public.employee_shift_assignments where employee_id=_employee_id),_effective_from)));
  return assignment_id;
end;
$$;

create or replace function public.assign_employee_shifts(_employee_ids uuid[],_shift_id uuid,_effective_from date,
  _effective_to date default null,_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _employee uuid; _entity uuid; _assignment uuid; _rows jsonb:='[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to assign shifts.' using errcode='42501'; end if;
  if _employee_ids is null or cardinality(_employee_ids) not between 1 and 1000 or array_position(_employee_ids,null) is not null then
    raise exception 'Choose between 1 and 1000 employees.' using errcode='22023';
  end if;
  if cardinality(_employee_ids)<>(select count(distinct id) from unnest(_employee_ids) id) then
    raise exception 'Each selected employee must appear once.' using errcode='22023';
  end if;
  if exists(select 1 from unnest(_employee_ids) selected(employee_id) left join public.employees e on e.id=selected.employee_id where e.id is null
    or not app.has_perm('shift.manage',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.id)) then
    raise exception 'One or more employees are outside your shift management scope.' using errcode='42501';
  end if;
  for _entity in select distinct entity_id from public.employees where id=any(_employee_ids) order by entity_id loop
    perform app.lock_payroll(_entity);
  end loop;
  for _employee in select id from unnest(_employee_ids) id order by id loop
    perform pg_advisory_xact_lock(hashtextextended(_employee::text,121));
  end loop;
  for _employee in select id from unnest(_employee_ids) id order by id loop
    _assignment:=public.assign_employee_shift(_employee,_shift_id,_effective_from,_effective_to,_note);
    _rows:=_rows||jsonb_build_array(jsonb_build_object('employee_id',_employee,'assignment_id',_assignment));
  end loop;
  return jsonb_build_object('employee_count',cardinality(_employee_ids),'assignments',_rows);
end $$;

create or replace function app.payroll_source_fingerprint(_entity uuid,_period text)
returns text language sql stable security definer set search_path=pg_catalog,public,app as $$
  select md5(jsonb_build_object(
    'calculation_contract','payroll_v4_shift_ownership_v1',
    'shifts',(select jsonb_agg(to_jsonb(s) order by s.id) from public.shifts s where s.entity_id is null or s.entity_id=_entity
      or exists(select 1 from public.employee_shift_assignments a join public.employees e on e.id=a.employee_id where a.shift_id=s.id and e.entity_id=_entity)),
    'shift_assignments',(select jsonb_agg(to_jsonb(a) order by a.id) from public.employee_shift_assignments a join public.employees e on e.id=a.employee_id
      where e.entity_id=_entity and a.effective_from<=app.payroll_period_start(_period)+interval '1 month'
        and coalesce(a.effective_to,'9999-12-31'::date)>=app.payroll_period_start(_period)-1),
    'adjustments',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_adjustments t where entity_id=_entity and period=_period),
    'advance_recoveries',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_advance_recoveries t where entity_id=_entity and period=_period),
    'policy',(select to_jsonb(p) from public.payroll_policies p where entity_id=_entity),
    'inputs',(select jsonb_agg(to_jsonb(i) order by employee_id) from public.payroll_monthly_inputs i where entity_id=_entity and period=_period),
    'employees',(select jsonb_agg(jsonb_build_object('id',e.id,'entity',e.entity_id,'branch',e.branch_id,'zone',e.zone_id,
      'department',e.department_id,'name',e.full_name,'code',e.employee_code,'join',e.join_date,'status',e.status) order by e.id)
      from public.employees e where entity_id=_entity),
    'salaries',(select jsonb_agg(to_jsonb(s) order by s.id) from public.salary_structures s join public.employees e on e.id=s.employee_id
      where e.entity_id=_entity and s.effective_from < app.payroll_period_start(_period)+interval '1 month'),
    'components',(select jsonb_agg(to_jsonb(c) order by id) from public.pay_components c where entity_id is null or entity_id=_entity),
    'attendance',(select jsonb_agg(to_jsonb(a) order by a.id) from public.attendance a join public.employees e on e.id=a.employee_id
      where e.entity_id=_entity and a.work_date >= app.payroll_period_start(_period) and a.work_date < app.payroll_period_start(_period)+interval '1 month'),
    'leaves',(select jsonb_agg(to_jsonb(l) order by l.id) from public.leaves l join public.employees e on e.id=l.employee_id
      where e.entity_id=_entity and l.start_date < app.payroll_period_start(_period)+interval '1 month' and l.end_date >= app.payroll_period_start(_period)),
    'regularizations',(select jsonb_agg(to_jsonb(r) order by r.id) from public.attendance_regularizations r join public.employees e on e.id=r.employee_id
      where e.entity_id=_entity and r.work_date>=app.payroll_period_start(_period) and r.work_date<app.payroll_period_start(_period)+interval '1 month'),
    'recompute',(select jsonb_agg(to_jsonb(q) order by q.id) from public.attendance_recompute_queue q left join public.employees e on e.id=q.employee_id
      where (e.entity_id=_entity or q.employee_id is null) and q.work_date>=app.payroll_period_start(_period) and q.work_date<app.payroll_period_start(_period)+interval '1 month'),
    'exits',(select jsonb_agg(to_jsonb(x) order by x.id) from public.exits x join public.employees e on e.id=x.employee_id where e.entity_id=_entity)
  )::text);
$$;

create or replace function app.attendance_punch_correction_source(_employee_id uuid,_work_date date)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,app as $$
  select jsonb_build_object(
    'shift_window',to_jsonb(w),
    'shift_context',(select jsonb_agg(jsonb_build_object('work_date',d,'shift',to_jsonb(s)) order by d)
      from generate_series(_work_date-1,_work_date+1,interval '1 day') d left join public.shifts s on s.id=app.attendance_shift_for_date(_employee_id,d::date)),
    'employee',jsonb_build_object('id',e.id,'entity_id',e.entity_id,'zone_id',e.zone_id,
      'branch_id',e.branch_id,'department_id',e.department_id,'join_date',e.join_date),
    'attendance',(select to_jsonb(a) from public.attendance a where a.employee_id=e.id and a.work_date=_work_date),
    'active_correction',(select to_jsonb(r) from public.attendance_regularizations r
      where r.employee_id=e.id and r.work_date=_work_date and r.status in ('Pending','Approved')),
    'raw_punches',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'punch_time',p.punch_time,
      'punch_state',p.punch_state,'punch_state_label',p.punch_state_label,'source',p.source)
      order by p.punch_time,p.id) from public.raw_punches p where p.employee_id=e.id
      and p.punch_time>=least((_work_date-1)::timestamp at time zone 'Asia/Kolkata',w.window_from)
      and p.punch_time<greatest((_work_date+2)::timestamp at time zone 'Asia/Kolkata',w.window_to)),'[]'::jsonb),
    'queue',coalesce((select jsonb_agg(to_jsonb(q) order by q.id) from public.attendance_recompute_queue q
      where (q.employee_id=e.id or q.employee_id is null) and q.work_date=_work_date),'[]'::jsonb),
    'published',exists(select 1 from public.payslips p where p.employee_id=e.id
      and p.period=to_char(_work_date,'YYYY-MM') and p.status='Published')
  ) from public.employees e cross join lateral app.attendance_punch_window(e.id,_work_date) w where e.id=_employee_id;
$$;

create or replace function public.get_attendance_punch_correction_context(_employee_id uuid,_work_date date)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare _emp public.employees; _source jsonb; _locked boolean; _blocked text; _active jsonb;
begin
  select * into _emp from public.employees where id=_employee_id;
  if auth.uid() is null or _emp.id is null or not app.has_perm('attendance.read',_emp.entity_id,
    _emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to view this attendance day.' using errcode='42501';
  end if;
  if _work_date is null or not isfinite(_work_date) then
    raise exception 'Choose a valid work date.' using errcode='22023';
  end if;
  _source:=app.attendance_punch_correction_source(_employee_id,_work_date);
  _active:=_source->'active_correction';
  _locked:=coalesce((_source#>>'{attendance,is_locked}')::boolean,false) or (_source->>'published')::boolean;
  _blocked:=case
    when not app.has_perm('attendance.manage',_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id)
      then 'You do not have permission to correct this employee’s punches.'
    when _emp.id=app.current_employee_id() or _emp.user_id=auth.uid()
      then 'Another HR manager must correct your own attendance.'
    when _locked then 'This attendance day is locked by finalized payroll.'
    when _work_date>(now() at time zone 'Asia/Kolkata')::date then 'Future attendance cannot be corrected.'
    when _emp.join_date is not null and _work_date<_emp.join_date then 'This date is before the employee joined.'
    when _source#>>'{shift_window,shift_id}' is null then 'Assign a shift for this date before correcting punches.'
    when _active->>'status'='Pending' then 'Review the pending correction request before editing this day.'
    else null end;
  return jsonb_build_object('employee_id',_employee_id,'work_date',_work_date,
    'shift_window',_source->'shift_window','shift_context',_source->'shift_context',
    'source_revision',md5(_source::text),'attendance',_source->'attendance',
    'active_correction',_active,'raw_punches',_source->'raw_punches',
    'check_in',case when _active->>'status'='Approved' then coalesce(_active->>'check_in',_source#>>'{attendance,check_in}')
      else _source#>>'{attendance,check_in}' end,
    'check_out',case when _active->>'status'='Approved' then coalesce(_active->>'check_out',_source#>>'{attendance,check_out}')
      else _source#>>'{attendance,check_out}' end,
    'is_locked',_locked,'can_correct',_blocked is null,'blocked_reason',_blocked,
    'pending_recompute',exists(select 1 from jsonb_array_elements(_source->'queue') q where q->>'processed_at' is null),
    'history',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id)
      from public.attendance_regularizations r where r.employee_id=_employee_id and r.work_date=_work_date),'[]'::jsonb),
    'correction_history',coalesce((select jsonb_agg(to_jsonb(h)-'payload' order by h.changed_at desc,h.request_id)
      from public.attendance_punch_correction_history h where h.employee_id=_employee_id and h.work_date=_work_date),'[]'::jsonb));
end $$;

create or replace function public.save_attendance_punch_correction(
  _request_id uuid,_employee_id uuid,_work_date date,_check_in timestamptz,_check_out timestamptz,
  _reason text,_source_revision text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare
  _emp public.employees; _entity uuid; _actor uuid:=auth.uid(); _source jsonb; _payload jsonb;
  _prior public.attendance_regularizations; _saved public.attendance_regularizations;
  _receipt public.attendance_punch_correction_history; _window record; _effective_in timestamptz; _effective_out timestamptz; _trimmed text:=btrim(coalesce(_reason,''));
begin
  select * into _emp from public.employees where id=_employee_id;
  if _actor is null or _emp.id is null or not app.has_perm('attendance.manage',_emp.entity_id,
    _emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to correct this employee’s punches.' using errcode='42501';
  end if;
  if _emp.id=app.current_employee_id() or _emp.user_id=_actor then
    raise exception 'Another HR manager must correct your own attendance.' using errcode='42501';
  end if;
  if _request_id is null or _work_date is null or not isfinite(_work_date) then
    raise exception 'A request ID and valid work date are required.' using errcode='22023';
  end if;
  if length(_trimmed)<3 or length(_trimmed)>1000 then
    raise exception 'Enter a correction reason between 3 and 1000 characters.' using errcode='22023';
  end if;
  if _check_in is null and _check_out is null then
    raise exception 'Enter a check-in or check-out time.' using errcode='22023';
  end if;
  if (_check_in is not null and not isfinite(_check_in)) or (_check_out is not null and not isfinite(_check_out))
    or (_check_in is not null and _check_out is not null and (_check_out<=_check_in or _check_out-_check_in>=interval '24 hours')) then
    raise exception 'Corrected checkout must follow check-in within a duty shorter than 24 hours.' using errcode='22023';
  end if;
  if _work_date>(now() at time zone 'Asia/Kolkata')::date or _check_in>clock_timestamp() or _check_out>clock_timestamp() then
    raise exception 'Future punches cannot be recorded.' using errcode='22023';
  end if;
  if _emp.join_date is not null and _work_date<_emp.join_date then
    raise exception 'This date is before the employee joined.' using errcode='22023';
  end if;
  _payload:=jsonb_build_object('employee_id',_employee_id,'work_date',_work_date,
    'check_in',_check_in,'check_out',_check_out,'reason',_trimmed,'source_revision',_source_revision);
  -- Same order as publication and all payroll source changes. Recheck scope after waiting.
  _entity:=_emp.entity_id; perform app.lock_payroll(_entity);
  select * into _emp from public.employees where id=_employee_id;
  if _emp.entity_id is distinct from _entity then
    raise exception 'Employee company changed. Reload before saving.' using errcode='40001';
  end if;
  if not app.has_perm('attendance.manage',_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id)
    or _emp.id=app.current_employee_id() or _emp.user_id=_actor then
    raise exception 'Not authorized to correct this employee’s punches.' using errcode='42501';
  end if;
  -- Serialize request keys even when two accidental uses target different companies.
  perform pg_advisory_xact_lock(hashtextextended('attendance-punch-request:'||_request_id::text,0));
  select * into _receipt from public.attendance_punch_correction_history where request_id=_request_id;
  if _receipt.request_id is not null then
    if _receipt.changed_by is distinct from _actor or _receipt.payload is distinct from _payload then
      raise exception 'This correction request ID was already used. Reload before saving.' using errcode='40001';
    end if;
    return jsonb_build_object('correction_id',_receipt.correction_id,'employee_id',_employee_id,
      'work_date',_work_date,'recompute_pending',exists(select 1 from public.attendance_recompute_queue q
        where (q.employee_id=_employee_id or q.employee_id is null) and q.work_date=_work_date and q.processed_at is null),
      'already_saved',true);
  end if;
  _source:=app.attendance_punch_correction_source(_employee_id,_work_date);
  if coalesce((_source#>>'{attendance,is_locked}')::boolean,false) or (_source->>'published')::boolean then
    raise exception 'This attendance day is locked by finalized payroll.' using errcode='55000';
  end if;
  if _source#>>'{active_correction,status}'='Pending' then
    raise exception 'Review the pending correction request before editing this day.' using errcode='55000';
  end if;
  if _source_revision is null or md5(_source::text) is distinct from _source_revision then
    raise exception 'This attendance day changed. Reload the latest punches before saving.' using errcode='40001';
  end if;
  select * into _window from app.attendance_punch_window(_employee_id,_work_date);
  if _window.shift_id is null then raise exception 'Assign a shift for this date before correcting punches.' using errcode='23514'; end if;
  if (_check_in is not null and (_check_in<_window.window_from or _check_in>=_window.window_to))
    or (_check_out is not null and (_check_out<_window.window_from or _check_out>=_window.window_to)) then
    raise exception 'Corrected times must belong to this work date’s assigned shift window. Select the correct work date or shift.' using errcode='22023';
  end if;
  select coalesce(_check_in,min(punch_time)),coalesce(_check_out,max(punch_time)) into _effective_in,_effective_out
    from public.raw_punches where employee_id=_employee_id and punch_time>=_window.window_from and punch_time<_window.window_to;
  if _effective_in is not null and _effective_out is not null and _effective_out-_effective_in>=interval '24 hours' then
    raise exception 'The corrected duty must be shorter than 24 hours. Review both endpoints.' using errcode='22023';
  end if;
  select * into _prior from public.attendance_regularizations
    where employee_id=_employee_id and work_date=_work_date and status='Approved';
  if _prior.id is not null then
    -- Preserve the original requester, reviewer, times and reason as historical evidence.
    update public.attendance_regularizations set status='Cancelled' where id=_prior.id;
  end if;
  insert into public.attendance_regularizations(id,employee_id,work_date,check_in,check_out,reason,
    status,requested_by,approver_id,decided_by,decided_at,decision_note)
  values(_request_id,_employee_id,_work_date,_check_in,_check_out,_trimmed,'Approved',
    _actor,app.current_employee_id(),_actor,clock_timestamp(),'Direct HR punch correction in Supabase')
  returning * into _saved;
  insert into public.attendance_punch_correction_history(request_id,employee_id,work_date,entity_id,zone_id,branch_id,
    department_id,correction_id,previous_correction_id,payload,source_revision,before_state,after_state,reason,changed_by)
  values(_request_id,_employee_id,_work_date,_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,
    _saved.id,_prior.id,_payload,_source_revision,_source,to_jsonb(_saved),_trimmed,_actor);
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id,branch_id)
    select _actor,email,'ATTENDANCE_PUNCH_CORRECTED','attendance_regularizations',_saved.id,_emp.entity_id,_emp.branch_id
      from auth.users where id=_actor;
  return jsonb_build_object('correction_id',_saved.id,'employee_id',_employee_id,
    'work_date',_work_date,'recompute_pending',true,'already_saved',false);
end $$;

-- Midnight starts and a long night followed by an unassigned day extend ownership beyond
-- the old previous/current-date fence. Match the worker's conservative four-date queue.
create or replace function app.tg_payroll_punch_recompute()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _date date;
begin
  if tg_op='UPDATE' and row(new.employee_id,new.punch_time) is not distinct from row(old.employee_id,old.punch_time) then
    return new;
  end if;
  if tg_op<>'INSERT' and old.employee_id is not null then
    _date:=(old.punch_time at time zone 'Asia/Kolkata')::date;
    perform app.enqueue_recompute_internal(old.employee_id,_date-2,_date+1,'Payroll: punch changed');
  end if;
  if tg_op<>'DELETE' and new.employee_id is not null then
    _date:=(new.punch_time at time zone 'Asia/Kolkata')::date;
    perform app.enqueue_recompute_internal(new.employee_id,_date-2,_date+1,'Payroll: punch arrived or relinked');
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

-- The ownership algorithm changes derived hours, even when nobody edits a schedule.
-- Queue existing unlocked attendance once on upgrade; retries must not churn generations.
-- The worker recalculates it using the new rules, without touching finalized payroll.
insert into public.attendance_recompute_queue(employee_id,work_date,reason)
  with candidates as (
    select distinct a.employee_id,a.work_date+offset_day as work_date
    from public.attendance a cross join generate_series(-1,1) offset_day
    where (select required from shift_ownership_upgrade)
  ) select a.employee_id,a.work_date,'Shift ownership rules upgraded'
  from candidates a join public.employees e on e.id=a.employee_id
  where a.work_date>=coalesce(e.join_date,a.work_date)
    and a.work_date<=coalesce((select min(x.last_day) from public.exits x where x.employee_id=e.id
      and x.status in ('Cleared','Completed') and x.last_day>=coalesce(e.join_date,'0001-01-01'::date)),a.work_date)
    and not exists(select 1 from public.attendance locked where locked.employee_id=a.employee_id and locked.work_date=a.work_date and locked.is_locked)
    and not exists(select 1 from public.payslips p where p.employee_id=a.employee_id
      and p.period=to_char(a.work_date,'YYYY-MM') and p.status='Published')
on conflict(employee_id,work_date) where processed_at is null do update
  set generation=public.attendance_recompute_queue.generation+1,reason=excluded.reason;

-- Existing drafts must be regenerated against the upstream shift configuration fingerprint.
update public.payroll_runs set needs_recalculation=true where status='Draft' and not needs_recalculation;
revoke all on function app.attendance_shift_for_date(uuid,date),app.attendance_shift_schedule(uuid,date),app.attendance_day_boundary(uuid,date),
  app.attendance_punch_window(uuid,date),app.validate_employee_shift_boundaries(uuid,date,date),app.queue_shift_recompute(uuid,date,date,text),
  app.tg_shift_definition_guard(),app.tg_shift_definition_recompute(),app.tg_shift_assignment_guard(),app.tg_shift_assignment_validate()
  from public,anon,authenticated,service_role;
-- This immutable validator is used by table CHECK constraints evaluated as the writing role.
revoke all on function app.shift_unpaid_break_minutes(time,time,jsonb) from public,anon;
grant execute on function app.shift_unpaid_break_minutes(time,time,jsonb) to authenticated,service_role;
revoke all on function public.assign_employee_shifts(uuid[],uuid,date,date,text) from public,anon;
grant execute on function public.assign_employee_shifts(uuid[],uuid,date,date,text) to authenticated;
notify pgrst,'reload schema';
commit;
