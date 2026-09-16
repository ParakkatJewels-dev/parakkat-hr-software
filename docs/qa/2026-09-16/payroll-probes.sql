\set ON_ERROR_STOP on
-- QA only. Full application schema on an independent, disposable PostgreSQL cluster.
do $$ begin
  if current_database() <> 'hr_role_matrix_audit' then raise exception 'Disposable role database required'; end if;
end $$;
create table audit_test.payroll_results(label text primary key, passed boolean, actual jsonb, expected jsonb);
grant select,insert on audit_test.payroll_results to authenticated;
create function audit_test.payroll_expect(_label text,_actual jsonb,_expected jsonb) returns void
language sql as $$ insert into audit_test.payroll_results values (_label,_actual is not distinct from _expected,_actual,_expected) $$;
create function audit_test.payroll_error(_sql text) returns text language plpgsql as $$
begin execute _sql; return 'accepted'; exception when others then return sqlstate; end $$;
grant execute on all functions in schema audit_test to authenticated;

-- Exactly one eligible synthetic employee. No configured payroll catalog exists in the baseline.
delete from public.salary_structures;
delete from public.pay_components;
delete from public.payslips where employee_id=audit_test.id(5,107);
delete from public.attendance where employee_id=audit_test.id(5,107);
insert into public.salary_structures(employee_id,effective_from,basic,gross,notes)
values(audit_test.id(5,107),'2026-01-01',20000,30000,'{"gross_components":[{"name":"HRA","amount":10000}]}'),
 (audit_test.id(5,107),'2026-10-01',40000,60000,null);
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,is_lop)
 select audit_test.id(5,107),d::date,'Present',1,'working',false
 from generate_series('2026-09-01'::date,'2026-09-30'::date,'1 day')d;

set role authenticated;
select set_config('request.jwt.claim.sub',audit_test.id(6,3)::text,false);
select public.run_payroll(audit_test.id(1,1),'2026-09');
select audit_test.payroll_expect('control/full-month salary and future structure excluded',
 (select jsonb_build_object('gross',gross,'net',net,'paid',paid_days,'lop',lop_days) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),
 '{"gross":30000,"net":30000,"paid":30,"lop":0}');
select audit_test.payroll_expect('control/named salary lines equal agreed gross',
 (select jsonb_agg(jsonb_build_object('code',l.code,'amount',l.amount) order by l.code) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=audit_test.id(5,107) and period='2026-09'),
 '[{"code":"BASIC","amount":20000},{"code":"GROSS_1","amount":10000}]');
select public.run_payroll(audit_test.id(1,1),'2026-09');
select audit_test.payroll_expect('control/rerun creates one payslip and two lines',
 (select jsonb_build_object('payslips',count(distinct p.id),'lines',count(l.id)) from public.payslips p join public.payslip_lines l on l.payslip_id=p.id where p.employee_id=audit_test.id(5,107) and p.period='2026-09'),
 '{"payslips":1,"lines":2}');
select audit_test.payroll_expect('control/basic above gross rejected',to_jsonb(audit_test.payroll_error($q$insert into public.salary_structures(employee_id,effective_from,basic,gross) values(audit_test.id(5,107),'2026-11-01',100,50)$q$)),'"23514"');

reset role;
update public.attendance set status='Absent',day_fraction=0 where employee_id=audit_test.id(5,107) and work_date='2026-09-02';
update public.attendance set status='Half Day',day_fraction=0.5 where employee_id=audit_test.id(5,107) and work_date='2026-09-03';
set role authenticated;
select public.run_payroll(audit_test.id(1,1),'2026-09');
select audit_test.payroll_expect('PAY-01/absence and half-day reduce payable days',
 (select jsonb_build_object('gross',gross,'paid',paid_days,'lop',lop_days) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),
 '{"gross":28500,"paid":28.5,"lop":1.5}');

reset role;
update public.attendance set status='Present',day_fraction=1,is_lop=false where employee_id=audit_test.id(5,107);
update public.attendance set status='On Leave',day_fraction=0,is_lop=true where employee_id=audit_test.id(5,107) and work_date<='2026-09-15';
set role authenticated;
select public.run_payroll(audit_test.id(1,1),'2026-09');
select audit_test.payroll_expect('control/explicit LOP prorates salary',
 (select jsonb_build_object('gross',gross,'paid',paid_days,'lop',lop_days) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),
 '{"gross":15000,"paid":15,"lop":15}');
insert into public.pay_components(code,name,kind,calc_type,amount,prorate_on_lop,entity_id)
values ('QA_FIXED','QA fixed deduction','deduction','fixed',3000,true,audit_test.id(1,1));
select public.run_payroll(audit_test.id(1,1),'2026-09');
select audit_test.payroll_expect('PAY-02/fixed deduction obeys Reduce with unpaid days',
 (select jsonb_build_object('gross',gross,'deductions',deductions,'net',net) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),
 '{"gross":15000,"deductions":1500,"net":13500}');

