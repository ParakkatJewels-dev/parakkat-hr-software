-- Synthetic acceptance fixtures only. Never run this against a hosted database.
\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'hr_payroll_integrity_audit' then raise exception 'Disposable payroll integrity database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub='';
create schema hourly_test;
create table hourly_test.results(label text primary key);
create function hourly_test.expect(label text,actual jsonb,expected jsonb) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception '%: expected %, got %',label,expected,actual; end if;
  insert into hourly_test.results values(label);
end $$;
create function hourly_test.error(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
create function hourly_test.save(_employee integer,_period text,_input jsonb) returns jsonb language sql as $$
  select register_test.save_input(register_test.id(4,_employee),_period,_input);
$$;
create function hourly_test.policy(_entity integer,_policy jsonb) returns jsonb language sql as $$
  select register_test.save_policy(register_test.id(1,_entity),_policy);
$$;
create function hourly_test.run_id(_entity integer,_period text) returns uuid language sql stable as $$
  select id from public.payroll_runs where entity_id=register_test.id(1,_entity) and period=_period;
$$;
create function hourly_test.summary(_entity integer,_employee integer,_period text) returns jsonb language sql as $$
  select value from jsonb_array_elements(public.get_payroll_attendance_summary(register_test.id(1,_entity),_period))
  where value->>'employee_id'=register_test.id(4,_employee)::text;
$$;
create function hourly_test.money(_employee integer,_period text) returns jsonb language sql stable as $$
  select jsonb_build_array(gross,deductions,net) from public.payslips where employee_id=register_test.id(4,_employee) and period=_period;
$$;
grant usage on schema hourly_test to authenticated,anon;
grant execute on all functions in schema hourly_test to authenticated,anon;
grant select,insert on hourly_test.results to authenticated,anon;

select hourly_test.expect('upgrade/published historical money and register are preserved',
 (select jsonb_build_array(status,net,payroll_register->'schema_version') from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),
 '["Published",30512.5,1]');
select hourly_test.expect('upgrade/previous policy keeps paid day calculation',
 (select jsonb_build_array(calculation_mode,credit_mode) from public.payroll_policies where entity_id=register_test.id(1,1)),
 '["paid_days","attendance"]');
select hourly_test.expect('credits/other paid leave remains paid in earned-credit mode',
 (select jsonb_build_array(h->'actual_working_days',h->'other_paid_leave_days',h->'casual_leave',h->'credited_hours',h->'earned_salary')
 from (select app.payroll_hourly_workings(12000,30,8.5,'earned','{}',
 '{"worked_hours":187,"working":25,"lop":0.5,"paid_leave":1,"casual_leave":0,"holidays":1,"offs":4}')h)x),
 '[23.5,1,1,59.5,11610.15]');
select hourly_test.expect('credits/recorded casual leave is not credited again as other paid leave',
 (select jsonb_build_array(h->'other_paid_leave_days',h->'casual_leave',h->'credited_hours')
 from (select app.payroll_hourly_workings(12000,30,8.5,'earned','{}',
 '{"worked_hours":187,"working":25,"lop":0.5,"paid_leave":1,"casual_leave":1,"holidays":1,"offs":4}')h)x),
 '[0,1,51]');
insert into public.entities(id,code,name) select register_test.id(1,n),'HOURLY-E'||n,'Hourly acceptance company '||n from generate_series(201,205)n;
insert into public.branches(id,entity_id,code,name) select register_test.id(2,n),register_test.id(1,n),'HOURLY-B'||n,'Hourly acceptance branch '||n from generate_series(201,205)n;
insert into auth.users(id,email) select register_test.id(3,n),'hourly-'||n||'@audit.invalid' from generate_series(201,204)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name,status,join_date) values
 (register_test.id(4,201),register_test.id(1,201),register_test.id(2,201),register_test.id(3,202),'HOURLY-REVIEW','Reviewed salary fixture','Active','2029-01-01'),
 (register_test.id(4,202),register_test.id(1,202),register_test.id(2,202),null,'HOURLY-LEGACY','Paid days compatibility','Active','2029-01-01'),
 (register_test.id(4,203),register_test.id(1,203),register_test.id(2,203),null,'HOURLY-JOIN','Hourly joiner','Active','2029-09-16'),
 (register_test.id(4,204),register_test.id(1,203),register_test.id(2,203),null,'HOURLY-LEAVE','Hourly leaver','Inactive','2029-01-01'),
 (register_test.id(4,205),register_test.id(1,204),register_test.id(2,204),null,'HOURLY-RECORDED','Recorded salary fixture','Active','2029-01-01'),
 (register_test.id(4,206),register_test.id(1,205),register_test.id(2,205),null,'HOURLY-MONTHS','Calendar divisor fixture','Active','2029-01-01');
