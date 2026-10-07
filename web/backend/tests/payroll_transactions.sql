\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'hr_payroll_integrity_audit' then raise exception 'Disposable payroll integrity database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub='';
create schema transaction_test;
create table transaction_test.results(label text primary key);
create function transaction_test.expect(label text,actual jsonb,expected jsonb) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception '%: expected %, got %',label,expected,actual; end if;
  insert into transaction_test.results values(label);
end $$;
create function transaction_test.error(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
create function transaction_test.advance(_n integer) returns uuid language sql stable as $$
 select id from public.payroll_advances where request_id=register_test.id(8,_n);
$$;
create function transaction_test.recover(_n integer,_period text,_amount numeric) returns jsonb language sql as $$
 select public.save_payroll_advance_recovery(transaction_test.advance(_n),_period,_amount,
   (select updated_at from public.payroll_advance_recoveries where advance_id=transaction_test.advance(_n) and period=_period));
$$;
create function transaction_test.run_id() returns uuid language sql stable security definer set search_path=pg_catalog,public,register_test as $$
 select id from public.payroll_runs where entity_id=register_test.id(1,61) and period='2028-01';
$$;
create function transaction_test.payment(_employee integer,_status text,_reason text default null,_reference text default null) returns jsonb language sql as $$
 select public.set_payroll_payment_status(transaction_test.run_id(),register_test.id(4,_employee),_status,_reason,_reference,
   (select updated_at from public.payroll_payments where run_id=transaction_test.run_id() and employee_id=register_test.id(4,_employee)));
$$;
grant usage on schema transaction_test to authenticated,anon;
grant execute on all functions in schema transaction_test to authenticated,anon;
grant select,insert on transaction_test.results to authenticated,anon;
insert into public.entities(id,code,name) values(register_test.id(1,61),'TX-E','Payroll transactions company');
insert into public.branches(id,entity_id,code,name) values
 (register_test.id(2,61),register_test.id(1,61),'TX-B1','Transactions branch one'),
 (register_test.id(2,62),register_test.id(1,61),'TX-B2','Transactions branch two');
insert into auth.users(id,email) select register_test.id(3,n),'transactions-'||n||'@audit.invalid' from generate_series(61,64)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name,status,join_date) values
 (register_test.id(4,61),register_test.id(1,61),register_test.id(2,61),register_test.id(3,62),'TX-EMP1','Transactions employee','Active','2027-01-01'),
 (register_test.id(4,62),register_test.id(1,61),register_test.id(2,62),null,'TX-EMP2','Second transactions employee','Active','2027-01-01');
update public.profiles set employee_id=register_test.id(4,61) where user_id=register_test.id(3,62);
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
 (register_test.id(3,61),(select id from public.roles where key='hr_manager'),'entity',register_test.id(1,61)),
 (register_test.id(3,62),(select id from public.roles where key='employee'),'self',null),
 (register_test.id(3,63),(select id from public.roles where key='hr_manager'),'branch',register_test.id(2,61)),
 (register_test.id(3,64),(select id from public.roles where key='hr_manager'),'branch',register_test.id(2,62));
insert into public.salary_structures(employee_id,effective_from,basic,gross)
 values(register_test.id(4,61),'2027-01-01',20000,30000),(register_test.id(4,62),'2027-01-01',10000,20000);
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes,computed_at)
 select register_test.id(4,n),d::date,'Present',1,'working',480,clock_timestamp()
 from generate_series(61,62)n cross join generate_series('2028-01-01'::date,'2028-01-31'::date,'1 day')d;
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,61)::text,false);
select public.save_payroll_policy(register_test.id(1,61),'{}');
select public.run_payroll(register_test.id(1,61),'2028-01');
select transaction_test.expect('payments/draft cannot track payment',to_jsonb(transaction_test.error($q$select transaction_test.payment(61,'held','Review')$q$)),'"23514"');
select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":1000,"reason":"Annual bonus"}',register_test.id(7,61));
select transaction_test.expect('sources/adjustment makes existing draft stale',
 (select to_jsonb(needs_recalculation) from public.payroll_runs where id=transaction_test.run_id()),'true');
