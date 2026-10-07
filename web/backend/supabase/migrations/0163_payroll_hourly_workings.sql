-- Explicit HR hourly workings. Legacy paid-day policies and all published amounts stay intact.
-- This migration defines capabilities only; it does not opt any company into a new method.
begin;

alter table public.payroll_policies add column if not exists calculation_mode text not null default 'paid_days';
alter table public.payroll_policies add column if not exists credit_mode text not null default 'attendance';
alter table public.payroll_policies drop constraint if exists payroll_policy_calculation_valid;
alter table public.payroll_policies add constraint payroll_policy_calculation_valid check (
  calculation_mode in ('paid_days','hourly_workings') and credit_mode in ('attendance','earned')
  and (calculation_mode<>'hourly_workings' or divisor_mode in ('calendar','fixed'))
);
alter table public.payroll_monthly_inputs add column if not exists attendance_source text not null default 'recorded';
alter table public.payroll_monthly_inputs add column if not exists worked_minutes integer;
alter table public.payroll_monthly_inputs add column if not exists actual_working_days numeric(5,2);
alter table public.payroll_monthly_inputs add column if not exists public_holiday_days numeric(5,2);
alter table public.payroll_monthly_inputs add column if not exists off_days numeric(5,2);
alter table public.payroll_monthly_inputs add column if not exists casual_leave_days numeric(5,2);
-- Like PF/ESI, NULL uses the configured deduction; an explicit zero is an approved exemption.
alter table public.payroll_monthly_inputs add column if not exists tds numeric(12,2);
alter table public.payroll_monthly_inputs alter column tds drop not null;
alter table public.payroll_monthly_inputs alter column tds set default null;
alter table public.payroll_monthly_inputs drop constraint if exists payroll_input_attendance_valid;
alter table public.payroll_monthly_inputs add constraint payroll_input_attendance_valid check (
  attendance_source in ('recorded','reviewed') and (worked_minutes is null or worked_minutes between 0 and 44640)
  and (actual_working_days is null or actual_working_days between 0 and 31)
  and (public_holiday_days is null or public_holiday_days between 0 and 31)
  and (off_days is null or off_days between 0 and 31)
  and (casual_leave_days is null or casual_leave_days between 0 and 31)
  and (tds is null or (tds>=0 and tds<'Infinity'::numeric))
);

-- Pure validation is shared by saving, readiness, generation and publication. A review is
-- a complete payroll-only monthly source, never an edit of EasyTime or attendance records.
create or replace function app.payroll_attendance_review_issue(_input jsonb,_policy jsonb,_employment_days integer)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare _source text:=coalesce(_input->>'attendance_source','recorded'); _key text; _value numeric;
  _hourly boolean:=coalesce(_policy->>'calculation_mode','paid_days')='hourly_workings';
begin
  if _source not in ('recorded','reviewed') then return 'Choose recorded attendance or HR-reviewed monthly totals.'; end if;
  if not _hourly and (_source='reviewed' or (_input->>'worked_minutes') is not null
    or (_input->>'actual_working_days') is not null or (_input->>'public_holiday_days') is not null
    or (_input->>'off_days') is not null or (_input->>'casual_leave_days') is not null) then
    return 'Monthly attendance and credit overrides require the HR hourly workings calculation mode.';
  end if;
  if _hourly and (coalesce((_input->>'ot_hours')::numeric,0)<>0 or coalesce((_input->>'late_hours')::numeric,0)<>0) then
    return 'Clear OT and late-hour overrides: hourly workings already pays the recorded worked time.';
  end if;
  if _source='reviewed' then
    if (_input->>'worked_minutes') is null or (_input->>'actual_working_days') is null or (_input->>'public_holiday_days') is null then
      return 'HR-reviewed totals require worked minutes, actual working days and public holiday days, including explicit zeroes.';
    end if;
    if coalesce(_policy->>'credit_mode','attendance')='attendance'
      and ((_input->>'off_days') is null or (_input->>'casual_leave_days') is null) then
      return 'HR-reviewed totals using attendance credits require explicit off days and casual leave days, including zeroes.';
    end if;
  elsif (_input->>'worked_minutes') is not null or (_input->>'actual_working_days') is not null or (_input->>'public_holiday_days') is not null then
    return 'Use HR-reviewed totals to replace worked hours or working/holiday days; otherwise clear those values.';
  end if;
  if (_source='reviewed' or (_input->>'off_days') is not null or (_input->>'casual_leave_days') is not null)
      and nullif(btrim(_input->>'notes'),'') is null then
    return 'Record the HR approval or reason for reviewed attendance and day-credit overrides.';
  end if;
  if (_input->>'worked_minutes') is not null then
    _value:=(_input->>'worked_minutes')::numeric;
    if _value<0 or _value<>trunc(_value) or _value>greatest(coalesce(_employment_days,0),0)*1440 then
      return 'Reviewed worked minutes must be whole minutes within the employment period.';
    end if;
  end if;
  foreach _key in array array['actual_working_days','public_holiday_days','off_days','casual_leave_days'] loop
    _value:=(_input->>_key)::numeric;
    if _value is not null and (_value<0 or _value>least(31,greatest(coalesce(_employment_days,0),0))) then
      return 'Each reviewed day total must fit within the employment period.';
    end if;
  end loop;
  return null;
