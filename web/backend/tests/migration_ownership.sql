\set ON_ERROR_STOP on
do $$ begin
  assert current_database()='hr_migration_ownership_audit','Disposable migration ownership database required';
  assert not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='public' or (n.nspname='storage' and c.relname='objects'))
      and c.relkind in ('r','p') and c.relrowsecurity
      and not exists(select 1 from pg_policy p where p.polrelid=c.oid
        and p.polname='active_account_required' and not p.polpermissive)),
    'every application RLS table and storage.objects retains the restrictive guard';
  assert (select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname<>'objects')=3,
    'platform metadata policy count unchanged';
  assert not exists(select 1 from pg_policy p join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname<>'objects'
    and (p.polname not in ('platform_migrations_policy','platform_buckets_policy','platform_internal_policy')
      or pg_get_expr(p.polqual,p.polrelid)<>'false' or not p.polpermissive)),
    'platform metadata policies unchanged';
  assert (select name from storage.migrations where id=1)='platform migration',
    'platform migration row unchanged';
  assert (select value from storage.ownership_internal_metadata where id=1)='platform metadata',
    'platform metadata row unchanged';
  assert not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='storage' and c.relname in ('migrations','buckets','ownership_internal_metadata')
      and pg_get_userbyid(c.relowner)<>'hr_platform_test_owner'),'platform ownership unchanged';
end $$;

-- A permissive storage policy deliberately depends only on the object. The restrictive guard
-- must still stop an existing JWT after its account is banned, while allowing active access.
insert into auth.users(id,email) values('d4410000-0000-0000-0000-000000000001','ownership-active@audit.invalid');
insert into public.notifications(id,user_id,type,title) values(
  'd4410000-0000-0000-0000-000000000002','d4410000-0000-0000-0000-000000000001','test','Ownership test');
insert into storage.objects(id,bucket_id,name) values(
  'd4410000-0000-0000-0000-000000000003','asset-photos','d4410000-0000-0000-0000-000000000004/photo.jpg');
create policy ownership_test_read on storage.objects for select to authenticated
  using (id='d4410000-0000-0000-0000-000000000003'::uuid);
set role authenticated;
set request.jwt.claim.sub='d4410000-0000-0000-0000-000000000001';
do $$ begin
  assert app.session_is_active(),'active account remains allowed';
  assert (select count(*) from storage.objects)=1,'active storage read preserved';
  assert (select count(*) from public.notifications)=1,'active direct self-policy read preserved';
end $$;
reset role;
update auth.users set banned_until=now()+interval '1 day' where id='d4410000-0000-0000-0000-000000000001';
set role authenticated;
do $$ begin
  assert not app.session_is_active(),'unchanged JWT loses account access';
  assert (select count(*) from storage.objects)=0,'banned storage read blocked';
  assert (select count(*) from public.notifications)=0,'banned direct self-policy read blocked';
end $$;
reset role;
set request.jwt.claim.sub='';
select 'PASS: 0144 applies twice under a non-superuser, leaves platform metadata untouched, and preserves active/banned HR and storage enforcement' as result;

-- The helper reruns 0144 after this fixture and expects a visible ownership error, proving
-- the fix excludes known platform metadata instead of skipping every non-owned table.
create table public.ownership_foreign_hr_table(id integer primary key);
alter table public.ownership_foreign_hr_table enable row level security;
alter table public.ownership_foreign_hr_table owner to hr_platform_test_owner;
