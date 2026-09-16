\set ON_ERROR_STOP on
-- Two phases, around migration 0143, using the real schema/RPCs and distinct RLS identities.
do $$ begin
  if current_database() <> 'hr_payroll_integrity_audit' then raise exception 'Disposable payroll integrity database required'; end if;
end $$;
\if :payroll_seed
reset role;
set request.jwt.claim.sub = '';
create schema payroll_test;
create function payroll_test.id(kind integer,n integer) returns uuid language sql immutable as $$
  select ('f430'||lpad(kind::text,4,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create table payroll_test.results(label text primary key);
create function payroll_test.expect(label text, actual jsonb, expected jsonb) returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception '%: expected %, got %',label,expected,actual;
  end if;
  insert into payroll_test.results values(label);
end $$;
create function payroll_test.error(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
grant usage on schema payroll_test to authenticated,anon;
grant execute on all functions in schema payroll_test to authenticated,anon;
grant insert,select on payroll_test.results to authenticated,anon;

insert into public.entities(id,code,name) select payroll_test.id(1,n),'PAY-E'||n,'Payroll test company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name) select payroll_test.id(2,n),payroll_test.id(1,n),'PAY-B'||n,'Payroll test branch '||n from generate_series(1,2)n;
insert into public.departments(id,entity_id,branch_id,name) select payroll_test.id(3,n),payroll_test.id(1,n),payroll_test.id(2,n),'Payroll test department '||n from generate_series(1,2)n;
insert into auth.users(id,email) select payroll_test.id(4,n),'payroll-'||n||'@audit.invalid' from generate_series(1,3)n;
insert into public.employees(id,entity_id,branch_id,department_id,user_id,employee_code,full_name,status)
  select payroll_test.id(5,n),payroll_test.id(1,case when n=3 then 2 else 1 end),
    payroll_test.id(2,case when n=3 then 2 else 1 end),payroll_test.id(3,case when n=3 then 2 else 1 end),
    payroll_test.id(4,n),'PAY-ACTOR-'||n,'Payroll actor '||n,'Active' from generate_series(1,3)n;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like 'PAY-ACTOR-%';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
  (payroll_test.id(4,1),(select id from public.roles where key='hr_manager'),'entity',payroll_test.id(1,1)),
  (payroll_test.id(4,2),(select id from public.roles where key='employee'),'self',null),
  (payroll_test.id(4,3),(select id from public.roles where key='employee'),'self',null);
insert into public.salary_structures(employee_id,effective_from,basic,gross,notes)
  select payroll_test.id(5,n),'2026-01-01',20000,30000,'{"gross_components":[{"name":"HRA","amount":10000}]}' from generate_series(2,3)n;
insert into public.salary_structures(employee_id,effective_from,basic,gross)
  values(payroll_test.id(5,2),'2026-10-01',40000,60000);

-- Exercise the actual old producer before applying the repair, including another company.
select public.run_payroll(payroll_test.id(1,2),'2026-07');
select public.publish_payroll((select id from public.payroll_runs where entity_id=payroll_test.id(1,2) and period='2026-07'));
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
select public.run_payroll(payroll_test.id(1,1),'2026-07');
select public.publish_payroll((select id from public.payroll_runs where entity_id=payroll_test.id(1,1) and period='2026-07'));
select payroll_test.expect('upgrade/old publication produced Paid',
 (select to_jsonb(status) from public.payslips where employee_id=payroll_test.id(5,2) and period='2026-07'),'"Paid"');
select set_config('request.jwt.claim.sub',payroll_test.id(4,2)::text,false);
select payroll_test.expect('upgrade/old published slip was invisible',
 (select to_jsonb(count(*)) from public.payslips where employee_id=payroll_test.id(5,2) and period='2026-07'),'0');
reset role;
set request.jwt.claim.sub = '';
insert into public.payroll_runs(id,entity_id,period,status) values
 (payroll_test.id(6,1),payroll_test.id(1,1),'2026-06','Draft'),
 (payroll_test.id(6,2),payroll_test.id(1,1),'2026-04','Published');
insert into public.payslips(employee_id,period,gross,deductions,net,status,run_id) values
 (payroll_test.id(5,2),'2026-05',123,0,123,'Paid',null),
 (payroll_test.id(5,2),'2026-06',123,0,123,'Paid',payroll_test.id(6,1)),
 (payroll_test.id(5,2),'2026-04',123,0,123,'Draft',payroll_test.id(6,2));
insert into public.payslip_lines(payslip_id,code,name,kind,amount)
 select id,'BASIC','Basic','earning',gross from public.payslips where period in('2026-04','2026-05','2026-06');
\else
reset role;
set request.jwt.claim.sub = '';
select payroll_test.expect('upgrade/migration retains unproven statuses',
 (select jsonb_agg(status order by period) from public.payslips where employee_id=payroll_test.id(5,2) and period in('2026-04','2026-05','2026-06')),'["Draft","Paid","Paid"]');
select payroll_test.expect('upgrade/legacy totals unchanged and statuses repaired',
 (select jsonb_agg(jsonb_build_object('gross',gross,'net',net,'status',status) order by employee_id) from public.payslips where period='2026-07'),
 '[{"gross":30000,"net":30000,"status":"Published"},{"gross":30000,"net":30000,"status":"Published"}]');
select payroll_test.expect('security/anonymous RPC grants remain closed',
 to_jsonb(has_function_privilege('anon','public.run_payroll(uuid,text)','execute') or has_function_privilege('anon','public.publish_payroll(uuid)','execute')),'false');
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,2)::text,false);
select payroll_test.expect('upgrade/employee sees only proven own publication',
 (select jsonb_agg(period order by period) from public.payslips),'["2026-07"]');
select payroll_test.expect('upgrade/legacy earning lines visible without foreign or draft lines',
 (select to_jsonb(count(*)) from public.payslip_lines),'2');

reset role;
set request.jwt.claim.sub = '';
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,is_lop)
 select payroll_test.id(5,2),d::date,'Present',1,'working',false from generate_series('2026-09-01'::date,'2026-09-30'::date,'1 day')d;
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select payroll_test.expect('generation/full-month agreed salary excludes future structure',
 (select jsonb_build_object('gross',gross,'net',net,'paid',paid_days,'lop',lop_days) from public.payslips where employee_id=payroll_test.id(5,2) and period='2026-09'),
 '{"gross":30000,"net":30000,"paid":30,"lop":0}');