delete from public.pay_components where code='QA_FIXED';
insert into public.pay_components(code,name,kind,calc_type,rate,cap_base,max_amount,prorate_on_lop,employer_share,entity_id)
values ('QA_PERCENT','QA percent cap','deduction','percent_of_basic',10,5000,400,true,false,audit_test.id(1,1)),
 ('QA_EMPLOYER','QA employer cost','deduction','percent_of_gross',3,null,null,true,true,audit_test.id(1,1));
insert into public.pay_components(code,name,kind,calc_type,amount,min_gross,max_gross,is_active,entity_id)
values ('QA_MIN','QA not eligible min','deduction','fixed',100,40000,null,true,audit_test.id(1,1)),
 ('QA_MAX','QA not eligible max','deduction','fixed',100,null,10000,true,audit_test.id(1,1)),
 ('QA_INACTIVE','QA disabled','deduction','fixed',100,null,null,false,audit_test.id(1,1));
reset role;
insert into public.pay_components(code,name,kind,calc_type,amount,entity_id)
values('QA_OTHER_ENTITY','QA different company','deduction','fixed',100,audit_test.id(1,2));
set role authenticated;
select public.run_payroll(audit_test.id(1,1),'2026-09');
select audit_test.payroll_expect('control/percent base cap amount cap employer cost and eligibility scope',
 (select jsonb_build_object('gross',gross,'deductions',deductions,'net',net,'employer_cost',employer_cost) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),
 '{"gross":15000,"deductions":400,"net":14600,"employer_cost":450}');

reset role;
delete from public.pay_components;
update public.attendance set status='Present',day_fraction=1,is_lop=false where employee_id=audit_test.id(5,107);
set role authenticated;
insert into public.pay_components(code,name,kind,calc_type,amount,entity_id)
values('QA_ALLOWANCE','Allowance part of gross','earning','fixed',5000,audit_test.id(1,1));
select public.run_payroll(audit_test.id(1,1),'2026-09');
select audit_test.payroll_expect('PAY-03/named structure and part-of-gross component preserve agreed gross',
 (select jsonb_build_object('gross',gross,'net',net) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),
 '{"gross":30000,"net":30000}');
delete from public.pay_components where code='QA_ALLOWANCE';
select public.run_payroll(audit_test.id(1,1),'2026-09');
select set_config('request.jwt.claim.sub',audit_test.id(6,7)::text,false);
select audit_test.payroll_expect('control/employee cannot read own draft',
 (select to_jsonb(count(*)) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),'0');
select audit_test.payroll_expect('control/employee cannot run payroll',
 to_jsonb(audit_test.payroll_error($q$select public.run_payroll(audit_test.id(1,1),'2026-09')$q$)),'"P0001"');
select set_config('request.jwt.claim.sub',audit_test.id(6,3)::text,false);
select public.publish_payroll((select id from public.payroll_runs where entity_id=audit_test.id(1,1) and period='2026-09'));
select audit_test.payroll_expect('control/publish marks run Published',
 (select to_jsonb(status) from public.payroll_runs where entity_id=audit_test.id(1,1) and period='2026-09'),'"Published"');
select audit_test.payroll_expect('control/rerunning published payroll rejected',
 to_jsonb(audit_test.payroll_error($q$select public.run_payroll(audit_test.id(1,1),'2026-09')$q$)),'"P0001"');
select audit_test.payroll_expect('control/deleting published payroll rejected',
 to_jsonb(audit_test.payroll_error($q$select public.delete_draft_payroll((select id from public.payroll_runs where entity_id=audit_test.id(1,1) and period='2026-09'))$q$)),'"23514"');
select audit_test.payroll_expect('PAY-04/published payslip uses employee-visible status',
 (select to_jsonb(status) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),'"Published"');
select set_config('request.jwt.claim.sub',audit_test.id(6,7)::text,false);
select audit_test.payroll_expect('PAY-04/employee can read own payslip after publication',
 (select to_jsonb(count(*)) from public.payslips where employee_id=audit_test.id(5,107) and period='2026-09'),'1');
select audit_test.payroll_expect('PAY-04/employee can read published earning lines',
 (select to_jsonb(count(*)) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.employee_id=audit_test.id(5,107) and p.period='2026-09'),'2');
reset role;
select to_jsonb(r) from audit_test.payroll_results r order by label;
select jsonb_build_object('total',count(*),'passed',count(*) filter(where passed),'failed',count(*) filter(where not passed)) from audit_test.payroll_results;