end $$;

-- Decimal hours are derived from integer minutes, never from an ambiguous H.MM number.
-- Earned credits: one CL day at 20 actual days, then up to four offs per six actual+CL days.
-- Other paid leave excludes recorded CL, which is credited exactly once.
create or replace function app.payroll_hourly_workings(_monthly_salary numeric,_divisor numeric,_hours_per_day numeric,
  _credit_mode text,_input jsonb,_attendance jsonb)
returns jsonb language sql immutable set search_path=pg_catalog as $$
  with source as (
    select coalesce(_input->>'attendance_source','recorded')='reviewed' as reviewed,
      case when _input->>'attendance_source'='reviewed' then (_input->>'worked_minutes')::numeric
        else round(coalesce((_attendance->>'worked_hours')::numeric,0)*60) end as minutes,
      case when _input->>'attendance_source'='reviewed' then (_input->>'actual_working_days')::numeric
        else greatest(0,coalesce((_attendance->>'working')::numeric,0)-coalesce((_attendance->>'lop')::numeric,0)-coalesce((_attendance->>'paid_leave')::numeric,0)) end as actual,
      case when _input->>'attendance_source'='reviewed' then (_input->>'public_holiday_days')::numeric
        else coalesce((_attendance->>'holidays')::numeric,0) end as holidays,
      case when _input->>'attendance_source'='reviewed' then 0
        else greatest(0,coalesce((_attendance->>'paid_leave')::numeric,0)-coalesce((_attendance->>'casual_leave')::numeric,0)) end as other_leave
  ), cl as (
    select source.*,coalesce((_input->>'casual_leave_days')::numeric,
      case when _credit_mode='earned' then case when actual>=20 then 1 else 0 end
        when reviewed then 0 else coalesce((_attendance->>'casual_leave')::numeric,0) end) as casual
    from source
  ), credits as (
    select cl.*,coalesce((_input->>'off_days')::numeric,
      case when _credit_mode='earned' then least(4,floor((actual+casual)/6))
        when reviewed then 0 else coalesce((_attendance->>'offs')::numeric,0) end) as offs
    from cl
  ), rates as (
    select credits.*,ceil(_monthly_salary/_divisor) as daily_rate,
      round(ceil(_monthly_salary/_divisor)/_hours_per_day,1) as hourly_rate,
      (holidays+offs+casual+other_leave)*_hours_per_day as credit_hours
    from credits
  )
  select jsonb_build_object('worked_minutes',minutes,'worked_hours',minutes/60.0,
    'actual_working_days',actual,'public_holiday',holidays,'off_days',offs,'casual_leave',casual,
    'other_paid_leave_days',other_leave,'credited_hours',credit_hours,'payable_hours',minutes/60.0+credit_hours,
    'per_day_wages',daily_rate,'per_hour_wages',hourly_rate,
    'earned_salary',round((minutes/60.0+credit_hours)*hourly_rate,2),
    'unrounded_earned_salary',(minutes/60.0+credit_hours)*hourly_rate,
    'total_working_days',actual+holidays+offs+casual+other_leave,
    'required_worked_hours',actual*_hours_per_day,'ot_memo_hours',minutes/60.0-actual*_hours_per_day,
    'ot_memo_amount',(minutes/60.0-actual*_hours_per_day)*hourly_rate)
  from rates;