update public.profiles set employee_id=register_test.id(4,201) where user_id=register_test.id(3,202);
insert into public.exits(employee_id,last_day,status) values(register_test.id(4,204),'2029-09-15','Completed');
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
 select register_test.id(3,201),(select id from public.roles where key='hr_manager'),'entity',register_test.id(1,n) from generate_series(201,205)n;
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
 (register_test.id(3,202),(select id from public.roles where key='employee'),'self',null),
 (register_test.id(3,203),(select id from public.roles where key='hr_manager'),'branch',register_test.id(2,201)),
 (register_test.id(3,204),(select id from public.roles where key='hr_manager'),'branch',register_test.id(2,202));
-- Explicit per-company daily basis for the reviewed HR worksheet fixtures.
update public.shifts set is_default=false where entity_id in (select register_test.id(1,n) from generate_series(201,205)n);
insert into public.shifts(entity_id,code,name,start_time,end_time,break_minutes,break_policy,full_day_minutes,half_day_minutes,is_default)
 select register_test.id(1,n),'HR-85-'||n,'HR eight and half hours','09:00','17:30',0,'fixed',510,255,true from generate_series(201,205)n;
insert into public.salary_structures(employee_id,effective_from,basic,gross) values
 (register_test.id(4,201),'2029-01-01',12000,12000),
 (register_test.id(4,202),'2029-01-01',20000,30000),
 (register_test.id(4,203),'2029-09-16',20000,30000),
 (register_test.id(4,204),'2029-01-01',20000,30000),
 (register_test.id(4,205),'2029-01-01',12000,12000),
 (register_test.id(4,206),'2029-01-01',20000,30000);
insert into public.pay_components(code,name,kind,calc_type,amount,prorate_on_lop,employer_share,entity_id)
 values('TDS','Configured synthetic TDS','deduction','fixed',250,false,false,register_test.id(1,201));
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes,computed_at)
 select register_test.id(4,202),d::date,'Present',1,'working',480,clock_timestamp()
 from generate_series('2029-09-01'::date,'2029-10-31'::date,'1 day')d;
update public.attendance set worked_minutes=600,ot_minutes=120,late_minutes=30
 where employee_id=register_test.id(4,202) and work_date='2029-09-01';
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes,computed_at)
 select register_test.id(4,205),d::date,'Present',1,'working',480,clock_timestamp()
 from generate_series('2029-09-01'::date,'2029-09-30'::date,'1 day')d;
update public.attendance set worked_minutes=405 where employee_id=register_test.id(4,205) and work_date='2029-09-23';
update public.attendance set status='Half Day',day_fraction=0.5,worked_minutes=255 where employee_id=register_test.id(4,205) and work_date='2029-09-24';
update public.attendance set status='Holiday',day_type='holiday',worked_minutes=0 where employee_id=register_test.id(4,205) and work_date='2029-09-25';
update public.attendance set status='Weekly Off',day_type='weekly_off',worked_minutes=0 where employee_id=register_test.id(4,205) and work_date between '2029-09-26' and '2029-09-29';
update public.attendance set status='Absent',day_fraction=0,worked_minutes=0 where employee_id=register_test.id(4,205) and work_date='2029-09-30';
update public.attendance set ot_minutes=120,late_minutes=30 where employee_id=register_test.id(4,205) and work_date='2029-09-01';

set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.policy(201,'{"calculation_mode":"hourly_workings","credit_mode":"earned","hours_per_day":8.5}');
select hourly_test.policy(202,'{"deduct_late":true}');
select hourly_test.policy(203,'{"calculation_mode":"hourly_workings","credit_mode":"earned","hours_per_day":8.5}');
select hourly_test.policy(204,'{"calculation_mode":"hourly_workings","credit_mode":"earned","hours_per_day":8.5}');
select hourly_test.policy(205,'{"calculation_mode":"hourly_workings","credit_mode":"earned","hours_per_day":8.5}');
select hourly_test.expect('policy/hourly mode accepts calendar and decimal daily hours',
 (select jsonb_build_array(calculation_mode,credit_mode,hours_per_day) from public.payroll_policies where entity_id=register_test.id(1,201)),
 '["hourly_workings","earned",8.5]');
select hourly_test.expect('policy/unknown calculation mode rejected',to_jsonb(hourly_test.error($q$select hourly_test.policy(201,'{"calculation_mode":"approximate"}')$q$)),'"23514"');
select hourly_test.expect('policy/unknown credit mode rejected',to_jsonb(hourly_test.error($q$select hourly_test.policy(201,'{"credit_mode":"all"}')$q$)),'"23514"');
select hourly_test.expect('policy/hourly working-day divisor rejected',to_jsonb(hourly_test.error($q$select hourly_test.policy(201,'{"divisor_mode":"working"}')$q$)),'"23514"');
select hourly_test.expect('review/no evidence cannot calculate unreviewed employee',
 to_jsonb(hourly_test.error($q$select public.run_payroll(register_test.id(1,201),'2029-09')$q$)),'"23514"');
