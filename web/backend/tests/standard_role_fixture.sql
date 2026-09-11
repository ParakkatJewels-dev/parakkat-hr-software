\set ON_ERROR_STOP on
-- Synthetic identities only. Run after the actual application migration history.
do $$ begin
  if current_database() <> 'hr_role_matrix_audit' then raise exception 'Disposable audit database required'; end if;
end $$;
create schema audit_test;
create function audit_test.id(prefix integer, n integer) returns uuid language sql immutable as $$
  select (prefix::text || '0000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
create table audit_test.actors (
  ordinal integer primary key, key text, user_id uuid, employee_id uuid,
  scope_type public.scope_type, scope_id uuid, visible_targets integer
);
insert into audit_test.actors values
  (1,'super_admin',audit_test.id(6,1),audit_test.id(5,101),'global',null,5),
  (2,'entity_admin',audit_test.id(6,2),audit_test.id(5,102),'entity',audit_test.id(1,1),4),
  (3,'hr_manager',audit_test.id(6,3),audit_test.id(5,103),'entity',audit_test.id(1,1),4),
  (4,'zonal_manager',audit_test.id(6,4),audit_test.id(5,104),'zone',audit_test.id(2,1),3),
  (5,'branch_manager',audit_test.id(6,5),audit_test.id(5,105),'branch',audit_test.id(3,1),2),
  (6,'dept_head',audit_test.id(6,6),audit_test.id(5,106),'department',audit_test.id(4,1),1),
  (7,'employee',audit_test.id(6,7),audit_test.id(5,107),'self',null,0),
  (8,'unassigned',audit_test.id(6,8),audit_test.id(5,108),null,null,0);
insert into public.entities(id,code,name)
  select audit_test.id(1,n),'AUDIT-E'||n,'Audit company '||n from generate_series(1,2)n;
insert into public.zones(id,entity_id,name)
  select audit_test.id(2,n),audit_test.id(1,case when n=3 then 2 else 1 end),'Audit zone '||n from generate_series(1,3)n;
insert into public.branches(id,entity_id,zone_id,code,name)
  select audit_test.id(3,n),audit_test.id(1,case when n=4 then 2 else 1 end),
    audit_test.id(2,case when n<=2 then 1 else n-1 end),'AUDIT-B'||n,'Audit branch '||n from generate_series(1,4)n;
insert into public.departments(id,entity_id,branch_id,name)
  select audit_test.id(4,n),audit_test.id(1,case when n=5 then 2 else 1 end),
    audit_test.id(3,case when n<=2 then 1 else n-1 end),'Audit department '||n from generate_series(1,5)n;
insert into auth.users(id,email)
  select user_id,key||'@audit.invalid' from audit_test.actors
  union all select audit_test.id(7,n),'target'||n||'@audit.invalid' from generate_series(1,5)n;
insert into public.employees(id,entity_id,branch_id,department_id,employee_code,full_name,email,user_id)
  select audit_test.id(5,n),audit_test.id(1,case when n=5 then 2 else 1 end),
    audit_test.id(3,case when n<=2 then 1 else n-1 end),audit_test.id(4,n),'TARGET-'||n,
    'Audit target '||n,'target'||n||'@audit.invalid',audit_test.id(7,n) from generate_series(1,5)n
  union all select employee_id,audit_test.id(1,1),audit_test.id(3,1),audit_test.id(4,1),
    'ACTOR-'||ordinal,'Audit '||key,key||'@audit.invalid',user_id from audit_test.actors;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id;
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select a.user_id,r.id,a.scope_type,a.scope_id from audit_test.actors a join public.roles r on r.key=a.key;
insert into public.attendance(id,employee_id,work_date,status,hours)
  select id,id,'2026-09-01','On Time',8 from public.employees where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
insert into public.leaves(id,employee_id,type,start_date,end_date,days,reason)
  select id,id,'Casual Leave','2026-09-02','2026-09-02',1,'Role audit' from public.employees where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
insert into public.expenses(id,employee_id,amount,status,description)
  select id,id,100,'Pending','Role audit' from public.employees where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
insert into public.tasks(id,employee_id,title,assigned_by)
  select id,id,'Role audit',audit_test.id(5,1) from public.employees where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
insert into public.goals(id,employee_id,title,weight,progress)
  select id,id,'Role audit',100,0 from public.employees where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
insert into public.payslips(id,employee_id,period,gross,deductions,net,status)
  select id,id,'2026-09',1000,100,900,'Published' from public.employees where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
insert into public.payslips(employee_id,period,gross,deductions,net,status)
  select id,'2026-10',1000,100,900,'Draft' from public.employees where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%';
grant usage on schema audit_test to authenticated, anon;
grant select on audit_test.actors to authenticated, anon;
grant execute on function audit_test.id(integer,integer) to authenticated, anon;
