-- Forward repair for databases which applied earlier copies of 0163/0164 before
-- those files acquired the current payroll shift basis and punch ownership helpers.
-- Keep definitions identical to their latest source migrations, preserving the
-- employment-aware attendance_shift_for_date resolver installed by 0165.
-- This migration changes schema only: no policy, shift, payroll, attendance or
-- queue rows are written, and no historical recomputation is requested.
begin;


-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0163_payroll_hourly_workings.sql
create or replace function app.payroll_shift_days(_employee uuid,_from date,_to date)
returns table(work_date date,shift_id uuid,shift_name text,daily_minutes integer,worked_minutes numeric,
  actual numeric,holiday numeric,off_day numeric,casual numeric,other_leave numeric)
language sql stable security definer set search_path=pg_catalog,public,app as $$
  select d::date,s.id,s.name,s.full_day_minutes,
    greatest(coalesce(a.worked_minutes,0),0)::numeric,
    case when a.day_type='working' then greatest(0,a.day_fraction-paid.days) else 0 end,
    case when a.day_type='holiday' then 1 else 0 end::numeric,
    case when a.day_type='weekly_off' then 1 else 0 end::numeric,
    case when coalesce(a.leave_type,l.type) in ('CL','Casual Leave') then paid.days else 0 end,
    case when coalesce(a.leave_type,l.type) in ('CL','Casual Leave') then 0 else paid.days end
  from generate_series(_from::timestamp,_to::timestamp,interval '1 day') d
  left join public.shifts s on s.id=public.shift_for_employee(_employee,d::date)
  left join public.attendance a on a.employee_id=_employee and a.work_date=d::date
  left join public.leaves l on l.id=a.leave_id
  cross join lateral (select case when a.day_type='working' and a.status='On Leave' and not a.is_lop
    then least(a.day_fraction,coalesce(l.day_fraction,a.day_fraction)) else 0 end::numeric as days) paid;
$$;

-- Restored from 0163_payroll_hourly_workings.sql
create or replace function app.payroll_shift_basis_issue(_employee uuid,_from date,_to date,_input jsonb)
returns text language sql stable security definer set search_path=pg_catalog,public,app as $$
  select case when count(*) filter(where daily_minutes is null or daily_minutes<=0)>0
    then 'Assign a shift with daily paid hours for every date in the payroll employment period.'
    when coalesce(_input->>'attendance_source','recorded')='reviewed' and count(distinct daily_minutes)>1
    then 'Daily shift hours change during this month. Use recorded daily attendance; monthly reviewed hours cannot be split between different hourly rates.' end
  from app.payroll_shift_days(_employee,_from,_to);
$$;

