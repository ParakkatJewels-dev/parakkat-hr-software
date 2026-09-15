\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'hr_message_requests_audit' then raise exception 'Disposable routine audit database required'; end if;
end $$;
\if :routine_seed
reset role;
set request.jwt.claim.sub='';
create schema audit_routine;
create function audit_routine.id(kind integer,n integer) returns uuid language sql immutable as $$
  select ('e40'||lpad(kind::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create function audit_routine.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create table audit_routine.refs(key text primary key,id uuid not null);
create function audit_routine.ref(key text) returns uuid language sql stable as $$select r.id from audit_routine.refs r where r.key=$1$$;
create function audit_routine.expect_error(statement text,code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then if sqlstate=code then return; end if; raise;
  end;
  raise exception 'Expected SQLSTATE % from %',code,statement;
end $$;
grant usage on schema audit_routine to authenticated,anon;
grant execute on all functions in schema audit_routine to authenticated,anon;
grant select,insert,update on audit_routine.refs to authenticated;
insert into public.entities(id,code,name)select audit_routine.id(1,n),'ROUTINE-E'||n,'Routine company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name)select audit_routine.id(2,n),audit_routine.id(1,n),'ROUTINE-B'||n,'Routine branch '||n from generate_series(1,2)n;
insert into public.departments(id,entity_id,branch_id,code,name)select audit_routine.id(3,n),audit_routine.id(1,case when n=3 then 2 else 1 end),
  audit_routine.id(2,case when n=3 then 2 else 1 end),'ROUTINE-D'||n,'Routine department '||n from generate_series(1,3)n;
insert into public.designations(id,entity_id,department_id,title)values
  (audit_routine.id(8,1),audit_routine.id(1,1),audit_routine.id(3,1),'Routine Operator');
insert into auth.users(id,email)select audit_routine.id(4,n),'routine-actor-'||n||'@audit.invalid' from generate_series(1,9)n;
insert into public.employees(id,entity_id,branch_id,department_id,designation_id,user_id,employee_code,full_name,status)
  select audit_routine.id(5,n),audit_routine.id(1,case when n=6 then 2 else 1 end),audit_routine.id(2,case when n=6 then 2 else 1 end),
    audit_routine.id(3,case when n=5 then 2 when n=6 then 3 else 1 end),case when n in(3,4)then audit_routine.id(8,1)end,
    audit_routine.id(4,n),'ROUTINE-ACTOR-'||n,'Routine actor '||n,case when n=7 then 'Inactive'else'Active'end from generate_series(1,9)n;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like'ROUTINE-ACTOR-%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_routine.id(4,n),r.id,'self' from generate_series(1,9)n cross join public.roles r where r.key='employee';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)values
  (audit_routine.id(4,1),(select id from public.roles where key='entity_admin'),'entity',audit_routine.id(1,1)),
  (audit_routine.id(4,2),(select id from public.roles where key='dept_head'),'department',audit_routine.id(3,1)),
  (audit_routine.id(4,8),(select id from public.roles where key='hr_manager'),'entity',audit_routine.id(1,1));
insert into public.roles(key,name)values('audit_routine_writer','Routine writer without read');
insert into public.role_permissions(role_id,permission_id)select r.id,p.id from public.roles r cross join public.permissions p
  where r.key='audit_routine_writer'and p.key in('task.create','task.update');
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select audit_routine.id(4,9),id,'department',audit_routine.id(3,1)from public.roles where key='audit_routine_writer';
insert into public.routine_items(id,employee_id,title,is_active,created_at)values
  (audit_routine.id(6,1),audit_routine.id(5,3),'Legacy active job',true,now()-interval'10 days'),
  (audit_routine.id(6,2),audit_routine.id(5,3),'Legacy retired job',false,now()-interval'10 days'),
  (audit_routine.id(6,3),audit_routine.id(5,5),'Other department legacy job',true,now()-interval'10 days');
insert into public.routine_ticks(id,routine_item_id,employee_id,on_date,done_by)values
  (audit_routine.id(7,1),audit_routine.id(6,1),audit_routine.id(5,3),audit_routine.today()-2,audit_routine.id(5,3)),
  (audit_routine.id(7,2),audit_routine.id(6,2),audit_routine.id(5,3),audit_routine.today()-3,audit_routine.id(5,3)),
  (audit_routine.id(7,3),audit_routine.id(6,1),audit_routine.id(5,4),audit_routine.today()-1,audit_routine.id(5,4)),
  (audit_routine.id(7,4),audit_routine.id(6,1),audit_routine.id(5,3),audit_routine.today()+1,audit_routine.id(5,3)),
  (audit_routine.id(7,5),audit_routine.id(6,2),audit_routine.id(5,3),audit_routine.today(),audit_routine.id(5,3));
\else
reset role;
set request.jwt.claim.sub='';
do $$ begin
  assert (select count(*)=3 from public.routine_ticks where id in(audit_routine.id(7,1),audit_routine.id(7,2),audit_routine.id(7,5))),
    'all legitimate legacy tick UUIDs survive migration';
  assert (select count(*)=2 from app.routine_tick_quarantine where id in(audit_routine.id(7,3),audit_routine.id(7,4))),
    'cross-owner and future legacy ticks are quarantined without inventing completions';
  assert not exists(select 1 from public.routine_ticks where id in(audit_routine.id(7,3),audit_routine.id(7,4))),
    'invalid ticks no longer reserve the real owner occurrence';
  assert (select count(*)=1 from public.routine_sets where employee_id=audit_routine.id(5,3)and is_legacy),
    'legacy jobs are grouped once per employee even after migration rerun';
  assert not has_table_privilege('authenticated','public.routine_ticks','insert,update,delete'),'ticks are RPC-only';
  assert not has_table_privilege('authenticated','public.routine_items','insert,update,delete'),'job history cannot be deleted or reassigned';
  assert not has_table_privilege('authenticated','public.routine_sets','insert,update,delete'),'schedule versions are RPC-only';
  assert not has_function_privilege('anon','public.routine_day(date,uuid)','execute'),'anonymous routine access denied';
  assert exists(select 1 from pg_publication_tables where pubname='supabase_realtime'and tablename='routine_sets'),'routine definitions publish live updates';
end $$;
insert into audit_routine.refs select'legacy',id from public.routine_sets where employee_id=audit_routine.id(5,3)and is_legacy;
set role anon;
select audit_routine.expect_error($q$select public.list_routine_sets()$q$,'42501');
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000003';
do $$ begin
  assert (select scheduled=1 and completed=0 and missed=0 and pending=1 and unscored_done_jobs=3
    and history_start_date=audit_routine.today()from public.routine_completion_stats(audit_routine.today()-5,audit_routine.today())
    where routine_id=audit_routine.ref('legacy')),'legacy expected work starts today and all prior/inactive completions stay unscored';
  assert (select scheduled=0 and unscored_done_jobs=2 from public.routine_completion_stats(audit_routine.today()-5,audit_routine.today()-1)
    where routine_id=audit_routine.ref('legacy')),'old retirement dates are not invented';
  assert (select count(*)=1 from public.routine_day(audit_routine.today())),'employee reads only active due own jobs';
end $$;
select audit_routine.expect_error($q$insert into public.routine_ticks(routine_item_id,employee_id,on_date,done_by)
  values(audit_routine.id(6,3),audit_routine.id(5,3),audit_routine.today(),audit_routine.id(5,3))$q$,'42501');
select audit_routine.expect_error($q$delete from public.routine_items where id=audit_routine.id(6,1)$q$,'42501');
select audit_routine.expect_error($q$update public.routine_ticks set done_at='2000-01-01',done_by=audit_routine.id(5,2)where id=audit_routine.id(7,1)$q$,'42501');
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3)],'Unauthorized','[{"title":"Job"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()))$q$,'42501');

-- Every employee is checked before an atomic definition/job batch writes anything.
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000002';
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3),audit_routine.id(5,5)],'Atomic failure','[{"title":"Job"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()))$q$,'42501');
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3),audit_routine.id(5,7)],'Inactive batch','[{"title":"Job"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()))$q$,'42501');
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3)],'Malformed batch','[{"title":"Good"},{"title":""}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()))$q$,'22023');
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3)],E'\n\t','[{"title":"Job"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()))$q$,'22023');
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3)],'Blank job',jsonb_build_array(jsonb_build_object('title',E'\n\t')),
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()))$q$,'22023');
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3)],'Backdated','[{"title":"Job"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()-1))$q$,'22023');
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3)],'Bad interval','[{"title":"Job"}]',
  jsonb_build_object('frequency','interval','interval_days',0,'start_date',audit_routine.today()))$q$,'22023');
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,3)],'Bad weekly','[{"title":"Job"}]',
  jsonb_build_object('frequency','weekly','weekdays','[0,8]'::jsonb,'start_date',audit_routine.today()))$q$,'22023');
