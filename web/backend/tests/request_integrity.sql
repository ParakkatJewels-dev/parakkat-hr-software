\set ON_ERROR_STOP on
-- Run after the full migration replay; every fixture/write is rolled back.
do $$ begin
  if current_database() not in ('hr_message_requests_audit','hr_request_integrity_audit') then
    raise exception 'Disposable request-integrity database required';
  end if;
end $$;
begin;
reset role;
set local request.jwt.claim.sub='';
create schema audit_request;
create function audit_request.id(kind integer,n integer) returns uuid language sql immutable as $$
  select ('d42'||lpad(kind::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create function audit_request.fail(statement text,code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate=code then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE % for %',code,statement;
end $$;
grant usage on schema audit_request to authenticated,anon;
grant execute on all functions in schema audit_request to authenticated,anon;
insert into public.entities(id,code,name) select audit_request.id(1,n),'REQUEST-E'||n,'Request company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name) select audit_request.id(2,n),audit_request.id(1,n),'REQUEST-B'||n,'Request branch '||n from generate_series(1,2)n;
insert into auth.users(id,email) select audit_request.id(3,n),'request-actor-'||n||'@audit.invalid' from generate_series(1,5)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name,status)
  select audit_request.id(4,n),audit_request.id(1,case when n=5 then 2 else 1 end),
    audit_request.id(2,case when n=5 then 2 else 1 end),audit_request.id(3,n),
    'REQUEST-ACTOR-'||n,'Request actor '||n,'Active' from generate_series(1,5)n;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like 'REQUEST-ACTOR-%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_request.id(3,n),r.id,'self' from generate_series(1,5)n cross join public.roles r where r.key='employee';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select audit_request.id(3,n),r.id,'entity',audit_request.id(1,case when n=5 then 2 else 1 end)
    from generate_series(2,5)n cross join public.roles r where r.key='hr_manager';
update public.profiles set is_super_admin=true where user_id=audit_request.id(3,4);

set local role authenticated;
select set_config('request.jwt.claim.sub',audit_request.id(3,1)::text,true);
select audit_request.fail($q$insert into public.expenses(employee_id,amount,status) values(audit_request.id(4,1),100,'Approved')$q$,'42501');
select audit_request.fail($q$insert into public.expenses(employee_id,amount,status) values(audit_request.id(4,1),100,'Paid')$q$,'42501');
select audit_request.fail($q$insert into public.expenses(employee_id,amount) values(audit_request.id(4,1),-100)$q$,'23514');
select audit_request.fail($q$insert into public.expenses(employee_id,amount) values(audit_request.id(4,1),'NaN')$q$,'23514');
select audit_request.fail($q$insert into public.expenses(employee_id,amount) values(audit_request.id(4,1),'Infinity')$q$,'23514');
select audit_request.fail($q$insert into public.expenses(employee_id,amount) values(audit_request.id(4,1),'-Infinity')$q$,'23514');
insert into public.expenses(id,employee_id,amount,created_by,approver_id)
  values(audit_request.id(5,1),audit_request.id(4,1),0,audit_request.id(3,2),audit_request.id(4,2));
do $$ begin
  assert (select created_by=audit_request.id(3,1) and approver_id is null and status='Pending' from public.expenses where id=audit_request.id(5,1)), 'filer and initial decision are authoritative';
end $$;
select audit_request.fail($q$insert into public.attendance_regularizations(employee_id,work_date,check_in,reason,status) values(audit_request.id(4,1),'2026-09-16','2026-09-16 09:00+05:30','Forgot punch','Approved')$q$,'42501');
insert into public.attendance_regularizations(id,employee_id,work_date,check_in,reason,requested_by,decided_by,decided_at)
  values(audit_request.id(6,1),audit_request.id(4,1),'2026-09-16','2026-09-16 09:00+05:30','Forgot punch',audit_request.id(3,2),audit_request.id(3,2),now());
do $$ begin
  assert (select requested_by=audit_request.id(3,1) and decided_by is null and decided_at is null and status='Pending'
    from public.attendance_regularizations where id=audit_request.id(6,1)), 'regularization cannot forge request or decision metadata';
end $$;
select audit_request.fail($q$insert into public.exits(employee_id,status,approvals) values(audit_request.id(4,1),'Completed','{"IT":"Approved","Admin":"Approved","Finance":"Approved","HR":"Approved"}')$q$,'42501');
select audit_request.fail($q$insert into public.exits(employee_id,approvals) values(audit_request.id(4,1),'{"IT":"Approved","Admin":"Pending","Finance":"Pending","HR":"Pending"}')$q$,'42501');
insert into public.exits(id,employee_id,reason,created_by) values(audit_request.id(7,1),audit_request.id(4,1),'Resignation',audit_request.id(3,2));
select audit_request.fail($q$select public.decide_exit_clearance(audit_request.id(7,1),'IT','Approved')$q$,'42501');

-- Managers can file their own and delegated requests but cannot decide either.
select set_config('request.jwt.claim.sub',audit_request.id(3,2)::text,true);
insert into public.expenses(id,employee_id,amount) values
  (audit_request.id(5,2),audit_request.id(4,2),100),(audit_request.id(5,3),audit_request.id(4,1),100);
select audit_request.fail($q$update public.expenses set status='Approved' where id=audit_request.id(5,2)$q$,'42501');
select audit_request.fail($q$update public.expenses set status='Paid' where id=audit_request.id(5,2)$q$,'42501');
select audit_request.fail($q$update public.expenses set status='Draft' where id=audit_request.id(5,2)$q$,'42501');
select audit_request.fail($q$update public.expenses set status='Approved',created_by=null where id=audit_request.id(5,3)$q$,'42501');
select audit_request.fail($q$update public.expenses set created_by=audit_request.id(3,3) where id=audit_request.id(5,3)$q$,'42501');
select audit_request.fail($q$update public.expenses set employee_id=audit_request.id(4,3) where id=audit_request.id(5,3)$q$,'42501');
select audit_request.fail($q$update public.expenses set branch_id=null where id=audit_request.id(5,3)$q$,'42501');
select audit_request.fail($q$update public.expenses set status='Paid' where id=audit_request.id(5,1)$q$,'22023');
select audit_request.fail($q$update public.expenses set status='Draft' where id=audit_request.id(5,1)$q$,'22023');
select audit_request.fail($q$update public.expenses set status='Approved',amount=999 where id=audit_request.id(5,1)$q$,'42501');
update public.expenses set status='Approved',approver_id=audit_request.id(4,5) where id=audit_request.id(5,1);
do $$ begin
  assert (select status='Approved' and approver_id=audit_request.id(4,2) from public.expenses where id=audit_request.id(5,1)), 'reviewer is server-stamped';
end $$;
select audit_request.fail($q$update public.expenses set amount=999 where id=audit_request.id(5,1)$q$,'42501');
update public.expenses set status='Paid',approver_id=null where id=audit_request.id(5,1);
do $$ begin
  assert (select status='Paid' and approver_id=audit_request.id(4,2) and amount=0 from public.expenses where id=audit_request.id(5,1)), 'payment preserves independent approval';
end $$;
update public.attendance_regularizations set status='Approved',decided_by=audit_request.id(3,5),decided_at='2000-01-01',approver_id=audit_request.id(4,5)
  where id=audit_request.id(6,1);
do $$ begin
  assert (select status='Approved' and decided_by=audit_request.id(3,2) and approver_id=audit_request.id(4,2) and decided_at>'2000-01-02'
    from public.attendance_regularizations where id=audit_request.id(6,1)), 'correction decision identity/time is authoritative';
end $$;
select audit_request.fail($q$update public.attendance_regularizations set check_in='2026-09-16 08:00+05:30' where id=audit_request.id(6,1)$q$,'42501');
select audit_request.fail($q$update public.attendance_regularizations set status='Pending' where id=audit_request.id(6,1)$q$,'22023');
insert into public.attendance_regularizations(id,employee_id,work_date,check_in,reason)
  values(audit_request.id(6,2),audit_request.id(4,1),'2026-09-17','2026-09-17 09:00+05:30','Filed for employee');
select audit_request.fail($q$update public.attendance_regularizations set status='Approved' where id=audit_request.id(6,2)$q$,'42501');
insert into public.exits(id,employee_id) values(audit_request.id(7,2),audit_request.id(4,2)),(audit_request.id(7,3),audit_request.id(4,1));
select audit_request.fail($q$select public.decide_exit_clearance(audit_request.id(7,2),'IT','Approved')$q$,'42501');
select audit_request.fail($q$select public.decide_exit_clearance(audit_request.id(7,3),'IT','Approved')$q$,'42501');
select audit_request.fail($q$update public.exits set status='Completed' where id=audit_request.id(7,1)$q$,'42501');
select audit_request.fail($q$update public.exits set approvals='{"IT":"Approved"}' where id=audit_request.id(7,1)$q$,'42501');
select audit_request.fail($q$update public.exits set created_by=null where id=audit_request.id(7,3)$q$,'42501');
select audit_request.fail($q$select public.complete_exit(audit_request.id(7,1))$q$,'22023');
select audit_request.fail($q$select public.decide_exit_clearance(audit_request.id(7,1),'Other','Approved')$q$,'22023');
select public.decide_exit_clearance(audit_request.id(7,1),'IT','Approved');
select public.decide_exit_clearance(audit_request.id(7,1),'Admin','Approved');
select public.decide_exit_clearance(audit_request.id(7,1),'Finance','Approved');
select public.decide_exit_clearance(audit_request.id(7,1),'HR','Rejected');
do $$ begin
  assert (select status='Clearance in Progress' and approvals->>'HR'='Rejected' and approvals->>'IT'='Approved' from public.exits where id=audit_request.id(7,1)), 'department decisions preserve other approvals';
end $$;
select public.decide_exit_clearance(audit_request.id(7,1),'HR','Approved');
do $$ begin assert (select status='Cleared' from public.exits where id=audit_request.id(7,1)), 'all four approvals clear exit'; end $$;
select public.decide_exit_clearance(audit_request.id(7,1),'IT','Rejected');
select audit_request.fail($q$select public.complete_exit(audit_request.id(7,1))$q$,'22023');
select public.decide_exit_clearance(audit_request.id(7,1),'IT','Approved');
select public.complete_exit(audit_request.id(7,1));
select audit_request.fail($q$select public.decide_exit_clearance(audit_request.id(7,1),'IT','Rejected')$q$,'22023');
select audit_request.fail($q$update public.exits set reason='Changed after completion' where id=audit_request.id(7,1)$q$,'42501');

select set_config('request.jwt.claim.sub',audit_request.id(3,5)::text,true);
select audit_request.fail($q$select public.decide_exit_clearance(audit_request.id(7,2),'IT','Approved')$q$,'42501');
select audit_request.fail($q$select public.complete_exit(audit_request.id(7,1))$q$,'42501');
do $$ begin assert (select count(*) from public.exits where id=audit_request.id(7,1))=0,'cross-company read stays closed'; end $$;
select set_config('request.jwt.claim.sub',audit_request.id(3,3)::text,true);
update public.expenses set status='Approved' where id=audit_request.id(5,3);
select set_config('request.jwt.claim.sub',audit_request.id(3,2)::text,true);
select audit_request.fail($q$update public.expenses set status='Paid' where id=audit_request.id(5,3)$q$,'42501');
select set_config('request.jwt.claim.sub',audit_request.id(3,4)::text,true);
insert into public.expenses(id,employee_id,amount) values(audit_request.id(5,4),audit_request.id(4,4),100);
select audit_request.fail($q$update public.expenses set status='Approved' where id=audit_request.id(5,4)$q$,'42501');
insert into public.exits(id,employee_id) values(audit_request.id(7,4),audit_request.id(4,4));
select audit_request.fail($q$select public.decide_exit_clearance(audit_request.id(7,4),'IT','Approved')$q$,'42501');
reset role;
set local request.jwt.claim.sub='';
do $$ begin
  assert (select status='Completed' and created_by=audit_request.id(3,1) from public.exits where id=audit_request.id(7,1)), 'exit completed only through verified lifecycle';
  assert (select count(*) from public.audit_log where table_name='exits' and row_id=audit_request.id(7,1)
    and actor=audit_request.id(3,2) and action like 'EXIT_%')=8,'clearance decisions and completion are audited';
  assert not has_function_privilege('anon','public.decide_exit_clearance(uuid,text,text)','execute'),'anonymous cannot clear exits';
  assert not has_function_privilege('anon','public.complete_exit(uuid)','execute'),'anonymous cannot complete exits';
end $$;
-- Owner/import path remains available, without relaxing the universal amount constraint.
insert into public.expenses(employee_id,amount,status) values(audit_request.id(4,1),50,'Paid');
select audit_request.fail($q$insert into public.expenses(employee_id,amount) values(audit_request.id(4,1),-1)$q$,'23514');
rollback;
select 'PASS: request entry states, immutable filer/identity, finite amounts, independent decisions, scoped exit clearance lifecycle and audit' as result;
