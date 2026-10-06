-- Payroll register, approved monthly adjustments and explicit company calculation policy.
-- No statutory rates or employee eligibility are inferred. Existing published amounts stay intact.
begin;

create table if not exists public.payroll_policies (
  entity_id uuid primary key references public.entities(id),
  divisor_mode text not null default 'calendar' check (divisor_mode in ('calendar','fixed','working')),
  fixed_days numeric(5,2) not null default 30 check (fixed_days > 0 and fixed_days <= 31),
  hours_per_day numeric(5,2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  ot_multiplier numeric(5,2) not null default 2 check (ot_multiplier >= 0 and ot_multiplier <= 10),
  deduct_late boolean not null default false,
  notes text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.payroll_monthly_inputs (
  employee_id uuid not null references public.employees(id),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  entity_id uuid not null references public.entities(id),
  zone_id uuid, branch_id uuid, department_id uuid,
  incentive numeric(12,2) not null default 0,
  target_incentive numeric(12,2) not null default 0,
  tea_expense numeric(12,2) not null default 0,
  other_allowances numeric(12,2) not null default 0,
  travel_food numeric(12,2) not null default 0,
  rent_commission numeric(12,2) not null default 0,
  special_allowance numeric(12,2) not null default 0,
  ot_hours numeric(8,2) not null default 0,
  late_hours numeric(8,2) not null default 0,
  pf numeric(12,2), esi numeric(12,2),
  advance_recovery numeric(12,2) not null default 0,
  welfare_fund numeric(12,2) not null default 0,
  other_deductions numeric(12,2) not null default 0,
  notes text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (employee_id,period),
  constraint payroll_input_amounts_valid check (
    least(incentive,target_incentive,tea_expense,other_allowances,travel_food,rent_commission,
      special_allowance,ot_hours,late_hours,coalesce(pf,0),coalesce(esi,0),advance_recovery,welfare_fund,other_deductions) >= 0
    and greatest(incentive,target_incentive,tea_expense,other_allowances,travel_food,rent_commission,
      special_allowance,ot_hours,late_hours,coalesce(pf,0),coalesce(esi,0),advance_recovery,welfare_fund,other_deductions) < 'Infinity'::numeric
    and ot_hours <= 744 and late_hours <= 744
  )
);
create index if not exists payroll_monthly_inputs_entity_period_idx on public.payroll_monthly_inputs(entity_id,period);
alter table public.payroll_runs add column if not exists needs_recalculation boolean not null default false;
alter table public.payroll_runs add column if not exists source_fingerprint text;
alter table public.payslips add column if not exists payroll_register jsonb;

alter table public.payroll_policies enable row level security;
alter table public.payroll_monthly_inputs enable row level security;
drop policy if exists payroll_policies_select on public.payroll_policies;
create policy payroll_policies_select on public.payroll_policies for select to authenticated
  using (app.has_perm('payroll.manage',entity_id,null,null,null,null));
drop policy if exists payroll_monthly_inputs_select on public.payroll_monthly_inputs;
create policy payroll_monthly_inputs_select on public.payroll_monthly_inputs for select to authenticated
  using (app.has_perm('payroll.manage',entity_id,zone_id,branch_id,department_id,employee_id));
drop policy if exists active_account_required on public.payroll_policies;
create policy active_account_required on public.payroll_policies as restrictive for all to authenticated
  using (app.session_is_active()) with check (app.session_is_active());
drop policy if exists active_account_required on public.payroll_monthly_inputs;
create policy active_account_required on public.payroll_monthly_inputs as restrictive for all to authenticated
  using (app.session_is_active()) with check (app.session_is_active());

-- One company lock orders policy, input, generation and publication transactions, including a
-- month that has no run yet. Company-wide serialization also makes policy changes unambiguous.
create or replace function app.lock_payroll(_entity uuid)
returns void language sql volatile set search_path=pg_catalog as $$
  select pg_advisory_xact_lock(hashtextextended('payroll:' || _entity::text,0));
$$;

create or replace function app.payroll_period_start(_period text)
returns date language plpgsql immutable set search_path=pg_catalog as $$
begin
  if _period is null or _period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Payroll period must be YYYY-MM.' using errcode='22023';
  end if;
  return (_period || '-01')::date;
end $$;

drop function if exists public.save_payroll_policy(uuid,jsonb);
create or replace function public.save_payroll_policy(_entity_id uuid, _policy jsonb, _expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _row public.payroll_policies%rowtype; _existing jsonb;
begin
  if auth.uid() is null or not app.has_perm('payroll.manage',_entity_id,null,null,null,null) then
    raise exception 'Not authorized to configure payroll for this company.' using errcode='42501';
  end if;
  if jsonb_typeof(_policy) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(_policy) k where k not in
      ('divisor_mode','fixed_days','hours_per_day','ot_multiplier','deduct_late','notes')) then
    raise exception 'Invalid payroll policy fields.' using errcode='22023';
  end if;
  perform app.lock_payroll(_entity_id);
  select to_jsonb(p) into _existing from public.payroll_policies p where entity_id=_entity_id;
  if (_existing->>'updated_at')::timestamptz is distinct from _expected_updated_at then
    raise exception 'Payroll policy changed in another session. Reload it before saving.' using errcode='40001';
  end if;
  _row := jsonb_populate_record(null::public.payroll_policies,
    jsonb_build_object('divisor_mode','calendar','fixed_days',30,'hours_per_day',8,'ot_multiplier',2,'deduct_late',false)
    || coalesce(_existing,'{}'::jsonb) || _policy
    || jsonb_build_object('entity_id',_entity_id,'updated_by',auth.uid(),'updated_at',clock_timestamp()));
  if _row.divisor_mode is null or _row.fixed_days is null or _row.hours_per_day is null
      or _row.ot_multiplier is null or _row.deduct_late is null then
    raise exception 'Complete all payroll policy values.' using errcode='22023';
  end if;
  insert into public.payroll_policies select (_row).*
  on conflict (entity_id) do update set divisor_mode=excluded.divisor_mode,fixed_days=excluded.fixed_days,
    hours_per_day=excluded.hours_per_day,ot_multiplier=excluded.ot_multiplier,deduct_late=excluded.deduct_late,
    notes=excluded.notes,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
  update public.payroll_runs set needs_recalculation=true where entity_id=_entity_id and status='Draft';
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'POLICY_SAVED','payroll_policies',_entity_id,_entity_id);
  return to_jsonb(_row);
end $$;

drop function if exists public.save_payroll_monthly_input(uuid,text,jsonb);
create or replace function public.save_payroll_monthly_input(_employee_id uuid,_period text,_input jsonb,_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _emp public.employees%rowtype; _row public.payroll_monthly_inputs%rowtype; _payload jsonb; _locked_entity uuid;
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
      'pf','esi','advance_recovery','welfare_fund','other_deductions','notes')) then
    raise exception 'Invalid payroll input fields.' using errcode='22023';
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
      'rent_commission',0,'special_allowance',0,'ot_hours',0,'late_hours',0,'advance_recovery',0,'welfare_fund',0,'other_deductions',0)
    || coalesce(_payload,'{}'::jsonb) || _input || jsonb_build_object('employee_id',_employee_id,'period',_period,
      'entity_id',_emp.entity_id,'zone_id',_emp.zone_id,'branch_id',_emp.branch_id,'department_id',_emp.department_id,
      'updated_by',auth.uid(),'updated_at',clock_timestamp()));
  _row.ot_hours:=coalesce(_row.ot_hours,0);
  _row.late_hours:=coalesce(_row.late_hours,0);
  if (_row.other_deductions>0 or _row.late_hours>0 or _row.pf is not null or _row.esi is not null)
      and nullif(btrim(_row.notes),'') is null then
    raise exception 'Record the approval or reason for other deductions, late deductions and PF/ESI overrides.' using errcode='23514';
  end if;
  insert into public.payroll_monthly_inputs select (_row).*
  on conflict (employee_id,period) do update set entity_id=excluded.entity_id,zone_id=excluded.zone_id,
    branch_id=excluded.branch_id,department_id=excluded.department_id,incentive=excluded.incentive,
    target_incentive=excluded.target_incentive,tea_expense=excluded.tea_expense,other_allowances=excluded.other_allowances,
    travel_food=excluded.travel_food,rent_commission=excluded.rent_commission,special_allowance=excluded.special_allowance,
    ot_hours=excluded.ot_hours,late_hours=excluded.late_hours,pf=excluded.pf,esi=excluded.esi,
    advance_recovery=excluded.advance_recovery,welfare_fund=excluded.welfare_fund,other_deductions=excluded.other_deductions,
    notes=excluded.notes,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
  update public.payroll_runs set needs_recalculation=true where entity_id=_emp.entity_id and period=_period and status='Draft';
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id,branch_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'INPUTS_SAVED:'||_period,'payroll_monthly_inputs',_employee_id,_emp.entity_id,_emp.branch_id);
  return to_jsonb(_row);
