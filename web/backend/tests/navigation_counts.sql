\set ON_ERROR_STOP on
-- The disposable runner replays production migrations before this contract.
do $$ begin
  if current_database()<>'hr_message_requests_audit' then raise exception 'Disposable navigation-count audit database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub='';
create schema audit_navigation;
create function audit_navigation.id(kind integer,n integer) returns uuid language sql immutable as $$
  select ('d51'||lpad(kind::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create function audit_navigation.today() returns date language sql stable as $$select (now() at time zone 'Asia/Kolkata')::date$$;
create function audit_navigation.expect(expected jsonb,self_only boolean default false) returns void language plpgsql as $$
declare actual jsonb:=public.get_navigation_counts(self_only); base jsonb:=public.get_section_counts(self_only);
begin
  assert actual @> expected,format('Expected navigation counts %s; got %s',expected,actual);
  assert actual @> base,'Legacy queues keep their exact semantics';
  assert (select count(*)=15 from jsonb_each(actual)),'Fixed scalar navigation envelope';
  assert not exists(select 1 from jsonb_each(actual) x where jsonb_typeof(x.value)<>'number'
    or x.value::text !~ '^[0-9]+$'),'Counts are nonnegative integers without row payloads';
end $$;
create function audit_navigation.expect_error(statement text,code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then if sqlstate=code then return; end if; raise;
  end;
  raise exception 'Expected SQLSTATE % from %',code,statement;
end $$;
create table audit_navigation.baseline(actor integer primary key,mapping integer not null);
grant usage on schema audit_navigation to authenticated,anon;
grant execute on all functions in schema audit_navigation to authenticated,anon;
grant select,insert on audit_navigation.baseline to authenticated;

insert into public.entities(id,code,name)select audit_navigation.id(1,n),'NAV-E'||n,'Navigation company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name)select audit_navigation.id(2,n),audit_navigation.id(1,n),'NAV-B'||n,'Navigation branch '||n from generate_series(1,2)n;
insert into public.departments(id,entity_id,branch_id,code,name,is_active)select audit_navigation.id(3,n),
  audit_navigation.id(1,case when n=3 then 2 else 1 end),audit_navigation.id(2,case when n=3 then 2 else 1 end),
  'NAV-D'||n,'Navigation department '||n,n<>4 from generate_series(1,4)n;
insert into auth.users(id,email)select audit_navigation.id(4,n),'navigation-'||n||'@audit.invalid' from generate_series(1,11)n;
insert into public.employees(id,entity_id,branch_id,department_id,user_id,employee_code,full_name,status)
  select audit_navigation.id(5,n),audit_navigation.id(1,case when n in(4,5)then 2 else 1 end),
    audit_navigation.id(2,case when n in(4,5)then 2 else 1 end),audit_navigation.id(3,case when n in(4,5)then 3 else 1 end),
    audit_navigation.id(4,n),'NAV-ACTOR-'||n,'Navigation actor '||n,case when n=7 then 'Inactive'else'Active'end
  from generate_series(1,11)n where n<>10;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like'NAV-ACTOR-%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_navigation.id(4,n),r.id,'self'from generate_series(1,9)n cross join public.roles r where r.key='employee'and n<>6;
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)values
  (audit_navigation.id(4,1),(select id from public.roles where key='entity_admin'),'entity',audit_navigation.id(1,1)),
  (audit_navigation.id(4,3),(select id from public.roles where key='dept_head'),'department',audit_navigation.id(3,1)),
  (audit_navigation.id(4,5),(select id from public.roles where key='entity_admin'),'entity',audit_navigation.id(1,2));
insert into public.roles(key,name)values('audit_navigation_reader','Navigation read only'),('audit_navigation_writer','Navigation action without reader or department');
insert into public.role_permissions(role_id,permission_id)select r.id,p.id from public.roles r cross join public.permissions p
  where(r.key='audit_navigation_reader'and p.key in('goal.read','task.read'))
    or(r.key='audit_navigation_writer'and p.key in('performance.manage','task.request','device.manage'));
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)values
  (audit_navigation.id(4,6),(select id from public.roles where key='audit_navigation_reader'),'self',null),
  (audit_navigation.id(4,11),(select id from public.roles where key='audit_navigation_writer'),'department',audit_navigation.id(3,1));
update public.profiles set is_super_admin=true where user_id=audit_navigation.id(4,10);
update auth.users set banned_until=now()+interval'1 day'where id=audit_navigation.id(4,8);
update auth.users set deleted_at=now()where id=audit_navigation.id(4,9);

insert into public.goals(id,employee_id,title,status)values
  (audit_navigation.id(6,1),audit_navigation.id(5,2),'Own active','Active'),
  (audit_navigation.id(6,2),audit_navigation.id(5,2),'Completed goal','Completed'),
  (audit_navigation.id(6,3),audit_navigation.id(5,2),'Dropped goal','Dropped'),
  (audit_navigation.id(6,4),audit_navigation.id(5,1),'Admin own active','Active'),
  (audit_navigation.id(6,5),audit_navigation.id(5,4),'Other company active','Active'),
  (audit_navigation.id(6,6),audit_navigation.id(5,6),'Read only active','Active'),
  (audit_navigation.id(6,7),audit_navigation.id(5,3),'Head own active','Active');
insert into public.payroll_runs(id,entity_id,period,status)values
  (audit_navigation.id(7,1),audit_navigation.id(1,1),'2035-01','Draft'),
  (audit_navigation.id(7,2),audit_navigation.id(1,1),'2035-02','Published'),
  (audit_navigation.id(7,3),audit_navigation.id(1,2),'2035-01','Draft');
insert into public.onboarding(id,entity_id,branch_id,name,progress)values
  (audit_navigation.id(8,1),audit_navigation.id(1,1),audit_navigation.id(2,1),'Partial checklist',20),
  (audit_navigation.id(8,2),audit_navigation.id(1,1),audit_navigation.id(2,1),'Completed checklist',100),
  (audit_navigation.id(8,3),audit_navigation.id(1,1),audit_navigation.id(2,1),'Unset progress',null),
  (audit_navigation.id(8,4),audit_navigation.id(1,2),audit_navigation.id(2,2),'Other company checklist',10);
insert into public.jobs(id,entity_id,branch_id,department_id,title)values
  (audit_navigation.id(9,1),audit_navigation.id(1,1),audit_navigation.id(2,1),audit_navigation.id(3,1),'Local opening'),
  (audit_navigation.id(9,2),audit_navigation.id(1,2),audit_navigation.id(2,2),audit_navigation.id(3,3),'Other company opening');
insert into public.candidates(id,job_id,name,stage)select audit_navigation.id(10,n),audit_navigation.id(9,case when n=7 then 2 else 1 end),
  'Navigation candidate '||n,(array['Applied','Shortlisted','Interview','Offered','Hired','Rejected','Applied'])[n]from generate_series(1,7)n;
insert into public.exits(id,employee_id,status,created_by,approvals)values
  (audit_navigation.id(11,1),audit_navigation.id(5,2),'Clearance in Progress',audit_navigation.id(4,2),'{}'),
  (audit_navigation.id(11,2),audit_navigation.id(5,6),'Cleared',audit_navigation.id(4,6),'{"IT":"Approved","Admin":"Approved","Finance":"Approved","HR":"Approved"}'),
  (audit_navigation.id(11,3),audit_navigation.id(5,1),'Clearance in Progress',audit_navigation.id(4,2),'{}'),
  (audit_navigation.id(11,4),audit_navigation.id(5,3),'Clearance in Progress',audit_navigation.id(4,1),'{}'),
  (audit_navigation.id(11,5),audit_navigation.id(5,4),'Clearance in Progress',audit_navigation.id(4,4),'{}'),
  (audit_navigation.id(11,6),audit_navigation.id(5,2),'Completed',audit_navigation.id(4,2),'{}');
insert into public.help_requests(id,entity_id,from_department_id,from_branch_id,to_department_id,to_branch_id,title,status)
  select audit_navigation.id(12,n),audit_navigation.id(1,1),audit_navigation.id(3,case when n=2 then 1 else 2 end),audit_navigation.id(2,1),
    audit_navigation.id(3,case when n=2 then 2 when n=4 then 4 else 1 end),audit_navigation.id(2,1),'Navigation request '||n,
    case when n=3 then 'Declined'else'Pending'end from generate_series(1,4)n;

-- Daily jobs include a completed occurrence, inactive job, retired set, tomorrow-only set,
-- another employee and an owner with read permission but no right to tick.
insert into public.routine_sets(id,employee_id,title,frequency,start_date,history_start_date,retired_on)
  select audit_navigation.id(13,n),audit_navigation.id(5,case when n=5 then 6 when n=6 then 1 else 2 end),
    'Navigation routine '||n,case when n=3 then 'once'else'daily'end,
    audit_navigation.today()+case when n=3 then 1 when n=4 then -2 else 0 end,audit_navigation.today(),
    case when n=4 then audit_navigation.today()-1 end from generate_series(1,6)n;
insert into public.routine_items(id,routine_id,employee_id,title,is_active)
  select audit_navigation.id(14,n),audit_navigation.id(13,case when n<=3 then 1 else n-2 end),
    audit_navigation.id(5,case when n=7 then 6 when n=8 then 1 else 2 end),'Navigation duty '||n,n<>3 from generate_series(1,8)n;
insert into public.routine_ticks(routine_item_id,employee_id,on_date,done_by)values
  (audit_navigation.id(14,2),audit_navigation.id(5,2),audit_navigation.today(),audit_navigation.id(5,2));

-- Reset generated notifications so the all-history count has a deterministic >1,000-row test.
delete from public.notifications where user_id in(select audit_navigation.id(4,n)from generate_series(1,11)n);
insert into public.notifications(user_id,type,title,created_at,read_at)
  select audit_navigation.id(4,2),'test','Old unread notification '||n,'2000-01-01',null from generate_series(1,1005)n;
insert into public.notifications(user_id,type,title,read_at)values
  (audit_navigation.id(4,2),'test','Read notification',now()),(audit_navigation.id(4,1),'test','Other inbox',null);

do $$ begin
  assert not has_function_privilege('anon','public.get_navigation_counts(boolean)','execute'),'Anonymous cannot execute navigation counts';
  assert has_function_privilege('authenticated','public.get_navigation_counts(boolean)','execute'),'Authenticated count entrypoint';
  assert(select count(*)=13 from pg_publication_tables where pubname='supabase_realtime'and schemaname='public'
    and tablename in('goals','payroll_runs','candidates','jobs','biotime_employees','onboarding','help_requests',
      'routine_sets','routine_items','routine_ticks','exits','notifications','task_assignees')),'All counted queues publish realtime updates';
end $$;
set role anon;
select audit_navigation.expect_error($q$select public.get_navigation_counts()$q$,'42501');
set role authenticated;
select audit_navigation.expect_error($q$select public.get_navigation_counts()$q$,'42501');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000001';
insert into audit_navigation.baseline values(1,(public.get_navigation_counts()->>'attendance_mapping')::integer);
select audit_navigation.expect('{"task_requests":2,"task_routine":1,"performance_mine":1,"performance_team":3,"payroll":1,"onboarding":2,"recruitment":4,"exits":2,"notifications":1}');
select audit_navigation.expect('{"task_requests":0,"task_routine":1,"performance_mine":1,"performance_team":0,"payroll":0,"onboarding":0,"recruitment":0,"exits":0,"notifications":1,"attendance_mapping":0}',true);
select audit_navigation.expect_error($q$select public.get_navigation_counts(null)$q$,'22023');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000002';
select audit_navigation.expect('{"task_requests":0,"task_routine":2,"performance_mine":1,"performance_team":0,"payroll":0,"onboarding":0,"recruitment":0,"exits":0,"notifications":1005,"attendance_mapping":0}');
select audit_navigation.expect('{"task_routine":2,"performance_mine":1,"notifications":1005}',true);
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000003';
select audit_navigation.expect('{"task_requests":1,"performance_mine":1,"performance_team":3,"payroll":0,"onboarding":0,"recruitment":0,"exits":0,"attendance_mapping":0}');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000005';
select audit_navigation.expect('{"task_requests":0,"performance_mine":0,"performance_team":1,"payroll":1,"onboarding":1,"recruitment":1,"exits":1,"notifications":0}');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000006';
select audit_navigation.expect('{"task_requests":0,"task_routine":0,"performance_mine":0,"performance_team":0,"payroll":0,"onboarding":0,"recruitment":0,"exits":0,"notifications":0,"attendance_mapping":0}');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000011';
select audit_navigation.expect('{"task_requests":0,"performance_mine":0,"performance_team":0,"attendance_mapping":0}');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000010';
select audit_navigation.expect('{"tasks":0,"task_requests":0,"task_routine":0,"performance_mine":0,"performance_team":0,"payroll":0,"onboarding":0,"recruitment":0,"exits":0,"notifications":0,"attendance_mapping":0}',true);
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000007';
select audit_navigation.expect_error($q$select public.get_navigation_counts()$q$,'42501');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000008';
select audit_navigation.expect_error($q$select public.get_navigation_counts(true)$q$,'42501');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000009';
select audit_navigation.expect_error($q$select public.get_navigation_counts()$q$,'42501');

-- Scope floor, unresolved states and per-employee correction authority on device mappings.
reset role;
set request.jwt.claim.sub='';
insert into public.biotime_employees(emp_code,link_status,employee_id)values
  ('NAV-UNMATCHED','unmatched',null),('NAV-AMBIGUOUS','ambiguous',null),
  ('NAV-IGNORED','ignored',null),('NAV-FOREIGN-LINK','ambiguous',audit_navigation.id(5,4));
set role authenticated;
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000001';
do $$ begin
  assert(public.get_navigation_counts()->>'attendance_mapping')::integer=(select mapping+2 from audit_navigation.baseline where actor=1),
    'Unresolved shared enrolments count, ignored and foreign held mappings do not';
end $$;
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000003';
select audit_navigation.expect('{"attendance_mapping":0}');

-- Real destination mutations immediately retire their corresponding work items.
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000002';
select public.set_routine_job_tick(audit_navigation.id(14,1),audit_navigation.today(),true);
update public.goals set status='Completed',progress=100 where id=audit_navigation.id(6,1);
update public.notifications set read_at=now()where user_id=auth.uid();
select audit_navigation.expect('{"task_routine":1,"performance_mine":0,"notifications":0}');
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000001';
select public.publish_payroll(audit_navigation.id(7,1));
select public.complete_exit(audit_navigation.id(11,2));
update public.onboarding set progress=100 where id=audit_navigation.id(8,1);
update public.candidates set stage='Hired'where id=audit_navigation.id(10,1);
select public.respond_to_help_request(audit_navigation.id(12,1),false,null,'No capacity');
select public.link_device_code('NAV-UNMATCHED',null,true);
select audit_navigation.expect('{"task_requests":1,"performance_team":2,"payroll":0,"onboarding":1,"recruitment":3,"exits":1}');
do $$ begin
  assert(public.get_navigation_counts()->>'attendance_mapping')::integer=(select mapping+1 from audit_navigation.baseline where actor=1),'Mapping decision refreshes aggregate';
end $$;
reset role;
set request.jwt.claim.sub='';
delete from public.role_assignments where user_id=audit_navigation.id(4,1)and role_id=(select id from public.roles where key='entity_admin');
set role authenticated;
set request.jwt.claim.sub='d5100004-0000-0000-0000-000000000001';
select audit_navigation.expect('{"task_requests":0,"performance_team":0,"payroll":0,"onboarding":0,"recruitment":0,"exits":0,"attendance_mapping":0}');
reset role;
set request.jwt.claim.sub='';
select 'PASS: all navigation queues, role/row scope, own versus team work, due routine jobs, complete inbox, live decisions, revoked and inactive access' as result;