select payroll_test.expect('generation/named earnings retained',
 (select jsonb_agg(jsonb_build_object('code',l.code,'amount',l.amount) order by l.code) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=payroll_test.id(5,2) and p.period='2026-09'),
 '[{"code":"BASIC","amount":20000},{"code":"GROSS_1","amount":10000}]');
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select payroll_test.expect('generation/rerun replaces draft without duplicates',
 (select jsonb_build_object('payslips',count(distinct p.id),'lines',count(l.id)) from public.payslips p join public.payslip_lines l on l.payslip_id=p.id where p.employee_id=payroll_test.id(5,2) and p.period='2026-09'),
 '{"payslips":1,"lines":2}');
select payroll_test.expect('generation/basic above gross rejected',to_jsonb(payroll_test.error($q$insert into public.salary_structures(employee_id,effective_from,basic,gross) values(payroll_test.id(5,2),'2026-11-01',100,50)$q$)),'"23514"');

reset role;
set request.jwt.claim.sub = '';
update public.attendance set status='Absent',day_fraction=0 where employee_id=payroll_test.id(5,2) and work_date='2026-09-02';
update public.attendance set status='Half Day',day_fraction=0.5 where employee_id=payroll_test.id(5,2) and work_date='2026-09-03';
update public.attendance set day_type='weekly_off',day_fraction=0 where employee_id=payroll_test.id(5,2) and work_date='2026-09-06';
update public.attendance set day_type='holiday',day_fraction=0 where employee_id=payroll_test.id(5,2) and work_date='2026-09-07';
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select payroll_test.expect('PAY-01/absence and half-day unpaid while rest days paid',
 (select jsonb_build_object('gross',gross,'paid',paid_days,'lop',lop_days) from public.payslips where employee_id=payroll_test.id(5,2) and period='2026-09'),
 '{"gross":28500,"paid":28.5,"lop":1.5}');