$$;


-- Price each date using the effective assignment, then the company/shared default.
-- No company-hours fallback: a missing shift is actionable payroll setup, not a guessed wage.
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

-- The same validation drives readiness, calculation and publication. Monthly reviewed hours
-- cannot be apportioned across different rates without daily evidence.
create or replace function app.payroll_shift_basis_issue(_employee uuid,_from date,_to date,_input jsonb)
returns text language sql stable security definer set search_path=pg_catalog,public,app as $$
  select case when count(*) filter(where daily_minutes is null or daily_minutes<=0)>0
    then 'Assign a shift with daily paid hours for every date in the payroll employment period.'
    when coalesce(_input->>'attendance_source','recorded')='reviewed' and count(distinct daily_minutes)>1
    then 'Daily shift hours change during this month. Use recorded daily attendance; monthly reviewed hours cannot be split between different hourly rates.' end
  from app.payroll_shift_days(_employee,_from,_to);
$$;

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

create or replace function public.save_payroll_policy(_entity_id uuid, _policy jsonb, _expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _row public.payroll_policies%rowtype; _existing jsonb;
begin
  if auth.uid() is null or not app.has_perm('payroll.manage',_entity_id,null,null,null,null) then
    raise exception 'Not authorized to configure payroll for this company.' using errcode='42501';
  end if;
  if jsonb_typeof(_policy) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(_policy) k where k not in
      ('divisor_mode','fixed_days','hours_per_day','ot_multiplier','deduct_late','notes','calculation_mode','credit_mode')) then
    raise exception 'Invalid payroll policy fields.' using errcode='22023';
  end if;
  perform app.lock_payroll(_entity_id);
  select to_jsonb(p) into _existing from public.payroll_policies p where entity_id=_entity_id;
  if (_existing->>'updated_at')::timestamptz is distinct from _expected_updated_at then
    raise exception 'Payroll policy changed in another session. Reload it before saving.' using errcode='40001';
  end if;
  _row := jsonb_populate_record(null::public.payroll_policies,
    jsonb_build_object('divisor_mode','calendar','fixed_days',30,'hours_per_day',case when _policy->>'calculation_mode'='hourly_workings' then 8.5 else 8 end,'ot_multiplier',2,'deduct_late',false,'calculation_mode','paid_days','credit_mode','attendance')
    || coalesce(_existing,'{}'::jsonb) || _policy
    || jsonb_build_object('entity_id',_entity_id,'updated_by',auth.uid(),'updated_at',clock_timestamp()));
  if _row.calculation_mode='hourly_workings' and not (_policy ? 'credit_mode')
      and coalesce(_existing->>'calculation_mode','paid_days')<>'hourly_workings' then _row.credit_mode:='earned'; end if;
  if _row.calculation_mode is null or _row.credit_mode is null or _row.divisor_mode is null or _row.fixed_days is null or _row.hours_per_day is null
      or _row.ot_multiplier is null or _row.deduct_late is null then
    raise exception 'Complete all payroll policy values.' using errcode='22023';
  end if;
  if _row.calculation_mode='hourly_workings' and _row.divisor_mode='working' then
    raise exception 'HR hourly workings supports a calendar or fixed-day divisor.' using errcode='23514';
  end if;
  insert into public.payroll_policies select (_row).*
  on conflict (entity_id) do update set divisor_mode=excluded.divisor_mode,fixed_days=excluded.fixed_days,
    hours_per_day=excluded.hours_per_day,ot_multiplier=excluded.ot_multiplier,deduct_late=excluded.deduct_late,
    calculation_mode=excluded.calculation_mode,credit_mode=excluded.credit_mode,
    notes=excluded.notes,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
  update public.payroll_runs set needs_recalculation=true where entity_id=_entity_id and status='Draft';
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'POLICY_SAVED','payroll_policies',_entity_id,_entity_id);
  return to_jsonb(_row);
