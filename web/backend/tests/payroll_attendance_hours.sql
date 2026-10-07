\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'hr_payroll_integrity_audit' then raise exception 'Disposable payroll integrity database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub='';
create schema hours_test;
create table hours_test.results(label text primary key);
create function hours_test.expect(label text,actual jsonb,expected jsonb) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception '%: expected %, got %',label,expected,actual; end if;
  insert into hours_test.results values(label);
end $$;
create function hours_test.error(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
create function hours_test.summary(_employee integer) returns jsonb language sql as $$
 select value from jsonb_array_elements(public.get_payroll_attendance_summary(register_test.id(1,3),'2027-04'))
 where value->>'employee_id'=register_test.id(4,_employee)::text;
$$;
create function hours_test.save(_employee integer,_input jsonb) returns jsonb language sql as $$
 select public.save_payroll_monthly_input(register_test.id(4,_employee),'2027-04',_input,
   (select updated_at from public.payroll_monthly_inputs where employee_id=register_test.id(4,_employee) and period='2027-04'));
$$;
grant usage on schema hours_test to authenticated,anon;
grant execute on all functions in schema hours_test to authenticated,anon;
grant select,insert on hours_test.results to authenticated,anon;
select hours_test.expect('upgrade/existing numeric zeroes retain explicit meaning',
 (select jsonb_build_array(ot_hours,late_hours) from public.payroll_monthly_inputs where employee_id=register_test.id(4,1) and period='2026-08'),'[0,0]');
select hours_test.expect('upgrade/published register and money not rewritten',
 (select jsonb_build_array(status,net,payroll_register->'schema_version',payroll_register->'ot_hours') from public.payslips where employee_id=register_test.id(4,1) and period='2026-09'),
 '["Published",30512.5,1,2]');
insert into public.entities(id,code,name) values(register_test.id(1,3),'HOURS-E','Automatic hours company');
insert into public.branches(id,entity_id,code,name) values(register_test.id(2,4),register_test.id(1,3),'HOURS-B','Hours branch');
insert into auth.users(id,email) select register_test.id(3,n),'hours-'||n||'@audit.invalid' from generate_series(6,8)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name,status,join_date) values
 (register_test.id(4,6),register_test.id(1,3),register_test.id(2,4),register_test.id(3,7),'HOURS-1','Automatic hours employee','Active','2027-01-01'),
 (register_test.id(4,7),register_test.id(1,3),register_test.id(2,4),null,'HOURS-2','Hours joiner','Active','2027-04-16'),
 (register_test.id(4,8),register_test.id(1,3),register_test.id(2,4),null,'HOURS-FUTURE','Future hours employee','Active','2030-01-01');
update public.profiles set employee_id=register_test.id(4,6) where user_id=register_test.id(3,7);
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
 (register_test.id(3,6),(select id from public.roles where key='hr_manager'),'entity',register_test.id(1,3)),
 (register_test.id(3,7),(select id from public.roles where key='employee'),'self',null),
 (register_test.id(3,8),(select id from public.roles where key='hr_manager'),'branch',register_test.id(2,4));
insert into public.salary_structures(employee_id,effective_from,basic,gross,notes) values
 (register_test.id(4,6),'2027-01-01',20000,30000,'{"gross_components":[{"name":"HRA","amount":10000}]}'),
 (register_test.id(4,7),'2027-04-16',20000,30000,null);
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes,first_punch_at,last_punch_at,computed_at)
 select register_test.id(4,6),d::date,'Present',1,'working',480,d+interval '3 hours 30 minutes',d+interval '12 hours',clock_timestamp()
 from generate_series('2027-04-01'::date,'2027-04-30'::date,'1 day')d;
update public.attendance set status='Half Day',day_fraction=0.5,worked_minutes=240,late_minutes=60
 where employee_id=register_test.id(4,6) and work_date='2027-04-02';
update public.attendance set worked_minutes=600,ot_minutes=120,late_minutes=30
 where employee_id=register_test.id(4,6) and work_date='2027-04-03';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,6)::text,false);
select public.save_payroll_policy(register_test.id(1,3),'{}');
select hours_test.expect('summary/no-input row derives OT and policy disables late charges',
 (select jsonb_build_array(s->'recorded_worked_hours',s->'recorded_ot_hours',s->'recorded_late_hours',s->'deductible_late_hours',
   s->'effective_ot_hours',s->'effective_late_hours',s->'ot_source',s->'late_source',s->'attendance_days',s->'expected_days') from (select hours_test.summary(6)s)x),
 '[238,2,1.5,0.5,2,0,"attendance","attendance",30,30]');