do $$ declare _result jsonb; begin
  assert not exists(select 1 from public.routine_sets where title in('Atomic failure','Inactive batch','Malformed batch')),'failed batches write no assignments';
  _result:=public.create_routine_set(array[audit_routine.id(5,3),audit_routine.id(5,4),audit_routine.id(5,3)],'Start checks',
    '[{"title":"Check temperatures","detail":"Record reading"},{"title":"Sign register"}]',jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  assert (_result->>'assigned_count')::integer=2,'bulk assignment deduplicates people';
  assert (select count(*)=4 from public.routine_items i join public.routine_sets s on s.id=i.routine_id where s.batch_id=(_result->>'batch_id')::uuid),
    'all jobs are saved for every selected employee';
end $$;
insert into audit_routine.refs select'checks3',id from public.routine_sets where title='Start checks'and employee_id=audit_routine.id(5,3);
insert into audit_routine.refs select'checks4',id from public.routine_sets where title='Start checks'and employee_id=audit_routine.id(5,4);
insert into audit_routine.refs select'job3a',id from public.routine_items where routine_id=audit_routine.ref('checks3')and sort_order=0;
insert into audit_routine.refs select'job3b',id from public.routine_items where routine_id=audit_routine.ref('checks3')and sort_order=1;
insert into audit_routine.refs select'job4a',id from public.routine_items where routine_id=audit_routine.ref('checks4')and sort_order=0;
do $$ begin
  assert (select employee->>'designation_id'=audit_routine.id(8,1)::text and employee->'designation'->>'title'='Routine Operator'
    and can_manage and jsonb_array_length(jobs)=2 from public.list_routine_sets()where id=audit_routine.ref('checks3')),
    'scoped list supplies exact designation identity and all jobs';
end $$;

-- Tick owner, actor and time come from the server; retries are idempotent.
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000003';
select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today(),true);
select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today(),true);
do $$ begin
  assert (select count(*)=1 from public.routine_ticks where routine_item_id=audit_routine.ref('job3a')and on_date=audit_routine.today()),'repeated tick has one fact';
  assert (select employee_id=audit_routine.id(5,3)and done_by=audit_routine.id(5,3)and done_at>=now()-interval'1 minute'
    from public.routine_ticks where routine_item_id=audit_routine.ref('job3a')),'server derives completion identity and timestamp';
  assert (select scheduled=2 and completed=1 and pending=1 and missed=0 and pct=50
    from public.routine_completion_stats(audit_routine.today(),audit_routine.today())where routine_id=audit_routine.ref('checks3')),'partial completion counts jobs';