end $$;

create or replace function public.save_payroll_monthly_input(_employee_id uuid,_period text,_input jsonb,_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _emp public.employees%rowtype; _row public.payroll_monthly_inputs%rowtype; _payload jsonb; _locked_entity uuid; _policy jsonb; _employment_days integer; _review_issue text;
begin
  perform app.payroll_period_start(_period);
  select * into _emp from public.employees where id=_employee_id;
  if _emp.id is null or auth.uid() is null or not app.has_perm('payroll.manage',_emp.entity_id,
    _emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to edit payroll inputs for this employee.' using errcode='42501';
  end if;
  if jsonb_typeof(_input) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(_input) k where k not in ('incentive','target_incentive','tea_expense',
      'other_allowances','travel_food','rent_commission','special_allowance','ot_hours','late_hours',
      'pf','esi','advance_recovery','welfare_fund','other_deductions','notes','tds','attendance_source','worked_minutes',
      'actual_working_days','public_holiday_days','off_days','casual_leave_days')) then
    raise exception 'Invalid payroll input fields.' using errcode='22023';
  end if;
  if _input->>'worked_minutes' is not null and ((_input->>'worked_minutes')::numeric<>trunc((_input->>'worked_minutes')::numeric)) then
    raise exception 'Worked minutes must be a whole number.' using errcode='23514';
  end if;
  perform app.lock_payroll(_emp.entity_id);
  _locked_entity:=_emp.entity_id;
  select * into _emp from public.employees where id=_employee_id;
  if _emp.id is null or _emp.entity_id is distinct from _locked_entity then
    raise exception 'Employee company changed during payroll input review. Reload before saving.' using errcode='40001';
  end if;
  if not app.has_perm('payroll.manage',_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to edit payroll inputs for this employee.' using errcode='42501';
  end if;
  if exists (select 1 from public.payroll_runs where entity_id=_emp.entity_id and period=_period and status='Published')
     or exists(select 1 from public.payslips where employee_id=_employee_id and period=_period and status='Published') then
    raise exception 'Published payroll inputs cannot be changed.' using errcode='55000';
  end if;
  select to_jsonb(i) into _payload from public.payroll_monthly_inputs i where employee_id=_employee_id and period=_period;
  if (_payload->>'updated_at')::timestamptz is distinct from _expected_updated_at then
    raise exception 'Payroll inputs changed in another session. Reload them before saving.' using errcode='40001';
  end if;
  _row := jsonb_populate_record(null::public.payroll_monthly_inputs,
    jsonb_build_object('incentive',0,'target_incentive',0,'tea_expense',0,'other_allowances',0,'travel_food',0,
      'rent_commission',0,'special_allowance',0,'ot_hours',null,'late_hours',null,'advance_recovery',0,'welfare_fund',0,'other_deductions',0,'tds',null,'attendance_source','recorded')
    || coalesce(_payload,'{}'::jsonb) || _input || jsonb_build_object('employee_id',_employee_id,'period',_period,
      'entity_id',_emp.entity_id,'zone_id',_emp.zone_id,'branch_id',_emp.branch_id,'department_id',_emp.department_id,
      'updated_by',auth.uid(),'updated_at',clock_timestamp()));
  select to_jsonb(p) into _policy from public.payroll_policies p where entity_id=_emp.entity_id;
  select employment_to-employment_from+1 into _employment_days from app.payroll_employee_windows(
    _emp.entity_id,app.payroll_period_start(_period),(app.payroll_period_start(_period)+interval '1 month - 1 day')::date) where employee_id=_employee_id;
  _review_issue:=app.payroll_attendance_review_issue(to_jsonb(_row),_policy,_employment_days);
  if _review_issue is not null then raise exception '%',_review_issue using errcode='23514'; end if;
  if _row.tds is not null and nullif(btrim(_row.notes),'') is null then
    raise exception 'Record the approval or reference for TDS, including an explicit zero.' using errcode='23514';
  end if;
  if ((_row.ot_hours is not null and _row.ot_hours is distinct from (_payload->>'ot_hours')::numeric)
      or (_row.late_hours is not null and _row.late_hours is distinct from (_payload->>'late_hours')::numeric))
      and nullif(btrim(_row.notes),'') is null then
    raise exception 'Record the reason for an OT or late-hours override, including an explicit zero.' using errcode='23514';
  end if;
  if (_row.other_deductions>0 or _row.pf is not null or _row.esi is not null)
      and nullif(btrim(_row.notes),'') is null then
    raise exception 'Record the approval or reason for other deductions and PF/ESI overrides.' using errcode='23514';
  end if;
  insert into public.payroll_monthly_inputs select (_row).*
  on conflict (employee_id,period) do update set entity_id=excluded.entity_id,zone_id=excluded.zone_id,
    branch_id=excluded.branch_id,department_id=excluded.department_id,incentive=excluded.incentive,
    target_incentive=excluded.target_incentive,tea_expense=excluded.tea_expense,other_allowances=excluded.other_allowances,
    travel_food=excluded.travel_food,rent_commission=excluded.rent_commission,special_allowance=excluded.special_allowance,
    ot_hours=excluded.ot_hours,late_hours=excluded.late_hours,pf=excluded.pf,esi=excluded.esi,
    advance_recovery=excluded.advance_recovery,welfare_fund=excluded.welfare_fund,other_deductions=excluded.other_deductions,
    tds=excluded.tds,attendance_source=excluded.attendance_source,worked_minutes=excluded.worked_minutes,
    actual_working_days=excluded.actual_working_days,public_holiday_days=excluded.public_holiday_days,
    off_days=excluded.off_days,casual_leave_days=excluded.casual_leave_days,
    notes=excluded.notes,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
  update public.payroll_runs set needs_recalculation=true where entity_id=_emp.entity_id and period=_period and status='Draft';
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id,branch_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'INPUTS_SAVED:'||_period,'payroll_monthly_inputs',_employee_id,_emp.entity_id,_emp.branch_id);
  if _row.ot_hours is distinct from (_payload->>'ot_hours')::numeric
      or _row.late_hours is distinct from (_payload->>'late_hours')::numeric then
    insert into public.payroll_hour_override_history(employee_id,period,entity_id,zone_id,branch_id,department_id,
      ot_hours_before,ot_hours_after,late_hours_before,late_hours_after,reason,changed_by)
    values(_employee_id,_period,_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,
      (_payload->>'ot_hours')::numeric,_row.ot_hours,(_payload->>'late_hours')::numeric,_row.late_hours,_row.notes,auth.uid());
  end if;
  return to_jsonb(_row);
end $$;

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

create or replace function app.payroll_source_fingerprint(_entity uuid,_period text)
returns text language sql stable security definer set search_path=pg_catalog,public,app as $$
  select md5(jsonb_build_object(
    'calculation_contract','payroll_v4',
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

-- New fields are automatically covered by the full-row policy/input fingerprint. Only
-- drafts need review under the new snapshot contract; published payroll is never rewritten.
update public.payroll_runs set needs_recalculation=true where status='Draft' and not needs_recalculation
  and exists(select 1 from public.payslips where run_id=payroll_runs.id and coalesce((payroll_register->>'schema_version')::integer,0)<4);
revoke all on function app.payroll_attendance_review_issue(jsonb,jsonb,integer),
  app.payroll_hourly_workings(numeric,numeric,numeric,text,jsonb,jsonb),
  app.payroll_shift_days(uuid,date,date),app.payroll_shift_basis_issue(uuid,date,date,jsonb),
  app.payroll_shift_workings(uuid,date,date,numeric,numeric,text,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.save_payroll_policy(uuid,jsonb,timestamptz),public.save_payroll_monthly_input(uuid,text,jsonb,timestamptz),
  public.get_payroll_attendance_summary(uuid,text),public.run_payroll(uuid,text),public.publish_payroll(uuid,text) from public,anon;
grant execute on function public.save_payroll_policy(uuid,jsonb,timestamptz),public.save_payroll_monthly_input(uuid,text,jsonb,timestamptz),
  public.get_payroll_attendance_summary(uuid,text),public.run_payroll(uuid,text),public.publish_payroll(uuid,text) to authenticated,service_role;

commit;