select hours_test.expect('summary/missing attendance stays visible and incomplete',
 (select jsonb_build_array(s->'attendance_days',s->'expected_days',s->'missing_days',s->'effective_ot_hours',s->'first_punch_at') from (select hours_test.summary(7)s)x),
 '[0,15,15,0,null]');
select hours_test.expect('summary/outside-month employee is neutral and distinguishable from missing attendance',
 (select jsonb_build_array(s->'in_payroll_month',s->'expected_days',s->'missing_days',s->'effective_ot_hours',s->'employment_issue') from (select hours_test.summary(8)s)x),
 '[false,0,0,0,null]');
select hours_test.expect('readiness/missing joiner attendance still blocks payroll',
 to_jsonb(hours_test.error($q$select public.run_payroll(register_test.id(1,3),'2027-04')$q$)),'"23514"');
select hours_test.expect('summary/punch and computation evidence present',
 (select to_jsonb(s->>'first_punch_at' is not null and s->>'last_punch_at' is not null and s->>'computed_at' is not null) from (select hours_test.summary(6)s)x),'true');
reset role;
set request.jwt.claim.sub='';
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes,computed_at)
 select register_test.id(4,7),d::date,'Present',1,'working',480,clock_timestamp()
 from generate_series('2027-04-16'::date,'2027-04-30'::date,'1 day')d;
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,6)::text,false);
select public.run_payroll(register_test.id(1,3),'2027-04');
select hours_test.expect('engine/automatic OT included without monthly input',
 (select jsonb_build_array(gross,deductions,net,payroll_register->'ot_hours',payroll_register->'ot_source',payroll_register->'late_hours')
 from public.payslips where employee_id=register_test.id(4,6) and period='2027-04'),'[30000,0,30000,2,"attendance",0]');
select public.save_payroll_policy(register_test.id(1,3),'{"deduct_late":true}',(select updated_at from public.payroll_policies where entity_id=register_test.id(1,3)));
select public.run_payroll(register_test.id(1,3),'2027-04');
select hours_test.expect('engine/automatic late excludes time already priced as half-day LOP',
 (select jsonb_build_array(gross,deductions,net,payroll_register->'late_hours',payroll_register->'recorded_late_hours',
 payroll_register->'recorded_deductible_late_hours',payroll_register->'late_source') from public.payslips where employee_id=register_test.id(4,6) and period='2027-04'),
 '[30000,62.5,29937.5,0.5,1.5,0.5,"attendance"]');
select hours_test.expect('override/new explicit zero requires a reason',
 to_jsonb(hours_test.error($q$select hours_test.save(6,'{"ot_hours":0}')$q$)),'"23514"');
select hours_test.save(6,'{"ot_hours":0,"late_hours":0,"notes":"HR verified no payable overtime or late recovery this month"}');
select public.run_payroll(register_test.id(1,3),'2027-04');
select hours_test.expect('override/explicit zero suppresses automatic hours',
 (select jsonb_build_array(gross,deductions,net,payroll_register->'ot_hours',payroll_register->'late_hours',payroll_register->'ot_source',payroll_register->'late_source')
 from public.payslips where employee_id=register_test.id(4,6) and period='2027-04'),'[29500,0,29500,0,0,"override","override"]');
select hours_test.save(6,'{"ot_hours":null,"late_hours":null,"notes":null}');
select public.run_payroll(register_test.id(1,3),'2027-04');
select hours_test.expect('override/reset to null restores attendance calculation',
 (select jsonb_build_array(net,payroll_register->'ot_hours',payroll_register->'late_hours',payroll_register->'ot_source')
 from public.payslips where employee_id=register_test.id(4,6) and period='2027-04'),'[29937.5,2,0.5,"attendance"]');
select hours_test.expect('override/reset stays null in input storage',
 (select jsonb_build_array(ot_hours,late_hours) from public.payroll_monthly_inputs where employee_id=register_test.id(4,6) and period='2027-04'),'[null,null]');
select hours_test.expect('audit/zero override and reset preserve before-after evidence',
 (select jsonb_agg(jsonb_build_array(ot_hours_before,ot_hours_after,late_hours_before,late_hours_after) order by changed_at)
 from public.payroll_hour_override_history where employee_id=register_test.id(4,6)),
 '[[null,0,null,0],[0,null,0,null]]');
