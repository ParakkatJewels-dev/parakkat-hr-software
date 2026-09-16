\set ON_ERROR_STOP on
-- Run only after replaying the production migrations in the disposable integration cluster.
do $$ begin
  if current_database() <> 'hr_message_requests_audit' then raise exception 'Disposable section-count audit database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub = '';
create schema audit_counts;
create function audit_counts.id(kind integer,n integer) returns uuid language sql immutable as $$
  select ('d41'||lpad(kind::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create function audit_counts.expect_error(statement text, code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = code then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE % from %',code,statement;
end $$;
create function audit_counts.expect(expected jsonb, self_only boolean default false) returns void language plpgsql as $$
declare actual jsonb := public.get_section_counts(self_only);
begin
  assert actual = expected, format('Expected section counts %s; got %s',expected,actual);
  assert (select count(*)=5 from jsonb_each(actual)), 'Only the fixed scalar count envelope is returned';
  assert not exists(select 1 from jsonb_each(actual) x where jsonb_typeof(x.value)<>'number'
    or x.value::text !~ '^[0-9]+$'), 'Counts are nonnegative integers, never employee or request rows';
end $$;
grant usage on schema audit_counts to authenticated,anon;
grant execute on all functions in schema audit_counts to authenticated,anon;

insert into public.entities(id,code,name) select audit_counts.id(1,n),'COUNTS-E'||n,'Count company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name) select audit_counts.id(2,n),audit_counts.id(1,n),'COUNTS-B'||n,'Count branch '||n from generate_series(1,2)n;
insert into public.departments(id,entity_id,branch_id,code,name) select audit_counts.id(3,n),
  audit_counts.id(1,case when n=4 then 2 else 1 end),audit_counts.id(2,case when n=4 then 2 else 1 end),
  'COUNTS-D'||n,case n when 1 then 'Count IT' when 2 then 'Count HR' when 3 then 'Count Sales' else 'Count foreign' end
  from generate_series(1,4)n;
insert into auth.users(id,email) select audit_counts.id(4,n),'section-actor-'||n||'@audit.invalid' from generate_series(1,12)n;
insert into public.employees(id,entity_id,branch_id,department_id,user_id,employee_code,full_name,status)
  select audit_counts.id(5,n),audit_counts.id(1,case when n=7 then 2 else 1 end),
    audit_counts.id(2,case when n=7 then 2 else 1 end),
    audit_counts.id(3,case when n in(2,6,9)then 2 when n in(5,11)then 3 when n=7 then 4 else 1 end),
    audit_counts.id(4,n),'COUNTS-ACTOR-'||n,'Count actor '||n,case when n=8 then 'Inactive' else 'Active' end
  from generate_series(1,12)n;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like 'COUNTS-ACTOR-%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_counts.id(4,n),r.id,'self' from generate_series(1,12)n cross join public.roles r where r.key='employee' and n<>11;
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
  (audit_counts.id(4,1),(select id from public.roles where key='entity_admin'),'entity',audit_counts.id(1,1)),
  (audit_counts.id(4,2),(select id from public.roles where key='hr_manager'),'entity',audit_counts.id(1,1)),
  (audit_counts.id(4,3),(select id from public.roles where key='dept_head'),'department',audit_counts.id(3,1)),
  (audit_counts.id(4,7),(select id from public.roles where key='entity_admin'),'entity',audit_counts.id(1,2)),
  (audit_counts.id(4,8),(select id from public.roles where key='dept_head'),'department',audit_counts.id(3,1)),
  (audit_counts.id(4,9),(select id from public.roles where key='hr_manager'),'entity',audit_counts.id(1,1));
insert into public.roles(key,name) values('audit_count_support','Count support handler');
insert into public.role_permissions(role_id,permission_id) select r.id,p.id from public.roles r cross join public.permissions p
  where r.key='audit_count_support' and p.key='ticket.manage';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_counts.id(4,4),id,'self' from public.roles where key='audit_count_support';
update public.profiles set is_super_admin=true where user_id=audit_counts.id(4,12);
update auth.users set banned_until=now()+interval '1 day' where id=audit_counts.id(4,9);
update auth.users set deleted_at=now() where id=audit_counts.id(4,10);

insert into public.ticket_categories(id,name,entity_id,department_id,branch_id,is_hr_queue) values
  (audit_counts.id(6,1),'Count IT queue',audit_counts.id(1,1),audit_counts.id(3,1),audit_counts.id(2,1),false),
  (audit_counts.id(6,2),'Count HR queue',audit_counts.id(1,1),audit_counts.id(3,2),audit_counts.id(2,1),true),
  (audit_counts.id(6,3),'Count foreign queue',audit_counts.id(1,2),audit_counts.id(3,4),audit_counts.id(2,2),false);
insert into public.tickets(id,employee_id,category_id,subject,status,created_at) values
  (audit_counts.id(7,1),audit_counts.id(5,5),audit_counts.id(6,2),'Sales to HR','Open','2000-01-01'),
  (audit_counts.id(7,2),audit_counts.id(5,5),audit_counts.id(6,1),'Sales to IT','In Progress','2000-01-01'),
  (audit_counts.id(7,3),audit_counts.id(5,5),audit_counts.id(6,1),'Sales to IT held','On Hold','2000-01-01'),
  (audit_counts.id(7,4),audit_counts.id(5,5),audit_counts.id(6,1),'Resolved IT','Resolved','2000-01-01'),
  (audit_counts.id(7,5),audit_counts.id(5,7),audit_counts.id(6,3),'Other company','Open','2000-01-01'),
  (audit_counts.id(7,6),audit_counts.id(5,5),null,'Legacy Sales ticket','Open','2000-01-01'),
  (audit_counts.id(7,7),audit_counts.id(5,4),audit_counts.id(6,2),'IT asking HR','Open','2000-01-01'),
  (audit_counts.id(7,8),audit_counts.id(5,2),audit_counts.id(6,2),'HR own ticket','Open','2000-01-01');
insert into public.tickets(employee_id,category_id,subject,created_at)
  select audit_counts.id(5,5),audit_counts.id(6,1),'Count old unresolved '||n,'2000-01-01' from generate_series(1,105)n;

insert into public.tasks(id,employee_id,title,status,created_at) values
  (audit_counts.id(11,1),audit_counts.id(5,5),'Primary and junction','To Do','2000-01-01'),
  (audit_counts.id(11,2),audit_counts.id(5,4),'Secondary worker','Blocked','2000-01-01'),
  (audit_counts.id(11,3),audit_counts.id(5,5),'Finished','Done','2000-01-01'),
  (audit_counts.id(11,4),audit_counts.id(5,5),'Cancelled','Cancelled','2000-01-01'),
  (audit_counts.id(11,5),audit_counts.id(5,4),'Other employee work','In Progress','2000-01-01'),
  (audit_counts.id(11,6),audit_counts.id(5,5),'Primary worker','In Progress','2000-01-01'),
  (audit_counts.id(11,7),audit_counts.id(5,12),'Administrator own work','To Do','2000-01-01');
insert into public.task_assignees(task_id,employee_id) values
  (audit_counts.id(11,1),audit_counts.id(5,5)),(audit_counts.id(11,2),audit_counts.id(5,5));
insert into public.tasks(employee_id,title,created_at)
  select audit_counts.id(5,5),'Count old active task '||n,'2000-01-01' from generate_series(1,1005)n;

insert into public.leaves(id,employee_id,type,start_date,end_date,days,status) values
  (audit_counts.id(8,1),audit_counts.id(5,5),'Count leave','2035-01-01','2035-01-01',1,'Pending'),
  (audit_counts.id(8,2),audit_counts.id(5,4),'Count leave','2035-01-02','2035-01-02',1,'Pending'),
  (audit_counts.id(8,3),audit_counts.id(5,4),'Count leave','2035-01-03','2035-01-03',1,'On Hold'),
  (audit_counts.id(8,4),audit_counts.id(5,3),'Count leave','2035-01-04','2035-01-04',1,'Pending'),
  (audit_counts.id(8,5),audit_counts.id(5,2),'Count leave','2035-01-05','2035-01-05',1,'Pending'),
  (audit_counts.id(8,6),audit_counts.id(5,1),'Count leave','2035-01-06','2035-01-06',1,'Pending'),
  (audit_counts.id(8,7),audit_counts.id(5,4),'Count leave','2035-01-07','2035-01-07',1,'Pending'),
  (audit_counts.id(8,8),audit_counts.id(5,5),'Count leave','2035-01-08','2035-01-08',1,'Rejected');
insert into public.attendance(employee_id,work_date,status,is_locked)
  values(audit_counts.id(5,4),'2035-01-07','Absent',true);
insert into public.expenses(id,employee_id,amount,status,created_by) values
  (audit_counts.id(9,1),audit_counts.id(5,5),100,'Pending',audit_counts.id(4,5)),
  (audit_counts.id(9,2),audit_counts.id(5,5),100,'Pending',audit_counts.id(4,2)),
  (audit_counts.id(9,3),audit_counts.id(5,2),100,'Pending',audit_counts.id(4,5)),
  (audit_counts.id(9,4),audit_counts.id(5,5),100,'Approved',audit_counts.id(4,5)),
  (audit_counts.id(9,5),audit_counts.id(5,7),100,'Pending',audit_counts.id(4,7)),
  (audit_counts.id(9,6),audit_counts.id(5,1),100,'Pending',audit_counts.id(4,5)),
  (audit_counts.id(9,7),audit_counts.id(5,4),100,'Pending',audit_counts.id(4,5));
insert into public.attendance_regularizations(id,employee_id,work_date,check_in,reason,status)
  select audit_counts.id(10,n),audit_counts.id(5,case n when 1 then 5 when 2 then 4 when 3 then 2 when 4 then 3 when 5 then 7 else 4 end),
    date '2035-02-01'+n,timestamptz '2035-02-01 09:00+05:30'+n*interval '1 day','Count correction',case when n=6 then 'Rejected' else 'Pending' end
  from generate_series(1,6)n;

do $$ begin
  assert not has_function_privilege('anon','public.get_section_counts(boolean)','execute'), 'Anonymous cannot execute counts';
  assert has_function_privilege('authenticated','public.get_section_counts(boolean)','execute'), 'Authenticated users can request their own summary';
  assert exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='task_assignees'), 'Secondary assignment removal is published';
  assert (select relreplident='f' from pg_class where oid='public.task_assignees'::regclass), 'Assignment change events retain replica identity';
end $$;
set role anon;
select audit_counts.expect_error($q$select public.get_section_counts()$q$,'42501');
set role authenticated;
select audit_counts.expect_error($q$select public.get_section_counts()$q$,'42501');

-- Ordinary requester: own tasks include a second assignee and all old work, with no page cap.
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000005';
select audit_counts.expect('{"tasks":1008,"leave":0,"expense":0,"attendance":0,"helpdesk":0}');
select audit_counts.expect('{"tasks":1008,"leave":0,"expense":0,"attendance":0,"helpdesk":0}',true);
select audit_counts.expect_error($q$select public.get_section_counts(null)$q$,'22023');

-- Count receiving-department work only when the user can actually handle it; read-only staff see zero.
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000004';
select audit_counts.expect('{"tasks":2,"leave":0,"expense":0,"attendance":0,"helpdesk":107}');
select audit_counts.expect('{"tasks":2,"leave":0,"expense":0,"attendance":0,"helpdesk":0}',true);
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000006';
select audit_counts.expect('{"tasks":0,"leave":0,"expense":0,"attendance":0,"helpdesk":0}');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000003';
select audit_counts.expect('{"tasks":0,"leave":3,"expense":0,"attendance":1,"helpdesk":107}');

-- HR sees manageable company tickets across receiving departments and only the current HR leave stage.
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000002';
select audit_counts.expect('{"tasks":0,"leave":2,"expense":3,"attendance":3,"helpdesk":111}');
select audit_counts.expect('{"tasks":0,"leave":0,"expense":0,"attendance":0,"helpdesk":0}',true);
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000001';
select audit_counts.expect('{"tasks":0,"leave":3,"expense":4,"attendance":4,"helpdesk":111}');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000007';
select audit_counts.expect('{"tasks":0,"leave":0,"expense":0,"attendance":0,"helpdesk":1}');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000011';
select audit_counts.expect('{"tasks":0,"leave":0,"expense":0,"attendance":0,"helpdesk":0}');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000012';
select audit_counts.expect('{"tasks":1,"leave":0,"expense":0,"attendance":0,"helpdesk":0}',true);

-- Blocked identities cannot use the RPC as an alternate scope/data entrypoint.
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000008';
select audit_counts.expect_error($q$select public.get_section_counts()$q$,'42501');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000009';
select audit_counts.expect_error($q$select public.get_section_counts(true)$q$,'42501');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000010';
select audit_counts.expect_error($q$select public.get_section_counts()$q$,'42501');

-- Genuine decisions and membership changes immediately change the next summary.
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000003';
select public.decide_leave(audit_counts.id(8,2),'Approved','Department coverage confirmed');
select public.set_ticket_status(audit_counts.id(7,2),'Resolved');
select audit_counts.expect('{"tasks":0,"leave":2,"expense":0,"attendance":1,"helpdesk":106}');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000002';
select audit_counts.expect('{"tasks":0,"leave":3,"expense":3,"attendance":3,"helpdesk":110}');
select public.decide_leave(audit_counts.id(8,2),'Approved','HR sanction recorded');
update public.expenses set status='Approved' where id=audit_counts.id(9,1);
update public.attendance_regularizations set status='Approved' where id=audit_counts.id(10,1);
select audit_counts.expect('{"tasks":0,"leave":2,"expense":2,"attendance":2,"helpdesk":110}');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000004';
delete from public.task_assignees where task_id=audit_counts.id(11,2) and employee_id=audit_counts.id(5,5);
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000005';
select audit_counts.expect('{"tasks":1007,"leave":0,"expense":0,"attendance":0,"helpdesk":0}');
update public.tasks set status='Done' where id=audit_counts.id(11,6);
select audit_counts.expect('{"tasks":1006,"leave":0,"expense":0,"attendance":0,"helpdesk":0}');

-- Removing the only active head transfers outstanding department review to HR, while locked
-- leave remains non-actionable. Revoked handling permission also removes the support badge.
reset role;
set request.jwt.claim.sub='';
delete from public.role_assignments where user_id=audit_counts.id(4,3) and role_id=(select id from public.roles where key='dept_head');
delete from public.role_assignments where user_id=audit_counts.id(4,4) and role_id=(select id from public.roles where key='audit_count_support');
set role authenticated;
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000002';
select audit_counts.expect('{"tasks":0,"leave":4,"expense":2,"attendance":2,"helpdesk":110}');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000003';
select audit_counts.expect('{"tasks":0,"leave":0,"expense":0,"attendance":0,"helpdesk":0}');
set request.jwt.claim.sub='d4100004-0000-0000-0000-000000000004';
select audit_counts.expect('{"tasks":2,"leave":0,"expense":0,"attendance":0,"helpdesk":0}');
reset role;
set request.jwt.claim.sub='';
select 'PASS: compact scoped section counts, current leave stage/locks, ownership exclusions, multi-assignee tasks, receiving support queues, live transitions and inactive/anonymous denials' as result;
