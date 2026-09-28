\set ON_ERROR_STOP on
-- Production migrations and real RLS, confined to the private integration cluster.
do $$ begin assert current_database()='hr_message_requests_audit', 'Disposable task trash database required'; end $$;
reset role;
set request.jwt.claim.sub='';
create schema audit_task_trash;
create function audit_task_trash.id(n integer) returns uuid language sql immutable as $$
  select ('a1550000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create function audit_task_trash.expect_error(statement text,code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then if sqlstate=code then return; end if; raise; end;
  raise exception 'Expected SQLSTATE % from %',code,statement;
end $$;
grant usage on schema audit_task_trash to authenticated,anon;
grant execute on all functions in schema audit_task_trash to authenticated,anon;
insert into public.entities(id,code,name) values(audit_task_trash.id(100),'TRASH-E','Task trash company');
insert into public.branches(id,entity_id,code,name)
  select audit_task_trash.id(100+n),audit_task_trash.id(100),'TRASH-B'||n,'Task trash branch '||n from generate_series(1,2)n;
insert into auth.users(id,email) select audit_task_trash.id(n),'task-trash-'||n||'@audit.invalid' from generate_series(1,6)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name)
  select audit_task_trash.id(10+n),audit_task_trash.id(100),audit_task_trash.id(case when n in(3,4)then 102 else 101 end),
    audit_task_trash.id(n),'TRASH-E'||n,'Task trash person '||n from generate_series(1,5)n;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like 'TRASH-E%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_task_trash.id(n),r.id,'self' from generate_series(1,5)n cross join public.roles r where r.key='employee';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select audit_task_trash.id(n),r.id,'branch',audit_task_trash.id(case when n=1 then 101 else 102 end)
  from unnest(array[1,4]) n cross join public.roles r where r.key='branch_manager';
update public.profiles set is_super_admin=true where user_id=audit_task_trash.id(6);
insert into public.tasks(id,employee_id,assigned_by,parent_task_id,title,status,due_date,completed_at) values
  (audit_task_trash.id(21),audit_task_trash.id(12),audit_task_trash.id(12),null,'Personal completed task','Done','2020-01-01','2020-01-01'),
  (audit_task_trash.id(22),audit_task_trash.id(12),audit_task_trash.id(11),null,'Delegated task','In Progress','2026-10-10',null),
  (audit_task_trash.id(23),audit_task_trash.id(13),audit_task_trash.id(14),null,'Other branch task','To Do',null,null),
  (audit_task_trash.id(24),audit_task_trash.id(12),audit_task_trash.id(11),audit_task_trash.id(22),'Preserved child','Blocked',null,null),
  (audit_task_trash.id(25),audit_task_trash.id(12),audit_task_trash.id(11),audit_task_trash.id(22),'Independently deleted child','To Do',null,null),
  (audit_task_trash.id(26),audit_task_trash.id(12),audit_task_trash.id(11),null,'Cross branch parent','To Do',null,null),
  (audit_task_trash.id(27),audit_task_trash.id(13),audit_task_trash.id(14),audit_task_trash.id(26),'Cross branch child','To Do',null,null),
  (audit_task_trash.id(28),audit_task_trash.id(12),audit_task_trash.id(14),null,'Cross branch assigner','To Do',null,null);
insert into public.task_assignees(task_id,employee_id) values(audit_task_trash.id(22),audit_task_trash.id(15));
insert into public.task_checklist_items(id,task_id,title,position,completed_at,completed_by,assigned_to) values
  (audit_task_trash.id(31),audit_task_trash.id(22),'Finished step',0,now(),audit_task_trash.id(12),audit_task_trash.id(12)),
  (audit_task_trash.id(32),audit_task_trash.id(22),'Remaining step',1,null,null,null);
insert into public.task_comments(id,task_id,author_user,body)
  values(audit_task_trash.id(33),audit_task_trash.id(22),audit_task_trash.id(2),'Preserved conversation');
insert into public.task_attachments(id,task_id,kind,storage_path,added_user)
  values(audit_task_trash.id(34),audit_task_trash.id(22),'file',audit_task_trash.id(22)||'/proof.pdf',audit_task_trash.id(2));
insert into storage.objects(bucket_id,name) values('task-files',audit_task_trash.id(22)||'/proof.pdf');
insert into public.notifications(id,user_id,type,title,tab,ref_id)
  values(audit_task_trash.id(35),audit_task_trash.id(2),'task','Task reminder','tasks',audit_task_trash.id(22));
