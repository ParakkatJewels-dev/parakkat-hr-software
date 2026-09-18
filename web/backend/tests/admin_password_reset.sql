-- Full production migrations, real RBAC helpers and synthetic Auth rows only. The runner creates
-- a private disposable database; this suite never talks to the hosted project or sends emails.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_password_audit' then raise exception 'requires disposable hr_password_audit database'; end if;
end $$;
create schema audit_password;
create function audit_password.id(prefix integer, n integer) returns uuid language sql immutable as $$
  select (prefix::text || '0000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
create function audit_password.expect_error(statement text, expected_code text, expected_message text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate <> expected_code or position(expected_message in sqlerrm) = 0 then raise; end if;
    return;
  end;
  raise exception 'Expected rejection: %', expected_message;
end $$;
grant usage on schema audit_password to authenticated, anon;
grant execute on all functions in schema audit_password to authenticated, anon;

insert into public.entities(id, code, name)
  select audit_password.id(1,n), 'PW-ENTITY-'||n, 'Password test company '||n from generate_series(1,2)n;
insert into public.branches(id, entity_id, code, name)
  select audit_password.id(2,n), audit_password.id(1,n), 'PW-BRANCH-'||n, 'Password test branch '||n from generate_series(1,2)n;
insert into auth.users(id, email, encrypted_password, raw_user_meta_data, raw_app_meta_data,
  email_confirmed_at, banned_until, confirmation_token, recovery_token, email_change_token_new,
  email_change, confirmation_sent_at, recovery_sent_at, email_change_token_current,
  email_change_sent_at, phone_change_token, phone_change_sent_at,
  reauthentication_token, reauthentication_sent_at)
  select audit_password.id(3,n), case when n = 3 then 'work.alias@audit.invalid' else 'login-'||n||'@audit.invalid' end,
    extensions.crypt('Initial!Bridge9', extensions.gen_salt('bf', 6)),
    '{"private_label":"preserve"}', '{"provider":"email","providers":["email"]}',
    now() - interval '1 day', case when n = 7 then now() + interval '1 day' end,
    'confirmation', 'recovery', 'email-new', 'pending@audit.invalid', now(), now(),
    'email-current', now(), 'phone', now(), 'reauthentication', now()
  from generate_series(1,12)n;
insert into auth.identities(id, provider_id, user_id, identity_data, provider)
  select audit_password.id(4,n), audit_password.id(3,n)::text, audit_password.id(3,n),
    jsonb_build_object('sub', audit_password.id(3,n)::text, 'test', 'unchanged'),
    case when n = 11 then 'saml:test' else 'email' end from generate_series(1,12)n;
insert into public.employees(id, entity_id, branch_id, user_id, full_name, employee_code)
  select audit_password.id(5,n), audit_password.id(1,case when n = 4 then 2 else 1 end),
    audit_password.id(2,case when n = 4 then 2 else 1 end), audit_password.id(3,n),
    case when n = 3 then 'Ramesh Kumar' else 'Synthetic Person '||n end, 'PW-EMP-'||n
  from generate_series(1,12)n where n <> 7;
update public.profiles p set employee_id = e.id from public.employees e where e.user_id = p.user_id;
update public.profiles set is_super_admin = true where user_id in (audit_password.id(3,1), audit_password.id(3,12));
update public.profiles set must_change_password = false;
insert into public.role_assignments(user_id, role_id, scope_type, scope_id)
  select audit_password.id(3,n), r.id, 'branch', audit_password.id(2,1)
  from generate_series(1,12)n join public.roles r on r.key = 'hr_manager' where n in (2,5);
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_password.id(3,n), r.id, 'self'
  from generate_series(1,12)n join public.roles r on r.key = 'employee' where n in (3,4,9);
insert into public.role_assignments(user_id, role_id, scope_type, scope_id)
  select audit_password.id(3,6), id, 'entity', audit_password.id(1,1) from public.roles where key = 'entity_admin';
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_password.id(3,8), id, 'global' from public.roles where key = 'super_admin';
insert into public.roles(key, name, rank) values ('password_audit_no_rbac', 'High rank without account authority', 90);
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_password.id(3,10), id, 'global' from public.roles where key = 'password_audit_no_rbac';
insert into auth.sessions(id, user_id)
  select audit_password.id(6,n), audit_password.id(3,case when n < 3 then 3 else 4 end) from generate_series(1,3)n;
insert into auth.refresh_tokens(user_id, session_id)
  select user_id::text, id from auth.sessions;
insert into auth.refresh_tokens(user_id) values (audit_password.id(3,3)::text);
insert into auth.one_time_tokens(id, user_id)
  select audit_password.id(7,n), audit_password.id(3,case when n < 3 then 3 else 4 end) from generate_series(1,3)n;
create table audit_password.original as select
  (select jsonb_agg(to_jsonb(p) - 'must_change_password' order by user_id) from public.profiles p) as profiles,
  (select jsonb_agg(to_jsonb(e) order by id) from public.employees e) as employees,
  (select jsonb_agg(to_jsonb(r) order by id) from public.role_assignments r) as assignments,
  (select jsonb_agg(to_jsonb(i) order by id) from auth.identities i) as identities;

do $$ begin
  assert not has_function_privilege('anon', 'public.admin_set_user_password(uuid,text)', 'execute'), 'anon blocked';
  assert not has_function_privilege('service_role', 'public.admin_set_user_password(uuid,text)', 'execute'), 'service role has no administrative-user shortcut';
  assert has_function_privilege('authenticated', 'public.admin_set_user_password(uuid,text)', 'execute'), 'authenticated RPC exposed';
  assert not has_function_privilege('authenticated', 'app.password_problem(text,text,text)', 'execute'), 'private validator';
end $$;
set role anon;
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),'Bright!River42')$q$, '42501', 'permission denied');
set role authenticated;
set request.jwt.claim.sub = '';
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),'Bright!River42')$q$, '42501', 'sign in');
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,2),'Bright!River42')$q$, '42501', 'own password');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,1),'Bright!River42')$q$, '42501', 'at or above');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,5),'Bright!River42')$q$, '42501', 'at or above');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,6),'Bright!River42')$q$, '42501', 'at or above');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,8),'Bright!River42')$q$, '42501', 'at or above');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,4),'Bright!River42')$q$, '42501', 'outside your scope');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,7),'Bright!River42')$q$, '42501', 'not linked');
select audit_password.expect_error($q$select public.admin_set_user_password(null,'Bright!River42')$q$, '22023', 'user is required');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,99),'Bright!River42')$q$, '22023', 'login not found');
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000009';
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),'Bright!River42')$q$, '42501', 'at or above');
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000010';
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),'Bright!River42')$q$, '42501', 'outside your scope');
select 'PASS: password administration rejects anonymous, self, peer/senior, other-scope, unlinked and non-admin callers' as result;

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),null)$q$, '22023', '8 characters');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),'short!')$q$, '22023', '8 characters');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),'12345678')$q$, '22023', 'only numbers');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),repeat('a',73))$q$, '22023', '72 UTF-8 bytes');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,3),repeat('é',37))$q$, '22023', '72 UTF-8 bytes');
reset role;
do $$ begin
  assert (select encrypted_password = extensions.crypt('Initial!Bridge9', encrypted_password) from auth.users where id = audit_password.id(3,3)), 'failed resets keep the original password';
  assert not (select must_change_password from public.profiles where user_id = audit_password.id(3,3)), 'failed reset keeps password gate';
  assert (select count(*) = 4 from auth.refresh_tokens), 'failed reset keeps sessions and tokens';
  assert not exists(select from public.audit_log where action = 'PASSWORD_RESET'), 'failed reset has no success audit';
