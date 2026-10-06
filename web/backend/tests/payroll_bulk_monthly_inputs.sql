-- Run after payroll_salary_register.sql in the private payroll test database.
\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'hr_payroll_integrity_audit' then raise exception 'Disposable payroll integrity database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub='';
create schema bulk_payroll_test;
create table bulk_payroll_test.results(label text primary key);
create function bulk_payroll_test.expect(label text,actual jsonb,expected jsonb) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception '%: expected %, got %',label,expected,actual; end if;
  insert into bulk_payroll_test.results values(label);
end $$;
create function bulk_payroll_test.error(statement text) returns jsonb language plpgsql as $$
begin execute statement; return '{"code":"accepted"}'; exception when others then
  return jsonb_build_object('code',sqlstate,'message',sqlerrm);
end $$;
create function bulk_payroll_test.row(_employee integer,_input jsonb) returns jsonb language sql as $$
  select jsonb_build_object('employee_id',register_test.id(4,_employee),'input',_input,
    'expected_updated_at',(select updated_at from public.payroll_monthly_inputs where employee_id=register_test.id(4,_employee) and period='2026-12'));
$$;
grant usage on schema bulk_payroll_test to authenticated,anon;
grant execute on all functions in schema bulk_payroll_test to authenticated,anon;
grant select,insert on bulk_payroll_test.results to authenticated,anon;
insert into public.payroll_runs(entity_id,period) values(register_test.id(1,1),'2026-12');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);

select bulk_payroll_test.expect('batch/create ordered rows and fresh revisions',
 (select jsonb_agg(jsonb_build_array(value->'employee_id',value->'incentive',value ? 'updated_at') order by ordinality)
  from jsonb_array_elements(public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
    bulk_payroll_test.row(3,'{"incentive":20}'),bulk_payroll_test.row(1,'{"incentive":10,"ot_hours":null}')))) with ordinality),
 jsonb_build_array(jsonb_build_array(register_test.id(4,3),20,true),jsonb_build_array(register_test.id(4,1),10,true)));