end $$;
select audit_routine.expect_error($q$select public.set_routine_job_tick(audit_routine.ref('job4a'),audit_routine.today(),true)$q$,'42501');
select audit_routine.expect_error($q$select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today()+1,true)$q$,'42501');
select audit_routine.expect_error($q$select public.set_routine_job_tick(audit_routine.id(6,2),audit_routine.today(),true)$q$,'42501');
select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today(),false);
select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today(),false);
select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today(),true);

-- Synthetic established history exercises historical manager correction and exact statistics.
reset role;
set request.jwt.claim.sub='';
update public.routine_sets set start_date=audit_routine.today()-2,history_start_date=audit_routine.today()-2 where id=audit_routine.ref('checks3');
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000003';
select audit_routine.expect_error($q$select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today()-1,true)$q$,'42501');
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000002';
select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today()-2,true);
select public.set_routine_job_tick(audit_routine.ref('job3b'),audit_routine.today()-2,true);
select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today()-1,true);
select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today(),false);
do $$ begin
  assert (select scheduled=6 and completed=3 and missed=1 and pending=2 and pct=50 and total_jobs=6 and done_jobs=3
    and scheduled_runs=3 and completed_runs=1 from public.routine_completion_stats(audit_routine.today()-2,audit_routine.today()+10)
    where routine_id=audit_routine.ref('checks3')),'statistics split jobs into completed, missed past and pending today; future dates excluded';
end $$;
select audit_routine.expect_error($q$select public.routine_completion_stats(audit_routine.today()-366,audit_routine.today())$q$,'22023');

