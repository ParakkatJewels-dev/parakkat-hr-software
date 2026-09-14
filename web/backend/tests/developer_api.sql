-- Synthetic credentials in a disposable local database only. Do not print the credentials.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_developer_api_audit' then raise exception 'requires disposable hr_developer_api_audit database'; end if;
end $$;
create schema audit_developer;
create function audit_developer.id(prefix integer, n integer) returns uuid language sql immutable as $$
  select (prefix::text || '0000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
create function audit_developer.expect_error(statement text, expected_code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate <> expected_code then raise; end if;
    return;
  end;
  raise exception 'Expected SQLSTATE %', expected_code;
end $$;
-- This table belongs solely to the test harness, never to an application migration.
create table audit_developer.keys(label text primary key, response jsonb not null);
create function audit_developer.secret(label text) returns text language sql stable as $$
  select response->>'api_key' from audit_developer.keys k where k.label = secret.label
$$;
create function audit_developer.key_id(label text) returns uuid language sql stable as $$
  select (response->'key'->>'id')::uuid from audit_developer.keys k where k.label = key_id.label
$$;
grant usage on schema audit_developer to authenticated, anon;
grant execute on all functions in schema audit_developer to authenticated, anon;
grant select, insert on audit_developer.keys to authenticated, anon;

insert into public.entities(id, code, name)
  select audit_developer.id(1,n), 'API-ENTITY-'||n, 'API test company '||n from generate_series(1,3)n;
insert into public.zones(id, entity_id, code, name)
  select audit_developer.id(2,n), audit_developer.id(1,n), 'API-ZONE-'||n, 'API test zone '||n from generate_series(1,2)n;
insert into public.branches(id, entity_id, zone_id, code, name, address)
  select audit_developer.id(3,n), audit_developer.id(1,n), audit_developer.id(2,n), 'API-BRANCH-'||n,
    'API test branch '||n, 'Private address' from generate_series(1,2)n;
insert into public.departments(id, entity_id, branch_id, code, name)
  select audit_developer.id(4,n), audit_developer.id(1,n), audit_developer.id(3,n), 'API-DEPT-'||n,
    'API test department '||n from generate_series(1,2)n;
insert into public.designations(id, entity_id, department_id, code, title)
  select audit_developer.id(5,n), audit_developer.id(1,n), audit_developer.id(4,n), 'API-DESIG-'||n,
    'API test designation '||n from generate_series(1,2)n;
insert into public.designations(id, title) values (audit_developer.id(5,3), 'API global designation');
insert into auth.users(id, email)
  select audit_developer.id(6,n), 'api-user-'||n||'@audit.invalid' from generate_series(1,5)n;
update public.profiles set is_super_admin = true where user_id in
  (audit_developer.id(6,1), audit_developer.id(6,2), audit_developer.id(6,5));
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_developer.id(6,3), id, 'global' from public.roles where key = 'super_admin';
insert into public.role_assignments(user_id, role_id, scope_type, scope_id)
  select audit_developer.id(6,4), id, 'entity', audit_developer.id(1,1) from public.roles where key = 'hr_manager';
insert into public.employees(id, entity_id, branch_id, department_id, designation_id,
  full_name, employee_code, email, phone, join_date, salary, meta)
  select audit_developer.id(7,n), audit_developer.id(1,case when n = 4 then 2 else 1 end),
    audit_developer.id(3,case when n = 4 then 2 else 1 end),
    audit_developer.id(4,case when n = 4 then 2 else 1 end),
    audit_developer.id(5,case when n = 4 then 2 else 1 end),
    'API Employee '||n, 'API-EMP-'||n, 'work-'||n||'@audit.invalid', 'PRIVATE-PHONE', '2026-01-01',
    '{"basic":123456}', '{"bank_account":"PRIVATE-BANK","pan":"PRIVATE-PAN","personal_address":"PRIVATE-HOME"}'
  from generate_series(1,5)n;
insert into public.attendance(id, employee_id, work_date, status, hours, check_in, check_out,
  worked_minutes, late_minutes, early_exit_minutes, ot_minutes)
  select audit_developer.id(8,n), audit_developer.id(7,n), '2026-08-01', 'Present', 8,
    '2026-08-01 09:00+05:30', '2026-08-01 17:00+05:30', 480, 0, 0, 0 from generate_series(1,5)n;
insert into public.attendance(id, employee_id, work_date, status, hours)
  values (audit_developer.id(8,6), audit_developer.id(7,1), '2026-07-31', 'Present', 8),
    (audit_developer.id(8,7), audit_developer.id(7,1), '2026-08-31', 'Present', 8);
-- Employee 5 has transferred. Neither company's restricted key may read the other company's history.
update public.employees set branch_id = audit_developer.id(3,2), department_id = audit_developer.id(4,2),
  designation_id = audit_developer.id(5,2) where id = audit_developer.id(7,5);

do $$ declare _signature text; _role text;
begin
  foreach _signature in array array['get_developer_settings()', 'set_developer_settings(boolean)',
    'list_developer_api_keys()', 'create_developer_api_key(text,text[],uuid,integer)', 'revoke_developer_api_key(uuid)'] loop
    assert has_function_privilege('authenticated', 'public.'||_signature, 'execute'), 'authenticated management RPC exposed';
    assert not has_function_privilege('anon', 'public.'||_signature, 'execute'), 'anonymous management denied';
    assert not has_function_privilege('service_role', 'public.'||_signature, 'execute'), 'no service-role user shortcut';
  end loop;
  assert has_function_privilege('anon', 'public.developer_api_read(text,text,integer,integer,date,date)', 'execute'), 'anonymous gateway RPC exposed';
  assert has_function_privilege('authenticated', 'public.developer_api_read(text,text,integer,integer,date,date)', 'execute'), 'authenticated API still requires key';
  foreach _role in array array['anon','authenticated','service_role'] loop
    assert not has_table_privilege(_role, 'app.developer_api_keys', 'select,insert,update,delete'), 'private keys table';
    assert not has_table_privilege(_role, 'app.developer_settings', 'select,insert,update,delete'), 'private settings table';
    assert not has_function_privilege(_role, 'app.developer_admin_active(uuid)', 'execute'), 'private authority helper';
    assert not has_function_privilege(_role, 'app.developer_key_metadata(app.developer_api_keys)', 'execute'), 'private metadata helper';
  end loop;
  assert (select bool_and(relrowsecurity) from pg_class where oid in ('app.developer_api_keys'::regclass,'app.developer_settings'::regclass)), 'private tables also enable RLS';
end $$;
set role anon;
select audit_developer.expect_error('select public.get_developer_settings()', '42501');
select audit_developer.expect_error('select * from app.developer_api_keys', '42501');
set role authenticated;
set request.jwt.claim.sub = '';
select audit_developer.expect_error('select public.get_developer_settings()', 'PT403');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000004';
select audit_developer.expect_error('select public.get_developer_settings()', 'PT403');
select audit_developer.expect_error('select public.set_developer_settings(true)', 'PT403');
select audit_developer.expect_error('select * from public.list_developer_api_keys()', 'PT403');
select audit_developer.expect_error($q$select public.create_developer_api_key('unauthorized',array['employees:read'])$q$, 'PT403');
select audit_developer.expect_error('select public.revoke_developer_api_key(null)', 'PT403');
select audit_developer.expect_error('select * from app.developer_api_keys', '42501');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
do $$ begin
  assert not (public.get_developer_settings()->>'enabled')::boolean, 'initially disabled';
end $$;
select audit_developer.expect_error('select public.set_developer_settings(null)', 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('',array['employees:read'])$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key(repeat('x',81),array['employees:read'])$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('test','{}')$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('test',null)$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('test',array['employees:write'])$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('test',array['employees:read',null])$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('test',array['employees:read'],null,0)$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('test',array['employees:read'],null,366)$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('test',array['employees:read'],null,null)$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_developer_api_key('test',array['employees:read'],audit_developer.id(1,99))$q$, 'PT400');
insert into audit_developer.keys values
  ('one', public.create_developer_api_key('  Company one  ',array['employees:read','organization:read','attendance:read','employees:read'],audit_developer.id(1,1))),
  ('two', public.create_developer_api_key('Company two',array['employees:read','organization:read','attendance:read'],audit_developer.id(1,2),365)),
  ('employees', public.create_developer_api_key('Employees only',array['employees:read'],null,1)),
  ('all', public.create_developer_api_key('All companies',array['employees:read','organization:read','attendance:read'])),
  ('rate', public.create_developer_api_key('Rate test',array[['employees:read'],['employees:read']])) ,
  ('expire', public.create_developer_api_key('Expiry test',array['employees:read'])),
  ('delete-entity', public.create_developer_api_key('Deleted company',array['employees:read'],audit_developer.id(1,3)));
do $$ declare _response jsonb; _metadata jsonb;
begin
  assert not (public.get_developer_settings()->>'enabled')::boolean, 'creation never enables API';
  select response into _response from audit_developer.keys where label = 'one';
  _metadata := _response->'key';
  assert _response - array['api_key','key'] = '{}'::jsonb, 'creation response explicit fields';
  assert (_response->>'api_key') ~ '^phr_[0-9a-f]{32}_[0-9a-f]{64}$', 'random 256-bit secret';
  assert _metadata - array['id','name','key_prefix','scopes','entity_id','created_at','expires_at','last_used_at','revoked_at'] = '{}'::jsonb, 'metadata allowlist';
  assert _metadata->>'name' = 'Company one', 'name normalized';
  assert _metadata->'scopes' = '["attendance:read","employees:read","organization:read"]'::jsonb, 'scopes deduplicated and sorted';
  assert _metadata->>'key_prefix' = 'phr_'||left(replace(_metadata->>'id','-',''),8), 'prefix reveals no secret bits';
  assert _metadata->'last_used_at' = 'null'::jsonb and _metadata->'revoked_at' = 'null'::jsonb, 'new key unused';
  assert (select count(*) = 7 from public.list_developer_api_keys()), 'metadata list';
end $$;
reset role;
do $$ begin
  assert (select count(distinct response->>'api_key') = 7 from audit_developer.keys), 'independent keys';
  assert not exists(select from audit_developer.keys t join app.developer_api_keys k on k.id = (t.response->'key'->>'id')::uuid
    where k.secret_hash <> encode(extensions.digest(t.response->>'api_key','sha256'),'hex')
      or position(t.response->>'api_key' in to_jsonb(k)::text) > 0), 'only digest persisted';
  assert (select scopes = array['employees:read'] from app.developer_api_keys where id = audit_developer.key_id('rate')), 'multidimensional scopes normalized';
end $$;
set role anon;
set request.jwt.claim.sub = '';
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees')$q$, 'PT503');
select audit_developer.expect_error($q$select public.developer_api_read(null,'employees')$q$, 'PT401');
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
do $$ begin perform public.set_developer_settings(true); end $$;
set role anon;
set request.jwt.claim.sub = '';
select 'PASS: developer settings, management authorization, key hashing, validation and disabled default' as result;

do $$ declare _page jsonb; _next jsonb; _item jsonb;
begin
  _page := public.developer_api_read(audit_developer.secret('one'),'employees',2);
  assert jsonb_array_length(_page->'data') = 2 and (_page->'pagination'->>'has_more')::boolean, 'first employee page';
  assert _page->'pagination' = '{"limit":2,"offset":0,"has_more":true}'::jsonb, 'pagination contract';
  _next := public.developer_api_read(audit_developer.secret('one'),'employees',2,2);
  assert jsonb_array_length(_next->'data') = 1 and not (_next->'pagination'->>'has_more')::boolean, 'last employee page';
  assert _page->'data'->0->>'id' = audit_developer.id(7,1)::text
    and _page->'data'->1->>'id' = audit_developer.id(7,2)::text
    and _next->'data'->0->>'id' = audit_developer.id(7,3)::text, 'stable order with no overlap';
  for _item in select value from jsonb_array_elements(_page->'data') loop
    assert _item->>'entity_id' = audit_developer.id(1,1)::text, 'employee company isolation';
    assert _item - array['id','employee_code','full_name','email','status','entity_id','zone_id','branch_id','department_id','designation_id','join_date'] = '{}'::jsonb,
      'employee work identity only, no salary, bank, phone, personal metadata or government IDs';
  end loop;
  assert public.developer_api_read(audit_developer.secret('one'),'employees',2,100)->'data' = '[]'::jsonb, 'empty last page';
  assert jsonb_array_length(public.developer_api_read(audit_developer.secret('two'),'employees')->'data') = 2, 'second company current employees';
  assert jsonb_array_length(public.developer_api_read(audit_developer.secret('all'),'employees')->'data') = 5, 'unrestricted explicitly authorized';
  _page := public.developer_api_read(audit_developer.secret('one'),'organization');
  assert jsonb_array_length(_page->'data') = 5, 'one company organization has five kinds';
  for _item in select value from jsonb_array_elements(_page->'data') loop
    assert _item->>'entity_id' = audit_developer.id(1,1)::text, 'organization company isolation';
    assert _item - array['kind','id','name','code','entity_id','zone_id','branch_id','is_active'] = '{}'::jsonb, 'organization field allowlist';
  end loop;
  assert (select array_agg(value->>'kind' order by value->>'kind') from jsonb_array_elements(_page->'data'))
    = array['branch','department','designation','entity','zone'], 'organization flat resource contract';
  assert jsonb_array_length(public.developer_api_read(audit_developer.secret('all'),'organization')->'data') = 12, 'all companies includes global designation';
  _page := public.developer_api_read(audit_developer.secret('one'),'attendance',50,0,'2026-08-01','2026-08-31');
  assert jsonb_array_length(_page->'data') = 4, 'inclusive 31-day attendance and transferred employee excluded';
  for _item in select value from jsonb_array_elements(_page->'data') loop
    assert _item->>'entity_id' = audit_developer.id(1,1)::text, 'attendance company isolation';
    assert _item->>'employee_id' <> audit_developer.id(7,5)::text, 'old company cannot read transferred employee';
    assert _item - array['id','employee_id','work_date','status','hours','worked_minutes','late_minutes','early_exit_minutes','ot_minutes','entity_id','branch_id'] = '{}'::jsonb,
      'attendance daily summaries only, no raw punch times';
  end loop;
  assert _page->'data'->3->>'work_date' = '2026-08-31', 'attendance ordered by date then id';
  assert jsonb_array_length(public.developer_api_read(audit_developer.secret('two'),'attendance',50,0,'2026-08-01','2026-08-31')->'data') = 1,
    'new company cannot read previous-company attendance';
  assert jsonb_array_length(public.developer_api_read(audit_developer.secret('all'),'attendance',50,0,'2026-08-01','2026-08-31')->'data') = 6, 'unrestricted attendance';
end $$;
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('employees'),'organization')$q$, 'PT403');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('employees'),'attendance',50,0,'2026-08-01','2026-08-02')$q$, 'PT403');
select audit_developer.expect_error($q$select public.developer_api_read('phr_'||repeat('0',32)||'_'||repeat('0',64),'employees')$q$, 'PT401');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one')||'x','employees')$q$, 'PT401');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'salary')$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),null)$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees',0)$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees',101)$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees',50,-1)$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees',50,1000001)$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees',50,0,'2026-08-01',null)$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'attendance')$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'attendance',50,0,'2026-08-01',null)$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'attendance',50,0,'2026-08-02','2026-08-01')$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'attendance',50,0,'2026-08-01','2026-09-01')$q$, 'PT400');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'attendance',50,0,'infinity','infinity')$q$, 'PT400');
select 'PASS: direct anonymous API requires valid credentials and stored scope; explicit fields, entity isolation, transfer privacy and pagination' as result;

