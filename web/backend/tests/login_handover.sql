-- Uses only the synthetic identities created by admin_password_reset.sql.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_password_audit' then raise exception 'requires disposable hr_password_audit database'; end if;
end $$;

begin;
set request.jwt.claim.sub = '';
insert into public.employees(id, entity_id, branch_id, full_name, employee_code, phone)
  values (audit_password.id(5,60), audit_password.id(1,1), audit_password.id(2,1), 'Handover Existing', 'HANDOVER-60', '9999000060'),
         (audit_password.id(5,61), audit_password.id(1,1), audit_password.id(2,1), 'Handover Fresh', 'HANDOVER-61', '9999000061');
insert into auth.users(id, email, encrypted_password, email_confirmed_at)
  values (audit_password.id(3,60), 'handover.existing@parakkatjewels.com',
    extensions.crypt('PreviouslyChosen!42', extensions.gen_salt('bf', 6)), now());
insert into auth.identities(id, provider_id, user_id, identity_data, provider)
  values (audit_password.id(4,60), audit_password.id(3,60)::text, audit_password.id(3,60),
    jsonb_build_object('sub', audit_password.id(3,60)::text, 'email', 'handover.existing@parakkatjewels.com'), 'email');
update public.profiles set must_change_password = false where user_id = audit_password.id(3,60);
create temporary table original_login as select encrypted_password from auth.users where id = audit_password.id(3,60);
create temporary table handover_results(kind text primary key, result jsonb);
grant insert, select on handover_results to authenticated;

set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
insert into handover_results values ('reused', public.provision_employee_login(audit_password.id(5,60)));
insert into handover_results values ('repeated', public.provision_employee_login(audit_password.id(5,60)));
insert into handover_results values ('fresh', public.provision_employee_login(audit_password.id(5,61)));
insert into handover_results values ('fresh-repeated', public.provision_employee_login(audit_password.id(5,61)));
reset role;
do $$ declare _result jsonb; _hash text;
begin
  select result into _result from handover_results where kind = 'reused';
  assert (_result->>'created')::boolean = false, 'adopting an existing account is not account creation';
  assert _result->>'password' is null, 'do not report a derived password that was never installed';
  assert _result->>'email' = 'handover.existing@parakkatjewels.com', 'handover identifies the reused login';
  assert _result->>'note' like '%password is unchanged%', 'handover explains existing password remains valid';
  assert (_result->'grant'->>'user_id')::uuid = audit_password.id(3,60), 'reuses the existing login';
  assert (select encrypted_password = (select encrypted_password from original_login) from auth.users where id = audit_password.id(3,60)), 'existing hash is unchanged';
  assert not (select must_change_password from public.profiles where user_id = audit_password.id(3,60)), 'existing password gate is unchanged';
  assert (select employee_id = audit_password.id(5,60) from public.profiles where user_id = audit_password.id(3,60)), 'existing login is linked';
  assert not exists (select from handover_results where kind in ('repeated', 'fresh-repeated')
    and ((result->>'created')::boolean or result->>'password' is not null)), 'retries never reset or redisplay passwords';
  select result into _result from handover_results where kind = 'fresh';
  assert (_result->>'created')::boolean, 'new accounts are reported as created';
  assert length(_result->>'password') >= 8, 'new login gets a usable handover credential';
  select encrypted_password into _hash from auth.users where id = (_result->'grant'->>'user_id')::uuid;
  assert _hash = extensions.crypt(_result->>'password', _hash), 'reported temporary password matches the stored hash';
  assert (select must_change_password from public.profiles where user_id = (_result->'grant'->>'user_id')::uuid), 'new password still requires replacement';
end $$;
rollback;
select 'PASS: provisioning reports actual account creation, preserves reused credentials and returns only installed temporary passwords' as result;