end $$;

-- Fingerprints catch salary/attendance/catalog/employee changes after generation, including
-- source changes made outside the payroll screen. No live sources are used to render a register.
create or replace function app.payroll_source_fingerprint(_entity uuid,_period text)
returns text language sql stable security definer set search_path=pg_catalog,public,app as $$
  select md5(jsonb_build_object(
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
    'exits',(select jsonb_agg(to_jsonb(x) order by x.id) from public.exits x join public.employees e on e.id=x.employee_id where e.entity_id=_entity)
  )::text);
$$;

create or replace function public.run_payroll(_entity_id uuid,_period text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare
  _from date := app.payroll_period_start(_period); _to date; _days int; _start date; _end date;
  _run_id uuid; _payslip_id uuid; _emp record; _sal public.salary_structures%rowtype; _comp record; _named record;
  _policy public.payroll_policies%rowtype; _input public.payroll_monthly_inputs%rowtype;
  _configured boolean; _stats record; _full_working numeric; _divisor numeric; _factor numeric;
  _paid numeric; _lop numeric; _salary numeric; _basic numeric; _earn numeric; _ded numeric; _employer numeric;
  _structure_total numeric; _base numeric; _amount numeric; _rate numeric; _hour_rate numeric;
  _ot numeric; _late numeric; _pf numeric; _esi numeric; _other_ded numeric; _advance numeric; _welfare numeric;
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
    _policy.ot_multiplier:=2; _policy.deduct_late:=false;
  end if;
  insert into public.payroll_runs(entity_id,period,status,run_by) values(_entity_id,_period,'Draft',auth.uid())
    on conflict(entity_id,period) do update set run_by=excluded.run_by where public.payroll_runs.status='Draft'
    returning id into _run_id;
  if _run_id is null then raise exception 'Published payroll cannot be regenerated.' using errcode='55000'; end if;
  delete from public.payslips where run_id=_run_id;

  for _emp in
    select e.*,b.name as branch_name,
      (select min(x.last_day) from public.exits x where x.employee_id=e.id and x.status in ('Cleared','Completed')
        and x.last_day>=coalesce(e.join_date,'0001-01-01'::date)) as last_day
    from public.employees e left join public.branches b on b.id=e.branch_id
    where e.entity_id=_entity_id and coalesce(e.join_date,_from)<=_to
      and (e.status='Active' or exists(select 1 from public.attendance a where a.employee_id=e.id and a.work_date between _from and _to)
        or exists(select 1 from public.exits x where x.employee_id=e.id and x.status in ('Cleared','Completed') and x.last_day>=_from))
    order by e.id
  loop
    _start:=greatest(_from,coalesce(_emp.join_date,_from)); _end:=least(_to,coalesce(_emp.last_day,_to));
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

    select count(*) as recorded,
      count(*) filter(where (a.is_missing_punch or a.status in ('Missing Punch','No Shift') or a.breaks_incomplete) and a.status_override is null) as unresolved,
      count(*) filter(where a.day_fraction<0 or a.day_fraction>1 or a.day_fraction is null or a.day_type not in ('working','weekly_off','holiday')) as invalid,
      coalesce(sum(case when a.day_type='working' then 1-a.day_fraction else 0 end),0) as lop,
      count(*) filter(where a.day_type='working') as working,
      count(*) filter(where a.day_type='holiday') as holidays,
      count(*) filter(where a.day_type='weekly_off') as offs,
      coalesce(sum(case when a.day_type='working' and a.status='On Leave' and not a.is_lop
        then least(a.day_fraction,coalesce(l.day_fraction,a.day_fraction)) else 0 end),0) as paid_leave,
      coalesce(sum(case when a.day_type='working' and a.status='On Leave' and not a.is_lop and coalesce(a.leave_type,l.type) in ('CL','Casual Leave')
        then least(a.day_fraction,coalesce(l.day_fraction,a.day_fraction)) else 0 end),0) as casual_leave,
      coalesce(sum(greatest(coalesce(a.worked_minutes,0),0)),0)/60.0 as worked_hours,
      coalesce(sum(greatest(a.ot_minutes,0)),0)/60.0 as ot_hours,
      coalesce(sum(greatest(a.late_minutes,0)),0)/60.0 as late_hours,
      coalesce(sum(case when a.day_type='working' and a.day_fraction=1 then greatest(a.late_minutes,0) else 0 end),0)/60.0 as deductible_late_hours
    into _stats from public.attendance a left join public.leaves l on l.id=a.leave_id
    where a.employee_id=_emp.id and a.work_date between _start and _end;
    if _stats.recorded <> (_end-_start+1) then
      raise exception 'Attendance is incomplete for %: % of % employment days. Recompute and review attendance first.',_emp.full_name,_stats.recorded,(_end-_start+1) using errcode='23514';
    end if;
    if _stats.unresolved>0 or _stats.invalid>0 then
      raise exception 'Resolve missing punches, missing shifts, incomplete breaks and invalid day credits for % before payroll.',_emp.full_name using errcode='23514';
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
    _salary:=round(_sal.gross*_factor,2); _basic:=round(_sal.basic*_factor,2);
    _rate:=_sal.gross/_divisor; _hour_rate:=_rate/_policy.hours_per_day;
    select * into _input from public.payroll_monthly_inputs where employee_id=_emp.id and period=_period;
    if coalesce(_input.ot_hours,0)>round(_stats.ot_hours,2) then
      raise exception 'Approved OT hours exceed recorded OT for %.',_emp.full_name using errcode='23514';
    end if;
    if _policy.deduct_late and coalesce(_input.late_hours,0)>round(_stats.deductible_late_hours,2) then
      raise exception 'Approved late hours exceed lateness on fully paid working days for %; do not charge the same time as loss of pay.',_emp.full_name using errcode='23514';
    end if;
    if coalesce(_input.late_hours,0)>0 and not _policy.deduct_late then
      raise exception 'Late deductions are disabled by company policy. Clear approved late hours for % or enable the policy.',_emp.full_name using errcode='23514';
    end if;
    _ot:=round(coalesce(_input.ot_hours,0)*_hour_rate*_policy.ot_multiplier,2);
    _late:=case when _policy.deduct_late then round(coalesce(_input.late_hours,0)*_hour_rate,2) else 0 end;
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
      -- Manual PF/ESI replace employee deductions with exactly those normalized codes only.
      continue when not _comp.employer_share and _comp.kind='deduction' and
        ((upper(btrim(_comp.code))='PF' and _input.pf is not null) or (upper(btrim(_comp.code))='ESI' and _input.esi is not null));
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
        case upper(btrim(_comp.code)) when 'PF' then _pf:=_pf+_amount; when 'ESI' then _esi:=_esi+_amount;
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
    _earn:=_earn+_ot;
    if _ot<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'OT','Overtime','earning',_ot,390); end if;
    if _input.pf is not null then _pf:=_input.pf; _ded:=_ded+_pf;
      if _pf<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'PF','PF (approved amount)','deduction',_pf,501); end if;
    end if;
    if _input.esi is not null then _esi:=_input.esi; _ded:=_ded+_esi;
      if _esi<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'ESI','ESI (approved amount)','deduction',_esi,502); end if;
    end if;
    _advance:=coalesce(_input.advance_recovery,0); _welfare:=coalesce(_input.welfare_fund,0);
    _other_ded:=_other_ded+coalesce(_input.other_deductions,0);
    for _key,_label,_amount in select * from (values ('LATE','Approved late deduction',_late),('ADVANCE','Salary advance recovery',_advance),
      ('WELFARE','Welfare fund',_welfare),('MONTHLY_OTHER_DEDUCTIONS','Loss, damages / other approved deductions',coalesce(_input.other_deductions,0))) v(k,label,amount) loop
      _ded:=_ded+_amount;
      if _amount<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,_key,_label,'deduction',_amount,590); end if;
    end loop;
    if _ded>_earn then raise exception 'Deductions exceed gross salary for %. Review recoveries before payroll.',_emp.full_name using errcode='23514'; end if;
    _register:=jsonb_build_object('employee_name',_emp.full_name,'employee_code',_emp.employee_code,'branch',coalesce(_emp.branch_name,''),
      'salary',_sal.gross,'days_per_month',_days,'net_working_days',_stats.working,'public_holiday',_stats.holidays,
      'actual_working_days',_stats.working-_lop-_stats.paid_leave,'off_days',_stats.offs,'casual_leave',_stats.casual_leave,
      'total_working_days',_paid,'per_day_wages',round(_rate,6),'per_day_working_hour',_policy.hours_per_day,
      'total_working_hours',round(_stats.worked_hours,2),'per_hour_wages',round(_hour_rate,6),'earned_salary',_salary,
      'incentive',coalesce(_input.incentive,0),'target_incentive',coalesce(_input.target_incentive,0),'tea_expense',coalesce(_input.tea_expense,0),
      'other_allowances',coalesce(_input.other_allowances,0),'travel_food',coalesce(_input.travel_food,0),'rent_commission',coalesce(_input.rent_commission,0),
      'special_allowance',coalesce(_input.special_allowance,0),'ot_hours',coalesce(_input.ot_hours,0),'ot_amount',_ot,
      'late_hours',coalesce(_input.late_hours,0),'late_amount',_late,'gross_salary',_earn,'pf',_pf,'esi',_esi,
      'advance_recovery',_advance,'welfare_fund',_welfare,'other_deductions',_other_ded,'net_pay_salary',_earn-_ded)
      || jsonb_build_object('paid_leave',_stats.paid_leave,'lop_days',_lop,'divisor_days',_divisor,'employment_from',_start,'employment_to',_end,
        'paid_hours',round(_paid*_policy.hours_per_day,2),'recorded_worked_hours',round(_stats.worked_hours,2),'recorded_ot_hours',round(_stats.ot_hours,2),'recorded_late_hours',round(_stats.late_hours,2),
        'policy',to_jsonb(_policy),'policy_configured',_configured,'notes',_input.notes,'schema_version',1);
    update public.payslips set gross=_earn,deductions=_ded,net=_earn-_ded,employer_cost=_employer,payroll_register=_register where id=_payslip_id;
    _count:=_count+1; _sum_gross:=_sum_gross+_earn; _sum_net:=_sum_net+(_earn-_ded);
  end loop;
  update public.payroll_runs set employees=_count,total_gross=_sum_gross,total_net=_sum_net,needs_recalculation=false,
    source_fingerprint=app.payroll_source_fingerprint(_entity_id,_period) where id=_run_id;
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'GENERATED:'||_period,'payroll_runs',_run_id,_entity_id);
  return jsonb_build_object('run_id',_run_id,'period',_period,'employees',_count,'total_gross',_sum_gross,'total_net',_sum_net,'policy_configured',_configured);