reset role;
set request.jwt.claim.sub = '';
update public.attendance set status='Present',day_fraction=1,day_type='working',is_lop=false where employee_id=payroll_test.id(5,2);
update public.attendance set status='On Leave',day_fraction=0,is_lop=true where employee_id=payroll_test.id(5,2) and work_date<='2026-09-15';
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
insert into public.pay_components(code,name,kind,calc_type,amount,prorate_on_lop,employer_share,entity_id) values
 ('PAY_FIXED','Fixed deduction','deduction','fixed',3000,true,false,payroll_test.id(1,1)),
 ('PAY_WHOLE','Non-prorated deduction','deduction','fixed',100,false,false,payroll_test.id(1,1)),
 ('PAY_EMPLOYER_FIXED','Employer cost','deduction','fixed',2000,true,true,payroll_test.id(1,1));
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select payroll_test.expect('PAY-02/fixed deduction and employer proration with opt-out',
 (select jsonb_build_object('gross',gross,'deductions',deductions,'net',net,'employer',employer_cost,'paid',paid_days,'lop',lop_days) from public.payslips where employee_id=payroll_test.id(5,2) and period='2026-09'),
 '{"gross":15000,"deductions":1600,"net":13400,"employer":1000,"paid":15,"lop":15}');
delete from public.pay_components;
insert into public.pay_components(code,name,kind,calc_type,rate,cap_base,max_amount,prorate_on_lop,employer_share,entity_id) values
 ('PAY_PERCENT','Percent cap','deduction','percent_of_basic',10,5000,400,true,false,payroll_test.id(1,1)),
 ('PAY_EMPLOYER','Employer percent','deduction','percent_of_gross',3,null,null,true,true,payroll_test.id(1,1));
insert into public.pay_components(code,name,kind,calc_type,amount,min_gross,max_gross,is_active,entity_id) values
 ('PAY_MIN','Ineligible min','deduction','fixed',100,40000,null,true,payroll_test.id(1,1)),
 ('PAY_MAX','Ineligible max','deduction','fixed',100,null,10000,true,payroll_test.id(1,1)),
 ('PAY_INACTIVE','Disabled','deduction','fixed',100,null,null,false,payroll_test.id(1,1));
reset role;
set request.jwt.claim.sub = '';
insert into public.pay_components(code,name,kind,calc_type,amount,entity_id) values('PAY_FOREIGN','Foreign','deduction','fixed',100,payroll_test.id(1,2));
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select payroll_test.expect('generation/percentage caps employer eligibility active and scope controls',
 (select jsonb_build_object('gross',gross,'deductions',deductions,'net',net,'employer_cost',employer_cost) from public.payslips where employee_id=payroll_test.id(5,2) and period='2026-09'),
 '{"gross":15000,"deductions":400,"net":14600,"employer_cost":450}');

reset role;
set request.jwt.claim.sub = '';
delete from public.pay_components;
update public.attendance set status='Present',day_fraction=1,is_lop=false where employee_id=payroll_test.id(5,2);
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
select public.run_payroll(payroll_test.id(1,1),'2026-09');
insert into public.pay_components(code,name,kind,calc_type,amount,prorate_on_lop,entity_id)
 values('PAY_ALLOWANCE','Allowance part of gross','earning','fixed',5000,true,payroll_test.id(1,1));