-- Restored from 0163_payroll_hourly_workings.sql
create or replace function app.payroll_shift_workings(_employee uuid,_from date,_to date,_monthly_salary numeric,
  _divisor numeric,_credit_mode text,_input jsonb,_attendance jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare _days jsonb; _daily jsonb; _base jsonb; _basis numeric; _count integer; _missing integer;
  _daily_rate numeric:=ceil(_monthly_salary/_divisor); _raw numeric; _worked numeric; _credited numeric;
  _required numeric; _memo numeric; _undated numeric; _casual_dated boolean; _off_dated boolean;
begin
  select jsonb_agg(to_jsonb(d) order by work_date),min(daily_minutes)/60.0,count(distinct daily_minutes),
    count(*) filter(where daily_minutes is null or daily_minutes<=0)
    into _days,_basis,_count,_missing from app.payroll_shift_days(_employee,_from,_to) d;
  if _missing>0 or _count=0 then return jsonb_build_object('shift_basis_issue','Assign a shift with daily paid hours for every date in the payroll employment period.'); end if;
  _base:=app.payroll_hourly_workings(_monthly_salary,_divisor,_basis,_credit_mode,_input,_attendance);
  if _count=1 then
    -- Preserve the verified HR worksheet formula when all dates have the same daily basis.
    return _base||jsonb_build_object('per_day_working_hour',_basis,'shift_basis','assigned_shift',
      'variable_shift_hours',false,'shift_days',_days,'undated_credit_days',0,'undated_credit_amount',0);
  end if;
  if _input->>'attendance_source'='reviewed' then return jsonb_build_object('shift_basis_issue',
    'Daily shift hours change during this month. Use recorded daily attendance; monthly reviewed hours cannot be split between different hourly rates.'); end if;
  _casual_dated:=_credit_mode='attendance' and (_input->>'casual_leave_days') is null;
  _off_dated:=_credit_mode='attendance' and (_input->>'off_days') is null;
  _undated:=case when _casual_dated then 0 else (_base->>'casual_leave')::numeric end
    +case when _off_dated then 0 else (_base->>'off_days')::numeric end;
  with days as (
    select d.*,daily_minutes/60.0 as basis,round(_daily_rate/(daily_minutes/60.0),1) as rate,
      holiday+other_leave+case when _casual_dated then casual else 0 end
        +case when _off_dated then off_day else 0 end as credit_days
    from jsonb_to_recordset(_days) as d(work_date date,shift_id uuid,shift_name text,daily_minutes integer,
      worked_minutes numeric,actual numeric,holiday numeric,off_day numeric,casual numeric,other_leave numeric)
  ), amounts as (
    select *,worked_minutes/60.0*rate as worked_amount,credit_days*basis*rate as credit_amount from days
  ) select sum(worked_amount+credit_amount)+_undated*_daily_rate,sum(worked_minutes)/60.0,
      sum(credit_days*basis),sum(actual*basis),sum((worked_minutes/60.0-actual*basis)*rate),
      jsonb_agg(jsonb_build_object('work_date',work_date,'shift_id',shift_id,'shift_name',shift_name,
        'daily_hours',basis,'hourly_rate',rate,'worked_hours',worked_minutes/60.0,
        'credited_hours',credit_days*basis,'worked_amount',worked_amount,'credit_amount',credit_amount) order by work_date)
    into _raw,_worked,_credited,_required,_memo,_daily from amounts;
  return _base||jsonb_build_object('per_day_working_hour',null,'per_hour_wages',null,
    'shift_basis','assigned_shift','variable_shift_hours',true,'shift_days',_daily,
    'credited_hours',_credited,'payable_hours',_worked+_credited,
    'required_worked_hours',_required,'ot_memo_hours',_worked-_required,'ot_memo_amount',_memo,
    'undated_credit_days',_undated,'undated_credit_amount',_undated*_daily_rate,
    'undated_credit_rule','one_daily_wage_per_day',
    'unrounded_earned_salary',_raw,'earned_salary',round(_raw,2));
end $$;

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0163_payroll_hourly_workings.sql
create or replace function public.run_payroll(_entity_id uuid,_period text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare
  _from date := app.payroll_period_start(_period); _to date; _days int; _start date; _end date;
  _run_id uuid; _payslip_id uuid; _emp record; _sal public.salary_structures%rowtype; _comp record; _named record;
  _policy public.payroll_policies%rowtype; _input public.payroll_monthly_inputs%rowtype;
  _hourly boolean; _reviewed boolean; _hourly_data jsonb; _review_issue text; _wages_roundoff numeric; _net_roundoff numeric; _tds numeric;
  _configured boolean; _stats record; _full_working numeric; _divisor numeric; _factor numeric;
  _paid numeric; _lop numeric; _salary numeric; _basic numeric; _earn numeric; _ded numeric; _employer numeric;
  _structure_total numeric; _base numeric; _amount numeric; _rate numeric; _hour_rate numeric;
  _ot numeric; _late numeric; _effective_ot numeric; _effective_late numeric; _pf numeric; _esi numeric; _other_ded numeric; _advance numeric; _welfare numeric;
  _adjustment record; _bonus numeric; _adjustment_incentive numeric; _adjustment_deductions numeric; _ledger_advance numeric;
  _count int:=0; _sum_gross numeric:=0; _sum_net numeric:=0; _register jsonb; _key text; _label text;
begin
  if auth.uid() is null and current_setting('role',true) in ('authenticated','anon') then
    raise exception 'Sign in to run payroll.' using errcode='42501';
  end if;
  if auth.uid() is not null and not app.has_perm('payroll.manage',_entity_id,null,null,null,null) then
    raise exception 'Not authorized to run payroll for this company.' using errcode='42501';
  end if;
  if _entity_id is null or not exists(select 1 from public.entities where id=_entity_id) then
    raise exception 'Choose a valid company.' using errcode='22023';
  end if;
  perform app.lock_payroll(_entity_id);
  _to := (_from+interval '1 month - 1 day')::date; _days := extract(day from _to)::int;
  select * into _policy from public.payroll_policies where entity_id=_entity_id;
  _configured := found;
  if not _configured then
    _policy.divisor_mode:='calendar'; _policy.fixed_days:=30; _policy.hours_per_day:=8;
    _policy.ot_multiplier:=2; _policy.deduct_late:=false; _policy.calculation_mode:='paid_days'; _policy.credit_mode:='attendance';
  end if;
  _hourly:=_policy.calculation_mode='hourly_workings';
  if _hourly and _policy.divisor_mode='working' then
    raise exception 'HR hourly workings supports a calendar or fixed-day divisor.' using errcode='23514';
  end if;
  insert into public.payroll_runs(entity_id,period,status,run_by) values(_entity_id,_period,'Draft',auth.uid())
    on conflict(entity_id,period) do update set run_by=excluded.run_by where public.payroll_runs.status='Draft'
    returning id into _run_id;
  if _run_id is null then raise exception 'Published payroll cannot be regenerated.' using errcode='55000'; end if;
  if exists(select 1 from (
    select employee_id from public.payroll_adjustments where entity_id=_entity_id and period=_period
    union select employee_id from public.payroll_advance_recoveries where entity_id=_entity_id and period=_period
  ) t where not exists(select 1 from app.payroll_employee_windows(_entity_id,_from,_to) w where w.employee_id=t.employee_id)) then
    raise exception 'Some adjustments or advance recoveries belong to employees outside this payroll month. Remove or reschedule them before calculating.' using errcode='23514';
  end if;
  delete from public.payslips where run_id=_run_id;

  for _emp in
    select e.*,b.name as branch_name,w.employment_from,w.employment_to,w.last_day
    from app.payroll_employee_windows(_entity_id,_from,_to) w
    join public.employees e on e.id=w.employee_id left join public.branches b on b.id=e.branch_id
    order by e.id
  loop
    _start:=_emp.employment_from; _end:=_emp.employment_to;
    continue when _end<_start;
    if _emp.status<>'Active' and _emp.last_day is null then
      raise exception 'Complete the last working day for inactive employee % before payroll.',_emp.full_name using errcode='23514';
    end if;
    select * into _sal from public.salary_structures where employee_id=_emp.id and effective_from<=_start
      order by effective_from desc limit 1;
    if _sal.id is null then raise exception 'Set a salary effective on or before % for %.',_start,_emp.full_name using errcode='23514'; end if;
    if exists(select 1 from public.salary_structures where employee_id=_emp.id and effective_from>_start and effective_from<=_end) then
      raise exception 'Midmonth salary revision for % requires a split-period calculation; this run cannot proceed.',_emp.full_name using errcode='23514';
    end if;
    if _sal.gross < 0 or _sal.basic < 0 or _sal.basic>_sal.gross or _sal.gross >= 'Infinity'::numeric then
      raise exception 'Invalid salary for %.',_emp.full_name using errcode='23514';
    end if;

    select * into _input from public.payroll_monthly_inputs where employee_id=_emp.id and period=_period;
    _review_issue:=app.payroll_attendance_review_issue(to_jsonb(_input),to_jsonb(_policy),_end-_start+1);
    if _review_issue is not null then raise exception '%: %',_emp.full_name,_review_issue using errcode='23514'; end if;
    _reviewed:=_hourly and coalesce(_input.attendance_source,'recorded')='reviewed';
    select * into _stats from app.payroll_attendance_metrics(_emp.id,_start,_end);
    if not _reviewed then
      if _stats.pending_recompute_days>0 then
        raise exception 'Attendance changes for % are awaiting recomputation. Refresh attendance before running payroll.',_emp.full_name using errcode='23514';
      end if;
      if _stats.recorded <> (_end-_start+1) then
        raise exception 'Attendance is incomplete for %: % of % employment days. Recompute and review attendance first.',_emp.full_name,_stats.recorded,(_end-_start+1) using errcode='23514';
      end if;
      if _stats.unresolved>0 or _stats.invalid>0 then
        raise exception 'Resolve missing punches, missing shifts, incomplete breaks and invalid day credits for % before payroll.',_emp.full_name using errcode='23514';
      end if;
    end if;
    _lop:=_stats.lop; _paid:=(_end-_start+1)-_lop;
    if _policy.divisor_mode='working' then
      select count(*) into _full_working from public.attendance where employee_id=_emp.id and work_date between _from and _to and day_type='working';
      if (select count(*) from public.attendance where employee_id=_emp.id and work_date between _from and _to)<>_days or _full_working=0 then
        raise exception 'Working-day divisor needs a complete month calendar, including outside employment, for %.',_emp.full_name using errcode='23514';
      end if;
      _divisor:=_full_working; _factor:=greatest(0,least(1,(_stats.working-_lop)/_divisor));
    elsif _policy.divisor_mode='fixed' then
      _divisor:=_policy.fixed_days; _factor:=greatest(0,least(1,1-(_days-(_end-_start+1)+_lop)/_divisor));
    else
      _divisor:=_days; _factor:=_paid/_days;
    end if;
    if _hourly then
      _review_issue:=app.payroll_shift_basis_issue(_emp.id,_start,_end,to_jsonb(_input));
      if _review_issue is not null then raise exception '%: %',_emp.full_name,_review_issue using errcode='23514'; end if;
      _hourly_data:=app.payroll_shift_workings(_emp.id,_start,_end,_sal.gross,_divisor,_policy.credit_mode,to_jsonb(_input),to_jsonb(_stats));
      _salary:=(_hourly_data->>'earned_salary')::numeric;
      _rate:=(_hourly_data->>'per_day_wages')::numeric; _hour_rate:=(_hourly_data->>'per_hour_wages')::numeric;
      _paid:=(_hourly_data->>'total_working_days')::numeric; _lop:=greatest(0,(_end-_start+1)-_paid);
      _factor:=case when _sal.gross=0 then 0 else _salary/_sal.gross end;
      _basic:=round(_sal.basic*_factor,2);
      _effective_ot:=0; _effective_late:=0; _ot:=0; _late:=0;
    else
      _hourly_data:=null;
      _salary:=round(_sal.gross*_factor,2); _basic:=round(_sal.basic*_factor,2);
      _rate:=_sal.gross/_divisor; _hour_rate:=_rate/_policy.hours_per_day;
      if coalesce(_input.ot_hours,0)>round(_stats.ot_hours,2) then
        raise exception 'Approved OT hours exceed recorded OT for %.',_emp.full_name using errcode='23514';
      end if;
      if _policy.deduct_late and coalesce(_input.late_hours,0)>round(_stats.deductible_late_hours,2) then
        raise exception 'Approved late hours exceed lateness on fully paid working days for %; do not charge the same time as loss of pay.',_emp.full_name using errcode='23514';
      end if;
      if coalesce(_input.late_hours,0)>0 and not _policy.deduct_late then
        raise exception 'Late deductions are disabled by company policy. Clear approved late hours for % or enable the policy.',_emp.full_name using errcode='23514';
      end if;
      _effective_ot:=coalesce(_input.ot_hours,round(_stats.ot_hours,2));
      _effective_late:=case when _policy.deduct_late then coalesce(_input.late_hours,round(_stats.deductible_late_hours,2)) else 0 end;
      _ot:=round(_effective_ot*_hour_rate*_policy.ot_multiplier,2);
      _late:=round(_effective_late*_hour_rate,2);
    end if;
    _wages_roundoff:=0; _net_roundoff:=0; _tds:=coalesce(_input.tds,0);
    _earn:=_basic; _ded:=0; _employer:=0; _pf:=0; _esi:=0; _other_ded:=0; _advance:=0; _welfare:=0;
    insert into public.payslips(employee_id,period,gross,deductions,net,status,run_id,paid_days,lop_days,employer_cost,
      entity_id,zone_id,branch_id,department_id)
    values(_emp.id,_period,0,0,0,'Draft',_run_id,_paid,_lop,0,_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id)
    on conflict(employee_id,period) do update set run_id=excluded.run_id,paid_days=excluded.paid_days,lop_days=excluded.lop_days,
      status='Draft',entity_id=excluded.entity_id,zone_id=excluded.zone_id,branch_id=excluded.branch_id,department_id=excluded.department_id
    returning id into _payslip_id;
    delete from public.payslip_lines where payslip_id=_payslip_id;
    insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'BASIC','Basic','earning',_basic,1);
    _structure_total:=_sal.basic;
    for _named in select * from app.salary_gross_components(_sal.notes) loop
      _structure_total:=_structure_total+_named.component_amount;
      if _structure_total>_sal.gross then raise exception 'Salary breakdown exceeds agreed monthly salary for %.',_emp.full_name using errcode='23514'; end if;
      _amount:=round(_structure_total*_factor,2)-_earn; _earn:=_earn+_amount;
      if _amount<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'GROSS_'||_named.component_order,_named.component_name,'earning',_amount,10+_named.component_order); end if;
    end loop;
    for _comp in select * from app.components_for(_emp.id) loop
      continue when _comp.min_gross is not null and _sal.gross<_comp.min_gross;
      continue when _comp.max_gross is not null and _sal.gross>_comp.max_gross;
      -- Non-null PF/ESI/TDS, including explicit zero, replace those exact normalized deduction codes.
      continue when not _comp.employer_share and _comp.kind='deduction' and
        ((upper(btrim(_comp.code))='PF' and _input.pf is not null) or (upper(btrim(_comp.code))='ESI' and _input.esi is not null) or (upper(btrim(_comp.code))='TDS' and _input.tds is not null));
      _base:=case _comp.calc_type when 'percent_of_basic' then case when _comp.prorate_on_lop then _basic else _sal.basic end
        when 'percent_of_gross' then case when _comp.prorate_on_lop then _salary else _sal.gross end else 0 end;
      if _comp.cap_base is not null then _base:=least(_base,_comp.cap_base); end if;
      _amount:=case when _comp.calc_type='fixed' then round(coalesce(_comp.amount,0)*case when _comp.prorate_on_lop then _factor else 1 end,2)
        else round(_base*coalesce(_comp.rate,0)/100,2) end;
      if _comp.max_amount is not null then _amount:=least(_amount,_comp.max_amount); end if;
      if _amount<0 or _amount>='Infinity'::numeric then raise exception 'Invalid pay component %.',_comp.code using errcode='23514'; end if;
      continue when _amount=0;
      if _comp.employer_share then _employer:=_employer+_amount;
      elsif _comp.kind='earning' then _earn:=_earn+_amount;
      else
        _ded:=_ded+_amount;
        case upper(btrim(_comp.code)) when 'PF' then _pf:=_pf+_amount; when 'ESI' then _esi:=_esi+_amount; when 'TDS' then _tds:=_tds+_amount;
          else _other_ded:=_other_ded+_amount; end case;
      end if;
      insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,_comp.code,_comp.name,
        case when _comp.employer_share then 'employer' else _comp.kind end,_amount,
        case when _comp.employer_share then 700 when _comp.kind='deduction' then 500 else 100 end+_comp.display_order);
    end loop;
    if _earn>_salary then raise exception 'Recurring earning components exceed earned salary for %. Review the salary breakdown.',_emp.full_name using errcode='23514'; end if;
    if _earn<_salary then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
      values(_payslip_id,'OTHER','Other allowances within salary','earning',_salary-_earn,300); end if;
    _earn:=_salary;
    for _key,_label in select * from (values ('incentive','Incentive'),('target_incentive','Target incentive'),('tea_expense','Tea expense'),
      ('other_allowances','Additional other allowances'),('travel_food','Travel allowance / food expense'),('rent_commission','Rent / commission'),
      ('special_allowance','Special allowance')) v(k,label) loop
      _amount:=coalesce((to_jsonb(_input)->>_key)::numeric,0); _earn:=_earn+_amount;
      if _amount<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'MONTHLY_'||upper(_key),_label,'earning',_amount,350); end if;
    end loop;
    _bonus:=0; _adjustment_incentive:=0; _adjustment_deductions:=0;
    for _adjustment in select * from public.payroll_adjustments where entity_id=_entity_id and employee_id=_emp.id and period=_period order by id loop
      if _adjustment.kind='deduction' then
        _ded:=_ded+_adjustment.amount; _other_ded:=_other_ded+_adjustment.amount;
        _adjustment_deductions:=_adjustment_deductions+_adjustment.amount;
      else
        _earn:=_earn+_adjustment.amount;
        if _adjustment.kind='bonus' then _bonus:=_bonus+_adjustment.amount;
        else _adjustment_incentive:=_adjustment_incentive+_adjustment.amount; end if;
      end if;
      insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'ADJUSTMENT_'||_adjustment.id,initcap(_adjustment.kind)||': '||_adjustment.reason,
          case when _adjustment.kind='deduction' then 'deduction' else 'earning' end,_adjustment.amount,case when _adjustment.kind='deduction' then 580 else 380 end);
    end loop;
    _earn:=_earn+_ot;
    if _ot<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'OT','Overtime','earning',_ot,390); end if;
    if _input.pf is not null then _pf:=_input.pf; _ded:=_ded+_pf;
      if _pf<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'PF','PF (approved amount)','deduction',_pf,501); end if;
    end if;
    if _input.esi is not null then _esi:=_input.esi; _ded:=_ded+_esi;
      if _esi<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'ESI','ESI (approved amount)','deduction',_esi,502); end if;
    end if;
    if coalesce(_input.tds,0)>0 then
      _ded:=_ded+_input.tds;
      insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'TDS','TDS (approved amount)','deduction',_input.tds,503);
    end if;
    select coalesce(sum(amount),0) into _ledger_advance from public.payroll_advance_recoveries
      where entity_id=_entity_id and employee_id=_emp.id and period=_period;
    if _ledger_advance>0 and coalesce(_input.advance_recovery,0)>0 then
      raise exception 'Clear the manual advance recovery for % before using scheduled advance recoveries.',_emp.full_name using errcode='23514';
    end if;
    _advance:=coalesce(_input.advance_recovery,0)+_ledger_advance; _welfare:=coalesce(_input.welfare_fund,0);
    _other_ded:=_other_ded+coalesce(_input.other_deductions,0);
    for _key,_label,_amount in select * from (values ('LATE','Approved late deduction',_late),('ADVANCE','Manual salary advance recovery',coalesce(_input.advance_recovery,0)),
      ('WELFARE','Welfare fund',_welfare),('MONTHLY_OTHER_DEDUCTIONS','Loss, damages / other approved deductions',coalesce(_input.other_deductions,0))) v(k,label,amount) loop
      _ded:=_ded+_amount;
      if _amount<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,_key,_label,'deduction',_amount,590); end if;
    end loop;
    for _adjustment in select r.*,a.reason from public.payroll_advance_recoveries r join public.payroll_advances a on a.id=r.advance_id
      where r.entity_id=_entity_id and r.employee_id=_emp.id and r.period=_period order by r.id loop
      _ded:=_ded+_adjustment.amount;
      insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'ADVANCE_'||_adjustment.advance_id,'Advance recovery: '||_adjustment.reason,'deduction',_adjustment.amount,591);
    end loop;
    if _hourly then
      -- Ceiling is applied before losing fractional paise from hours multiplied by rate.
      -- The rounded earning lines plus this line still reconcile to the exact HR wages.
      _wages_roundoff:=ceil(_earn+(_hourly_data->>'unrounded_earned_salary')::numeric-_salary)-_earn;
      if _wages_roundoff<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'WAGES_ROUNDOFF','Wages round-off','earning',_wages_roundoff,399); end if;
      _earn:=_earn+_wages_roundoff;
    end if;
    if _ded>_earn then raise exception 'Deductions exceed gross salary for %. Review recoveries before payroll.',_emp.full_name using errcode='23514'; end if;
    if _hourly then
      _net_roundoff:=round(_earn-_ded,0)-(_earn-_ded);
      if _net_roundoff<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'NET_ROUNDOFF','Net pay round-off','deduction',-_net_roundoff,599); end if;
      _ded:=_ded-_net_roundoff;
    end if;
    _register:=jsonb_build_object('employee_name',_emp.full_name,'employee_code',_emp.employee_code,'branch',coalesce(_emp.branch_name,''),
      'salary',_sal.gross,'days_per_month',_days,'net_working_days',_stats.working,'public_holiday',_stats.holidays,
      'actual_working_days',_stats.working-_lop-_stats.paid_leave,'off_days',_stats.offs,'casual_leave',_stats.casual_leave,
      'total_working_days',_paid,'per_day_wages',round(_rate,6),'per_day_working_hour',_policy.hours_per_day,
      'total_working_hours',round(_stats.worked_hours,2),'per_hour_wages',round(_hour_rate,6),'earned_salary',_salary,
      'incentive',coalesce(_input.incentive,0)+_adjustment_incentive,'target_incentive',coalesce(_input.target_incentive,0),'tea_expense',coalesce(_input.tea_expense,0),
      'other_allowances',coalesce(_input.other_allowances,0),'travel_food',coalesce(_input.travel_food,0),'rent_commission',coalesce(_input.rent_commission,0),
      'special_allowance',coalesce(_input.special_allowance,0),'ot_hours',_effective_ot,'ot_amount',_ot,
      'late_hours',_effective_late,'late_amount',_late,'gross_salary',_earn,'pf',_pf,'esi',_esi,
      'advance_recovery',_advance,'welfare_fund',_welfare,'other_deductions',_other_ded,'net_pay_salary',_earn-_ded)
      || jsonb_build_object('paid_leave',_stats.paid_leave,'lop_days',_lop,'divisor_days',_divisor,'employment_from',_start,'employment_to',_end,
        'paid_hours',round(_paid*_policy.hours_per_day,2),'recorded_worked_hours',round(_stats.worked_hours,2),'recorded_ot_hours',round(_stats.ot_hours,2),'recorded_late_hours',round(_stats.late_hours,2),
        'recorded_deductible_late_hours',round(_stats.deductible_late_hours,2),
        'ot_source',case when _input.ot_hours is null then 'attendance' else 'override' end,
        'late_source',case when _input.late_hours is null then 'attendance' else 'override' end,
        'bonus',_bonus,'adjustment_incentive',_adjustment_incentive,'adjustment_deductions',_adjustment_deductions,'ledger_advance_recovery',_ledger_advance,
        'policy',to_jsonb(_policy),'policy_configured',_configured,'notes',_input.notes,'schema_version',4);
    if _hourly then _register:=_register||_hourly_data||jsonb_build_object(
      'total_working_hours',(_hourly_data->>'worked_hours')::numeric,'paid_hours',(_hourly_data->>'payable_hours')::numeric,
      'paid_leave',(_hourly_data->>'casual_leave')::numeric+(_hourly_data->>'other_paid_leave_days')::numeric,
      'ot_source','included_in_worked_hours','late_source','included_in_worked_hours'); end if;
    _register:=_register||jsonb_build_object('calculation_mode',_policy.calculation_mode,
      'method_version',case when _hourly then 'hourly_workings_shift_v2' else 'paid_days_v1' end,
      'credit_mode',_policy.credit_mode,'attendance_source',coalesce(_input.attendance_source,'recorded'),
      'attendance_reviewed',_reviewed,'attendance_review_reason',case when _reviewed or _input.off_days is not null or _input.casual_leave_days is not null then _input.notes end,
      'attendance_input',case when _input.employee_id is not null then to_jsonb(_input) else null end,'attendance_metrics',to_jsonb(_stats),
      'credit_rules',case when _hourly and _policy.credit_mode='earned' then jsonb_build_object('cl_actual_days_threshold',20,'cl_days',1,'off_days_per',6,'max_off_days',4) else jsonb_build_object('source','attendance') end,
      'rounding_rules',case when _hourly then jsonb_build_object('daily_rate','ceil','hourly_rate_decimals',1,'wages','ceil','net','round') else '{}'::jsonb end,
      'tds',_tds,'wages_roundoff',_wages_roundoff,'net_roundoff',_net_roundoff);
    if not _hourly then _register:=_register||jsonb_build_object('worked_minutes',round(_stats.worked_hours*60),
      'worked_hours',_stats.worked_hours,'credited_hours',0,'payable_hours',round(_paid*_policy.hours_per_day,2),
      'other_paid_leave_days',greatest(0,_stats.paid_leave-_stats.casual_leave)); end if;
    update public.payslips set gross=_earn,deductions=_ded,net=_earn-_ded,employer_cost=_employer,payroll_register=_register where id=_payslip_id;
    _count:=_count+1; _sum_gross:=_sum_gross+_earn; _sum_net:=_sum_net+(_earn-_ded);
  end loop;
  update public.payroll_runs set employees=_count,total_gross=_sum_gross,total_net=_sum_net,needs_recalculation=false,
    source_fingerprint=app.payroll_source_fingerprint(_entity_id,_period) where id=_run_id;
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'GENERATED:'||_period,'payroll_runs',_run_id,_entity_id);
  return jsonb_build_object('run_id',_run_id,'period',_period,'employees',_count,'total_gross',_sum_gross,'total_net',_sum_net,'policy_configured',_configured);