end $$;
set role authenticated;
select public.admin_set_user_password(audit_password.id(3,3), 'Bright!River42');
reset role;
do $$ declare _user auth.users%rowtype;
begin
  select * into _user from auth.users where id = audit_password.id(3,3);
  assert _user.encrypted_password = extensions.crypt('Bright!River42', _user.encrypted_password), 'temporary password authenticates with bcrypt';
  assert _user.encrypted_password <> extensions.crypt('Initial!Bridge9', _user.encrypted_password), 'old password rejected';
  assert _user.encrypted_password like '$2a$10$%', 'GoTrue compatible bcrypt cost';
  assert _user.confirmation_token = '' and _user.recovery_token = '' and _user.email_change_token_current = ''
    and _user.email_change_token_new = '' and _user.phone_change_token = '' and _user.reauthentication_token = '', 'pending authentication tokens cleared';
  assert _user.confirmation_sent_at is null and _user.recovery_sent_at is null and _user.email_change_sent_at is null
    and _user.phone_change_sent_at is null and _user.reauthentication_sent_at is null, 'pending-token timestamps cleared';
  assert (select must_change_password from public.profiles where user_id = _user.id), 'admin-set password remains temporary';
  assert not exists(select from auth.sessions where user_id = _user.id), 'all target sessions revoked';
  assert not exists(select from auth.refresh_tokens where user_id = _user.id::text), 'session and legacy refresh tokens revoked';
  assert not exists(select from auth.one_time_tokens where user_id = _user.id), 'one-time recovery tokens revoked';
  assert (select count(*) = 1 from auth.sessions) and (select count(*) = 1 from auth.refresh_tokens)
    and (select count(*) = 1 from auth.one_time_tokens), 'other users stay signed in';
  assert exists(select from public.audit_log where actor = audit_password.id(3,2) and row_id = _user.id
    and action = 'PASSWORD_RESET' and entity_id = audit_password.id(1,1) and branch_id = audit_password.id(2,1)), 'scoped audit records actor and target';
  assert _user.email = 'work.alias@audit.invalid' and _user.email_confirmed_at is not null
    and _user.raw_user_meta_data = '{"private_label":"preserve"}'::jsonb, 'account email, confirmation and metadata preserved';