select hourly_test.expect('review/missing hours cannot silently become zero',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"attendance_source":"reviewed","actual_working_days":23.5,"public_holiday_days":1,"notes":"Reviewed HR register"}')$q$)),'"23514"');
select hourly_test.expect('review/missing holiday total is distinct from reviewed zero',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"attendance_source":"reviewed","worked_minutes":11220,"actual_working_days":23.5,"notes":"Reviewed HR register"}')$q$)),'"23514"');
select hourly_test.expect('review/missing actual days cannot silently become zero',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"attendance_source":"reviewed","worked_minutes":11220,"public_holiday_days":1,"notes":"Reviewed HR register"}')$q$)),'"23514"');
select hourly_test.expect('review/manual total requires reason',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"attendance_source":"reviewed","worked_minutes":11220,"actual_working_days":23.5,"public_holiday_days":1}')$q$)),'"23514"');
select hourly_test.expect('review/negative worked minutes rejected',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"attendance_source":"reviewed","worked_minutes":-1,"actual_working_days":23.5,"public_holiday_days":1,"notes":"Reviewed HR register"}')$q$)),'"23514"');
select hourly_test.expect('review/fractional minutes rejected',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"attendance_source":"reviewed","worked_minutes":11220.5,"actual_working_days":23.5,"public_holiday_days":1,"notes":"Reviewed HR register"}')$q$)),'"23514"');
select hourly_test.expect('review/impossible monthly hours rejected',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"attendance_source":"reviewed","worked_minutes":43201,"actual_working_days":23.5,"public_holiday_days":1,"notes":"Reviewed HR register"}')$q$)),'"23514"');
select hourly_test.expect('review/recorded source forbids manual worked total',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"worked_minutes":11220,"notes":"Cannot rewrite source"}')$q$)),'"23514"');
select hourly_test.expect('review/recorded source forbids manual actual days',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"actual_working_days":23.5,"notes":"Cannot rewrite source"}')$q$)),'"23514"');
select hourly_test.expect('review/paid-days mode forbids reviewed attendance',
 to_jsonb(hourly_test.error($q$select hourly_test.save(202,'2029-09','{"attendance_source":"reviewed","worked_minutes":11220,"actual_working_days":23.5,"public_holiday_days":1,"notes":"Reviewed HR register"}')$q$)),'"23514"');
select hourly_test.expect('inputs/positive TDS requires reason',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"tds":100}')$q$)),'"23514"');
select hourly_test.expect('inputs/explicit zero TDS also requires an approval reason',
 to_jsonb(hourly_test.error($q$select hourly_test.save(202,'2029-09','{"tds":0}')$q$)),'"23514"');
select hourly_test.save(201,'2029-09','{"attendance_source":"reviewed","worked_minutes":11220,"actual_working_days":23.5,"public_holiday_days":1,"pf":1370,"esi":86,"welfare_fund":50,"notes":"Reviewed signed monthly register; employee has no device enrollment"}');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('tax/unset TDS uses configured tax without inventing an approval',hourly_test.money(201,'2029-09'),'[11210,1756,9454]');
select hourly_test.expect('tax/new omitted TDS is stored as null',
 (select to_jsonb(tds is null) from public.payroll_monthly_inputs where employee_id=register_test.id(4,201) and period='2029-09'),'true');
select hourly_test.save(201,'2029-09','{"tds":0}');
select hourly_test.expect('review/non-device employee explicitly ready with missing records still visible',
 (select jsonb_build_array(s->'reviewed_source_ready',s->'missing_days',s->'recorded_missing_days') from (select hourly_test.summary(201,201,'2029-09')s)x), '[true,0,30]');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('acceptance/HR sample uses correct eight-and-half-hour arithmetic',hourly_test.money(201,'2029-09'),'[11210,1506,9704]');
select hourly_test.expect('tax/approved zero suppresses configured tax and retains zero in input',
 (select jsonb_build_array(p.payroll_register->'tds',i.tds) from public.payslips p join public.payroll_monthly_inputs i on i.employee_id=p.employee_id and i.period=p.period
 where p.employee_id=register_test.id(4,201) and p.period='2029-09'),'[0,0]');
select hourly_test.save(201,'2029-09','{"tds":null}');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('tax/null reset restores configured TDS once',hourly_test.money(201,'2029-09'),'[11210,1756,9454]');
select hourly_test.expect('tax/catalog result is numeric but input reset stays null',
 (select jsonb_build_array(p.payroll_register->'tds',i.tds) from public.payslips p join public.payroll_monthly_inputs i on i.employee_id=p.employee_id and i.period=p.period
 where p.employee_id=register_test.id(4,201) and p.period='2029-09'),'[250,null]');
select hourly_test.save(201,'2029-09','{"tds":0}');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('tax/reapproved zero clears catalog tax without changing base wages',hourly_test.money(201,'2029-09'),'[11210,1506,9704]');
select hourly_test.expect('acceptance/hourly sample trace explains every conversion and credit',
 (select jsonb_build_array(payroll_register->'schema_version',payroll_register->'calculation_mode',payroll_register->'attendance_source',
 payroll_register->'worked_minutes',payroll_register->'actual_working_days',payroll_register->'public_holiday',payroll_register->'off_days',payroll_register->'casual_leave',
 payroll_register->'per_day_wages',payroll_register->'per_hour_wages',payroll_register->'credited_hours',payroll_register->'payable_hours')
 from public.payslips where employee_id=register_test.id(4,201) and period='2029-09'),
 '[4,"hourly_workings","reviewed",11220,23.5,1,4,1,400,47.1,51,238]');
