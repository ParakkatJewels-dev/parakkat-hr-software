-- Isolated PostgreSQL contract test. NEVER run on the application database.
-- createdb ... hr_account_audit; psql ... -d hr_account_audit -v ON_ERROR_STOP=1 -f this-file
-- Minimal auth/RBAC fixtures stand in for Supabase; production RPCs/migrations are included below.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_account_audit' then raise exception 'requires disposable hr_account_audit database'; end if;
end $$;
create schema auth;
create schema app;
create schema extensions;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table auth.users (
  id uuid primary key, instance_id uuid, aud text, role text, email text unique, encrypted_password text,
  email_confirmed_at timestamptz, created_at timestamptz, updated_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  confirmation_token text, recovery_token text, email_change_token_new text, email_change text
);
create table auth.identities (
  id uuid primary key, provider_id text, user_id uuid references auth.users(id), identity_data jsonb,
  provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz
);
create table public.employees (
  id uuid primary key, user_id uuid references auth.users(id), entity_id uuid, zone_id uuid,
  branch_id uuid, department_id uuid
);
create table public.profiles (
  user_id uuid primary key references auth.users(id), employee_id uuid references public.employees(id),
  is_super_admin boolean not null default false
);
create table public.roles (id uuid primary key, key text, rank int);
create table public.role_assignments (id uuid primary key default gen_random_uuid(), user_id uuid, role_id uuid, scope_type text, scope_id uuid);
create function app.handle_new_user() returns trigger language plpgsql as $$ begin
  insert into public.profiles(user_id) values(new.id) on conflict do nothing; return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function app.handle_new_user();

-- Same rank/branch semantics as the application helpers; this suite tests the new RPC boundaries,
-- not Supabase's HTTP/JWT layer or the entire application's RLS configuration.
create function app.is_super_admin() returns boolean language sql as $$
  select coalesce((select is_super_admin from public.profiles where user_id=auth.uid()), false)
    or exists(select 1 from public.role_assignments ra join public.roles r on r.id=ra.role_id
      where ra.user_id=auth.uid() and r.key='super_admin' and ra.scope_type='global')
$$;
create function app.max_role_rank() returns int language sql as $$
  select case when app.is_super_admin() then 1000 else coalesce((select max(r.rank)
    from public.role_assignments ra join public.roles r on r.id=ra.role_id where ra.user_id=auth.uid()),0) end
$$;
create function app.can_admin_user(target uuid) returns boolean language sql as $$
  select app.is_super_admin() or greatest(
    coalesce((select max(r.rank) from public.role_assignments ra join public.roles r on r.id=ra.role_id where ra.user_id=target),0),
    coalesce((select 1000 from public.profiles where user_id=target and is_super_admin),0)) < app.max_role_rank()
$$;
create function app.has_perm(p text, e uuid, z uuid, b uuid, d uuid, emp uuid) returns boolean language sql as $$
  select app.is_super_admin() or exists(select 1 from public.role_assignments ra join public.roles r on r.id=ra.role_id
    where ra.user_id=auth.uid() and r.key='branch_manager' and p='rbac.manage' and ra.scope_type='branch' and ra.scope_id=b)
$$;

\ir ../supabase/migrations/0016_user_role_admin.sql
\ir ../supabase/migrations/0018_admin_create_user.sql
\ir ../supabase/migrations/0111_a_default_password_is_a_temporary_one.sql
\ir ../supabase/migrations/0120_user_account_integrity.sql