-- Snapshot the original retained content; exclude task metadata that is intentionally changed.
create table audit_task_trash.snapshot as select
  (select jsonb_agg(to_jsonb(x) order by id) from public.task_comments x where task_id=audit_task_trash.id(22)) comments,
  (select jsonb_agg(to_jsonb(x) order by id) from public.task_checklist_items x where task_id=audit_task_trash.id(22)) checklist,
  (select jsonb_agg(to_jsonb(x) order by employee_id) from public.task_assignees x where task_id=audit_task_trash.id(22)) assignees,
  (select jsonb_agg(to_jsonb(x) order by id) from public.task_attachments x where task_id=audit_task_trash.id(22)) attachments;

set role authenticated;
set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000002';
select audit_task_trash.expect_error('select public.soft_delete_task(audit_task_trash.id(22))','42501');
select audit_task_trash.expect_error('delete from public.tasks where id=audit_task_trash.id(21)','42501');
select audit_task_trash.expect_error('update public.tasks set deleted_at=now() where id=audit_task_trash.id(21)','42501');
select audit_task_trash.expect_error('update public.tasks set restored_at=now() where id=audit_task_trash.id(21)','42501');
select audit_task_trash.expect_error($q$insert into public.tasks(employee_id,assigned_by,title,deleted_at)
  values(audit_task_trash.id(12),audit_task_trash.id(12),'Forged trash',now())$q$,'42501');
select public.soft_delete_task(audit_task_trash.id(21));
do $$ begin
  assert exists(select 1 from public.tasks where id=audit_task_trash.id(21) and deleted_at is not null), 'Scoped row remains visible for realtime';
  assert not app.can_read_task(audit_task_trash.id(21)), 'Operational read helpers exclude trash';
  assert (select count(*)=1 from public.list_deleted_tasks()), 'An employee sees their own recoverable task';
end $$;
select public.restore_task(audit_task_trash.id(21));
do $$ begin
  assert (select status='Done' and due_date='2020-01-01' and completed_at='2020-01-01' and restored_at is not null from public.tasks where id=audit_task_trash.id(21)), 'Restore preserves dates and completed status';
end $$;

set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000005';
select audit_task_trash.expect_error('select public.soft_delete_task(audit_task_trash.id(22))','42501');
set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000001';
select audit_task_trash.expect_error('select public.soft_delete_task(audit_task_trash.id(23))','42501');
select audit_task_trash.expect_error('select public.soft_delete_task(audit_task_trash.id(26))','42501');
do $$ begin assert (select deleted_at is null from public.tasks where id=audit_task_trash.id(26)), 'Cross-scope family deletion is atomic'; end $$;
select public.soft_delete_task(audit_task_trash.id(28));
do $$ begin assert (select assigner is null from public.list_deleted_tasks() where id=audit_task_trash.id(28)), 'Trash names retain employee read scope'; end $$;
select public.soft_delete_task(audit_task_trash.id(25));
select public.soft_delete_task(audit_task_trash.id(22));
select audit_task_trash.expect_error('select public.soft_delete_task(audit_task_trash.id(22))','22023');
do $$ begin
  assert (select deleted_task_count=2 and can_restore from public.list_deleted_tasks() where id=audit_task_trash.id(22)), 'Parent trash row accounts for active descendants only';
  assert (select not can_restore from public.list_deleted_tasks() where id=audit_task_trash.id(25)), 'Independent child waits for parent restore';
  assert (select delete_batch_id=audit_task_trash.id(22) from public.tasks where id=audit_task_trash.id(24)), 'Child shares deletion batch';
end $$;
select audit_task_trash.expect_error('select public.restore_task(audit_task_trash.id(25))','22023');
select audit_task_trash.expect_error('select public.restore_task(audit_task_trash.id(24))','22023');
select audit_task_trash.expect_error($q$insert into public.tasks(employee_id,assigned_by,parent_task_id,title)
  values(audit_task_trash.id(12),audit_task_trash.id(11),audit_task_trash.id(22),'Under deleted parent')$q$,'42501');

set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000002';
do $$ begin
  assert not exists(select 1 from public.list_deleted_tasks()), 'Assignee cannot list delegated trash';
  assert not exists(select 1 from public.task_comments where task_id=audit_task_trash.id(22)), 'Deleted task thread is hidden';
  assert not exists(select 1 from public.task_checklist_items where task_id=audit_task_trash.id(22)), 'Deleted checklist is hidden';
  assert not exists(select 1 from public.task_assignees where task_id=audit_task_trash.id(22)), 'Deleted assignment content is hidden';
  assert not exists(select 1 from public.task_attachments where task_id=audit_task_trash.id(22)), 'Deleted attachment metadata is hidden';
  assert not public.task_attachment_visible(audit_task_trash.id(22)||'/proof.pdf'), 'Deleted storage object is inaccessible';
  assert not exists(select 1 from public.notifications where id=audit_task_trash.id(35)), 'Deleted task notification is hidden';
  assert (public.get_section_counts(true)->>'tasks')::integer=1, 'Personal open count excludes deleted family';
  assert (public.get_navigation_counts(true)->>'notifications')::integer=(select count(*) from public.notifications where read_at is null), 'Unread navigation matches visible notifications';