do $$ begin
  for n in 1..60 loop perform public.developer_api_read(audit_developer.secret('rate'),'employees',1); end loop;
end $$;
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('rate'),'employees',1)$q$, 'PT429');
do $$ begin
  perform public.developer_api_read(audit_developer.secret('employees'),'employees',1);
end $$;
reset role;
do $$ begin
  assert (select rate_count = 60 and last_used_at is not null from app.developer_api_keys where id = audit_developer.key_id('rate')), 'rate cap is exact and usage recorded';
end $$;
update app.developer_api_keys set rate_window_at = clock_timestamp() - interval '61 seconds' where id = audit_developer.key_id('rate');
update app.developer_api_keys set expires_at = clock_timestamp() - interval '1 second' where id = audit_developer.key_id('expire');
set role anon;
do $$ begin perform public.developer_api_read(audit_developer.secret('rate'),'employees',1); end $$;
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('expire'),'employees')$q$, 'PT401');
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
select public.revoke_developer_api_key(audit_developer.key_id('employees'));
select public.revoke_developer_api_key(audit_developer.key_id('employees'));
select audit_developer.expect_error('select public.revoke_developer_api_key(null)', 'PT400');
select audit_developer.expect_error('select public.revoke_developer_api_key(audit_developer.id(1,99))', 'PT400');
do $$ begin
  assert (select revoked_at is not null from public.list_developer_api_keys() where id = audit_developer.key_id('employees')), 'revoked metadata retained';
  perform public.set_developer_settings(false);
  perform public.set_developer_settings(false);