select hours_test.save(6,'{"ot_hours":1,"late_hours":0.25,"notes":"HR approved one hour OT and fifteen minutes late recovery"}');
select public.run_payroll(register_test.id(1,3),'2027-04');
select hours_test.expect('override/justified partial overrides price effective hours',
 (select jsonb_build_array(gross,deductions,net) from public.payslips where employee_id=register_test.id(4,6) and period='2027-04'),'[29750,31.25,29718.75]');
select hours_test.save(6,'{"ot_hours":3}');
select hours_test.expect('override/summary reports override above recorded time',
 to_jsonb(hours_test.summary(6)->>'override_issue'='OT override exceeds recorded overtime.'),'true');
select hours_test.expect('override/excess requires correcting attendance evidence first',
 to_jsonb(hours_test.error($q$select public.run_payroll(register_test.id(1,3),'2027-04')$q$)),'"23514"');
select hours_test.expect('bulk/new override without reason aborts earlier valid reset',
 to_jsonb(hours_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,3),'2027-04',jsonb_build_array(
  jsonb_build_object('employee_id',register_test.id(4,6),'input','{"ot_hours":null}'::jsonb,'expected_updated_at',
    (select updated_at from public.payroll_monthly_inputs where employee_id=register_test.id(4,6) and period='2027-04')),
  jsonb_build_object('employee_id',register_test.id(4,7),'input','{"ot_hours":0}'::jsonb,'expected_updated_at',null)))$q$)),'"23514"');
select hours_test.expect('bulk/failed override leaves earlier value unchanged',
 (select to_jsonb(ot_hours) from public.payroll_monthly_inputs where employee_id=register_test.id(4,6) and period='2027-04'),'3');
select hours_test.save(6,'{"ot_hours":null,"late_hours":null}');
select public.run_payroll(register_test.id(1,3),'2027-04');

-- Durable queue work and unapplied approved corrections block both calculation and publication.
reset role;
set request.jwt.claim.sub='';
select public.enqueue_recompute(register_test.id(4,6),'2027-04-04','2027-04-04','New punch evidence');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,6)::text,false);
select hours_test.expect('freshness/queued source shown before worker processes it',hours_test.summary(6)->'pending_recompute_days','1');
select hours_test.expect('freshness/queued work blocks regeneration',
 to_jsonb(hours_test.error($q$select public.run_payroll(register_test.id(1,3),'2027-04')$q$)),'"23514"');
select hours_test.expect('freshness/queued work invalidates prepared publication',
 to_jsonb(hours_test.error($q$select public.publish_payroll(id,source_fingerprint) from public.payroll_runs where entity_id=register_test.id(1,3) and period='2027-04'$q$)),'"55000"');
reset role;
set request.jwt.claim.sub='';
update public.attendance set ot_minutes=60,worked_minutes=540,computed_at=clock_timestamp() where employee_id=register_test.id(4,6) and work_date='2027-04-04';
update public.attendance_recompute_queue set processed_at=clock_timestamp() where employee_id=register_test.id(4,6) and work_date='2027-04-04';
insert into public.attendance_regularizations(id,employee_id,work_date,check_out,reason,status)
 values(register_test.id(9,1),register_test.id(4,6),'2027-04-05','2027-04-05T14:00:00Z','Approved missing checkout','Approved');
update public.attendance_recompute_queue set processed_at=clock_timestamp() where employee_id=register_test.id(4,6) and work_date='2027-04-05';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,6)::text,false);
select hours_test.expect('freshness/approved correction needs actual derivation even after queue acknowledgement',hours_test.summary(6)->'pending_recompute_days','1');
select hours_test.expect('freshness/unapplied correction blocks payroll',
 to_jsonb(hours_test.error($q$select public.run_payroll(register_test.id(1,3),'2027-04')$q$)),'"23514"');
reset role;
set request.jwt.claim.sub='';
update public.attendance set regularization_id=register_test.id(9,1),computed_at=clock_timestamp(),ot_minutes=120,worked_minutes=600
 where employee_id=register_test.id(4,6) and work_date='2027-04-05';
insert into public.raw_punches(emp_code,employee_id,punch_time)
 values('HOURS-1',register_test.id(4,6),'2027-04-06T14:00:00Z');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,6)::text,false);