select transaction_test.expect('sources/stale adjustment draft cannot publish',
 to_jsonb(transaction_test.error($q$select register_test.publish(transaction_test.run_id())$q$)),'"55000"');
select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":1000,"reason":"Annual bonus"}',register_test.id(7,61));
select transaction_test.expect('adjustment/retry keeps one entry',(select to_jsonb(count(*)) from public.payroll_adjustments where id=register_test.id(7,61)),'1');
select transaction_test.expect('adjustment/stale version rejects overwrite',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":2000,"reason":"Changed bonus"}',register_test.id(7,61))$q$)),'"40001"');
select transaction_test.expect('adjustment/unknown fields rejected',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":1,"reason":"Reason","entity_id":"invalid"}')$q$)),'"22023"');
select transaction_test.expect('adjustment/reason required',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"deduction","amount":100,"reason":" "}')$q$)),'"23514"');
select transaction_test.expect('adjustment/unknown kind rejected',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"earning","amount":100,"reason":"Reason"}')$q$)),'"23514"');
select transaction_test.expect('adjustment/fractional cents rejected',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":0.001,"reason":"Reason"}')$q$)),'"23514"');
select transaction_test.expect('adjustment/nonfinite rejected',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":"NaN","reason":"Reason"}')$q$)),'"23514"');
select transaction_test.expect('adjustment/outside employment rejected',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2026-01','{"kind":"bonus","amount":100,"reason":"Reason"}')$q$)),'"23514"');
select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"incentive","amount":250,"reason":"Sales incentive"}',register_test.id(7,62));
select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"deduction","amount":200,"reason":"Agreed recovery"}',register_test.id(7,63));
select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"deduction","amount":100,"reason":"Agreed recovery corrected"}',register_test.id(7,63),
 (select updated_at from public.payroll_adjustments where id=register_test.id(7,63)));
select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"deduction","amount":500,"reason":"Uniform recovery"}',register_test.id(7,64));
select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":99,"reason":"Mistaken draft"}',register_test.id(7,65));
select transaction_test.expect('adjustment/stale delete rejected',
 to_jsonb(transaction_test.error($q$select public.delete_payroll_adjustment(register_test.id(7,65),null)$q$)),'"40001"');
select public.delete_payroll_adjustment(register_test.id(7,65),(select updated_at from public.payroll_adjustments where id=register_test.id(7,65)));
select transaction_test.expect('adjustment/delete leaves audit evidence',
 (select to_jsonb(count(*)) from public.payroll_transaction_history where source_table='payroll_adjustments' and action='DELETE' and before_value->>'id'=register_test.id(7,65)::text),'1');

select public.create_payroll_advance(register_test.id(4,61),'2027-12-15',6000,'Salary advance',register_test.id(8,61));
select public.create_payroll_advance(register_test.id(4,61),'2027-12-15',6000,'Salary advance',register_test.id(8,61));
select transaction_test.expect('advance/retry issues only once',(select to_jsonb(count(*)) from public.payroll_advances where request_id=register_test.id(8,61)),'1');
select transaction_test.expect('advance/reused request different amount rejected',
 to_jsonb(transaction_test.error($q$select public.create_payroll_advance(register_test.id(4,61),'2027-12-15',7000,'Salary advance',register_test.id(8,61))$q$)),'"40001"');
select transaction_test.expect('advance/negative amount rejected',
 to_jsonb(transaction_test.error($q$select public.create_payroll_advance(register_test.id(4,61),'2027-12-15',-1,'Salary advance',register_test.id(8,62))$q$)),'"23514"');
select transaction_test.expect('advance/infinite date rejected',
 to_jsonb(transaction_test.error($q$select public.create_payroll_advance(register_test.id(4,61),'infinity',100,'Salary advance',register_test.id(8,62))$q$)),'"23514"');
select transaction_test.expect('recovery/before issue month rejected',
 to_jsonb(transaction_test.error($q$select transaction_test.recover(61,'2027-11',100)$q$)),'"23514"');