select hourly_test.expect('acceptance/review reason remains on frozen register',
 (select to_jsonb(payroll_register->>'attendance_review_reason' like 'Reviewed signed monthly register%') from public.payslips where employee_id=register_test.id(4,201) and period='2029-09'),'true');
select hourly_test.expect('inputs/hourly OT cannot be added twice',to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"ot_hours":1}')$q$)),'"23514"');
select hourly_test.expect('inputs/hourly shortfall cannot receive extra late charge',to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"late_hours":1}')$q$)),'"23514"');
select hourly_test.expect('inputs/negative TDS rejected',to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"tds":-1}')$q$)),'"23514"');
select hourly_test.expect('inputs/nonfinite TDS rejected',to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"tds":"NaN"}')$q$)),'"23514"');

-- Explicit zero and null reset must remain different for earned paid-day credits.
select hourly_test.save(201,'2029-09','{"off_days":0,"casual_leave_days":0}');
select hourly_test.expect('sources/credit edit invalidates existing draft',
 (select to_jsonb(needs_recalculation) from public.payroll_runs where id=hourly_test.run_id(201,'2029-09')),'true');
select hourly_test.expect('sources/stale reviewed draft cannot publish',
 to_jsonb(hourly_test.error($q$select register_test.publish(hourly_test.run_id(201,'2029-09'))$q$)),'"55000"');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('credits/zero override is respected',
 (select jsonb_build_array(payroll_register->'off_days',payroll_register->'casual_leave',gross,net) from public.payslips where employee_id=register_test.id(4,201) and period='2029-09'), '[0,0,9209,7703]');
select hourly_test.save(201,'2029-09','{"off_days":null,"casual_leave_days":null}');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('credits/null restores earned thresholds',hourly_test.money(201,'2029-09'),'[11210,1506,9704]');
select hourly_test.policy(201,'{"credit_mode":"attendance"}');
select hourly_test.expect('credits/reviewed attendance-credit mode requires complete explicit credits',
 hourly_test.summary(201,201,'2029-09')->'reviewed_source_ready','false');
select hourly_test.expect('credits/missing reviewed casual-day total cannot silently become zero',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"off_days":0}')$q$)),'"23514"');
select hourly_test.expect('credits/incomplete reviewed credits also block calculation after policy change',
 to_jsonb(hourly_test.error($q$select public.run_payroll(register_test.id(1,201),'2029-09')$q$)),'"23514"');
select hourly_test.save(201,'2029-09','{"off_days":0,"casual_leave_days":0}');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('credits/explicit zero reviewed attendance credits are accepted',hourly_test.money(201,'2029-09'),'[9209,1506,7703]');
select hourly_test.expect('credits/clearing required attendance credits is rejected atomically',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"off_days":null,"casual_leave_days":null}')$q$)),'"23514"');
select hourly_test.policy(201,'{"credit_mode":"earned"}');
select hourly_test.save(201,'2029-09','{"off_days":null,"casual_leave_days":null}');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('credits/earned mode still derives omitted reviewed credits',hourly_test.money(201,'2029-09'),'[11210,1506,9704]');
select hourly_test.save(201,'2029-09','{"tds":123.15,"other_deductions":0.1}');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('rounding/positive net roundoff reconciles without reducing gross',hourly_test.money(201,'2029-09'),'[11210,1629,9581]');
select hourly_test.expect('rounding/positive net roundoff has negative deduction line',
 (select to_jsonb(l.amount) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=register_test.id(4,201) and p.period='2029-09' and l.code='NET_ROUNDOFF'), '-0.25');
select hourly_test.save(201,'2029-09','{"tds":123.45}');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('rounding/negative net roundoff is retained as a deduction',hourly_test.money(201,'2029-09'),'[11210,1630,9580]');
select hourly_test.expect('rounding/salary TDS and net rounding remain itemized',
 (select jsonb_build_array(payroll_register->'tds',payroll_register->'wages_roundoff',payroll_register->'net_roundoff') from public.payslips where employee_id=register_test.id(4,201) and period='2029-09'), '[123.45,0.2,-0.45]');
select hourly_test.expect('rounding/earning and deduction line sums match whole-rupee totals',
 (select jsonb_build_array(sum(l.amount) filter(where l.kind='earning'),sum(l.amount) filter(where l.kind='deduction')) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=register_test.id(4,201) and p.period='2029-09'), '[11210,1630]');
select hourly_test.save(201,'2029-09','{"other_deductions":99999}');
select hourly_test.expect('readiness/deductions exceeding hourly earnings rejected',
 to_jsonb(hourly_test.error($q$select public.run_payroll(register_test.id(1,201),'2029-09')$q$)),'"23514"');