end $$;

-- A repeat reset does not clear a gate already set, and a normal GoTrue update clears it.
set role authenticated;
select public.admin_set_user_password(audit_password.id(3,3), 'Another!Bridge42');
reset role;
do $$ begin
  assert (select must_change_password from public.profiles where user_id = audit_password.id(3,3)), 'repeat administrative reset preserves gate';
end $$;
set request.jwt.claim.sub = '';
update auth.users set encrypted_password = extensions.crypt('Chosen!Bridge84', extensions.gen_salt('bf', 10)) where id = audit_password.id(3,3);
do $$ begin
  assert not (select must_change_password from public.profiles where user_id = audit_password.id(3,3)), 'subsequent self-service Auth password update clears gate';
end $$;
select 'PASS: password rules, atomic failure, bcrypt handover, forced replacement, token revocation and audit' as result;

set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,1),'Bright!River42')$q$, '42501', 'own password');
select audit_password.expect_error($q$select public.admin_set_user_password(audit_password.id(3,11),'Bright!River42')$q$, '22023', 'does not have an email login');
select public.admin_set_user_password(audit_password.id(3,7), 'Bright!River42');
select public.admin_set_user_password(audit_password.id(3,12), 'Bright!River42');
reset role;
do $$ declare _original audit_password.original%rowtype;
begin
  select * into _original from audit_password.original;
  assert _original.profiles = (select jsonb_agg(to_jsonb(p) - 'must_change_password' order by user_id) from public.profiles p), 'all profile identities and super-admin flags preserved';
  assert _original.employees = (select jsonb_agg(to_jsonb(e) order by id) from public.employees e), 'all employee records and links preserved';
  assert _original.assignments = (select jsonb_agg(to_jsonb(r) order by id) from public.role_assignments r), 'all role grants preserved';
  assert _original.identities = (select jsonb_agg(to_jsonb(i) order by id) from auth.identities i), 'all Auth identities preserved';
  assert (select banned_until > now() from auth.users where id = audit_password.id(3,7)), 'reset cannot reactivate a banned account';
  assert (select count(*) = 4 from public.audit_log where action = 'PASSWORD_RESET'), 'exactly successful resets audited';
end $$;
select 'PASS: super-admin-only unlinked resets, SSO protection and preservation of account identity, grants and bans' as result;

-- 0132 removes identity restrictions through the real RPC, including normalized name parts,
-- the full name, the email's local part (username), and the full email address.
set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
do $$ declare _password text;
begin
  foreach _password in array array['RA.MESH!2480', 'kumar!2480', 'Ramesh Kumar', 'work.alias', 'work.alias@audit.invalid'] loop
    perform public.admin_set_user_password(audit_password.id(3,3), _password);
  end loop;
end $$;
reset role;
do $$ begin
  assert (select encrypted_password = extensions.crypt('work.alias@audit.invalid', encrypted_password)
    from auth.users where id = audit_password.id(3,3)), 'full email is accepted and stored as a working password hash';
  assert (select must_change_password from public.profiles where user_id = audit_password.id(3,3)), 'identity-based temporary passwords still require replacement';
  assert (select count(*) = 9 from public.audit_log where action = 'PASSWORD_RESET'), 'all five name/email passwords succeeded and were audited';
end $$;
select 'PASS: administrator password resets accept names, usernames, email prefixes and full email addresses' as result;