create function public.expect_failure(statement text, message text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(message in sqlerrm)=0 then raise; end if;
    return;
  end;
  raise exception 'Expected failure: %', message;
end $$;

insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-000000000001','admin@example.test'),
 ('00000000-0000-0000-0000-000000000002','manager@example.test'),
 ('00000000-0000-0000-0000-000000000003','senior@example.test'),
 ('00000000-0000-0000-0000-000000000004','staff@example.test'),
 ('00000000-0000-0000-0000-000000000005','unlinked@example.test');
update public.profiles set is_super_admin=true where user_id='00000000-0000-0000-0000-000000000001';
insert into public.roles values
 ('20000000-0000-0000-0000-000000000001','branch_manager',40),
 ('20000000-0000-0000-0000-000000000002','hr_manager',60);
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
 ('00000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','branch','30000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002','branch','30000000-0000-0000-0000-000000000001');
insert into public.employees(id,user_id,branch_id) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000003',null,'30000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000004',null,'30000000-0000-0000-0000-000000000002');
update public.profiles p set employee_id=e.id from public.employees e where e.user_id=p.user_id;

set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select expect_failure($q$select admin_create_user_with_employee('failed@example.test','temporary!', '10000000-0000-0000-0000-000000000099')$q$, 'employee not found');
select expect_failure($q$select admin_create_user_with_employee('occupied@example.test','temporary!', '10000000-0000-0000-0000-000000000001')$q$, 'already has a login');
select expect_failure($q$select admin_create_user_with_employee(null,'temporary!')$q$, 'valid email');
select expect_failure($q$select admin_create_user_with_employee('short@example.test','short')$q$, '8 characters');
select expect_failure($q$select link_user_to_employee('00000000-0000-0000-0000-000000000099',null)$q$, 'login not found');
do $$ declare uid uuid;
begin
  assert (select count(*) from auth.users)=5, 'failed creates must roll back auth.users';
  assert (select count(*) from auth.identities)=0, 'failed creates must roll back identities';
  assert (select count(*) from public.profiles)=5, 'failed creates must roll back profiles';
  uid := admin_create_user_with_employee(' Created@Example.Test ', 'temporary!', '10000000-0000-0000-0000-000000000003', true);
  assert (select user_id from public.employees where id='10000000-0000-0000-0000-000000000003')=uid, 'employee backlink';
  assert (select is_super_admin and must_change_password from public.profiles where user_id=uid), 'promotion and password gate';
  assert (select email from auth.users where id=uid)='created@example.test', 'email normalized';
  update auth.users set encrypted_password='different-hash' where id=uid;
  assert not (select must_change_password from public.profiles where user_id=uid), 'actual password change clears the gate';
end $$;
select expect_failure($q$select admin_create_user_with_employee('created@example.test','temporary!')$q$, 'already exists');

set request.jwt.claim.sub='00000000-0000-0000-0000-000000000002';
select expect_failure($q$select admin_create_user_with_employee('denied@example.test','temporary!')$q$, 'only a super admin');
select expect_failure($q$select link_user_to_employee('00000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004')$q$, 'at or above');
select expect_failure($q$select link_user_to_employee('00000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000004')$q$, 'not linked');
select expect_failure($q$select link_user_to_employee('00000000-0000-0000-0000-000000000004',null)$q$, 'only a super admin');
select expect_failure($q$select link_user_to_employee('00000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000004')$q$, 'not authorized');
select link_user_to_employee('00000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001');
do $$ begin
  assert not has_function_privilege('anon','public.admin_create_user_with_employee(text,text,uuid,boolean)','execute'), 'anon cannot create users';
  assert not has_function_privilege('anon','public.link_user_to_employee(uuid,uuid)','execute'), 'anon cannot relink users';
  assert has_function_privilege('authenticated','public.admin_create_user_with_employee(text,text,uuid,boolean)','execute'), 'authenticated RPC exposed';
end $$;
-- The final profile-flag administrator and the final role-granted administrator are protected.
update public.profiles set is_super_admin=false where user_id in (select id from auth.users where email='created@example.test');
select expect_failure($q$update public.profiles set is_super_admin=false where user_id='00000000-0000-0000-0000-000000000001'$q$, 'last super admin');
insert into public.roles values ('20000000-0000-0000-0000-000000000003','super_admin',100);
insert into public.role_assignments(user_id,role_id,scope_type) values
 ('00000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000003','global');
update public.profiles set is_super_admin=false where user_id='00000000-0000-0000-0000-000000000001';
select expect_failure($q$delete from public.role_assignments where role_id='20000000-0000-0000-0000-000000000003'$q$, 'last super admin');
select expect_failure($q$delete from public.profiles where user_id='00000000-0000-0000-0000-000000000005'$q$, 'last super admin');
select 'PASS: atomic creation, identity links, password gate, rank/scope checks, RPC grants and last-admin protection' as result;