end $$;
select audit_task_trash.expect_error('select public.restore_task(audit_task_trash.id(22))','42501');
select audit_task_trash.expect_error($q$insert into public.task_comments(task_id,author_user,body)
  values(audit_task_trash.id(22),audit_task_trash.id(2),'Stale comment')$q$,'42501');
select audit_task_trash.expect_error($q$insert into public.task_checklist_items(task_id,title)
  values(audit_task_trash.id(22),'Stale checklist')$q$,'42501');
update public.task_comments set body='Hidden edit' where id=audit_task_trash.id(33);
delete from public.task_attachments where id=audit_task_trash.id(34);
update public.tasks set title='Hidden edit' where id=audit_task_trash.id(22);

set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000004';
do $$ begin assert not exists(select 1 from public.list_deleted_tasks()), 'Other branch manager cannot read trash'; end $$;
select audit_task_trash.expect_error('select public.restore_task(audit_task_trash.id(22))','42501');
set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000001';
select public.restore_task(audit_task_trash.id(22));
do $$ begin
  assert (select deleted_at is null and title='Delegated task' from public.tasks where id=audit_task_trash.id(22)), 'Task restored without stale edits';
  assert (select deleted_at is null and parent_task_id=audit_task_trash.id(22) and status='Blocked' from public.tasks where id=audit_task_trash.id(24)), 'Child restored with relationship and status';
  assert (select deleted_at is not null from public.tasks where id=audit_task_trash.id(25)), 'Previously deleted child remains deleted';
end $$;
select public.restore_task(audit_task_trash.id(25));
select audit_task_trash.expect_error('select public.restore_task(audit_task_trash.id(22))','22023');

set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000002';
do $$ begin
  assert exists(select 1 from public.notifications where id=audit_task_trash.id(35)), 'Restore brings back original task notification';
  assert public.task_attachment_visible(audit_task_trash.id(22)||'/proof.pdf'), 'Restored object is reachable';
end $$;
reset role;
do $$ declare before audit_task_trash.snapshot; begin
  select * into before from audit_task_trash.snapshot;
  assert before.comments=(select jsonb_agg(to_jsonb(x) order by id) from public.task_comments x where task_id=audit_task_trash.id(22)), 'Conversation unchanged';
  assert before.checklist=(select jsonb_agg(to_jsonb(x) order by id) from public.task_checklist_items x where task_id=audit_task_trash.id(22)), 'Checklist completion and ownership unchanged';
  assert before.assignees=(select jsonb_agg(to_jsonb(x) order by employee_id) from public.task_assignees x where task_id=audit_task_trash.id(22)), 'Assignees unchanged';
  assert before.attachments=(select jsonb_agg(to_jsonb(x) order by id) from public.task_attachments x where task_id=audit_task_trash.id(22)), 'Attachments unchanged';
  assert exists(select 1 from storage.objects where bucket_id='task-files' and name=audit_task_trash.id(22)||'/proof.pdf'), 'Stored file retained';
end $$;
set role authenticated;
set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000006';
select public.soft_delete_task(audit_task_trash.id(23));
select public.restore_task(audit_task_trash.id(23));
reset role;
update auth.users set banned_until=now()+interval '1 day' where id=audit_task_trash.id(1);
set role authenticated;
set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000001';
select audit_task_trash.expect_error('select public.soft_delete_task(audit_task_trash.id(22))','42501');
select audit_task_trash.expect_error('select public.list_deleted_tasks()','42501');
reset role;
update auth.users set banned_until=null where id=audit_task_trash.id(1);
set role anon;
set request.jwt.claim.sub='';
select audit_task_trash.expect_error('select public.soft_delete_task(audit_task_trash.id(22))','42501');
select audit_task_trash.expect_error('select public.restore_task(audit_task_trash.id(22))','42501');
select audit_task_trash.expect_error('select public.list_deleted_tasks()','42501');
reset role;
select 'PASS: recoverable task deletion preserves task families and all contents, restricts scope and direct writes, hides operational counts/notifications, and restores original history' as result;