select hourly_test.expect('readiness/failed calculation preserves prior complete draft',hourly_test.money(201,'2029-09'),'[11210,1630,9580]');
select hourly_test.save(201,'2029-09','{"other_deductions":0.1}');

-- Preserve one salary payment when bonus, incentive and advance ledger entries join the calculation.
select public.save_payroll_adjustment(register_test.id(4,201),'2029-09','{"kind":"bonus","amount":1000.25,"reason":"Annual bonus"}',register_test.id(7,201));
select public.save_payroll_adjustment(register_test.id(4,201),'2029-09','{"kind":"incentive","amount":250.25,"reason":"Sales incentive"}',register_test.id(7,202));
select public.create_payroll_advance(register_test.id(4,201),'2029-08-01',1000,'Documented salary advance',register_test.id(8,201));
select public.save_payroll_advance_recovery((select id from public.payroll_advances where request_id=register_test.id(8,201)),'2029-09',300.25,null);
select public.run_payroll(register_test.id(1,201),'2029-09');
select public.run_payroll(register_test.id(1,201),'2029-09');
select hourly_test.expect('transactions/bonus incentive and scheduled recovery appear exactly once',hourly_test.money(201,'2029-09'),'[12461,1930,10531]');
select hourly_test.expect('transactions/ledger components remain traceable',
 (select jsonb_build_array(payroll_register->'bonus',payroll_register->'adjustment_incentive',payroll_register->'ledger_advance_recovery') from public.payslips where employee_id=register_test.id(4,201) and period='2029-09'), '[1000.25,250.25,300.25]');

-- Review bypass belongs only to the employee and explicit source; recorded data stays guarded.
select hourly_test.save(205,'2029-09','{"pf":1370,"esi":86,"welfare_fund":50,"notes":"Verified deductions"}');
select public.run_payroll(register_test.id(1,204),'2029-09');
select hourly_test.expect('recorded/complete attendance yields the same hourly sample',hourly_test.money(205,'2029-09'),'[11210,1506,9704]');
select hourly_test.expect('recorded/automatic OT and late are not added on top of worked hours',
 (select jsonb_build_array(payroll_register->'ot_amount',payroll_register->'late_amount',payroll_register->'attendance_source') from public.payslips where employee_id=register_test.id(4,205) and period='2029-09'), '[0,0,"recorded"]');
select hourly_test.policy(204,'{"credit_mode":"attendance"}');
select public.run_payroll(register_test.id(1,204),'2029-09');
select hourly_test.expect('credits/attendance mode uses recorded leave instead of earned casual credit',hourly_test.money(205,'2029-09'),'[10810,1506,9304]');
select hourly_test.policy(204,'{"credit_mode":"earned"}');
select hourly_test.save(205,'2029-09','{"off_days":0,"casual_leave_days":0}');
select public.run_payroll(register_test.id(1,204),'2029-09');
select hourly_test.expect('credits/recorded source accepts reviewed zero day-credit overrides',hourly_test.money(205,'2029-09'),'[9209,1506,7703]');
select hourly_test.save(205,'2029-09','{"off_days":null,"casual_leave_days":null}');
select public.run_payroll(register_test.id(1,204),'2029-09');
select hourly_test.expect('credits/recorded null reset restores earned day-credit rules',hourly_test.money(205,'2029-09'),'[11210,1506,9704]');
reset role;
set request.jwt.claim.sub='';
update public.attendance set is_missing_punch=true where employee_id=register_test.id(4,205) and work_date='2029-09-01';
select public.enqueue_recompute(register_test.id(4,205),'2029-09-01','2029-09-01','New device evidence');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.expect('recorded/unresolved punches still block hourly payroll',
 to_jsonb(hourly_test.error($q$select public.run_payroll(register_test.id(1,204),'2029-09')$q$)),'"23514"');
select hourly_test.save(205,'2029-09','{"attendance_source":"reviewed","worked_minutes":11220,"actual_working_days":23.5,"public_holiday_days":1,"notes":"Signed manual register reviewed while device corrections are pending"}');
select public.run_payroll(register_test.id(1,204),'2029-09');
select hourly_test.expect('review/explicit reviewed source can proceed with pending device issues',hourly_test.money(205,'2029-09'),'[11210,1506,9704]');
select hourly_test.expect('review/source reset cannot leave sticky reviewed totals on recorded mode',
 to_jsonb(hourly_test.error($q$select hourly_test.save(205,'2029-09','{"attendance_source":"recorded"}')$q$)),'"23514"');
select hourly_test.expect('review/rejected source reset retains complete approved evidence',
 (select jsonb_build_array(attendance_source,worked_minutes,actual_working_days,public_holiday_days) from public.payroll_monthly_inputs where employee_id=register_test.id(4,205) and period='2029-09'), '["reviewed",11220,23.5,1]');
select hourly_test.save(205,'2029-09','{"attendance_source":"recorded","worked_minutes":null,"actual_working_days":null,"public_holiday_days":null}');
select hourly_test.expect('review/resetting source restores evidence guard',
 to_jsonb(hourly_test.error($q$select public.run_payroll(register_test.id(1,204),'2029-09')$q$)),'"23514"');