end $$;

drop function if exists public.publish_payroll(uuid);
create or replace function public.publish_payroll(_run_id uuid,_expected_fingerprint text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _run public.payroll_runs%rowtype; _from date;
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
      +(p.payroll_register->>'rent_commission')::numeric+(p.payroll_register->>'special_allowance')::numeric+(p.payroll_register->>'ot_amount')::numeric)
    or p.deductions is distinct from ((p.payroll_register->>'pf')::numeric+(p.payroll_register->>'esi')::numeric
      +(p.payroll_register->>'advance_recovery')::numeric+(p.payroll_register->>'welfare_fund')::numeric
      +(p.payroll_register->>'other_deductions')::numeric+(p.payroll_register->>'late_amount')::numeric)
    or p.gross is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='earning')
    or p.deductions is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='deduction')
    or p.employer_cost is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='employer')
    or p.net is distinct from p.gross-p.deductions)) then
    raise exception 'Payroll totals or register do not reconcile. Regenerate this draft.' using errcode='23514';
  end if;
  if _run.employees is distinct from (select count(*) from public.payslips where run_id=_run_id)
    or _run.total_gross is distinct from (select sum(gross) from public.payslips where run_id=_run_id)
    or _run.total_net is distinct from (select sum(net) from public.payslips where run_id=_run_id) then
    raise exception 'Payroll run totals do not reconcile. Regenerate this draft.' using errcode='23514';
  end if;
  -- Lock exactly the employment interval priced in the immutable register.
  update public.attendance a set is_locked=true from public.payslips p where p.run_id=_run_id and p.employee_id=a.employee_id
    and a.work_date between (p.payroll_register->>'employment_from')::date and (p.payroll_register->>'employment_to')::date;
  update public.payslips set status='Published' where run_id=_run_id;
  update public.payroll_runs set status='Published',published_at=now(),needs_recalculation=false where id=_run_id;
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'PUBLISHED:'||_run.period,'payroll_runs',_run_id,_run.entity_id);
end $$;