select transaction_test.recover(61,'2028-01',1500);
select transaction_test.recover(61,'2028-02',1500);
select transaction_test.expect('recovery/over-allocation rejected',
 to_jsonb(transaction_test.error($q$select transaction_test.recover(61,'2028-03',4000)$q$)),'"23514"');
select transaction_test.recover(61,'2028-01',4500);
select transaction_test.expect('recovery/edit excludes its prior amount from ceiling',
 (select to_jsonb(sum(amount)) from public.payroll_advance_recoveries where advance_id=transaction_test.advance(61)),'6000');
select transaction_test.recover(61,'2028-01',1500);
select transaction_test.expect('recovery/stale version rejected',
 to_jsonb(transaction_test.error($q$select public.save_payroll_advance_recovery(transaction_test.advance(61),'2028-01',1000,null)$q$)),'"40001"');
select transaction_test.expect('recovery/legacy amount cannot coexist',
 to_jsonb(transaction_test.error($q$select register_test.save_input(register_test.id(4,61),'2028-01','{"advance_recovery":100}')$q$)),'"23514"');
select register_test.save_input(register_test.id(4,61),'2028-03','{"advance_recovery":100}');
select transaction_test.expect('recovery/schedule cannot coexist with legacy amount',
 to_jsonb(transaction_test.error($q$select transaction_test.recover(61,'2028-03',1000)$q$)),'"23514"');
select transaction_test.expect('advance/allocated advance cannot void',
 to_jsonb(transaction_test.error($q$select public.void_payroll_advance(transaction_test.advance(61),'Mistaken entry',(select updated_at from public.payroll_advances where id=transaction_test.advance(61)))$q$)),'"23514"');
select public.create_payroll_advance(register_test.id(4,61),'2027-12-15',100,'Mistaken advance',register_test.id(8,62));
select transaction_test.recover(62,'2028-02',50);
select transaction_test.recover(62,'2028-02',0);
select public.void_payroll_advance(transaction_test.advance(62),'Duplicate entry',(select updated_at from public.payroll_advances where id=transaction_test.advance(62)));
select transaction_test.expect('advance/void stays in history',
 (select to_jsonb(voided_at is not null and void_reason='Duplicate entry') from public.payroll_advances where id=transaction_test.advance(62)),'true');
select transaction_test.expect('advance/void blocks new recovery',
 to_jsonb(transaction_test.error($q$select transaction_test.recover(62,'2028-02',50)$q$)),'"23514"');

select set_config('request.jwt.claim.sub',register_test.id(3,62)::text,false);
select transaction_test.expect('security/self employee cannot read management entries',
 jsonb_build_array((select count(*) from public.payroll_adjustments),(select count(*) from public.payroll_advances),(select count(*) from public.payroll_advance_recoveries),(select count(*) from public.payroll_transaction_history)), '[0,0,0,0]');
select transaction_test.expect('security/self employee cannot create advance',
 to_jsonb(transaction_test.error($q$select public.create_payroll_advance(register_test.id(4,61),'2027-12-15',100,'Request',register_test.id(8,63))$q$)),'"42501"');
select set_config('request.jwt.claim.sub',register_test.id(3,64)::text,false);
select transaction_test.expect('security/other branch cannot read entries',
 (select to_jsonb(count(*)) from public.payroll_adjustments),'0');