-- Employment windows constrain manual totals without changing a full monthly rate.
select hourly_test.expect('employment/joiner cannot claim more days than employment window',
 to_jsonb(hourly_test.error($q$select hourly_test.save(203,'2029-09','{"attendance_source":"reviewed","worked_minutes":5100,"actual_working_days":16,"public_holiday_days":0,"notes":"Reviewed joiner"}')$q$)),'"23514"');
select hourly_test.expect('employment/leaver cannot claim more minutes than employment window',
 to_jsonb(hourly_test.error($q$select hourly_test.save(204,'2029-09','{"attendance_source":"reviewed","worked_minutes":21601,"actual_working_days":12,"public_holiday_days":0,"notes":"Reviewed leaver"}')$q$)),'"23514"');
select hourly_test.save(203,'2029-09','{"attendance_source":"reviewed","worked_minutes":5100,"actual_working_days":10,"public_holiday_days":0,"notes":"Reviewed joiner since 16 September"}');
select hourly_test.save(204,'2029-09','{"attendance_source":"reviewed","worked_minutes":6120,"actual_working_days":12,"public_holiday_days":0,"notes":"Reviewed leaver through 15 September"}');
select public.run_payroll(register_test.id(1,203),'2029-09');
select hourly_test.expect('employment/joiner uses full monthly rate and only reviewed hours',hourly_test.money(203,'2029-09'),'[10996,0,10996]');
select hourly_test.expect('employment/leaver earns threshold off-day credit',hourly_test.money(204,'2029-09'),'[13995,0,13995]');
select hourly_test.expect('employment/window snapshots remain explicit',
 (select jsonb_agg(jsonb_build_array(payroll_register->'employment_from',payroll_register->'employment_to') order by employee_id) from public.payslips where run_id=hourly_test.run_id(203,'2029-09')), '[["2029-09-16","2029-09-30"],["2029-09-01","2029-09-15"]]');
select hourly_test.expect('bulk/invalid reviewed row rolls back earlier valid employee update',
 to_jsonb(hourly_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,203),'2029-09',jsonb_build_array(
 jsonb_build_object('employee_id',register_test.id(4,203),'input','{"worked_minutes":5101}'::jsonb,'expected_updated_at',
 (select updated_at from public.payroll_monthly_inputs where employee_id=register_test.id(4,203) and period='2029-09')),
 jsonb_build_object('employee_id',register_test.id(4,204),'input','{"worked_minutes":-1}'::jsonb,'expected_updated_at',
 (select updated_at from public.payroll_monthly_inputs where employee_id=register_test.id(4,204) and period='2029-09'))))$q$)),'"23514"');
select hourly_test.expect('bulk/failed review save preserves both employees totals',
 (select jsonb_agg(worked_minutes order by employee_id) from public.payroll_monthly_inputs where employee_id in (register_test.id(4,203),register_test.id(4,204)) and period='2029-09'),'[5100,6120]');

-- Same reviewed work in a 28-day month explicitly distinguishes calendar from fixed divisor.
select hourly_test.save(206,'2029-02','{"attendance_source":"reviewed","worked_minutes":10200,"actual_working_days":20,"public_holiday_days":0,"notes":"Reviewed February monthly totals"}');
select public.run_payroll(register_test.id(1,205),'2029-02');
select hourly_test.expect('divisor/calendar February rounds daily rate before hourly rate',
 (select jsonb_build_array(payroll_register->'divisor_days',payroll_register->'per_day_wages',payroll_register->'per_hour_wages',gross) from public.payslips where employee_id=register_test.id(4,206) and period='2029-02'), '[28,1072,126.1,25725]');
select hourly_test.policy(205,'{"divisor_mode":"fixed","fixed_days":30}');
select hourly_test.expect('sources/divisor change makes calculated month stale',
 (select to_jsonb(needs_recalculation) from public.payroll_runs where id=hourly_test.run_id(205,'2029-02')),'true');
select public.run_payroll(register_test.id(1,205),'2029-02');
select hourly_test.expect('divisor/fixed thirty-day month remains explicit',
 (select jsonb_build_array(payroll_register->'divisor_days',payroll_register->'per_day_wages',payroll_register->'per_hour_wages',gross) from public.payslips where employee_id=register_test.id(4,206) and period='2029-02'), '[30,1000,117.6,23991]');
select hourly_test.save(206,'2029-02','{"actual_working_days":19.5}');
select public.run_payroll(register_test.id(1,205),'2029-02');
select hourly_test.expect('credits/casual leave threshold does not round nineteen-and-half up',
 (select jsonb_build_array(payroll_register->'off_days',payroll_register->'casual_leave') from public.payslips where employee_id=register_test.id(4,206) and period='2029-02'), '[3,0]');