create or replace function public.delete_draft_payroll(_run_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _run public.payroll_runs%rowtype;
begin
  select * into _run from public.payroll_runs where id=_run_id;
  if _run.id is null then raise exception 'Payroll run not found.' using errcode='P0002'; end if;
  if auth.uid() is null or not app.has_perm('payroll.manage',_run.entity_id,null,null,null,null) then
    raise exception 'Not authorized to delete payroll for this company.' using errcode='42501';
  end if;
  perform app.lock_payroll(_run.entity_id);
  select * into _run from public.payroll_runs where id=_run_id for update;
  if _run.status<>'Draft' then raise exception 'Only draft payroll runs can be deleted.' using errcode='23514'; end if;
  delete from public.payroll_runs where id=_run_id;
end $$;

-- Serialize changes to every source used by a calculation. Mark affected drafts for review;
-- global catalog changes conservatively invalidate all draft companies. The fingerprint is an
-- additional guard against source changes to joined records or older drafts without snapshots.
create or replace function app.tg_payroll_source_changed()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _entities uuid[]; _current_entities uuid[]; _entity uuid; _old jsonb; _new jsonb;
begin
  _old:=case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  _new:=case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
  if tg_table_name='pay_components' and (tg_op='INSERT' and new.entity_id is null
      or tg_op='DELETE' and old.entity_id is null
      or tg_op='UPDATE' and (old.entity_id is null or new.entity_id is null)) then
    select array_agg(id order by id) into _entities from public.entities;
  elsif tg_table_name in ('employees','pay_components','payroll_policies','payroll_monthly_inputs') then
    _entities:=array[( _old->>'entity_id')::uuid,(_new->>'entity_id')::uuid];
  else
    select array_agg(distinct e.entity_id order by e.entity_id) into _entities from public.employees e
      where e.id in ((_old->>'employee_id')::uuid,(_new->>'employee_id')::uuid);
  end if;
  for _entity in select distinct unnest(_entities) as id order by id loop
    if _entity is not null then
      perform app.lock_payroll(_entity);
      update public.payroll_runs r set needs_recalculation=true where r.entity_id=_entity and r.status='Draft'
        and case tg_table_name
          when 'attendance' then r.period in (left(_old->>'work_date',7),left(_new->>'work_date',7))
            and (_old-'is_locked') is distinct from (_new-'is_locked')
          when 'payroll_monthly_inputs' then r.period in (_old->>'period',_new->>'period')
          when 'salary_structures' then r.period>=least(left(_old->>'effective_from',7),left(_new->>'effective_from',7))
          when 'leaves' then
            (r.period>=left(_old->>'start_date',7) and r.period<=left(_old->>'end_date',7))
            or (r.period>=left(_new->>'start_date',7) and r.period<=left(_new->>'end_date',7))
          else true end;
    end if;
  end loop;
  if tg_table_name in ('attendance','salary_structures','exits','leaves') then
    select array_agg(distinct e.entity_id order by e.entity_id) into _current_entities from public.employees e
      where e.id in ((_old->>'employee_id')::uuid,(_new->>'employee_id')::uuid);
    if _current_entities is distinct from _entities then
      raise exception 'Employee company changed while updating payroll sources. Retry the change with refreshed employee information.' using errcode='40001';
    end if;
  end if;
  if tg_table_name='attendance' then
    if exists(select 1 from public.payslips p where p.status='Published'
      and ((p.employee_id=(_old->>'employee_id')::uuid and p.period=to_char((_old->>'work_date')::date,'YYYY-MM'))
        or (p.employee_id=(_new->>'employee_id')::uuid and p.period=to_char((_new->>'work_date')::date,'YYYY-MM')))) then
      raise exception 'Attendance used by published payroll is locked.' using errcode='55000';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
do $$ declare _table text;
begin
  foreach _table in array array['attendance','salary_structures','pay_components','employees','exits','leaves','payroll_policies','payroll_monthly_inputs'] loop
    execute format('drop trigger if exists payroll_source_changed on public.%I',_table);
    execute format('drop trigger if exists zz_payroll_source_changed on public.%I',_table);
    -- Run after existing ancestry stamping so a branch transfer locks BOTH legal entities.
    execute format('create trigger zz_payroll_source_changed before insert or update or delete on public.%I for each row execute function app.tg_payroll_source_changed()',_table);
  end loop;
end $$;

-- Direct API writes cannot bypass lifecycle RPCs. Triggers also preserve published evidence
-- against service imports or accidental owner DML; migration reapplication does not mutate it.
create or replace function app.tg_payroll_published_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _published boolean:=false; _id uuid;
begin
  if tg_table_name='payroll_runs' then
    _published:=old.status='Published';
  elsif tg_table_name='payslips' then
    if tg_op<>'INSERT' then
      _published:=old.status='Published' or exists(select 1 from public.payroll_runs where id=old.run_id and status='Published');
    end if;
    if tg_op<>'DELETE' then
      _published:=_published or exists(select 1 from public.payroll_runs where id=new.run_id and status='Published');
    end if;
  elsif tg_table_name='payslip_lines' then
    _id:=case when tg_op='DELETE' then old.payslip_id else new.payslip_id end;
    _published:=exists(select 1 from public.payslips p left join public.payroll_runs r on r.id=p.run_id
      where p.id=_id and (p.status='Published' or r.status='Published'));
    if tg_op='UPDATE' then
      _published:=_published or exists(select 1 from public.payslips p left join public.payroll_runs r on r.id=p.run_id
        where p.id=old.payslip_id and (p.status='Published' or r.status='Published'));
    end if;
  elsif tg_table_name='payroll_monthly_inputs' then
    if tg_op<>'INSERT' then
      perform app.lock_payroll(old.entity_id);
      _published:=exists(select 1 from public.payroll_runs where entity_id=old.entity_id and period=old.period and status='Published')
        or exists(select 1 from public.payslips where employee_id=old.employee_id and period=old.period and status='Published');
    end if;
    if tg_op<>'DELETE' then
      perform app.lock_payroll(new.entity_id);
      _published:=_published or exists(select 1 from public.payroll_runs where entity_id=new.entity_id and period=new.period and status='Published')
        or exists(select 1 from public.payslips where employee_id=new.employee_id and period=new.period and status='Published');
    end if;
  end if;
  if _published then raise exception 'Published payroll is immutable.' using errcode='55000'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists payroll_runs_published_guard on public.payroll_runs;
create trigger payroll_runs_published_guard before update or delete on public.payroll_runs for each row execute function app.tg_payroll_published_guard();
drop trigger if exists payslips_published_guard on public.payslips;
create trigger payslips_published_guard before insert or update or delete on public.payslips for each row execute function app.tg_payroll_published_guard();
drop trigger if exists payslip_lines_published_guard on public.payslip_lines;
create trigger payslip_lines_published_guard before insert or update or delete on public.payslip_lines for each row execute function app.tg_payroll_published_guard();
drop trigger if exists payroll_inputs_published_guard on public.payroll_monthly_inputs;
create trigger payroll_inputs_published_guard before insert or update or delete on public.payroll_monthly_inputs for each row execute function app.tg_payroll_published_guard();

revoke all on public.payroll_policies,public.payroll_monthly_inputs from public,anon,authenticated;
grant select on public.payroll_policies,public.payroll_monthly_inputs to authenticated,service_role;
revoke insert,update,delete on public.payroll_runs,public.payslips,public.payslip_lines from public,anon,authenticated;
revoke all on function app.lock_payroll(uuid),app.payroll_period_start(text),app.payroll_source_fingerprint(uuid,text),app.tg_payroll_published_guard(),app.tg_payroll_source_changed() from public,anon,authenticated;
revoke all on function public.save_payroll_policy(uuid,jsonb,timestamptz),public.save_payroll_monthly_input(uuid,text,jsonb,timestamptz),public.run_payroll(uuid,text),public.publish_payroll(uuid,text) from public,anon;
grant execute on function public.save_payroll_policy(uuid,jsonb,timestamptz),public.save_payroll_monthly_input(uuid,text,jsonb,timestamptz),public.run_payroll(uuid,text),public.publish_payroll(uuid,text) to authenticated,service_role;

do $$ declare _table text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach _table in array array['payroll_policies','payroll_monthly_inputs','salary_structures','pay_components'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=_table) then
        execute format('alter publication supabase_realtime add table public.%I',_table);
      end if;
    end loop;
  end if;
end $$;

commit;