select transaction_test.expect('security/other branch cannot change adjustment',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":1,"reason":"Forbidden"}')$q$)),'"42501"');
select set_config('request.jwt.claim.sub',register_test.id(3,63)::text,false);
select transaction_test.expect('security/branch HR sees only own entries',
 (select to_jsonb(count(*)) from public.payroll_adjustments),'4');
select transaction_test.expect('security/direct insert cannot bypass RPC',
 to_jsonb(transaction_test.error($q$insert into public.payroll_advances(request_id,entity_id,employee_id,issued_on,amount,reason) values(gen_random_uuid(),register_test.id(1,61),register_test.id(4,61),'2028-01-01',1,'Bypass')$q$)),'"42501"');
select set_config('request.jwt.claim.sub',register_test.id(3,61)::text,false);
select public.run_payroll(register_test.id(1,61),'2028-01');
select transaction_test.expect('engine/itemized amounts reconcile without double count',
 (select jsonb_build_array(gross,deductions,net,payroll_register->'bonus',payroll_register->'incentive',payroll_register->'other_deductions',payroll_register->'advance_recovery',
   payroll_register->'adjustment_incentive',payroll_register->'adjustment_deductions',payroll_register->'ledger_advance_recovery',payroll_register->'schema_version')
 from public.payslips where employee_id=register_test.id(4,61) and period='2028-01'),'[31250,2100,29150,1000,250,600,1500,250,600,1500,4]');
select transaction_test.expect('engine/individual deduction reasons preserved on payslip',
 (select to_jsonb(count(*)) from public.payslip_lines l join public.payslips p on p.id=l.payslip_id where p.run_id=transaction_test.run_id()
 and l.name in ('Deduction: Agreed recovery corrected','Deduction: Uniform recovery','Advance recovery: Salary advance')),'3');
reset role;
set request.jwt.claim.sub='';
update public.payslips set payroll_register=jsonb_set(payroll_register,'{adjustment_incentive}','251')
 where employee_id=register_test.id(4,61) and period='2028-01';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,61)::text,false);
select transaction_test.expect('publication/tampered transaction metadata rejected',
 to_jsonb(transaction_test.error($q$select register_test.publish(transaction_test.run_id())$q$)),'"23514"');
select public.run_payroll(register_test.id(1,61),'2028-01');
select transaction_test.expect('engine/company totals include itemized transactions',
 (select jsonb_build_array(total_gross,total_net) from public.payroll_runs where id=transaction_test.run_id()),'[51250,49150]');
select public.publish_payroll(id,source_fingerprint) from public.payroll_runs where id=transaction_test.run_id();
select transaction_test.expect('payments/publish starts unpaid without changing earnings',
 (select jsonb_agg(status order by employee_id) from public.payroll_payments where run_id=transaction_test.run_id()),'["unpaid","unpaid"]');
select transaction_test.expect('publication/recovery cannot be changed',
 to_jsonb(transaction_test.error($q$select transaction_test.recover(61,'2028-01',0)$q$)),'"55000"');
select transaction_test.expect('publication/adjustment cannot be removed',
 to_jsonb(transaction_test.error($q$select public.delete_payroll_adjustment(register_test.id(7,61),(select updated_at from public.payroll_adjustments where id=register_test.id(7,61)))$q$)),'"55000"');
select transaction_test.expect('publication/new bonus cannot be appended',
 to_jsonb(transaction_test.error($q$select public.save_payroll_adjustment(register_test.id(4,61),'2028-01','{"kind":"bonus","amount":1,"reason":"Late bonus"}')$q$)),'"55000"');
select transaction_test.expect('payments/hold reason required',
 to_jsonb(transaction_test.error($q$select transaction_test.payment(61,'held')$q$)),'"23514"');
select set_config('request.jwt.claim.sub',register_test.id(3,63)::text,false);
select transaction_test.payment(61,'held','Employee requested delayed payment');
select transaction_test.expect('security/branch recovery RPC distinguishes published from scheduled without company totals',
 (select jsonb_agg(jsonb_build_array(value->>'period',value->'posted') order by value->>'period') from jsonb_array_elements(public.get_payroll_advance_recoveries(register_test.id(1,61)))),
 '[["2028-01",true],["2028-02",false]]');
select transaction_test.expect('payments/branch HR can hold own salary',
 (select to_jsonb(status) from public.payroll_payments where run_id=transaction_test.run_id() and employee_id=register_test.id(4,61)),'"held"');
select transaction_test.expect('payments/branch HR cannot hold other branch',
 to_jsonb(transaction_test.error($q$select transaction_test.payment(62,'held','Forbidden hold')$q$)),'"42501"');
