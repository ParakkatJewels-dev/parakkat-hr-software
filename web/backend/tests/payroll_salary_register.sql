-- The current payroll contract, exercised after the historical 0143 upgrade suite.
\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'hr_payroll_integrity_audit' then raise exception 'Disposable payroll integrity database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub='';
create schema register_test;
create function register_test.id(kind integer,n integer) returns uuid language sql immutable as $$
  select ('c158'||lpad(kind::text,4,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create table register_test.results(label text primary key);
create function register_test.expect(label text,actual jsonb,expected jsonb) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception '%: expected %, got %',label,expected,actual; end if;
  insert into register_test.results values(label);
end $$;
create function register_test.error(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
create function register_test.save_policy(_entity uuid,_policy jsonb) returns jsonb language sql as $$
  select public.save_payroll_policy(_entity,_policy,(select updated_at from public.payroll_policies where entity_id=_entity));
$$;
create function register_test.save_input(_employee uuid,_period text,_input jsonb) returns jsonb language sql as $$
  select public.save_payroll_monthly_input(_employee,_period,_input,(select updated_at from public.payroll_monthly_inputs where employee_id=_employee and period=_period));
$$;
create function register_test.publish(_run uuid) returns void language sql as $$
  select public.publish_payroll(_run,(select source_fingerprint from public.payroll_runs where id=_run));
$$;
grant usage on schema register_test to authenticated,anon;
grant execute on all functions in schema register_test to authenticated,anon;
grant select,insert on register_test.results to authenticated,anon;
insert into public.entities(id,code,name) select register_test.id(1,n),'REG-E'||n,'Register company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name) select register_test.id(2,n),register_test.id(1,n),'REG-B'||n,'Register branch '||n from generate_series(1,2)n;
insert into auth.users(id,email) select register_test.id(3,n),'register-'||n||'@audit.invalid' from generate_series(1,3)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name,status,join_date) values
 (register_test.id(4,1),register_test.id(1,1),register_test.id(2,1),register_test.id(3,2),'REG-EMP1','Register employee','Active','2026-01-01'),
 (register_test.id(4,2),register_test.id(1,2),register_test.id(2,2),register_test.id(3,3),'REG-EMP2','Foreign employee','Active','2026-01-01');
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like 'REG-EMP%';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
 (register_test.id(3,1),(select id from public.roles where key='hr_manager'),'entity',register_test.id(1,1)),
 (register_test.id(3,2),(select id from public.roles where key='employee'),'self',null),
 (register_test.id(3,3),(select id from public.roles where key='employee'),'self',null);
insert into public.salary_structures(employee_id,effective_from,basic,gross,notes)
 values(register_test.id(4,1),'2026-01-01',20000,30000,'{"gross_components":[{"name":"HRA","amount":10000}]}');
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,is_lop,worked_minutes)
 select register_test.id(4,1),d::date,'Present',1,'working',false,480
 from generate_series('2026-09-01'::date,'2026-09-30'::date,'1 day')d;

set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select public.run_payroll(register_test.id(1,1),'2026-09');
select register_test.expect('policy/unconfigured draft is clearly marked',
 (select payroll_register->'policy_configured' from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),'false');
select register_test.expect('policy/unconfigured publication rejected',
 to_jsonb(register_test.error($q$select register_test.publish((select id from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'))$q$)),'"23514"');
select register_test.save_policy(register_test.id(1,1),'{}');
select register_test.expect('policy/default editable policy created',
 (select jsonb_build_array(divisor_mode,fixed_days,hours_per_day,ot_multiplier,deduct_late) from public.payroll_policies where entity_id=register_test.id(1,1)),
 '["calendar",30,8,2,false]');
select register_test.expect('policy/change marks draft stale',
 (select to_jsonb(needs_recalculation) from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'),'true');
select register_test.expect('policy/negative divisor rejected',
 to_jsonb(register_test.error($q$select register_test.save_policy(register_test.id(1,1),'{"fixed_days":0}')$q$)),'"23514"');
select register_test.expect('policy/unknown field rejected',
 to_jsonb(register_test.error($q$select register_test.save_policy(register_test.id(1,1),'{"unexpected":1}')$q$)),'"22023"');
select register_test.expect('policy/foreign company rejected',
 to_jsonb(register_test.error($q$select register_test.save_policy(register_test.id(1,2),'{}')$q$)),'"42501"');
select register_test.save_policy(register_test.id(1,1),'{"deduct_late":true}');
select register_test.save_input(register_test.id(4,1),'2026-09','{"incentive":1000,"target_incentive":500,"tea_expense":100,"other_allowances":200,"travel_food":300,"rent_commission":400,"special_allowance":500,"ot_hours":2,"late_hours":0.5,"advance_recovery":1000,"welfare_fund":50,"other_deductions":100,"notes":"HR approved attendance, allowances and deductions"}');
select register_test.expect('inputs/negative amount rejected',
 to_jsonb(register_test.error($q$select register_test.save_input(register_test.id(4,1),'2026-09','{"incentive":-1}')$q$)),'"23514"');
select register_test.expect('inputs/nonfinite amount rejected',
 to_jsonb(register_test.error($q$select register_test.save_input(register_test.id(4,1),'2026-09','{"incentive":"NaN"}')$q$)),'"23514"');
select register_test.expect('inputs/reason required for overrides',
 to_jsonb(register_test.error($q$select register_test.save_input(register_test.id(4,1),'2026-08','{"pf":0}')$q$)),'"23514"');
select register_test.expect('inputs/foreign employee rejected',
 to_jsonb(register_test.error($q$select register_test.save_input(register_test.id(4,2),'2026-09','{}')$q$)),'"42501"');
select register_test.expect('inputs/bad month rejected',
 to_jsonb(register_test.error($q$select register_test.save_input(register_test.id(4,1),'2026-13','{}')$q$)),'"22023"');
select register_test.save_input(register_test.id(4,1),'2026-08','{"ot_hours":null,"late_hours":null}');
select register_test.expect('inputs/blank hours mean no approval',
 (select jsonb_build_array(ot_hours,late_hours) from public.payroll_monthly_inputs where employee_id=register_test.id(4,1) and period='2026-08'),'[0,0]');
select register_test.expect('readiness/OT exceeds record blocked',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"23514"');

reset role;
set request.jwt.claim.sub='';
update public.attendance set status='Absent',day_fraction=0,worked_minutes=0 where employee_id=register_test.id(4,1) and work_date='2026-09-02';
update public.attendance set status='Half Day',day_fraction=0.5,worked_minutes=240,late_minutes=60 where employee_id=register_test.id(4,1) and work_date='2026-09-03';
update public.attendance set ot_minutes=120,late_minutes=30,worked_minutes=600 where employee_id=register_test.id(4,1) and work_date='2026-09-04';
update public.attendance set status='Weekly Off',day_type='weekly_off',worked_minutes=0 where employee_id=register_test.id(4,1) and work_date='2026-09-06';
update public.attendance set status='Holiday',day_type='holiday',worked_minutes=0 where employee_id=register_test.id(4,1) and work_date='2026-09-07';
update public.attendance set status='On Leave',leave_type='CL',worked_minutes=0 where employee_id=register_test.id(4,1) and work_date='2026-09-08';
insert into public.pay_components(code,name,kind,calc_type,rate,amount,prorate_on_lop,employer_share,entity_id) values
 ('PF','Configured PF','deduction','percent_of_basic',10,null,true,false,register_test.id(1,1)),
 ('ESI','Configured ESI','deduction','fixed',null,100,false,false,register_test.id(1,1)),
 ('PF_EMPLOYER','Employer contribution','deduction','fixed',null,500,false,true,register_test.id(1,1)),
 ('CUSTOM','Configured other deduction','deduction','fixed',null,200,false,false,register_test.id(1,1));
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select public.run_payroll(register_test.id(1,1),'2026-09');
select register_test.expect('register/earnings deductions and employer reconcile',
 (select jsonb_build_array(gross,deductions,net,employer_cost,paid_days,lop_days) from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),
 '[32000,3412.5,28587.5,500,28.5,1.5]');
select register_test.expect('register/sheet calculation columns',
 (select jsonb_build_array(payroll_register->'salary',payroll_register->'days_per_month',payroll_register->'net_working_days',payroll_register->'public_holiday',
 payroll_register->'actual_working_days',payroll_register->'off_days',payroll_register->'casual_leave',payroll_register->'total_working_days',
 payroll_register->'per_day_wages',payroll_register->'per_day_working_hour',payroll_register->'total_working_hours',payroll_register->'per_hour_wages',
 payroll_register->'earned_salary',payroll_register->'ot_amount',payroll_register->'late_amount',payroll_register->'other_deductions')
 from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),
 '[30000,30,28,1,25.5,1,1,28.5,1000,8,206,125,28500,500,62.5,300]');
select register_test.expect('register/payslip earning lines equal gross',
 (select to_jsonb(sum(l.amount)) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=register_test.id(4,1) and p.period='2026-09' and l.kind='earning'),'32000');
select register_test.save_input(register_test.id(4,1),'2026-09','{"pf":0,"esi":75}');
select register_test.expect('inputs/changed draft publication rejected',
 to_jsonb(register_test.error($q$select register_test.publish((select id from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'))$q$)),'"55000"');
select public.run_payroll(register_test.id(1,1),'2026-09');
select register_test.expect('inputs/PF zero and ESI override replace catalog once',
 (select jsonb_build_array(payroll_register->'pf',payroll_register->'esi',deductions,net,employer_cost) from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),
 '[0,75,1487.5,30512.5,500]');
select register_test.save_input(register_test.id(4,1),'2026-09','{"late_hours":1.5}');
select register_test.expect('readiness/late double-count with half-day LOP blocked',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"23514"');
select register_test.save_input(register_test.id(4,1),'2026-09','{"late_hours":0.5,"other_deductions":99999}');
select register_test.expect('readiness/negative net blocked',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"23514"');
select register_test.save_input(register_test.id(4,1),'2026-09','{"other_deductions":100}');
select public.run_payroll(register_test.id(1,1),'2026-09');

-- Every failure leaves the last complete draft intact, but stale drafts cannot publish.
reset role;
set request.jwt.claim.sub='';
delete from public.attendance where employee_id=register_test.id(4,1) and work_date='2026-09-30';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select register_test.expect('sources/attendance mutation marks stale',
 (select to_jsonb(needs_recalculation) from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'),'true');
select register_test.expect('readiness/missing day blocks calculation',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"23514"');
select register_test.expect('readiness/failed recalculation preserves draft',
 (select to_jsonb(net) from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),'30512.5');
reset role;
set request.jwt.claim.sub='';
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,is_missing_punch,worked_minutes)
 values(register_test.id(4,1),'2026-09-30','Missing Punch',0.5,'working',true,0);
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select register_test.expect('readiness/missing punch blocks calculation',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"23514"');
reset role;
set request.jwt.claim.sub='';
update public.attendance set status='Present',day_fraction=1,is_missing_punch=false,worked_minutes=480 where employee_id=register_test.id(4,1) and work_date='2026-09-30';
insert into public.salary_structures(employee_id,effective_from,basic,gross) values(register_test.id(4,1),'2026-09-15',30000,40000);
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select register_test.expect('readiness/midmonth revision explicitly blocked',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"23514"');
reset role;
set request.jwt.claim.sub='';
delete from public.salary_structures where employee_id=register_test.id(4,1) and effective_from='2026-09-15';
insert into public.employees(id,entity_id,branch_id,employee_code,full_name,status,join_date)
 values(register_test.id(4,3),register_test.id(1,1),register_test.id(2,1),'REG-JOIN','New joiner','Active','2026-09-16');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select register_test.expect('readiness/missing salary not silently skipped',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"23514"');
reset role;
set request.jwt.claim.sub='';
insert into public.salary_structures(employee_id,effective_from,basic,gross) values(register_test.id(4,3),'2026-09-16',20000,30000);
-- A completed exit from an earlier employment must not silently exclude a rehire.
insert into public.exits(employee_id,last_day,status) values(register_test.id(4,3),'2026-08-15','Completed');
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes)
 select register_test.id(4,3),d::date,'Present',1,'working',480 from generate_series('2026-09-16'::date,'2026-09-30'::date,'1 day')d;
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select public.run_payroll(register_test.id(1,1),'2026-09');
select register_test.expect('employment/midmonth joiner only paid since joining',
 (select jsonb_build_array(gross,paid_days,payroll_register->'employment_from') from public.payslips where employee_id=register_test.id(4,3) and period='2026-09'),
 '[15000,15,"2026-09-16"]');
reset role;
set request.jwt.claim.sub='';
insert into public.employees(id,entity_id,branch_id,employee_code,full_name,status,join_date)
 values(register_test.id(4,4),register_test.id(1,1),register_test.id(2,1),'REG-EXIT','Historical leaver','Inactive','2026-01-01');
insert into public.exits(employee_id,last_day,status) values(register_test.id(4,4),'2026-09-15','Completed');
insert into public.salary_structures(employee_id,effective_from,basic,gross) values(register_test.id(4,4),'2026-01-01',20000,30000);
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes)
 select register_test.id(4,4),d::date,'Present',1,'working',480 from generate_series('2026-09-01'::date,'2026-09-15'::date,'1 day')d;
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select public.run_payroll(register_test.id(1,1),'2026-09');
select register_test.expect('employment/inactive leaver paid through final working date',
 (select jsonb_build_array(gross,paid_days,payroll_register->'employment_to') from public.payslips where employee_id=register_test.id(4,4) and period='2026-09'),
 '[15000,15,"2026-09-15"]');

-- Calendar, fixed and working divisors are explicit policies with unrounded intermediate rates.
select register_test.save_policy(register_test.id(1,1),'{"divisor_mode":"fixed","fixed_days":26}');
select public.run_payroll(register_test.id(1,1),'2026-09');
select register_test.expect('policy/fixed divisor subtracts unpaid days from agreed salary',
 (select payroll_register->'earned_salary' from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),'28269.23');
select register_test.save_policy(register_test.id(1,1),'{"divisor_mode":"working"}');
select register_test.expect('policy/working divisor needs joiner full calendar',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"23514"');
reset role;
set request.jwt.claim.sub='';
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type)
 select register_test.id(4,3),d::date,'Absent',0,'working' from generate_series('2026-09-01'::date,'2026-09-15'::date,'1 day')d;
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type)
 select register_test.id(4,4),d::date,'Absent',0,'working' from generate_series('2026-09-16'::date,'2026-09-30'::date,'1 day')d;
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select public.run_payroll(register_test.id(1,1),'2026-09');
select register_test.expect('policy/working divisor excludes calendar rest days',
 (select jsonb_build_array(payroll_register->'divisor_days',payroll_register->'earned_salary') from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),
 '[28,28392.86]');
select register_test.save_policy(register_test.id(1,1),'{"divisor_mode":"calendar"}');
select public.run_payroll(register_test.id(1,1),'2026-09');
select register_test.expect('security/direct API monetary update rejected',
 to_jsonb(register_test.error($q$update public.payslips set net=1 where employee_id=register_test.id(4,1)$q$)),'"42501"');
select register_test.expect('security/direct API policy update rejected',
 to_jsonb(register_test.error($q$update public.payroll_policies set deduct_late=false where entity_id=register_test.id(1,1)$q$)),'"42501"');
select register_test.expect('security/direct API run publication rejected',
 to_jsonb(register_test.error($q$update public.payroll_runs set status='Published' where entity_id=register_test.id(1,1)$q$)),'"42501"');
reset role;
set request.jwt.claim.sub='';
update public.payslips set payroll_register=jsonb_set(payroll_register,'{net_pay_salary}','1')
 where employee_id=register_test.id(4,1) and period='2026-09';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select register_test.expect('publication/register totals must match statement',
 to_jsonb(register_test.error($q$select register_test.publish((select id from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'))$q$)),'"23514"');
reset role;
set request.jwt.claim.sub='';
update public.payslips set payroll_register=jsonb_set(payroll_register,'{net_pay_salary}',to_jsonb(net))
 where employee_id=register_test.id(4,1) and period='2026-09';
update public.payroll_runs set total_net=total_net+1 where entity_id=register_test.id(1,1) and period='2026-09';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select register_test.expect('publication/run totals must match employee statements',
 to_jsonb(register_test.error($q$select register_test.publish((select id from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'))$q$)),'"23514"');
select public.run_payroll(register_test.id(1,1),'2026-09');
select set_config('request.jwt.claim.sub',register_test.id(3,2)::text,false);
select register_test.expect('security/employee cannot read inputs',(select to_jsonb(count(*)) from public.payroll_monthly_inputs),'0');
select register_test.expect('security/employee cannot configure payroll',
 to_jsonb(register_test.error($q$select register_test.save_policy(register_test.id(1,1),'{}')$q$)),'"42501"');
select register_test.expect('security/employee cannot read draft register',
 (select to_jsonb(count(*)) from public.payslips where employee_id=register_test.id(4,1)),'0');
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select register_test.publish((select id from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'));
select register_test.publish((select id from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'));
select register_test.expect('lifecycle/published inputs frozen',
 to_jsonb(register_test.error($q$select register_test.save_input(register_test.id(4,1),'2026-09','{"incentive":1}')$q$)),'"55000"');
select register_test.expect('lifecycle/published regeneration rejected',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-09')$q$)),'"55000"');
select set_config('request.jwt.claim.sub',register_test.id(3,2)::text,false);
select register_test.expect('lifecycle/employee sees immutable published register',
 (select jsonb_build_array(status,payroll_register->'employee_name',payroll_register->'net_pay_salary') from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),
 '["Published","Register employee",30512.5]');
reset role;
set request.jwt.claim.sub='';
select register_test.expect('lifecycle/attendance locked for every paid employment interval',
 (select to_jsonb(count(*)) from public.attendance where employee_id in(register_test.id(4,1),register_test.id(4,3),register_test.id(4,4)) and is_locked),'60');
select register_test.expect('lifecycle/owner published money update rejected',
 to_jsonb(register_test.error($q$update public.payslips set net=1 where employee_id=register_test.id(4,1)$q$)),'"55000"');
select register_test.expect('lifecycle/owner published lines delete rejected',
 to_jsonb(register_test.error($q$delete from public.payslip_lines where payslip_id in(select id from public.payslips where employee_id=register_test.id(4,1))$q$)),'"55000"');
select register_test.expect('lifecycle/owner published status reset rejected',
 to_jsonb(register_test.error($q$update public.payroll_runs set status='Draft' where entity_id=register_test.id(1,1)$q$)),'"55000"');
select register_test.expect('lifecycle/locked attendance update rejected',
 to_jsonb(register_test.error($q$update public.attendance set day_fraction=0 where employee_id=register_test.id(4,1) and work_date='2026-09-01'$q$)),'"55000"');
select register_test.expect('lifecycle/locked attendance delete rejected',
 to_jsonb(register_test.error($q$delete from public.attendance where employee_id=register_test.id(4,1) and work_date='2026-09-01'$q$)),'"55000"');
select register_test.expect('lifecycle/service input insertion into published month rejected',
 to_jsonb(register_test.error($q$insert into public.payroll_monthly_inputs(employee_id,period,entity_id) values(register_test.id(4,3),'2026-09',register_test.id(1,1))$q$)),'"55000"');
select register_test.expect('security/anonymous payroll RPCs closed',
 to_jsonb(has_function_privilege('anon','public.save_payroll_policy(uuid,jsonb,timestamptz)','execute') or has_function_privilege('anon','public.save_payroll_monthly_input(uuid,text,jsonb,timestamptz)','execute')),'false');
select register_test.expect('audit/input saves logged without compensation payload',
 to_jsonb(exists(select 1 from public.audit_log where actor=register_test.id(3,1) and row_id=register_test.id(4,1) and action='INPUTS_SAVED:2026-09')),'true');
set role authenticated;
set request.jwt.claim.sub='';
select register_test.expect('security/authenticated role still requires actor for generation',
 to_jsonb(register_test.error($q$select public.run_payroll(register_test.id(1,1),'2026-11')$q$)),'"42501"');
select register_test.expect('security/authenticated role still requires actor for publication',
 to_jsonb(register_test.error($q$select register_test.publish((select id from public.payroll_runs limit 1))$q$)),'"42501"');
reset role;
select 'PASS: payroll salary register '||count(*)||' assertions; policy, approvals, exact register arithmetic, readiness, proration, publication and immutable evidence' from register_test.results;