end $$;
set role anon;
set request.jwt.claim.sub = '';
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees')$q$, 'PT503');
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000002';
do $$ begin perform public.set_developer_settings(true); end $$;
set role anon;
set request.jwt.claim.sub = '';
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('employees'),'employees')$q$, 'PT401');
do $$ begin perform public.developer_api_read(audit_developer.secret('one'),'employees'); end $$;
reset role;
do $$ begin
  assert (select rate_count = 1 from app.developer_api_keys where id = audit_developer.key_id('rate')), 'elapsed window renews quota';
  assert (select count(*) = 1 from public.audit_log where action = 'API_KEY_REVOKE' and row_id = audit_developer.key_id('employees')), 'idempotent revoke audit';
  assert (select count(*) = 1 from public.audit_log where action = 'DEVELOPER_API_DISABLE'), 'idempotent setting audit';
end $$;
select 'PASS: exact per-key rate quota, expiry, idempotent revoke, master disable and re-enable' as result;

-- Every request checks current creator authority, rather than trusting authority at creation.
update public.profiles set is_super_admin = false where user_id = audit_developer.id(6,1);
set role anon;
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees')$q$, 'PT401');
reset role;
update public.profiles set is_super_admin = true where user_id = audit_developer.id(6,1);
update auth.users set banned_until = clock_timestamp() + interval '1 day' where id = audit_developer.id(6,1);
set role anon;
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees')$q$, 'PT401');
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
select audit_developer.expect_error('select public.get_developer_settings()', 'PT403');
reset role;
update auth.users set banned_until = clock_timestamp() - interval '1 second' where id = audit_developer.id(6,1);
set role anon;
set request.jwt.claim.sub = '';
do $$ begin perform public.developer_api_read(audit_developer.secret('one'),'employees'); end $$;
reset role;
update auth.users set deleted_at = clock_timestamp() where id = audit_developer.id(6,1);
set role anon;
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('one'),'employees')$q$, 'PT401');
reset role;
update auth.users set deleted_at = null where id = audit_developer.id(6,1);
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
insert into audit_developer.keys values ('role-admin', public.create_developer_api_key('Role granted admin',array['employees:read']));
do $$ begin assert (public.get_developer_settings()->>'enabled')::boolean, 'role-granted super admin qualifies'; end $$;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000005';
insert into audit_developer.keys values ('delete-creator', public.create_developer_api_key('Deleted creator',array['employees:read']));
set role anon;
set request.jwt.claim.sub = '';
do $$ begin perform public.developer_api_read(audit_developer.secret('role-admin'),'employees'); end $$;
reset role;
delete from public.role_assignments where user_id = audit_developer.id(6,3);
delete from auth.users where id = audit_developer.id(6,5);
delete from public.entities where id = audit_developer.id(1,3);
set role anon;
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('role-admin'),'employees')$q$, 'PT401');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('delete-creator'),'employees')$q$, 'PT401');
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('delete-entity'),'employees')$q$, 'PT401');
reset role;
do $$ begin
  assert not exists(select from app.developer_api_keys where id in (audit_developer.key_id('delete-creator'),audit_developer.key_id('delete-entity'))), 'deletion never broadens authority';
  assert exists(select from public.audit_log where action = 'API_KEY_CREATE' and row_id = audit_developer.key_id('one')
    and actor = audit_developer.id(6,1) and entity_id = audit_developer.id(1,1)), 'safe audit includes actor, key id and company';
  assert not exists(select from public.audit_log a cross join audit_developer.keys k
    where position(k.response->>'api_key' in to_jsonb(a)::text) > 0
      or position(encode(extensions.digest(k.response->>'api_key','sha256'),'hex') in to_jsonb(a)::text) > 0), 'no plaintext or digest in audit';
end $$;
select 'PASS: creator demotion, ban, soft deletion, role removal and hard deletion invalidate access; entity deletion cannot broaden keys; safe audit' as result;