select payroll_test.expect('PAY-03/incompatible named plus catalog earnings rejected',
 to_jsonb(payroll_test.error($q$select public.run_payroll(payroll_test.id(1,1),'2026-09')$q$)),'"23514"');
select payroll_test.expect('PAY-03/rejected run preserves complete prior draft',
 (select jsonb_build_object('gross',p.gross,'net',p.net,'lines',count(l.id),'sum',sum(l.amount)) from public.payslips p join public.payslip_lines l on l.payslip_id=p.id where p.employee_id=payroll_test.id(5,2) and p.period='2026-09' group by p.id),
 '{"gross":30000,"net":30000,"lines":2,"sum":30000}');
-- Plain notes/catalog-only structures remain supported, with the configured allowance intact.
update public.salary_structures set notes='Legacy notes' where employee_id=payroll_test.id(5,2) and effective_from='2026-01-01';
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select payroll_test.expect('PAY-03/catalog-only allowance remains part of agreed gross',
 (select jsonb_agg(jsonb_build_object('code',l.code,'amount',l.amount) order by l.code) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=payroll_test.id(5,2) and p.period='2026-09'),
 '[{"code":"BASIC","amount":20000},{"code":"OTHER","amount":5000},{"code":"PAY_ALLOWANCE","amount":5000}]');
update public.salary_structures set notes='{"gross_components":[{"name":"HRA","amount":5000}]}' where employee_id=payroll_test.id(5,2) and effective_from='2026-01-01';
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select payroll_test.expect('PAY-03/compatible named and catalog allowances both retained',
 (select jsonb_agg(jsonb_build_object('code',l.code,'amount',l.amount) order by l.code) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=payroll_test.id(5,2) and p.period='2026-09'),
 '[{"code":"BASIC","amount":20000},{"code":"GROSS_1","amount":5000},{"code":"PAY_ALLOWANCE","amount":5000}]');
reset role;
set request.jwt.claim.sub = '';
update public.attendance set day_fraction=0,is_lop=true where employee_id=payroll_test.id(5,2) and work_date<='2026-09-15';
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select payroll_test.expect('PAY-02/fixed earning allowance prorates and gross reconciles',
 (select jsonb_agg(jsonb_build_object('code',l.code,'amount',l.amount) order by l.code) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=payroll_test.id(5,2) and p.period='2026-09'),
 '[{"code":"BASIC","amount":10000},{"code":"GROSS_1","amount":2500},{"code":"PAY_ALLOWANCE","amount":2500}]');
update public.salary_structures set notes='{"gross_components":[{"name":"Invalid HRA","amount":20000}]}' where employee_id=payroll_test.id(5,2) and effective_from='2026-01-01';
select payroll_test.expect('PAY-03/invalid structure alone rejected',
 to_jsonb(payroll_test.error($q$select public.run_payroll(payroll_test.id(1,1),'2026-09')$q$)),'"23514"');

-- Fractional breakdowns must not become spurious overflow errors due to cent rounding.
delete from public.pay_components;
update public.salary_structures set basic=333.33,gross=1000,notes='{"gross_components":[{"name":"HRA","amount":333.33},{"name":"Travel","amount":333.34}]}' where employee_id=payroll_test.id(5,2) and effective_from='2026-01-01';
reset role;
set request.jwt.claim.sub = '';
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,is_lop) values
 (payroll_test.id(5,2),'2026-08-01','Half Day',0.5,'working',false);
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
select public.run_payroll(payroll_test.id(1,1),'2026-08');
select payroll_test.expect('generation/31-day fractional named breakdown reconciles exactly',
 (select jsonb_build_object('gross',p.gross,'paid',p.paid_days,'lines',count(l.id),'sum',sum(l.amount)) from public.payslips p join public.payslip_lines l on l.payslip_id=p.id where p.employee_id=payroll_test.id(5,2) and p.period='2026-08' group by p.id),
 '{"gross":983.87,"paid":30.5,"lines":3,"sum":983.87}');
