\set ON_ERROR_STOP on
do $$ begin
  assert current_database()='hr_migration_ownership_audit','Disposable migration ownership database required';
  create role hr_migration_test_owner nosuperuser nobypassrls;
  create role hr_platform_test_owner nosuperuser nobypassrls;
end $$;

-- Only this database's application objects change owner. Other contract databases and the
-- cluster's audit_owner role retain their ownership and privileges.
alter schema public owner to hr_migration_test_owner;
alter schema app owner to hr_migration_test_owner;
grant usage on schema auth,storage,extensions to hr_migration_test_owner;
grant usage on schema storage to hr_platform_test_owner;
grant select on auth.users to hr_migration_test_owner;
do $$ declare obj record; begin
  for obj in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','app') and c.relkind in ('r','p','v','m')
  loop execute format('alter table %I.%I owner to hr_migration_test_owner',obj.nspname,obj.relname); end loop;
  for obj in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as arguments
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app') and p.prokind='f'
  loop execute format('alter function %I.%I(%s) owner to hr_migration_test_owner',obj.nspname,obj.proname,obj.arguments); end loop;
end $$;
alter table storage.objects owner to hr_migration_test_owner;

-- Supabase's internal metadata has a different owner. Its policies are platform concerns;
-- this application only supplies policies for storage.objects.
create table storage.migrations(id integer primary key, name text not null);
create table storage.ownership_internal_metadata(id integer primary key, value text not null);
insert into storage.migrations values(1,'platform migration');
insert into storage.ownership_internal_metadata values(1,'platform metadata');
alter table storage.migrations enable row level security;
alter table storage.buckets enable row level security;
alter table storage.ownership_internal_metadata enable row level security;
create policy platform_migrations_policy on storage.migrations using (false);
create policy platform_buckets_policy on storage.buckets using (false);
create policy platform_internal_policy on storage.ownership_internal_metadata using (false);
alter table storage.migrations owner to hr_platform_test_owner;
alter table storage.buckets owner to hr_platform_test_owner;
alter table storage.ownership_internal_metadata owner to hr_platform_test_owner;

set role hr_migration_test_owner;
-- A temporary body lets the old policy loop reproduce its ownership failure before the
-- real 0144 migration installs the authoritative account-state function.
create function app.session_is_active() returns boolean language sql stable as $$ select true $$;
do $$ declare target record; denied boolean := false; message text; begin
  assert not (select rolsuper or rolbypassrls from pg_roles where rolname=current_user),
    'migration principal must not bypass ownership/RLS';
  begin
    for target in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','storage') and c.relkind in ('r','p') and c.relrowsecurity
      order by n.nspname,case when c.relname='migrations' then 0 else 1 end,c.relname
    loop
      execute format('drop policy if exists active_account_required on %I.%I',target.nspname,target.relname);
      execute format('create policy active_account_required on %I.%I as restrictive for all to authenticated using ((select app.session_is_active())) with check ((select app.session_is_active()))',target.nspname,target.relname);
    end loop;
  exception when insufficient_privilege then
    get stacked diagnostics message = message_text;
    assert message='must be owner of table migrations',message;
    denied := true;
  end;
  assert denied,'old broad policy loop must reproduce the hosted ownership failure';
  assert not exists(select 1 from pg_policy where polname='active_account_required'),
    'failed broad loop must roll back all policy changes';
end $$;
reset role;
select 'PASS: original broad storage policy loop reproduces must be owner of table migrations under a non-superuser' as result;
