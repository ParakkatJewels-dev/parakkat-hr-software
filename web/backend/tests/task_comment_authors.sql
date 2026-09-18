\set ON_ERROR_STOP on
-- Seed real legacy rows before 0149, then run RLS/identity contracts after all migrations.
do $$ begin
  assert current_database() = 'hr_message_requests_audit', 'Disposable database required';
end $$;

\if :task_authors_seed
create schema audit_task_authors;
create function audit_task_authors.id(n integer) returns uuid language sql immutable as $$
  select ('a1490000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
grant usage on schema audit_task_authors to authenticated, anon;
grant execute on function audit_task_authors.id(integer) to authenticated, anon;

insert into public.entities(id, code, name)
  values (audit_task_authors.id(100), 'AUTHOR-ENTITY', 'Synthetic task author company');
insert into public.branches(id, entity_id, code, name)
  select audit_task_authors.id(100+n), audit_task_authors.id(100), 'AUTHOR-B'||n, 'Synthetic branch '||n
  from generate_series(1,2)n;
insert into auth.users(id,email,raw_user_meta_data)
  select audit_task_authors.id(n), 'task-author-'||n||'@audit.invalid',
    case when n=4 then '{"full_name":"Unlinked administrator"}'::jsonb else '{}'::jsonb end
  from generate_series(1,5)n;
insert into public.employees(id,entity_id,branch_id,employee_code,full_name,user_id)
  select audit_task_authors.id(10+n), audit_task_authors.id(100),
    audit_task_authors.id(case when n=1 then 101 else 102 end), 'AUTHOR-E'||n,
    'Task participant '||n, audit_task_authors.id(n) from generate_series(1,3)n;
update public.profiles p set employee_id=e.id from public.employees e
  where p.user_id=e.user_id and e.entity_id=audit_task_authors.id(100);
update public.profiles set is_super_admin=true where user_id in (audit_task_authors.id(4),audit_task_authors.id(5));
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_task_authors.id(n),r.id,'self' from generate_series(1,3)n
  cross join public.roles r where r.key='employee';
insert into public.tasks(id,employee_id,title)
  values (audit_task_authors.id(21),audit_task_authors.id(11),'Shared synthetic task'),
         (audit_task_authors.id(22),audit_task_authors.id(13),'Private synthetic task');
insert into public.task_assignees(task_id,employee_id)
  values (audit_task_authors.id(21),audit_task_authors.id(12));
insert into public.task_comments(id,task_id,author_id,author_user,body)
  values (audit_task_authors.id(31),audit_task_authors.id(21),null,audit_task_authors.id(2),'Legacy missing employee link'),
         (audit_task_authors.id(32),audit_task_authors.id(21),null,audit_task_authors.id(4),'Legacy administrator'),
         (audit_task_authors.id(33),audit_task_authors.id(21),audit_task_authors.id(12),audit_task_authors.id(6),'Legacy deleted login'),
         (audit_task_authors.id(34),audit_task_authors.id(22),audit_task_authors.id(13),audit_task_authors.id(3),'Private comment');

\else
begin;
set role authenticated;
set request.jwt.claim.sub='a1490000-0000-0000-0000-000000000001';
do $$ begin
  assert not exists(select 1 from public.employees where id=audit_task_authors.id(12)), 'other participant personnel row stays private';
  assert (select author_name='Task participant 2' from public.task_comments where id=audit_task_authors.id(31)), 'backfills through account link despite null author_id';
  assert (select author_name='Unlinked administrator' from public.task_comments where id=audit_task_authors.id(32)), 'backfills unlinked administrative account';
  assert (select author_name='Task participant 2' from public.task_comments where id=audit_task_authors.id(33)), 'preserves historical employee when login no longer exists';
  assert not exists(select 1 from public.task_comments where task_id=audit_task_authors.id(22)), 'private task author names stay private';
end $$;

-- The client may still send the pre-migration fields; the server derives the actual identity.
set request.jwt.claim.sub='a1490000-0000-0000-0000-000000000002';
insert into public.task_comments(id,task_id,author_user,author_id,author_name,body)
  values (audit_task_authors.id(35),audit_task_authors.id(21),audit_task_authors.id(2),audit_task_authors.id(11),'Forged name','Server resolves my name');
do $$ begin
  assert (select author_id=audit_task_authors.id(12) and author_name='Task participant 2'
    from public.task_comments where id=audit_task_authors.id(35)), 'cannot impersonate another employee on insert';
  begin
    update public.task_comments set author_name='Forged name' where id=audit_task_authors.id(35);
    raise exception 'Expected name change to be rejected';
  exception when insufficient_privilege then null; end;
  begin
    update public.task_comments set author_id=audit_task_authors.id(11) where id=audit_task_authors.id(35);
    raise exception 'Expected employee change to be rejected';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.task_comments(task_id,author_user,body)
      values(audit_task_authors.id(21),audit_task_authors.id(1),'Forged account');
    raise exception 'Expected account impersonation to be rejected';
  exception when insufficient_privilege then null; end;
end $$;
update public.task_comments set body='Edited own words' where id=audit_task_authors.id(35);

set request.jwt.claim.sub='a1490000-0000-0000-0000-000000000004';
insert into public.task_comments(id,task_id,author_user,body)
  values(audit_task_authors.id(36),audit_task_authors.id(21),audit_task_authors.id(4),'Admin message');
set request.jwt.claim.sub='a1490000-0000-0000-0000-000000000005';
insert into public.task_comments(id,task_id,author_user,body)
  values(audit_task_authors.id(37),audit_task_authors.id(21),audit_task_authors.id(5),'Account without metadata');
set request.jwt.claim.sub='a1490000-0000-0000-0000-000000000001';
do $$ begin
  assert (select author_name='Task participant 2' from public.task_comments where id=audit_task_authors.id(35)), 'cross-scope author visible to assignee';
  assert (select author_name='Unlinked administrator' and author_id is null from public.task_comments where id=audit_task_authors.id(36)), 'unlinked account name is readable';
  assert (select author_name='task-author-5' from public.task_comments where id=audit_task_authors.id(37)), 'fallback uses account handle without disclosing complete email';
end $$;

reset role;
delete from public.employees where id=audit_task_authors.id(12);
delete from auth.users where id=audit_task_authors.id(2);
set role authenticated;
set request.jwt.claim.sub='a1490000-0000-0000-0000-000000000001';
do $$ begin
  assert (select author_name='Task participant 2' and author_id is null from public.task_comments where id=audit_task_authors.id(35)), 'deleting the employee/account preserves historical name';
end $$;
set request.jwt.claim.sub='a1490000-0000-0000-0000-000000000003';
do $$ begin
  assert not exists(select 1 from public.task_comments where task_id=audit_task_authors.id(21)), 'non-participant cannot read identities on another task';
end $$;
reset role;
update auth.users set banned_until=now()+interval '1 day' where id=audit_task_authors.id(1);
set role authenticated;
set request.jwt.claim.sub='a1490000-0000-0000-0000-000000000001';
do $$ begin
  assert not exists(select 1 from public.task_comments), 'revoked account cannot read author snapshots';
end $$;
reset role;
set role anon;
set request.jwt.claim.sub='';
do $$ begin
  begin
    assert not exists(select 1 from public.task_comments), 'anonymous cannot read author snapshots';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
select 'PASS: task chat names are backfilled and server-stamped across scopes, survive unlink/deletion, reject impersonation, and retain task/account RLS' as result;
\endif