select transaction_test.expect('payments/held salary cannot mark paid',
 to_jsonb(transaction_test.error($q$select transaction_test.payment(61,'paid',null,'BANK-1')$q$)),'"23514"');
select transaction_test.expect('payments/stale hold release rejected',
 to_jsonb(transaction_test.error($q$select public.set_payroll_payment_status(transaction_test.run_id(),register_test.id(4,61),'unpaid',null,null,null)$q$)),'"40001"');
select transaction_test.payment(61,'unpaid');
select transaction_test.expect('payments/paid reference required',
 to_jsonb(transaction_test.error($q$select transaction_test.payment(61,'paid')$q$)),'"23514"');
select transaction_test.payment(61,'paid',null,'BANK-2028-001');
select transaction_test.expect('payments/paid reference and timestamp stored',
 (select jsonb_build_array(status,payment_reference,paid_at is not null,hold_reason) from public.payroll_payments where run_id=transaction_test.run_id() and employee_id=register_test.id(4,61)),
 '["paid","BANK-2028-001",true,null]');
select transaction_test.expect('payments/recorded payment cannot undo',
 to_jsonb(transaction_test.error($q$select transaction_test.payment(61,'unpaid')$q$)),'"55000"');
select transaction_test.expect('payments/hold release and payment never change salary owed',
 (select jsonb_build_array(status,gross,deductions,net) from public.payslips where employee_id=register_test.id(4,61) and period='2028-01'),'["Published",31250,2100,29150]');
select transaction_test.expect('payments/audit preserves hold release and paid sequence',
 (select jsonb_agg(after_value->'status' order by changed_at) from public.payroll_transaction_history where source_table='payroll_payments' and employee_id=register_test.id(4,61)),
 '["unpaid","held","unpaid","paid"]');
-- Upgrade compatibility: already published payroll has no newly invented payment history.
select set_config('request.jwt.claim.sub',register_test.id(3,1)::text,false);
select public.set_payroll_payment_status((select id from public.payroll_runs where entity_id=register_test.id(1,1) and period='2026-09'),register_test.id(4,1),'held','Legacy payment pending');
select transaction_test.expect('upgrade/legacy published salary can start payment tracking',
 (select to_jsonb(status) from public.payroll_payments where employee_id=register_test.id(4,1)),'"held"');
reset role;
set request.jwt.claim.sub='';
select transaction_test.expect('audit/ledger history cannot be rewritten',
 to_jsonb(transaction_test.error($q$update public.payroll_transaction_history set action='CHANGED' where employee_id=register_test.id(4,61)$q$)),'"55000"');
select transaction_test.expect('advance/issued principal immutable even by import owner',
 to_jsonb(transaction_test.error($q$update public.payroll_advances set amount=9000 where request_id=register_test.id(8,61)$q$)),'"55000"');
select transaction_test.expect('payments/table requires a hold reason even for imports',
 to_jsonb(transaction_test.error($q$update public.payroll_payments set status='held',hold_reason=null where employee_id=register_test.id(4,62)$q$)),'"23514"');
select transaction_test.expect('payments/table requires a payment reference even for imports',
 to_jsonb(transaction_test.error($q$update public.payroll_payments set status='paid',paid_at=now(),payment_reference=null where employee_id=register_test.id(4,62)$q$)),'"23514"');
select transaction_test.expect('payments/import owner cannot delete recorded payment',
 to_jsonb(transaction_test.error($q$delete from public.payroll_payments where employee_id=register_test.id(4,61)$q$)),'"55000"');
select transaction_test.expect('security/anonymous writes closed',
 jsonb_build_array(has_function_privilege('anon','public.create_payroll_advance(uuid,date,numeric,text,uuid)','execute'),
 has_function_privilege('anon','public.set_payroll_payment_status(uuid,uuid,text,text,text,timestamptz)','execute')),'[false,false]');
select 'PASS: payroll transactions '||count(*)||' assertions; reasoned adjustments, advance allocations, duplicate protection, holds and payments, immutable audit and scope' from transaction_test.results;