select hourly_test.save(206,'2029-02','{"actual_working_days":28,"off_days":null,"casual_leave_days":null}');
select public.run_payroll(register_test.id(1,205),'2029-02');
select hourly_test.expect('credits/earned weekly credit is capped at four without capping total days',
 (select jsonb_build_array(payroll_register->'off_days',payroll_register->'casual_leave',payroll_register->'total_working_days') from public.payslips where employee_id=register_test.id(4,206) and period='2029-02'), '[4,1,33]');

-- Preserve sub-cent hourly precision until the final whole-rupee ceiling. With this
-- independently derived example, rounding 7201/60*60.2 to cents first loses one rupee.
reset role;
set request.jwt.claim.sub='';
insert into public.salary_structures(employee_id,effective_from,basic,gross)
 values(register_test.id(4,206),'2029-10-01',10000,15360);
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.save(206,'2029-10','{"attendance_source":"reviewed","worked_minutes":7201,"actual_working_days":14,"public_holiday_days":0,"off_days":0,"casual_leave_days":0,"notes":"Reviewed minute-precision fixture"}');
select public.run_payroll(register_test.id(1,205),'2029-10');
select hourly_test.expect('rounding/raw fractional cent is not discarded before ceiling',hourly_test.money(206,'2029-10'),'[7226,0,7226]');
select hourly_test.expect('rounding/fractional-cent ceiling is fully reconciled in earning lines',
 (select jsonb_build_array(sum(l.amount) filter(where l.kind='earning'),max((p.payroll_register->>'wages_roundoff')::numeric))
 from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=register_test.id(4,206) and p.period='2029-10'), '[7226,1]');

-- Build an internally consistent draft using the wrong divisor, then restore the real
-- policy and source fingerprint. A forged snapshot must not choose its own divisor.
select hourly_test.policy(205,'{"fixed_days":31}');
select public.run_payroll(register_test.id(1,205),'2029-10');
select hourly_test.policy(205,'{"fixed_days":30}');
reset role;
set request.jwt.claim.sub='';
update public.payslips set payroll_register=jsonb_set(payroll_register,'{policy}',
 (select to_jsonb(p) from public.payroll_policies p where entity_id=register_test.id(1,205)))
 where employee_id=register_test.id(4,206) and period='2029-10';
update public.payroll_runs set needs_recalculation=false,source_fingerprint=app.payroll_source_fingerprint(entity_id,period)
 where id=hourly_test.run_id(205,'2029-10');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.expect('publication/coherent forged divisor cannot override real company policy',
 to_jsonb(hourly_test.error($q$select register_test.publish(hourly_test.run_id(205,'2029-10'))$q$)),'"23514"');
select public.run_payroll(register_test.id(1,205),'2029-10');
select hourly_test.expect('publication/recalculation restores trusted fixed-day divisor',hourly_test.money(206,'2029-10'),'[7226,0,7226]');
reset role;
set request.jwt.claim.sub='';
insert into public.salary_structures(employee_id,effective_from,basic,gross)
 values(register_test.id(4,206),'2029-11-01',0,0);
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.save(206,'2029-11','{"attendance_source":"reviewed","worked_minutes":5100,"actual_working_days":10,"public_holiday_days":0,"notes":"Reviewed zero-salary fixture"}');
select public.run_payroll(register_test.id(1,205),'2029-11');
select hourly_test.expect('salary/explicit zero salary with worked hours has no division error',hourly_test.money(206,'2029-11'),'[0,0,0]');
select register_test.publish(hourly_test.run_id(205,'2029-11'));
select hourly_test.expect('salary/zero-money hourly register can publish without phantom lines',
 (select to_jsonb(status) from public.payslips where employee_id=register_test.id(4,206) and period='2029-11'),'"Published"');

-- Existing paid-day payroll keeps automatic overtime and late pricing, including cents.
select public.run_payroll(register_test.id(1,202),'2029-09');
select hourly_test.expect('legacy/paid-days arithmetic retains overtime and fractional late deduction',hourly_test.money(202,'2029-09'),'[30500,62.5,30437.5]');
select hourly_test.expect('legacy/new register reports paid-days calculation mode',
 (select jsonb_build_array(payroll_register->'schema_version',payroll_register->'calculation_mode') from public.payslips where employee_id=register_test.id(4,202) and period='2029-09'),'[4,"paid_days"]');
select hourly_test.save(202,'2029-09','{"tds":100.25,"notes":"Reviewed TDS amount"}');
select public.run_payroll(register_test.id(1,202),'2029-09');
select hourly_test.expect('legacy/TDS applies without imposing hourly whole-rupee rounding',hourly_test.money(202,'2029-09'),'[30500,162.75,30337.25]');
select public.run_payroll(register_test.id(1,202),'2029-10');
select register_test.publish(hourly_test.run_id(202,'2029-10'));
select hourly_test.expect('legacy/paid-days publish succeeds with no monthly input row',
 (select jsonb_build_array(status,gross,net,payroll_register->'attendance_input') from public.payslips where employee_id=register_test.id(4,202) and period='2029-10'), '["Published",30000,30000,null]');

