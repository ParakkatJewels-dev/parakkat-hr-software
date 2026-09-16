\set ON_ERROR_STOP on
-- QA only: run after testRoleMatrix in a disposable cluster. Successful probe writes roll back.
do $$ begin
  if current_database() <> 'hr_role_matrix_audit' then raise exception 'Disposable role database required'; end if;
end $$;
create table audit_test.extra_results(label text primary key, passed boolean, actual jsonb, expected jsonb);
grant select,insert on audit_test.extra_results to authenticated;
create function audit_test.extra_expect(_label text,_actual jsonb,_expected jsonb) returns void
language sql as $$ insert into audit_test.extra_results values (_label,_actual is not distinct from _expected,_actual,_expected) $$;
create function audit_test.extra_attempt(_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  begin
    execute _sql into v;
    raise exception using errcode='PZ001',message='Rollback QA mutation';
  exception when sqlstate 'PZ001' then null;
    when others then v:=jsonb_build_object('denied',true,'sqlstate',sqlstate,'message',sqlerrm);
  end;
  return v;
end $$;
create function audit_test.extra_expect_denied(_label text,_sql text) returns void language plpgsql as $$
declare v jsonb;
begin
  v:=audit_test.extra_attempt(_sql);
  insert into audit_test.extra_results values(_label,coalesce((v->>'denied')::boolean,false),v,'{"denied":true}');
end $$;
create function audit_test.approve_own_through_draft() returns jsonb language plpgsql as $$
declare v jsonb;
begin
  update public.expenses set status='Draft' where id=app.current_employee_id();
  update public.expenses set status='Approved' where id=app.current_employee_id() returning jsonb_build_object('status',status) into v;
  return v;
end $$;
grant execute on all functions in schema audit_test to authenticated;

-- Give the role personas different real designation records as well as different grants.
insert into public.designations(entity_id,department_id,title)
 select audit_test.id(1,1),audit_test.id(4,1),'QA '||case ordinal
   when 1 then 'Group Director' when 2 then 'Company Director' when 3 then 'HR Manager'
   when 4 then 'Zonal Sales Manager' when 5 then 'Store Manager' when 6 then 'Department Supervisor'
   when 7 then 'Sales Associate' else 'Unassigned Clerk' end
 from audit_test.actors;
update public.employees e set designation_id=d.id
 from audit_test.actors a join public.designations d on d.title='QA '||case a.ordinal
   when 1 then 'Group Director' when 2 then 'Company Director' when 3 then 'HR Manager'
   when 4 then 'Zonal Sales Manager' when 5 then 'Store Manager' when 6 then 'Department Supervisor'
   when 7 then 'Sales Associate' else 'Unassigned Clerk' end
 where e.id=a.employee_id;

-- Broaden exact read-scope checks to modules absent from the existing seven-role row matrix.
insert into public.documents(id,employee_id,title,url) select id,id,'Additional QA personal file','https://fixture.invalid/private.pdf' from public.employees
 where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
insert into public.exits(id,employee_id,reason) select id,id,'Additional QA exit' from public.employees
 where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
insert into public.jobs(id,entity_id,branch_id,department_id,title)
 select id,entity_id,branch_id,department_id,'Additional QA job' from public.employees where employee_code like 'TARGET-%';
insert into public.candidates(id,job_id,name) select id,id,'Additional QA candidate' from public.jobs where title='Additional QA job';
insert into public.onboarding(id,entity_id,branch_id,department_id,name)
 select id,entity_id,branch_id,department_id,'Additional QA joiner' from public.employees where employee_code like 'TARGET-%';

set role authenticated;
do $$
declare a record; tbl text; actual jsonb; expected jsonb;
begin
  for a in select * from audit_test.actors order by ordinal loop
    perform set_config('request.jwt.claim.sub',a.user_id::text,true);
    foreach tbl in array array['documents','exits','jobs','candidates','onboarding'] loop
      execute format('select coalesce(jsonb_agg(id::text order by id),''[]''::jsonb) from public.%I where id between %L and %L or id=%L',
        tbl,audit_test.id(5,1),audit_test.id(5,5),a.employee_id) into actual;
      select coalesce(jsonb_agg(eid::text order by eid),'[]'::jsonb) into expected from (
        select audit_test.id(5,n) eid from generate_series(1,5)n where a.ordinal<=3 and n<=a.visible_targets
        union all select a.employee_id where tbl in ('documents','exits') and (a.key<>'unassigned' or tbl='exits')
      ) s;
      perform audit_test.extra_expect(a.key||'/'||tbl||'/exact visible rows',actual,expected);
    end loop;
  end loop;
end $$;

select set_config('request.jwt.claim.sub',audit_test.id(6,7)::text,false);
select audit_test.extra_expect('employee/designation/cannot rewrite own designation',audit_test.extra_attempt($q$
 with x as (update public.employees set designation_id=null where id=app.current_employee_id() returning id)
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from x$q$),'[]');
select audit_test.extra_expect('employee/expense/pending control',audit_test.extra_attempt($q$
 with x as (insert into public.expenses(employee_id,amount,status) values(app.current_employee_id(),100,'Pending') returning status)
 select to_jsonb(x) from x$q$),'{"status":"Pending"}');
select audit_test.extra_expect_denied('employee/expense/cannot insert Approved',$q$
 with x as (insert into public.expenses(employee_id,amount,status) values(app.current_employee_id(),100,'Approved') returning status,amount)
 select to_jsonb(x) from x$q$);
select audit_test.extra_expect_denied('employee/expense/cannot insert Paid',$q$
 with x as (insert into public.expenses(employee_id,amount,status) values(app.current_employee_id(),100,'Paid') returning status,amount)
 select to_jsonb(x) from x$q$);
select audit_test.extra_expect_denied('employee/expense/cannot insert negative amount',$q$
 with x as (insert into public.expenses(employee_id,amount,status) values(app.current_employee_id(),-100,'Pending') returning status,amount)
 select to_jsonb(x) from x$q$);
select audit_test.extra_expect_denied('employee/expense/cannot forge filer',$q$
 with x as (insert into public.expenses(employee_id,amount,status,created_by) values(app.current_employee_id(),100,'Pending',audit_test.id(6,3)) returning created_by)
 select to_jsonb(x) from x$q$);
select audit_test.extra_expect_denied('employee/exit/cannot self-certify clearance',$q$
 with x as (insert into public.exits(employee_id,reason,status,approvals) values(app.current_employee_id(),'QA exit','Completed',
 '{"IT":"Approved","Admin":"Approved","Finance":"Approved","HR":"Approved"}') returning status,approvals)
 select to_jsonb(x) from x$q$);
select audit_test.extra_expect_denied('employee/regularization/cannot insert Approved',$q$
 with x as (insert into public.attendance_regularizations(employee_id,work_date,check_in,check_out,reason,status)
 values(app.current_employee_id(),'2026-09-16','2026-09-16 09:00+05:30','2026-09-16 17:30+05:30','QA request','Approved') returning status,work_date)
 select to_jsonb(x) from x$q$);

select set_config('request.jwt.claim.sub',audit_test.id(6,5)::text,false);
select audit_test.extra_expect_denied('branch_manager/expense/cannot approve own Pending control',$q$
 with x as (update public.expenses set status='Approved' where id=app.current_employee_id() returning status)
 select to_jsonb(x) from x$q$);
select audit_test.extra_expect_denied('branch_manager/expense/cannot pay own Pending',$q$
 with x as (update public.expenses set status='Paid' where id=app.current_employee_id() returning status)
 select to_jsonb(x) from x$q$);
select audit_test.extra_expect_denied('branch_manager/expense/cannot self-approve through Draft',$q$
 select audit_test.approve_own_through_draft()$q$);
reset role;
select set_config('request.jwt.claim.sub','',false);
-- Captured server fixture representing a manager filing another person's claim.
update public.expenses set created_by=audit_test.id(6,5) where id=audit_test.id(5,1);
set role authenticated;
select set_config('request.jwt.claim.sub',audit_test.id(6,5)::text,false);
select audit_test.extra_expect_denied('branch_manager/expense/cannot approve filed claim control',$q$
 with x as (update public.expenses set status='Approved' where id=audit_test.id(5,1) returning status)
 select to_jsonb(x) from x$q$);
select audit_test.extra_expect_denied('branch_manager/expense/cannot erase filer and approve',$q$
 with x as (update public.expenses set status='Approved',created_by=null where id=audit_test.id(5,1) returning status,created_by)
 select to_jsonb(x) from x$q$);
reset role;
select set_config('request.jwt.claim.sub','',false);

-- Account-deactivation behavior is reported separately because existing access JWT expiry
-- may be an explicitly accepted policy; these calls use already-issued actor identity.
update public.employees set status='Inactive' where id=audit_test.id(5,103);
set role authenticated;
select set_config('request.jwt.claim.sub',audit_test.id(6,3)::text,false);
select audit_test.extra_expect('inactive HR/employee rows revoked',to_jsonb((select count(*) from public.employees where employee_code like 'TARGET-%')),'0');
reset role;
select set_config('request.jwt.claim.sub','',false);
update public.employees set status='Active' where id=audit_test.id(5,103);
update auth.users set banned_until=now()+interval '1 day' where id=audit_test.id(6,3);
set role authenticated;
select set_config('request.jwt.claim.sub',audit_test.id(6,3)::text,false);
select audit_test.extra_expect('banned HR/employee rows revoked',to_jsonb((select count(*) from public.employees where employee_code like 'TARGET-%')),'0');
reset role;
select set_config('request.jwt.claim.sub','',false);
update auth.users set banned_until=null where id=audit_test.id(6,3);

select jsonb_build_object('label',label,'passed',passed,'actual',actual,'expected',expected) as probe_result
 from audit_test.extra_results order by label;
select jsonb_build_object('total',count(*),'passed',count(*) filter(where passed),'failed',count(*) filter(where not passed)) as probe_summary from audit_test.extra_results;