select hours_test.expect('freshness/raw punch transaction durably queues all adjacent shift ownership dates',hours_test.summary(6)->'pending_recompute_days','4');
reset role;
set request.jwt.claim.sub='';
update public.attendance set computed_at=clock_timestamp() where employee_id=register_test.id(4,6) and work_date between '2027-04-04' and '2027-04-07';
update public.attendance_recompute_queue set processed_at=clock_timestamp() where employee_id=register_test.id(4,6) and processed_at is null;
select public.enqueue_recompute(null,'2027-04-07','2027-04-07','Whole workforce refresh');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,6)::text,false);
select hours_test.expect('freshness/global queue applies only within each employment interval',
 jsonb_build_array(hours_test.summary(6)->'pending_recompute_days',hours_test.summary(7)->'pending_recompute_days'),'[1,0]');
reset role;
set request.jwt.claim.sub='';
update public.attendance_recompute_queue set processed_at=clock_timestamp() where employee_id is null and work_date='2027-04-07';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,6)::text,false);
select public.run_payroll(register_test.id(1,3),'2027-04');
select hours_test.expect('freshness/recomputed punches flow into automatic hours and salary',
 (select jsonb_build_array(payroll_register->'ot_hours',gross,net) from public.payslips where employee_id=register_test.id(4,6) and period='2027-04'),
 '[5,30750,30687.5]');
select set_config('request.jwt.claim.sub',register_test.id(3,8)::text,false);
select hours_test.expect('security/branch HR reads scoped summary with company late policy',
 jsonb_build_array(jsonb_array_length(public.get_payroll_attendance_summary(register_test.id(1,3),'2027-04')),hours_test.summary(6)->'policy_deduct_late'),'[3,true]');
select hours_test.expect('security/branch HR does not gain company policy table visibility',
 (select to_jsonb(count(*)) from public.payroll_policies where entity_id=register_test.id(1,3)),'0');
select hours_test.expect('security/foreign company summary stays empty',public.get_payroll_attendance_summary(register_test.id(1,1),'2027-04'),'[]');
select set_config('request.jwt.claim.sub',register_test.id(3,7)::text,false);
select hours_test.expect('security/employee cannot use manager summary RPC',
 to_jsonb(hours_test.error($q$select public.get_payroll_attendance_summary(register_test.id(1,3),'2027-04')$q$)),'"42501"');
select hours_test.expect('security/employee cannot read hour override history',
 (select to_jsonb(count(*)) from public.payroll_hour_override_history),'0');
select set_config('request.jwt.claim.sub',register_test.id(3,6)::text,false);
select public.publish_payroll(id,source_fingerprint) from public.payroll_runs where entity_id=register_test.id(1,3) and period='2027-04';
select hours_test.expect('publication/automatic hours freeze in published snapshot',
 to_jsonb(hours_test.error($q$select hours_test.save(6,'{"ot_hours":0,"notes":"Late attempt"}')$q$)),'"55000"');
reset role;
set request.jwt.claim.sub='';
select hours_test.expect('publication/new correction on locked attendance rejected',
 to_jsonb(hours_test.error($q$insert into public.attendance_regularizations(employee_id,work_date,check_out,reason)
 values(register_test.id(4,6),'2027-04-08','2027-04-08T15:00:00Z','Late correction')$q$)),'"55000"');
select hours_test.expect('publication/existing correction cannot be rewritten',
 to_jsonb(hours_test.error($q$update public.attendance_regularizations set check_out='2027-04-05T16:00:00Z' where id=register_test.id(9,1)$q$)),'"55000"');
select hours_test.expect('audit/history cannot be rewritten even by import owner',
 to_jsonb(hours_test.error($q$update public.payroll_hour_override_history set ot_hours_after=99 where employee_id=register_test.id(4,6)$q$)),'"55000"');
select hours_test.expect('security/anonymous summary execution closed',
 to_jsonb(has_function_privilege('anon','public.get_payroll_attendance_summary(uuid,text)','execute')),'false');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select public.save_payroll_monthly_input(register_test.id(4,1),'2026-08','{"incentive":5}',
 (select updated_at from public.payroll_monthly_inputs where employee_id=register_test.id(4,1) and period='2026-08'));
select hours_test.expect('upgrade/unchanged legacy zero override needs no invented reason',
 (select jsonb_build_array(ot_hours,late_hours,notes) from public.payroll_monthly_inputs where employee_id=register_test.id(4,1) and period='2026-08'),'[0,0,null]');
reset role;
set request.jwt.claim.sub='';
select 'PASS: automatic payroll attendance hours '||count(*)||' assertions; shared live summary, effective hours, justified overrides, legacy preservation, durable recompute readiness and correction locks' from hours_test.results;