select public.delete_draft_payroll((select id from public.payroll_runs where entity_id=payroll_test.id(1,1) and period='2026-08'));
select payroll_test.expect('generation/deleting draft removes slip and its lines',
 (select to_jsonb(count(*)) from public.payslips where employee_id=payroll_test.id(5,2) and period='2026-08'),'0');
update public.salary_structures set basic=20000,gross=30000,notes='{"gross_components":[{"name":"HRA","amount":10000}]}' where employee_id=payroll_test.id(5,2) and effective_from='2026-01-01';
select public.run_payroll(payroll_test.id(1,1),'2026-09');
select set_config('request.jwt.claim.sub',payroll_test.id(4,2)::text,false);
select payroll_test.expect('security/employee cannot read own draft',
 (select to_jsonb(count(*)) from public.payslips where period='2026-09'),'0');
select payroll_test.expect('security/employee cannot read draft lines',
 (select to_jsonb(count(*)) from public.payslip_lines),'2');
select payroll_test.expect('security/employee cannot run payroll',
 to_jsonb(payroll_test.error($q$select public.run_payroll(payroll_test.id(1,1),'2026-09')$q$)),'"P0001"');
select payroll_test.expect('security/employee cannot publish payroll',
 to_jsonb(payroll_test.error($q$select public.publish_payroll(payroll_test.id(6,1))$q$)),'"P0001"');
select set_config('request.jwt.claim.sub',payroll_test.id(4,1)::text,false);
select payroll_test.expect('security/HR cannot run foreign payroll',
 to_jsonb(payroll_test.error($q$select public.run_payroll(payroll_test.id(1,2),'2026-09')$q$)),'"P0001"');
select public.publish_payroll((select id from public.payroll_runs where entity_id=payroll_test.id(1,1) and period='2026-09'));
select public.publish_payroll((select id from public.payroll_runs where entity_id=payroll_test.id(1,1) and period='2026-09'));
select payroll_test.expect('PAY-04/publication marks run and payslip Published',
 (select jsonb_build_object('run',r.status,'slip',p.status) from public.payroll_runs r join public.payslips p on p.run_id=r.id where p.employee_id=payroll_test.id(5,2) and p.period='2026-09'),
 '{"run":"Published","slip":"Published"}');
select payroll_test.expect('security/published period cannot be regenerated',
 to_jsonb(payroll_test.error($q$select public.run_payroll(payroll_test.id(1,1),'2026-09')$q$)),'"P0001"');
select payroll_test.expect('security/published period cannot be deleted',
 to_jsonb(payroll_test.error($q$select public.delete_draft_payroll((select id from public.payroll_runs where entity_id=payroll_test.id(1,1) and period='2026-09'))$q$)),'"23514"');
select set_config('request.jwt.claim.sub',payroll_test.id(4,2)::text,false);
select payroll_test.expect('PAY-04/employee sees own newly published statement',
 (select jsonb_build_object('gross',gross,'deductions',deductions,'net',net) from public.payslips where period='2026-09'),
 '{"gross":15000,"deductions":0,"net":15000}');
select payroll_test.expect('PAY-04/employee sees newly published earning lines',
 (select to_jsonb(count(*)) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.period='2026-09'),'2');
select set_config('request.jwt.claim.sub',payroll_test.id(4,3)::text,false);
select payroll_test.expect('security/foreign employee cannot see new publication',
 (select to_jsonb(count(*)) from public.payslips where period='2026-09'),'0');
reset role;
set request.jwt.claim.sub = '';
select 'PASS: payroll output integrity '||count(*)||' assertions; historical upgrade, arithmetic, rounding, component reconciliation, publication, RLS, and lifecycle controls' from payroll_test.results;
\endif