-- Source permissions and optimistic edits apply to manual totals as to money inputs.
select set_config('request.jwt.claim.sub',register_test.id(3,202)::text,false);
select hourly_test.expect('security/employee cannot approve own reviewed monthly input',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"worked_minutes":11000}')$q$)),'"42501"');
select set_config('request.jwt.claim.sub',register_test.id(3,204)::text,false);
select hourly_test.expect('security/other branch cannot approve monthly totals',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"worked_minutes":11000}')$q$)),'"42501"');
select set_config('request.jwt.claim.sub',register_test.id(3,203)::text,false);
select hourly_test.expect('security/scoped HR reads reviewed source readiness',hourly_test.summary(201,201,'2029-09')->'reviewed_source_ready','true');
select hourly_test.expect('security/scoped HR cannot change company calculation policy',
 to_jsonb(hourly_test.error($q$select hourly_test.policy(201,'{"hours_per_day":9}')$q$)),'"42501"');
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.expect('inputs/stale update cannot overwrite approved totals',
 to_jsonb(hourly_test.error($q$select public.save_payroll_monthly_input(register_test.id(4,201),'2029-09','{"worked_minutes":11000}',null)$q$)),'"40001"');
select hourly_test.expect('security/anonymous monthly saves remain closed',
 to_jsonb(has_function_privilege('anon','public.save_payroll_monthly_input(uuid,text,jsonb,timestamptz)','execute')),'false');

-- Publication rechecks register arithmetic and permanently locks the reviewed evidence.
reset role;
set request.jwt.claim.sub='';
update public.payslips set payroll_register=jsonb_set(payroll_register,'{credited_hours}','999')
 where employee_id=register_test.id(4,201) and period='2029-09';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.expect('publication/tampered hourly trace is rejected',
 to_jsonb(hourly_test.error($q$select register_test.publish(hourly_test.run_id(201,'2029-09'))$q$)),'"23514"');
select public.run_payroll(register_test.id(1,201),'2029-09');
reset role;
set request.jwt.claim.sub='';
update public.payslip_lines l set amount=-amount from public.payslips p where p.id=l.payslip_id
 and p.employee_id=register_test.id(4,201) and p.period='2029-09' and l.code='NET_ROUNDOFF';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.expect('publication/reversed signed net-roundoff line is rejected',
 to_jsonb(hourly_test.error($q$select register_test.publish(hourly_test.run_id(201,'2029-09'))$q$)),'"23514"');
select public.run_payroll(register_test.id(1,201),'2029-09');
reset role;
set request.jwt.claim.sub='';
update public.payslips set payroll_register=jsonb_set(payroll_register,'{net_roundoff}','0.2')
 where employee_id=register_test.id(4,201) and period='2029-09';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,201)::text,false);
select hourly_test.expect('publication/tampered net-roundoff snapshot is rejected',
 to_jsonb(hourly_test.error($q$select register_test.publish(hourly_test.run_id(201,'2029-09'))$q$)),'"23514"');
select public.run_payroll(register_test.id(1,201),'2029-09');
select register_test.publish(hourly_test.run_id(201,'2029-09'));
select hourly_test.expect('publication/reviewed non-device payroll can publish with explicit evidence',
 (select jsonb_build_array(status,gross,net) from public.payslips where employee_id=register_test.id(4,201) and period='2029-09'),'["Published",12461,10531]');
select hourly_test.expect('publication/reviewed attendance cannot be silently rewritten',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"worked_minutes":11000}')$q$)),'"55000"');
select hourly_test.expect('publication/TDS cannot change after publish',
 to_jsonb(hourly_test.error($q$select hourly_test.save(201,'2029-09','{"tds":0}')$q$)),'"55000"');
select public.set_payroll_payment_status(hourly_test.run_id(201,'2029-09'),register_test.id(4,201),'held','Bank details awaiting confirmation',null,
 (select updated_at from public.payroll_payments where run_id=hourly_test.run_id(201,'2029-09') and employee_id=register_test.id(4,201)));
select hourly_test.expect('payments/hold is separate from salary calculation',
 (select jsonb_build_array(p.net,t.status) from public.payslips p join public.payroll_payments t on t.run_id=p.run_id and t.employee_id=p.employee_id
 where p.employee_id=register_test.id(4,201) and p.period='2029-09'),'[10531,"held"]');
select hourly_test.expect('transactions/published reviewed recovery cannot change',
 to_jsonb(hourly_test.error($q$select public.save_payroll_advance_recovery((select id from public.payroll_advances where request_id=register_test.id(8,201)),'2029-09',0,
 (select updated_at from public.payroll_advance_recoveries where advance_id=(select id from public.payroll_advances where request_id=register_test.id(8,201)) and period='2029-09'))$q$)),'"55000"');
reset role;
set request.jwt.claim.sub='';
select 'PASS: hourly payroll workings '||count(*)||' assertions; reviewed and recorded attendance, HR formula acceptance, earned credits, exact money lines, TDS, employment windows, policy divisors, legacy arithmetic, transactions, scoped access and publication locks' from hourly_test.results;