select bulk_payroll_test.expect('batch/marks existing draft for recalculation',
 (select to_jsonb(needs_recalculation) from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-12'),'true');
select bulk_payroll_test.expect('batch/retains singular null approval semantics',
 (select to_jsonb(ot_hours) from public.payroll_monthly_inputs where employee_id=register_test.id(4,1) and period='2026-12'),'0');

reset role;
set request.jwt.claim.sub='';
create table bulk_payroll_test.before_rows as select jsonb_agg(to_jsonb(i) order by employee_id) value
  from public.payroll_monthly_inputs i where entity_id=register_test.id(1,1) and period='2026-12';
create table bulk_payroll_test.before_audit as select count(*) value from public.audit_log
  where table_name='payroll_monthly_inputs' and entity_id=register_test.id(1,1) and action='INPUTS_SAVED:2026-12';
grant select on bulk_payroll_test.before_rows,bulk_payroll_test.before_audit to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select bulk_payroll_test.expect('batch/second invalid amount preserves SQLSTATE',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":111}'),bulk_payroll_test.row(3,'{"incentive":-1}')))$q$)->'code','"23514"');
select bulk_payroll_test.expect('batch/failed second row rolls back every value and revision',
 (select jsonb_agg(to_jsonb(i) order by employee_id) from public.payroll_monthly_inputs i where entity_id=register_test.id(1,1) and period='2026-12'),
 (select value from bulk_payroll_test.before_rows));
select bulk_payroll_test.expect('batch/error identifies authorized employee and row',
 to_jsonb((bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":111}'),bulk_payroll_test.row(3,'{"other_deductions":5}')))$q$)->>'message')
   like 'Row 2 (REG-JOIN — New joiner): Record the approval%'),'true');
select bulk_payroll_test.expect('batch/stale second revision aborts first valid update',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":111}'),bulk_payroll_test.row(3,'{"incentive":222}')||'{"expected_updated_at":null}'::jsonb))$q$)->'code','"40001"');
select bulk_payroll_test.expect('batch/stale update retains every revision',
 (select jsonb_agg(to_jsonb(i) order by employee_id) from public.payroll_monthly_inputs i where entity_id=register_test.id(1,1) and period='2026-12'),
 (select value from bulk_payroll_test.before_rows));
select bulk_payroll_test.expect('batch/duplicate employee rejected atomically',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":111}'),bulk_payroll_test.row(1,'{"incentive":222}')))$q$)->'code','"22023"');
select bulk_payroll_test.expect('batch/foreign employee rejected even after valid row',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":111}'),bulk_payroll_test.row(2,'{"incentive":222}')))$q$)->'code','"42501"');
select bulk_payroll_test.expect('batch/foreign rejection does not expose foreign employee name',
 to_jsonb((bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(2,'{"incentive":222}')))$q$)->>'message')='Row 1: Employee is not available in your payroll scope for the selected company.'),'true');
select bulk_payroll_test.expect('batch/selected company must own all employees',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,2),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":111}')))$q$)->'code','"42501"');
select bulk_payroll_test.expect('batch/invalid row metadata rejected',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{}')||'{"entity_id":"unexpected"}'::jsonb))$q$)->'code','"22023"');
select bulk_payroll_test.expect('batch/invalid employee ID rejected clearly',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12','[{"employee_id":"invalid","input":{}}]')$q$)->'code','"22023"');
select bulk_payroll_test.expect('batch/invalid revision rejected clearly',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{}')||'{"expected_updated_at":"invalid"}'::jsonb))$q$)->'code','"22023"');
select bulk_payroll_test.expect('batch/unknown input field retains singular validation',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"net_pay_salary":1}')))$q$)->'code','"22023"');
select bulk_payroll_test.expect('batch/empty batch rejected',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12','[]')$q$)->'code','"22023"');
select bulk_payroll_test.expect('batch/nonarray payload rejected',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12','{}')$q$)->'code','"22023"');
select bulk_payroll_test.expect('batch/size over1000 rejected before writes',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',
   (select jsonb_agg(bulk_payroll_test.row(1,'{}')) from generate_series(1,1001)))$q$)->'code','"22023"');
select bulk_payroll_test.expect('batch/published month still immutable',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-09',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":111}')))$q$)->'code','"55000"');
select bulk_payroll_test.expect('batch/all failed batches preserved original rows',
 (select jsonb_agg(to_jsonb(i) order by employee_id) from public.payroll_monthly_inputs i where entity_id=register_test.id(1,1) and period='2026-12'),
 (select value from bulk_payroll_test.before_rows));
reset role;
set request.jwt.claim.sub='';
select bulk_payroll_test.expect('batch/rollback leaves no misleading audit events',
 (select to_jsonb(count(*)) from public.audit_log where table_name='payroll_monthly_inputs' and entity_id=register_test.id(1,1) and action='INPUTS_SAVED:2026-12'),
 (select to_jsonb(value) from bulk_payroll_test.before_audit));
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
  bulk_payroll_test.row(1,'{"pf":0,"esi":25,"notes":"Finance approved statutory overrides"}'),
  bulk_payroll_test.row(3,'{"target_incentive":50}')));
select bulk_payroll_test.expect('batch/patch preserves unedited values and explicit zero PF',
 (select jsonb_agg(jsonb_build_array(incentive,target_incentive,pf,esi) order by employee_id) from public.payroll_monthly_inputs
  where entity_id=register_test.id(1,1) and period='2026-12'),'[[10,0,0,25],[20,50,null,null]]');
reset role;
set request.jwt.claim.sub='';
insert into public.branches(id,entity_id,code,name) values(register_test.id(2,3),register_test.id(1,1),'REG-B3','Other branch');
insert into public.employees(id,entity_id,branch_id,employee_code,full_name,status,join_date)
  values(register_test.id(4,5),register_test.id(1,1),register_test.id(2,3),'REG-OTHER','Other branch employee','Active','2030-01-01');
insert into auth.users(id,email) values(register_test.id(3,4),'register-branch-hr@audit.invalid');
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select register_test.id(3,4),id,'branch',register_test.id(2,1) from public.roles where key='hr_manager';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,4)::text,false);
select bulk_payroll_test.expect('batch/branch HR may bulk save permitted employees',
 to_jsonb(jsonb_array_length(public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":11}'),bulk_payroll_test.row(3,'{"incentive":21}'))))),'2');
select bulk_payroll_test.expect('batch/branch HR cannot include another branch in same company',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{"incentive":999}'),bulk_payroll_test.row(5,'{"incentive":222}')))$q$)->'code','"42501"');
select bulk_payroll_test.expect('batch/cross-branch failure rolls back earlier authorized row',
 (select to_jsonb(incentive) from public.payroll_monthly_inputs where employee_id=register_test.id(4,1) and period='2026-12'),'11');
select set_config('request.jwt.claim.sub',register_test.id(3,2)::text,false);
select bulk_payroll_test.expect('batch/employee role cannot save own row',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12',jsonb_build_array(
   bulk_payroll_test.row(1,'{}')))$q$)->'code','"42501"');
set request.jwt.claim.sub='';
select bulk_payroll_test.expect('batch/authenticated role still needs an actor',
 bulk_payroll_test.error($q$select public.save_payroll_monthly_inputs(register_test.id(1,1),'2026-12','[]')$q$)->'code','"42501"');
reset role;
select bulk_payroll_test.expect('batch/anonymous execute grant absent',
 to_jsonb(has_function_privilege('anon','public.save_payroll_monthly_inputs(uuid,text,jsonb)','execute')),'false');
select 'PASS: payroll bulk monthly inputs '||count(*)||' assertions; ordered results, bounded validation, all-or-nothing revision-safe writes, scope, publication and audit rollback'
 from bulk_payroll_test.results;