-- Schedule/job replacement starts tomorrow and never changes another employee's batch instance.
select audit_routine.expect_error($q$select public.replace_routine_set(audit_routine.ref('checks3'),'Too soon','[{"title":"Replacement"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()))$q$,'22023');
insert into audit_routine.refs values('replacement',public.replace_routine_set(audit_routine.ref('checks3'),'New checks','[{"title":"One new job"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1)));
do $$ begin
  assert (select retired_on=audit_routine.today()and replaced_by=audit_routine.ref('replacement')from public.routine_sets where id=audit_routine.ref('checks3')),
    'old version remains scheduled through today';
  assert (select retired_on is null and replaced_by is null from public.routine_sets where id=audit_routine.ref('checks4')),'another batch instance stays untouched';
  assert (select count(*)=2 from public.routine_day(audit_routine.today(),audit_routine.id(5,3))where routine_id=audit_routine.ref('checks3')),'today keeps the original two jobs';
  assert (select count(*)=1 from public.routine_day(audit_routine.today()+1,audit_routine.id(5,3))where routine_id=audit_routine.ref('replacement')),'tomorrow gets replacement jobs';
  assert (select scheduled=6 and completed=3 and missed=1 and pending=2 from public.routine_completion_stats(audit_routine.today()-2,audit_routine.today())
    where routine_id=audit_routine.ref('checks3')),'replacement preserves historical denominators and completions';
end $$;
select public.retire_routine_set(audit_routine.ref('checks4'));
do $$ begin
  assert (select count(*)=2 from public.routine_day(audit_routine.today(),audit_routine.id(5,4))where routine_id=audit_routine.ref('checks4')),'retirement preserves current due jobs';
  assert not exists(select 1 from public.routine_day(audit_routine.today()+1,audit_routine.id(5,4))where routine_id=audit_routine.ref('checks4')),'retirement removes future reminders';
end $$;

-- Calendar recurrence uses ISO weekdays, month-end clamping, and the start-day interval anchor.
reset role;
set request.jwt.claim.sub='';
do $$ declare s public.routine_sets; begin
  s.start_date:='2024-01-01';s.frequency:='weekly';s.weekdays:=array[1,5];
  assert app.routine_due(s,'2024-01-01')and app.routine_due(s,'2024-01-05')and not app.routine_due(s,'2024-01-02'),'weekly matches only selected ISO weekdays';
  s.frequency:='monthly';s.month_day:=31;
  assert app.routine_due(s,'2024-02-29')and app.routine_due(s,'2025-02-28')and app.routine_due(s,'2024-04-30')
    and not app.routine_due(s,'2024-02-28'),'monthly day31 clamps leap and short months';
  s.frequency:='interval';s.interval_days:=3;
  assert app.routine_due(s,'2024-01-01')and app.routine_due(s,'2024-01-04')and not app.routine_due(s,'2024-01-03'),'interval anchors to start date';
  s.frequency:='once';
  assert app.routine_due(s,'2024-01-01')and not app.routine_due(s,'2024-01-02'),'one-time routine occurs once';
  s.frequency:='daily';s.end_date:='2024-01-10';s.retired_on:='2024-01-05';
  assert app.routine_due(s,'2024-01-05')and not app.routine_due(s,'2024-01-06')and not app.routine_due(s,'2023-12-31'),'end, retirement and start boundaries are inclusive';
end $$;
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000002';
do $$ declare result jsonb; begin
  result:=public.create_routine_set(array[audit_routine.id(5,3)],'Not due today','[{"title":"Tomorrow only"}]',
    jsonb_build_object('frequency','once','start_date',audit_routine.today()+1));
  insert into audit_routine.refs select'not_due_job',i.id from public.routine_items i where i.routine_id=(result->'routine_ids'->>0)::uuid;
end $$;
select audit_routine.expect_error($q$select public.set_routine_job_tick(audit_routine.ref('not_due_job'),audit_routine.today(),true)$q$,'42501');
do $$ begin
  assert not exists(select 1 from public.routine_completion_stats(audit_routine.today(),audit_routine.today())where routine_name='Not due today'),
    'a date with no scheduled occurrence contributes no denominator';
end $$;

-- Scope, foreign-entity filters, revoked read and role-limited direct tables match RPCs.
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000005';
do $$ begin
  assert not exists(select 1 from public.list_routine_sets()where employee_id=audit_routine.id(5,3)),'unrelated department cannot inspect assignments';
  assert not exists(select 1 from public.routine_completion_stats(audit_routine.today()-2,audit_routine.today(),array[audit_routine.id(5,3)])),
    'employee filter never widens RLS scope';
end $$;
select audit_routine.expect_error($q$select public.retire_routine_set(audit_routine.ref('checks3'))$q$,'42501');
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000006';
do $$ begin assert not exists(select 1 from public.list_routine_sets()),'foreign company has no routine access';end $$;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000009';
do $$ begin
  assert not exists(select 1 from public.routine_items where employee_id=audit_routine.id(5,3)),'task.create alone does not authorize SELECT';
  assert not exists(select 1 from public.routine_ticks where employee_id=audit_routine.id(5,3)),'task.update alone does not authorize SELECT';
end $$;
select audit_routine.expect_error($q$select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today(),true)$q$,'42501');
reset role;
set request.jwt.claim.sub='';
delete from public.role_assignments where user_id=audit_routine.id(4,3);
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000003';
do $$ begin
  assert not exists(select 1 from public.routine_day(audit_routine.today())),'revoking access removes own reminders';
  assert not exists(select 1 from public.routine_completion_stats(audit_routine.today()-5,audit_routine.today())),'revoking access removes historical reads';
end $$;
select audit_routine.expect_error($q$select public.set_routine_job_tick(audit_routine.ref('job3a'),audit_routine.today(),true)$q$,'42501');
reset role;
set request.jwt.claim.sub='';
select 'PASS: named routine batches, legacy history/quarantine, recurring due dates, atomic scoped writes, trusted completion ticks and versioned job statistics' as result;
\endif