end $$;

-- Restored from 0163_payroll_hourly_workings.sql
create or replace function public.publish_payroll(_run_id uuid,_expected_fingerprint text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _run public.payroll_runs%rowtype; _from date; _slip record; _review_issue text; _expected_hourly jsonb; _stats record; _salary numeric; _divisor numeric;
begin
  if auth.uid() is null and current_setting('role',true) in ('authenticated','anon') then
    raise exception 'Sign in to publish payroll.' using errcode='42501';
  end if;
  select * into _run from public.payroll_runs where id=_run_id;
  if _run.id is null then raise exception 'Payroll run not found.' using errcode='P0002'; end if;
  if auth.uid() is not null and not app.has_perm('payroll.manage',_run.entity_id,null,null,null,null) then
    raise exception 'Not authorized to publish payroll for this company.' using errcode='42501';
  end if;
  perform app.lock_payroll(_run.entity_id);
  select * into _run from public.payroll_runs where id=_run_id for update;
  if _run.status='Published' then return; end if;
  if _expected_fingerprint is null or _expected_fingerprint is distinct from _run.source_fingerprint then
    raise exception 'This draft changed since review. Reload the register and review its latest totals before publishing.' using errcode='40001';
  end if;
  if not exists(select 1 from public.payroll_policies where entity_id=_run.entity_id) then
    raise exception 'Save the company payroll policy and regenerate this draft before publishing.' using errcode='23514';
  end if;
  if _run.needs_recalculation or _run.source_fingerprint is distinct from app.payroll_source_fingerprint(_run.entity_id,_run.period) then
    raise exception 'Payroll sources changed. Regenerate and review this draft before publishing.' using errcode='55000';
  end if;
  if _run.employees=0 or not exists(select 1 from public.payslips where run_id=_run_id) then
    raise exception 'An empty payroll cannot be published.' using errcode='23514';
  end if;
  if exists(select 1 from public.payslips p where p.run_id=_run_id and (p.status<>'Draft' or p.payroll_register is null or p.net<0
    or not p.payroll_register ?& array['employee_name','branch','salary','days_per_month','net_working_days','public_holiday',
      'actual_working_days','off_days','casual_leave','total_working_days','per_day_wages','per_day_working_hour','total_working_hours',
      'per_hour_wages','earned_salary','incentive','target_incentive','tea_expense','other_allowances','travel_food','rent_commission',
      'special_allowance','ot_hours','ot_amount','late_hours','late_amount','gross_salary','pf','esi','advance_recovery','welfare_fund','other_deductions','net_pay_salary']
    or p.gross is distinct from (p.payroll_register->>'gross_salary')::numeric
    or p.net is distinct from (p.payroll_register->>'net_pay_salary')::numeric
    or p.gross is distinct from ((p.payroll_register->>'earned_salary')::numeric+(p.payroll_register->>'incentive')::numeric
      +(p.payroll_register->>'target_incentive')::numeric+(p.payroll_register->>'tea_expense')::numeric
      +(p.payroll_register->>'other_allowances')::numeric+(p.payroll_register->>'travel_food')::numeric
      +(p.payroll_register->>'rent_commission')::numeric+(p.payroll_register->>'special_allowance')::numeric+(p.payroll_register->>'ot_amount')::numeric+coalesce((p.payroll_register->>'bonus')::numeric,0)+coalesce((p.payroll_register->>'wages_roundoff')::numeric,0))
    or p.deductions is distinct from ((p.payroll_register->>'pf')::numeric+(p.payroll_register->>'esi')::numeric
      +(p.payroll_register->>'advance_recovery')::numeric+(p.payroll_register->>'welfare_fund')::numeric
      +(p.payroll_register->>'other_deductions')::numeric+(p.payroll_register->>'late_amount')::numeric
      +coalesce((p.payroll_register->>'tds')::numeric,0)-coalesce((p.payroll_register->>'net_roundoff')::numeric,0))
    or p.gross is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='earning')
    or p.deductions is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='deduction')
    or p.employer_cost is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='employer')
    or p.net is distinct from p.gross-p.deductions)) then
    raise exception 'Payroll totals or register do not reconcile. Regenerate this draft.' using errcode='23514';
  end if;
  if exists(select 1 from public.payslips p where p.run_id=_run_id and (
    p.payroll_register->>'schema_version' is distinct from '4'
    or not p.payroll_register ?& array['bonus','adjustment_incentive','adjustment_deductions','ledger_advance_recovery']
    or exists(select 1 from jsonb_each(p.payroll_register) j where j.key in ('bonus','adjustment_incentive','adjustment_deductions','ledger_advance_recovery')
      and (jsonb_typeof(j.value)<>'number' or (j.value#>>'{}')::numeric<0 or (j.value#>>'{}')::numeric>='Infinity'::numeric))
    or (p.payroll_register->>'bonus')::numeric is distinct from
      (select coalesce(sum(a.amount),0) from public.payroll_adjustments a where a.employee_id=p.employee_id and a.entity_id=p.entity_id and a.period=p.period and a.kind='bonus')
    or (p.payroll_register->>'adjustment_incentive')::numeric is distinct from
      (select coalesce(sum(a.amount),0) from public.payroll_adjustments a where a.employee_id=p.employee_id and a.entity_id=p.entity_id and a.period=p.period and a.kind='incentive')
    or (p.payroll_register->>'adjustment_deductions')::numeric is distinct from
      (select coalesce(sum(a.amount),0) from public.payroll_adjustments a where a.employee_id=p.employee_id and a.entity_id=p.entity_id and a.period=p.period and a.kind='deduction')
    or (p.payroll_register->>'ledger_advance_recovery')::numeric is distinct from
      (select coalesce(sum(a.amount),0) from public.payroll_advance_recoveries a where a.employee_id=p.employee_id and a.entity_id=p.entity_id and a.period=p.period))) then
    raise exception 'Payroll transaction details do not reconcile. Regenerate this draft.' using errcode='23514';
  end if;
  -- Validate the exact calculation inputs as well as ledger totals before locking output.
  for _slip in select p.*,to_jsonb(i) as current_input,to_jsonb(pol) as current_policy
    from public.payslips p left join public.payroll_monthly_inputs i on i.employee_id=p.employee_id and i.period=p.period
    join public.payroll_policies pol on pol.entity_id=p.entity_id where p.run_id=_run_id loop
    if not exists(select 1 from app.payroll_employee_windows(_run.entity_id,app.payroll_period_start(_run.period),
      (app.payroll_period_start(_run.period)+interval '1 month - 1 day')::date) w where w.employee_id=_slip.employee_id
      and w.employment_from=(_slip.payroll_register->>'employment_from')::date
      and w.employment_to=(_slip.payroll_register->>'employment_to')::date) then
      raise exception 'Payroll employment interval does not reconcile. Regenerate this draft.' using errcode='23514';
    end if;
    select gross into _salary from public.salary_structures where employee_id=_slip.employee_id
      and effective_from<=(_slip.payroll_register->>'employment_from')::date order by effective_from desc limit 1;
    if _salary is null or _salary is distinct from (_slip.payroll_register->>'salary')::numeric
      or _slip.payroll_register->'policy' is distinct from _slip.current_policy then
      raise exception 'Payroll salary or policy snapshot does not reconcile. Regenerate this draft.' using errcode='23514';
    end if;
    _review_issue:=app.payroll_attendance_review_issue(_slip.current_input,_slip.current_policy,
      (_slip.payroll_register->>'employment_to')::date-(_slip.payroll_register->>'employment_from')::date+1);
    if _review_issue is not null then raise exception '%',_review_issue using errcode='23514'; end if;
    if not _slip.payroll_register ?& array['calculation_mode','method_version','credit_mode','attendance_source','attendance_reviewed',
        'attendance_input','attendance_metrics','tds','wages_roundoff','net_roundoff']
      or _slip.payroll_register->>'calculation_mode' is distinct from _slip.current_policy->>'calculation_mode'
      or _slip.payroll_register->>'credit_mode' is distinct from _slip.current_policy->>'credit_mode'
      or _slip.payroll_register->>'attendance_source' is distinct from coalesce(_slip.current_input->>'attendance_source','recorded')
      or (_slip.payroll_register->>'attendance_reviewed')::boolean is distinct from (coalesce(_slip.current_input->>'attendance_source','recorded')='reviewed')
      or _slip.payroll_register->'attendance_input' is distinct from coalesce(_slip.current_input,'null'::jsonb) then
      raise exception 'Payroll attendance source snapshot does not reconcile. Regenerate this draft.' using errcode='23514';
    end if;
    if exists(select 1 from jsonb_each(_slip.payroll_register) j where j.key in ('tds','wages_roundoff','net_roundoff')
      and (jsonb_typeof(j.value)<>'number' or (j.value#>>'{}')::numeric>='Infinity'::numeric))
      or (_slip.payroll_register->>'tds')::numeric<0
      or (_slip.payroll_register->>'wages_roundoff')::numeric<0 or (_slip.payroll_register->>'wages_roundoff')::numeric>1
      or abs((_slip.payroll_register->>'net_roundoff')::numeric)>0.5
      or (coalesce(_slip.current_input->>'attendance_source','recorded')='reviewed' or _slip.current_input->>'off_days' is not null or _slip.current_input->>'casual_leave_days' is not null)
        and _slip.payroll_register->>'attendance_review_reason' is distinct from _slip.current_input->>'notes' then
      raise exception 'Payroll review or rounding snapshot is invalid. Regenerate this draft.' using errcode='23514';
    end if;
    select * into _stats from app.payroll_attendance_metrics(_slip.employee_id,
      (_slip.payroll_register->>'employment_from')::date,(_slip.payroll_register->>'employment_to')::date);
    if _slip.payroll_register->'attendance_metrics' is distinct from to_jsonb(_stats) then
      raise exception 'Payroll attendance evidence snapshot does not reconcile. Regenerate this draft.' using errcode='23514';
    end if;
    if _slip.payroll_register->>'attendance_source'<>'reviewed' and (_stats.pending_recompute_days>0
      or _stats.unresolved>0 or _stats.invalid>0 or _stats.recorded<>(_slip.payroll_register->>'employment_to')::date-(_slip.payroll_register->>'employment_from')::date+1) then
      raise exception 'Recorded attendance is incomplete or unresolved. Regenerate this draft after review.' using errcode='23514';
    end if;
    if exists(select 1 from public.payslip_lines l where l.payslip_id=_slip.id
      and (l.amount>='Infinity'::numeric or l.amount<0 and not (l.code='NET_ROUNDOFF' and l.kind='deduction'
        and _slip.payroll_register->>'calculation_mode'='hourly_workings'
        and l.amount=-(_slip.payroll_register->>'net_roundoff')::numeric and l.amount>=-0.5))) then
      raise exception 'Invalid payroll line amount. Regenerate this draft.' using errcode='23514';
    end if;
    if _slip.payroll_register->>'calculation_mode'='hourly_workings' then
      if (select coalesce(sum(amount),0) from public.payslip_lines where payslip_id=_slip.id and code='WAGES_ROUNDOFF' and kind='earning')
          is distinct from (_slip.payroll_register->>'wages_roundoff')::numeric
        or (select coalesce(sum(amount),0) from public.payslip_lines where payslip_id=_slip.id and code='NET_ROUNDOFF' and kind='deduction')
          is distinct from -(_slip.payroll_register->>'net_roundoff')::numeric then
        raise exception 'Payroll round-off lines do not reconcile. Regenerate this draft.' using errcode='23514';
      end if;
      _divisor:=case when _slip.current_policy->>'divisor_mode'='fixed' then (_slip.current_policy->>'fixed_days')::numeric
        else extract(day from app.payroll_period_start(_run.period)+interval '1 month - 1 day') end;
      _review_issue:=app.payroll_shift_basis_issue(_slip.employee_id,(_slip.payroll_register->>'employment_from')::date,
        (_slip.payroll_register->>'employment_to')::date,_slip.current_input);
      if _review_issue is not null then raise exception '%',_review_issue using errcode='23514'; end if;
      _expected_hourly:=app.payroll_shift_workings(_slip.employee_id,(_slip.payroll_register->>'employment_from')::date,
        (_slip.payroll_register->>'employment_to')::date,_salary,_divisor,
        _slip.current_policy->>'credit_mode',_slip.current_input,to_jsonb(_stats));
      if _slip.payroll_register->>'method_version' is distinct from 'hourly_workings_shift_v2'
        or (_slip.payroll_register->>'divisor_days')::numeric is distinct from _divisor
        or not _slip.payroll_register @> _expected_hourly
        or _slip.payroll_register->'shift_days' is distinct from _expected_hourly->'shift_days'
        or (_slip.payroll_register->>'ot_amount')::numeric<>0 or (_slip.payroll_register->>'late_amount')::numeric<>0
        or (_slip.payroll_register->>'wages_roundoff')::numeric is distinct from ceil(_slip.gross-(_slip.payroll_register->>'wages_roundoff')::numeric
          +(_expected_hourly->>'unrounded_earned_salary')::numeric-(_expected_hourly->>'earned_salary')::numeric)-(_slip.gross-(_slip.payroll_register->>'wages_roundoff')::numeric)
        or (_slip.payroll_register->>'net_roundoff')::numeric is distinct from round(_slip.net-(_slip.payroll_register->>'net_roundoff')::numeric,0)-(_slip.net-(_slip.payroll_register->>'net_roundoff')::numeric)
        or (_slip.payroll_register->>'attendance_reviewed')::boolean and nullif(btrim(_slip.payroll_register->>'attendance_review_reason'),'') is null then
        raise exception 'HR hourly workings or reviewed totals do not reconcile. Regenerate this draft.' using errcode='23514';
      end if;
    elsif _slip.payroll_register->>'method_version' is distinct from 'paid_days_v1'
      or (_slip.payroll_register->>'wages_roundoff')::numeric<>0 or (_slip.payroll_register->>'net_roundoff')::numeric<>0 then
      raise exception 'Paid-day payroll method snapshot does not reconcile. Regenerate this draft.' using errcode='23514';
    end if;
  end loop;
  if _run.employees is distinct from (select count(*) from app.payroll_employee_windows(_run.entity_id,app.payroll_period_start(_run.period),
      (app.payroll_period_start(_run.period)+interval '1 month - 1 day')::date))
    or _run.employees is distinct from (select count(*) from public.payslips where run_id=_run_id)
    or _run.total_gross is distinct from (select sum(gross) from public.payslips where run_id=_run_id)
    or _run.total_net is distinct from (select sum(net) from public.payslips where run_id=_run_id) then
    raise exception 'Payroll run totals do not reconcile. Regenerate this draft.' using errcode='23514';
  end if;
  if exists(select 1 from public.payslips p cross join lateral app.payroll_attendance_metrics(p.employee_id,
      (p.payroll_register->>'employment_from')::date,(p.payroll_register->>'employment_to')::date) m
      where p.run_id=_run_id and p.payroll_register->>'attendance_source'<>'reviewed' and m.pending_recompute_days>0) then
    raise exception 'Attendance changes are awaiting recomputation. Refresh attendance and regenerate payroll before publishing.' using errcode='55000';
  end if;
  -- Lock exactly the employment interval priced in the immutable register.
  update public.attendance a set is_locked=true from public.payslips p where p.run_id=_run_id and p.employee_id=a.employee_id
    and a.work_date between (p.payroll_register->>'employment_from')::date and (p.payroll_register->>'employment_to')::date;
  update public.payslips set status='Published' where run_id=_run_id;
  update public.payroll_runs set status='Published',published_at=now(),needs_recalculation=false where id=_run_id;
  insert into public.payroll_payments(run_id,employee_id,entity_id,zone_id,branch_id,department_id,updated_by)
    select run_id,employee_id,entity_id,zone_id,branch_id,department_id,auth.uid() from public.payslips where run_id=_run_id
    on conflict(run_id,employee_id) do nothing;
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'PUBLISHED:'||_run.period,'payroll_runs',_run_id,_run.entity_id);
end $$;

-- Restored from 0163_payroll_hourly_workings.sql
create or replace function public.get_payroll_attendance_summary(_entity_id uuid,_period text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare _from date; _to date; _result jsonb;
begin
  if auth.uid() is null or not app.has_perm_any_scope('payroll.manage') then
    raise exception 'Not authorized to view payroll attendance.' using errcode='42501';
  end if;
  _from:=app.payroll_period_start(_period); _to:=(_from+interval '1 month - 1 day')::date;
  if _entity_id is null then raise exception 'Choose a payroll company.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_id',e.id,'recorded_worked_hours',round(m.worked_hours,2),'recorded_ot_hours',round(m.ot_hours,2),
    'recorded_late_hours',round(m.late_hours,2),'deductible_late_hours',round(m.deductible_late_hours,2),
    'effective_ot_hours',case when p.calculation_mode='hourly_workings' then 0 when w.employee_id is not null then coalesce(i.ot_hours,round(m.ot_hours,2)) else 0 end,
    'effective_late_hours',case when p.calculation_mode='hourly_workings' then 0 when w.employee_id is not null and coalesce(p.deduct_late,false) then coalesce(i.late_hours,round(m.deductible_late_hours,2)) else 0 end,
    'ot_source',case when p.calculation_mode='hourly_workings' then 'included_in_worked_hours' when i.ot_hours is null then 'attendance' else 'override' end,
    'late_source',case when p.calculation_mode='hourly_workings' then 'included_in_worked_hours' when i.late_hours is null then 'attendance' else 'override' end,
    'in_payroll_month',w.employee_id is not null,
    'attendance_days',m.recorded,'expected_days',coalesce(w.employment_to-w.employment_from+1,0),
    'missing_days',case when review.ready then 0 else greatest(0,coalesce(w.employment_to-w.employment_from+1,0)-m.recorded) end,
    'unresolved_days',case when review.ready then 0 else m.unresolved end,'invalid_days',case when review.ready then 0 else m.invalid end,
    'pending_recompute_days',case when review.ready then 0 else m.pending_recompute_days end,
    'recorded_missing_days',greatest(0,coalesce(w.employment_to-w.employment_from+1,0)-m.recorded),
    'recorded_unresolved_days',m.unresolved,'recorded_invalid_days',m.invalid,'recorded_pending_recompute_days',m.pending_recompute_days,
    'attendance_source',coalesce(i.attendance_source,'recorded'),'reviewed_source_ready',review.ready,
    'attendance_review_issue',review.issue,'attendance_review_reason',i.notes,
    'calculation_mode',coalesce(p.calculation_mode,'paid_days'),'credit_mode',coalesce(p.credit_mode,'attendance'),
    'effective_worked_hours',case when p.calculation_mode='hourly_workings' then (h.data->>'worked_hours')::numeric else m.worked_hours end,
    'payable_hours',case when p.calculation_mode='hourly_workings' then (h.data->>'payable_hours')::numeric else null end,
    'credited_hours',case when p.calculation_mode='hourly_workings' then (h.data->>'credited_hours')::numeric else 0 end,
    'variable_shift_hours',h.data->'variable_shift_hours','daily_shift_hours',h.data->'per_day_working_hour',
    'undated_credit_days',h.data->'undated_credit_days',
    'first_punch_at',m.first_punch_at,'last_punch_at',m.last_punch_at,'computed_at',m.computed_at,
    'employment_from',coalesce(w.employment_from,greatest(_from,coalesce(e.join_date,_from))),
    'employment_to',coalesce(w.employment_to,least(_to,coalesce(previous_exit.last_day,_to))),
    'policy_deduct_late',coalesce(p.deduct_late,false),
    'employment_issue',case when w.employee_id is not null and e.status<>'Active' and w.last_day is null then 'Complete the last working day for this inactive employee.' end,
    'override_issue',case when w.employee_id is null then null when review.issue is not null then review.issue when p.calculation_mode='hourly_workings' then null when i.ot_hours>round(m.ot_hours,2) then 'OT override exceeds recorded overtime.'
      when i.late_hours>0 and not coalesce(p.deduct_late,false) then 'Late deductions are disabled by company policy.'
      when i.late_hours>round(m.deductible_late_hours,2) then 'Late override exceeds lateness on fully paid working days.' end
  ) order by e.id),'[]'::jsonb) into _result
  from public.employees e left join app.payroll_employee_windows(_entity_id,_from,_to) w on e.id=w.employee_id
  left join lateral (select min(x.last_day) as last_day from public.exits x where x.employee_id=e.id
    and x.status in ('Cleared','Completed') and x.last_day>=coalesce(e.join_date,'0001-01-01'::date))previous_exit on true
  cross join lateral app.payroll_attendance_metrics(e.id,w.employment_from,w.employment_to) m
  left join public.payroll_monthly_inputs i on i.employee_id=e.id and i.period=_period
  left join public.payroll_policies p on p.entity_id=e.entity_id
  cross join lateral (select coalesce(app.payroll_attendance_review_issue(to_jsonb(i),to_jsonb(p),w.employment_to-w.employment_from+1),
    case when p.calculation_mode='hourly_workings' and w.employee_id is not null then app.payroll_shift_basis_issue(e.id,w.employment_from,w.employment_to,to_jsonb(i)) end) as issue) check_review
  cross join lateral (select check_review.issue,coalesce(p.calculation_mode='hourly_workings' and i.attendance_source='reviewed' and check_review.issue is null and w.employee_id is not null,false) as ready) review
  cross join lateral (select case when p.calculation_mode='hourly_workings' and w.employee_id is not null then
    app.payroll_shift_workings(e.id,w.employment_from,w.employment_to,0,30,coalesce(p.credit_mode,'attendance'),to_jsonb(i),to_jsonb(m)) else '{}'::jsonb end as data) h
  where e.entity_id=_entity_id and app.has_perm('payroll.manage',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.id);
  return _result;
end $$;

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- Restored from 0164_shift_maintenance_safety.sql
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

-- CREATE OR REPLACE retains existing ACLs. Restrict every newly added helper
-- explicitly; the immutable break validator must also execute for table writers.
revoke all on function app.payroll_shift_days(uuid,date,date),
  app.payroll_shift_basis_issue(uuid,date,date,jsonb),
  app.payroll_shift_workings(uuid,date,date,numeric,numeric,text,jsonb,jsonb),
  app.attendance_day_boundary(uuid,date),app.attendance_punch_window(uuid,date)
  from public,anon,authenticated,service_role;
revoke all on function app.shift_unpaid_break_minutes(time,time,jsonb) from public,anon;
grant execute on function app.shift_unpaid_break_minutes(time,time,jsonb) to authenticated,service_role;
revoke all on function public.assign_employee_shifts(uuid[],uuid,date,date,text) from public,anon;
grant execute on function public.assign_employee_shifts(uuid[],uuid,date,date,text) to authenticated;
notify pgrst,'reload schema';
commit;
