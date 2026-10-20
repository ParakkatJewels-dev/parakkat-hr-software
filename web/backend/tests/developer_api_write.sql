-- Personal assistant keys (0168). Runs after developer_api.sql in the same disposable database and
-- reuses its organisation, helpers and key table. Synthetic credentials only; never printed.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_developer_api_audit' then raise exception 'requires disposable hr_developer_api_audit database'; end if;
end $$;

create schema audit_agent;
-- Every successful call must hand back a clean anonymous session.
create function audit_agent.clean() returns void language plpgsql as $$
begin
  if current_user <> 'anon' or auth.uid() is not null
     or coalesce(current_setting('request.jwt.claims', true), '') <> ''
     or coalesce(current_setting('request.jwt.claim.role', true), '') <> '' then
    raise exception 'identity leaked: user %, uid %', current_user, auth.uid();
  end if;
end $$;
create function audit_agent.call(label text, tool text, args jsonb default '{}') returns jsonb language sql volatile as $$
  select public.developer_api_call(audit_developer.secret(label), tool, args)
$$;
create function audit_agent.ok(label text, tool text, args jsonb default '{}') returns jsonb language plpgsql volatile as $$
declare _response jsonb := public.developer_api_call(audit_developer.secret(label), tool, args);
begin
  perform audit_agent.clean();
  if not coalesce((_response->>'ok')::boolean, false) then
    raise exception 'Expected % to succeed, got %', tool, _response->'error';
  end if;
  return _response->'data';
end $$;
create function audit_agent.fails(label text, tool text, args jsonb default '{}', expected text default null)
returns jsonb language plpgsql volatile as $$
declare _response jsonb := public.developer_api_call(audit_developer.secret(label), tool, args);
begin
  perform audit_agent.clean();
  if coalesce((_response->>'ok')::boolean, true) then raise exception 'Expected % to be refused', tool; end if;
  if expected is not null and _response->'error'->>'code' <> expected then
    raise exception 'Expected % to fail with %, got %', tool, expected, _response->'error';
  end if;
  if _response->'error'->>'message' ~* '(row-level security|relation|column|constraint|schema|hr_agent|pg_)' then
    raise exception 'database detail leaked: %', _response->'error'->>'message';
  end if;
  return _response->'error';
end $$;
grant usage on schema audit_agent to anon, authenticated;
grant execute on all functions in schema audit_agent to anon, authenticated;

-- PostgREST's login role: NOINHERIT and a member of both API roles, exactly like `authenticator`.
do $$ begin
  if not exists(select from pg_roles where rolname = 'api_gateway_sim') then
    create role api_gateway_sim noinherit login;
  end if;
end $$;
grant anon, authenticated to api_gateway_sim;

-- Organisation: a second department in company 1, managers, a plain employee and an outsider.
insert into public.departments(id, entity_id, branch_id, code, name)
  values (audit_developer.id(4,3), audit_developer.id(1,1), audit_developer.id(3,1), 'API-DEPT-3', 'API test department 3');
insert into auth.users(id, email)
  select audit_developer.id(6,n), 'agent-user-'||n||'@audit.invalid' from generate_series(11,15)n;
insert into public.employees(id, entity_id, branch_id, department_id, designation_id, full_name, employee_code, email, join_date)
  values
  (audit_developer.id(7,11), audit_developer.id(1,1), audit_developer.id(3,1), audit_developer.id(4,1), audit_developer.id(5,1), 'Agent Manager', 'AG-11', 'ag11@audit.invalid', '2026-01-01'),
  (audit_developer.id(7,12), audit_developer.id(1,1), audit_developer.id(3,1), audit_developer.id(4,1), audit_developer.id(5,1), 'Agent Entity Admin', 'AG-12', 'ag12@audit.invalid', '2026-01-01'),
  (audit_developer.id(7,13), audit_developer.id(1,1), audit_developer.id(3,1), audit_developer.id(4,1), audit_developer.id(5,1), 'Agent Team Member', 'AG-13', 'ag13@audit.invalid', '2026-01-01'),
  (audit_developer.id(7,14), audit_developer.id(1,2), audit_developer.id(3,2), audit_developer.id(4,2), audit_developer.id(5,2), 'Agent Outsider', 'AG-14', 'ag14@audit.invalid', '2026-01-01'),
  (audit_developer.id(7,15), audit_developer.id(1,1), audit_developer.id(3,1), audit_developer.id(4,3), null, 'Agent Other Head', 'AG-15', 'ag15@audit.invalid', '2026-01-01');
update public.profiles p set employee_id = audit_developer.id(7, n)
  from generate_series(11,15)n where p.user_id = audit_developer.id(6, n);
insert into public.role_assignments(user_id, role_id, scope_type, scope_id)
  select audit_developer.id(6,11), id, 'department'::scope_type, audit_developer.id(4,1) from public.roles where key = 'dept_head'
  union all select audit_developer.id(6,12), id, 'entity'::scope_type, audit_developer.id(1,1) from public.roles where key = 'entity_admin'
  union all select audit_developer.id(6,14), id, 'department'::scope_type, audit_developer.id(4,2) from public.roles where key = 'dept_head'
  union all select audit_developer.id(6,15), id, 'department'::scope_type, audit_developer.id(4,3) from public.roles where key = 'dept_head';
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_developer.id(6,13), id, 'self' from public.roles where key = 'employee';
-- The super admin grants the new permission to manager roles in the Roles screen.
insert into public.role_permissions(role_id, permission_id)
  select r.id, p.id from public.roles r join public.permissions p on p.key = 'api.connect'
  where r.key in ('dept_head', 'entity_admin') on conflict do nothing;
insert into public.leaves(id, employee_id, type, start_date, end_date, days, reason, status)
  values (audit_developer.id(9,1), audit_developer.id(7,13), 'Casual', current_date + 20, current_date + 21, 2, 'Family function', 'Pending');

-- Grants -----------------------------------------------------------------------------------------
do $$ declare _signature text;
begin
  assert has_function_privilege('anon', 'public.developer_api_call(text,text,jsonb)', 'execute'), 'gateway entry point exposed to anon';
  assert not has_function_privilege('authenticated', 'public.developer_api_call(text,text,jsonb)', 'execute'), 'entry point not for app sessions';
  assert not has_function_privilege('service_role', 'public.developer_api_call(text,text,jsonb)', 'execute'), 'no service-role shortcut';
  assert not has_schema_privilege('anon', 'hr_agent', 'usage'), 'tools unreachable without the identity switch';
  assert has_schema_privilege('authenticated', 'hr_agent', 'usage'), 'tools run as authenticated';
  assert not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'hr_agent' and (has_function_privilege('anon', p.oid, 'execute') or p.prosecdef)), 'tools are invoker-only and closed to anon';
  assert not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'hr_agent' and p.proname ~ '(delete|remove|trash|untick|purge)'), 'no deleting tool exists';
  assert not has_function_privilege('authenticated', 'agent_gateway.authorize(text,text)', 'execute'), 'authorizer is gateway-only';
  assert not has_schema_privilege('anon', 'app', 'usage'), 'app schema stays closed to anon';
  assert not has_schema_privilege('authenticated', 'agent_gateway', 'usage'), 'gateway schema is anon-only';
  foreach _signature in array array['set_agent_api_enabled(boolean)', 'get_my_agent_access()',
    'create_my_api_key(text,text[],integer)', 'list_my_api_keys()', 'revoke_my_api_key(uuid)'] loop
    assert has_function_privilege('authenticated', 'public.'||_signature, 'execute'), 'self-service RPC exposed';
    assert not has_function_privilege('anon', 'public.'||_signature, 'execute'), 'self-service RPC needs sign-in';
  end loop;
end $$;
select 'PASS: assistant entry point, tool schema and self-service RPC grants' as result;

-- Everything from here to COMMIT is one transaction. Counters are not flushed mid-transaction, so
-- the difference from this snapshot is exactly what the calls below deleted.
begin;
create temp table agent_delete_baseline as select relid, n_tup_del from pg_stat_xact_user_tables;

-- Keys -------------------------------------------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000013';
do $$ begin
  assert not (public.get_my_agent_access()->>'allowed')::boolean, 'plain employee lacks api.connect';
end $$;
select audit_developer.expect_error($q$select public.create_my_api_key('mine',array['tasks:manage'])$q$, 'PT403');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000011';
do $$ begin
  assert (public.get_my_agent_access()->>'allowed')::boolean, 'manager has api.connect';
  assert not (public.get_my_agent_access()->>'enabled')::boolean, 'assistant access starts off';
end $$;
select audit_developer.expect_error($q$select public.create_my_api_key('mine',array['tasks:manage'])$q$, 'PT503');
select audit_developer.expect_error('select public.set_agent_api_enabled(true)', 'PT403');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
do $$ begin
  assert (public.set_agent_api_enabled(true)->>'agent_enabled')::boolean, 'super admin turns assistant access on';
  assert (public.get_developer_settings()->>'agent_enabled')::boolean, 'settings report the switch';
end $$;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000011';
select audit_developer.expect_error($q$select public.create_my_api_key('',array['tasks:manage'])$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_my_api_key('x',array['employees:read'])$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_my_api_key('x',array['tasks:manage',null])$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_my_api_key('x','{}')$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_my_api_key('x',array['tasks:manage'],91)$q$, 'PT400');
select audit_developer.expect_error($q$select public.create_my_api_key('x',array['tasks:manage'],0)$q$, 'PT400');
insert into audit_developer.keys values
  ('m-all', public.create_my_api_key(' Hermes laptop ', array['tasks:manage','leave:manage','assets:manage','goals:manage','tasks:manage'])),
  ('m-tasks', public.create_my_api_key('Hermes tasks only', array['tasks:manage'], 7)),
  ('agent-rate', public.create_my_api_key('Rate test', array['tasks:manage'])),
  ('filler-1', public.create_my_api_key('Filler 1', array['goals:manage'])),
  ('filler-2', public.create_my_api_key('Filler 2', array['goals:manage']));
select audit_developer.expect_error($q$select public.create_my_api_key('Sixth',array['goals:manage'])$q$, 'PT400');
select public.revoke_my_api_key(audit_developer.key_id('filler-2'));
select public.revoke_my_api_key(audit_developer.key_id('filler-2'));
do $$ declare _response jsonb := (select response from audit_developer.keys where label = 'm-all');
begin
  assert (_response->>'api_key') ~ '^phr_[0-9a-f]{32}_[0-9a-f]{64}$', 'same opaque key format';
  assert (_response->'key') - array['id','name','key_prefix','scopes','created_at','expires_at','last_used_at','revoked_at'] = '{}'::jsonb, 'metadata allowlist';
  assert _response->'key'->'scopes' = '["assets:manage","goals:manage","leave:manage","tasks:manage"]'::jsonb, 'scopes deduplicated and sorted';
  assert _response->'key'->>'name' = 'Hermes laptop', 'name trimmed';
  assert (_response->'key'->>'expires_at')::timestamptz between now() + interval '29 days' and now() + interval '31 days', '30-day default';
  assert (select count(*) from public.list_my_api_keys()) = 5, 'owner lists own keys';
  assert (select count(*) from public.list_my_api_keys() where revoked_at is not null) = 1, 'revoke is idempotent';
end $$;
-- Room for one more after revoking.
insert into audit_developer.keys values ('filler-3', public.create_my_api_key('Filler 3', array['goals:manage']));
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000012';
insert into audit_developer.keys values ('ea-all', public.create_my_api_key('Entity admin', array['tasks:manage','leave:manage','assets:manage','goals:manage']));
select audit_developer.expect_error($q$select public.revoke_my_api_key(audit_developer.key_id('m-all'))$q$, 'PT400');
do $$ begin assert (select count(*) from public.list_my_api_keys()) = 1, 'nobody lists another person''s keys'; end $$;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000014';
insert into audit_developer.keys values ('outsider', public.create_my_api_key('Outsider', array['tasks:manage','leave:manage','goals:manage']));
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000015';
insert into audit_developer.keys values ('head3', public.create_my_api_key('Other head', array['tasks:manage']));
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
do $$ begin
  assert exists(select 1 from public.list_developer_api_keys() where id = audit_developer.key_id('m-all')
    and kind = 'manage' and owner_name = 'Agent Manager'), 'super admin sees personal keys with their owner';
  assert exists(select 1 from public.list_developer_api_keys() where kind = 'read'), 'read keys keep their kind';
end $$;
reset role;
set request.jwt.claim.sub = '';
do $$ begin
  assert (select bool_and(kind = 'manage' and entity_id is null) from app.developer_api_keys
    where id in (audit_developer.key_id('m-all'), audit_developer.key_id('ea-all'))), 'manage keys are unrestricted by company';
end $$;
select audit_developer.expect_error($q$insert into app.developer_api_keys(name,key_prefix,secret_hash,scopes,expires_at,kind)
  values ('mixed','p',repeat('a',64),array['employees:read','tasks:manage'],now()+interval '1 day','manage')$q$, '23514');
select audit_developer.expect_error($q$insert into app.developer_api_keys(name,key_prefix,secret_hash,scopes,expires_at,kind,entity_id)
  values ('scoped','p',repeat('b',64),array['tasks:manage'],now()+interval '1 day','manage',audit_developer.id(1,1))$q$, '23514');
select 'PASS: personal keys need api.connect and the switch; validation, cap, revoke, owner-only listing, super admin overview' as result;

-- Gateway boundaries ------------------------------------------------------------------------------
set session authorization api_gateway_sim;
set role anon;
-- A manage key never opens the org-wide read endpoints, and a read key never acts as anybody.
select audit_developer.expect_error($q$select public.developer_api_read(audit_developer.secret('m-all'),'employees')$q$, 'PT401');
select audit_developer.expect_error($q$select public.developer_api_call(audit_developer.secret('all'),'whoami')$q$, 'PT401');
select audit_developer.expect_error($q$select public.developer_api_call('phr_bad','whoami')$q$, 'PT401');
select audit_developer.expect_error($q$select audit_agent.call('m-all','drop_everything')$q$, 'PT400');
select audit_developer.expect_error($q$select audit_agent.call('m-tasks','decide_leave','{}')$q$, 'PT403');
select audit_developer.expect_error($q$select audit_agent.call('m-tasks','list_goals')$q$, 'PT403');
select audit_developer.expect_error('select * from hr_agent.whoami(''{}'')', '42501');
do $$ declare _me jsonb := audit_agent.ok('m-all', 'whoami');
begin
  assert _me->'employee'->>'id' = audit_developer.id(7,11)::text, 'acts as the key owner';
  assert _me->'employee'->>'name' = 'Agent Manager', 'owner name';
  assert _me->'areas' = '["assets:manage","goals:manage","leave:manage","tasks:manage"]'::jsonb, 'areas reported for tool filtering';
  assert (audit_agent.ok('m-tasks', 'whoami')->'areas') = '["tasks:manage"]'::jsonb, 'narrow key reports its one area';
end $$;
do $$ begin
  perform audit_agent.fails('m-all', 'list_tasks', '{"bogus":1}', 'invalid');
  perform audit_agent.fails('m-all', 'get_task', '{"task_id":"not-an-id"}', 'invalid');
  perform audit_agent.fails('m-all', 'get_task', '{}', 'invalid');
  perform audit_agent.fails('m-all', 'list_tasks', '{"status":"Finished"}', 'invalid');
  perform audit_agent.fails('m-all', 'list_tasks', '{"limit":500}', 'invalid');
  assert public.developer_api_call(audit_developer.secret('m-all'), 'whoami', '[]')->'error'->>'code' = 'invalid', 'arguments must be an object';
  perform audit_agent.clean();
end $$;
select 'PASS: read and manage keys never cross; unknown tools, missing areas and bad arguments are refused; identity always restored' as result;

-- Basics ------------------------------------------------------------------------------------------
do $$ declare _found jsonb;
begin
  _found := audit_agent.ok('m-all', 'find_employees', '{"query":"agent"}');
  assert _found->'employees' @> jsonb_build_array(jsonb_build_object('id', audit_developer.id(7,13))), 'finds people in scope';
  assert not (_found->'employees' @> jsonb_build_array(jsonb_build_object('id', audit_developer.id(7,14)))), 'never finds people outside scope';
  assert not (_found::text ~ '(PRIVATE|salary|phone|bank)'), 'directory fields only';
  _found := audit_agent.ok('m-all', 'find_employees', '{"query":"%"}');
  assert jsonb_array_length(_found->'employees') = 0, 'wildcards are literal';
  _found := audit_agent.ok('m-all', 'find_employees', '{"limit":1}');
  assert jsonb_array_length(_found->'employees') = 1 and (_found->>'has_more')::boolean, 'paging reports more';
end $$;
select 'PASS: employee search follows the owner''s visibility and returns directory fields only' as result;

-- Tasks -------------------------------------------------------------------------------------------
create temp table agent_ids(label text primary key, id uuid not null);
grant all on agent_ids to anon, authenticated;
do $$ declare _task jsonb;
begin
  _task := audit_agent.ok('m-all', 'create_task', jsonb_build_object('title', '  Prepare Diwali stock list ',
    'description', 'Count every display tray', 'assignee_id', audit_developer.id(7,13), 'helper_ids', jsonb_build_array(audit_developer.id(7,1)),
    'priority', 'high', 'due_date', (current_date + 7)::text, 'subtasks', jsonb_build_array('Trays', ' ', 'Vault')));
  insert into agent_ids values ('task', (_task->>'task_id')::uuid);
  perform audit_agent.fails('m-all', 'create_task', jsonb_build_object('title', 'Outside', 'assignee_id', audit_developer.id(7,14)), 'forbidden');
  perform audit_agent.fails('m-all', 'create_task', jsonb_build_object('title', 'Bad date', 'assignee_id', audit_developer.id(7,13), 'due_date', '2026-02-30'), 'invalid');
  perform audit_agent.fails('outsider', 'get_task', jsonb_build_object('task_id', (select id from agent_ids where label = 'task')), 'not_found');
  perform audit_agent.fails('outsider', 'update_task', jsonb_build_object('task_id', (select id from agent_ids where label = 'task'), 'status', 'Done'), 'not_found');
end $$;
reset role;
reset session authorization;
do $$ declare _id uuid := (select id from agent_ids where label = 'task');
begin
  assert exists(select 1 from public.tasks where id = _id and assigned_by = audit_developer.id(7,11)
    and employee_id = audit_developer.id(7,13) and priority = 'High' and status = 'To Do' and title = 'Prepare Diwali stock list'), 'task saved under the manager''s name';
  assert (select count(*) from public.task_assignees where task_id = _id and added_by = audit_developer.id(7,11)) = 2, 'main person and helper';
  assert (select array_agg(title order by position) from public.task_checklist_items where task_id = _id) = array['Trays','Vault'], 'blank subtasks skipped';
end $$;
set session authorization api_gateway_sim;
set role anon;
do $$ declare _id uuid := (select id from agent_ids where label = 'task'); _comment jsonb; _subtask jsonb; _task jsonb;
begin
  perform audit_agent.ok('m-all', 'update_task', jsonb_build_object('task_id', _id, 'status', 'done'));
  perform audit_agent.ok('m-all', 'update_task', jsonb_build_object('task_id', _id, 'status', 'In Progress', 'clear_due_date', true));
  perform audit_agent.fails('m-all', 'update_task', jsonb_build_object('task_id', _id), 'invalid');
  perform audit_agent.fails('m-all', 'update_task', jsonb_build_object('task_id', _id, 'due_date', '2026-12-01', 'clear_due_date', true), 'invalid');
  _comment := audit_agent.ok('m-all', 'comment_on_task', jsonb_build_object('task_id', _id, 'body', 'Please finish by Friday'));
  insert into agent_ids values ('comment', (_comment->>'comment_id')::uuid);
  perform audit_agent.ok('m-all', 'comment_on_task', jsonb_build_object('task_id', _id, 'body', 'Reply', 'reply_to', _comment->>'comment_id'));
  _subtask := audit_agent.ok('m-all', 'add_subtask', jsonb_build_object('task_id', _id, 'title', 'Showroom'));
  insert into agent_ids values ('subtask', (_subtask->>'subtask_id')::uuid);
  -- Ticking writes the ticker's name as the person who did the work: only people on the task may.
  perform audit_agent.fails('m-all', 'tick_subtask', jsonb_build_object('subtask_id', _subtask->>'subtask_id'));
  assert (audit_agent.ok('m-all', 'add_task_helpers', jsonb_build_object('task_id', _id,
    'employee_ids', jsonb_build_array(audit_developer.id(7,11), audit_developer.id(7,1))))->>'added')::integer = 1, 'existing helpers skipped';
  perform audit_agent.ok('m-all', 'tick_subtask', jsonb_build_object('subtask_id', _subtask->>'subtask_id', 'done', true));
  _task := audit_agent.ok('m-all', 'get_task', jsonb_build_object('task_id', _id));
  assert jsonb_array_length(_task->'people') = 3, 'three people on the task';
  assert jsonb_array_length(_task->'comments') = 2, 'comments returned';
  assert _task->'subtasks'->>'total' = '3' and _task->'subtasks'->>'done' = '1', 'subtask counts';
  assert _task->>'due_date' is null, 'due date cleared';
  assert (audit_agent.ok('m-all', 'list_tasks', '{"view":"assigned_to_me"}')->'tasks') @> jsonb_build_array(jsonb_build_object('id', _id)), 'my tasks';
  assert (audit_agent.ok('m-all', 'list_tasks', '{"view":"created_by_me","query":"diwali"}')->'tasks') @> jsonb_build_array(jsonb_build_object('id', _id)), 'tasks I set';
  assert jsonb_array_length(audit_agent.ok('outsider', 'list_tasks', '{}')->'tasks') = 0, 'outsider sees nothing';
end $$;
reset role;
reset session authorization;
do $$ declare _id uuid := (select id from agent_ids where label = 'task');
begin
  assert exists(select 1 from public.task_comments where id = (select id from agent_ids where label = 'comment')
    and author_user = audit_developer.id(6,11) and author_id = audit_developer.id(7,11)), 'comment authored by the manager';
  assert exists(select 1 from public.task_comments where parent_id = (select id from agent_ids where label = 'comment')), 'reply threaded';
  assert exists(select 1 from public.task_checklist_items where id = (select id from agent_ids where label = 'subtask')
    and completed_by = audit_developer.id(7,11)), 'tick names the manager';
  assert exists(select 1 from public.tasks where id = _id and status = 'In Progress' and completed_at is null and due_date is null), 'reopening clears completion';
end $$;
select 'PASS: tasks are created, updated, discussed and ticked under the manager''s name and scope' as result;

-- Routines, department requests, tickets ---------------------------------------------------------
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set role authenticated;
insert into agent_ids values ('category', public.save_ticket_category('Agent IT desk', audit_developer.id(4,3)));
reset role;
set request.jwt.claim.sub = '';
set session authorization api_gateway_sim;
set role anon;
do $$ declare _routine jsonb; _list jsonb; _jobs jsonb; _request jsonb; _answer jsonb; _ticket jsonb;
  _today text := ((now() at time zone 'Asia/Kolkata')::date)::text;
begin
  _routine := audit_agent.ok('m-all', 'create_routine', jsonb_build_object('employee_ids', jsonb_build_array(audit_developer.id(7,13)),
    'title', 'Opening checks', 'jobs', jsonb_build_array(jsonb_build_object('title', 'Open shutters'), jsonb_build_object('title', 'Count cash')),
    'schedule', jsonb_build_object('frequency', 'daily', 'start_date', _today)));
  _list := audit_agent.ok('m-all', 'list_routines', jsonb_build_object('employee_id', audit_developer.id(7,13)));
  assert jsonb_array_length(_list->'routines') = 1, 'routine listed';
  insert into agent_ids values ('routine', (_list->'routines'->0->>'id')::uuid);
  _jobs := _list->'routines'->0->'jobs';
  assert jsonb_array_length(_jobs) = 2, 'routine jobs listed with ids';
  -- Dropping a job would remove it.
  perform audit_agent.fails('m-all', 'update_routine', jsonb_build_object('routine_id', _list->'routines'->0->>'id', 'title', 'Opening checks',
    'jobs', jsonb_build_array(_jobs->0), 'schedule', jsonb_build_object('frequency', 'daily', 'start_date', _today)), 'invalid');
  perform audit_agent.ok('m-all', 'update_routine', jsonb_build_object('routine_id', _list->'routines'->0->>'id', 'title', 'Opening checks',
    'jobs', _jobs || jsonb_build_array(jsonb_build_object('title', 'Switch on lights')), 'schedule', jsonb_build_object('frequency', 'daily', 'start_date', _today)));
  perform audit_agent.fails('outsider', 'stop_routine', jsonb_build_object('routine_id', _list->'routines'->0->>'id'));

  _request := audit_agent.ok('m-all', 'request_help', jsonb_build_object('from_department_id', audit_developer.id(4,1),
    'to_department_id', audit_developer.id(4,3), 'title', 'Need a hand with displays', 'priority', 'medium'));
  perform audit_agent.ok('m-all', 'cancel_help_request', jsonb_build_object('request_id', _request->>'request_id'));
  _request := audit_agent.ok('m-all', 'request_help', jsonb_build_object('from_department_id', audit_developer.id(4,1),
    'to_department_id', audit_developer.id(4,3), 'title', 'Need IT for billing counter'));
  insert into agent_ids values ('request', (_request->>'request_id')::uuid);
  assert (audit_agent.ok('head3', 'list_help_requests', '{"direction":"incoming","status":"pending"}')->'requests')
    @> jsonb_build_array(jsonb_build_object('id', _request->>'request_id')), 'receiving head sees it';
  _answer := audit_agent.ok('head3', 'answer_help_request', jsonb_build_object('request_id', _request->>'request_id',
    'accept', true, 'assignee_id', audit_developer.id(7,15), 'note', 'On it'));
  assert (_answer->>'accepted')::boolean, 'request accepted';

  perform audit_agent.ok('m-all', 'list_ticket_categories');
  _ticket := audit_agent.ok('m-all', 'create_ticket', jsonb_build_object('category_id', (select id from agent_ids where label = 'category'),
    'subject', 'Printer jammed', 'priority', 'low'));
  insert into agent_ids values ('ticket', (_ticket->>'ticket_id')::uuid);
  perform audit_agent.fails('m-all', 'create_ticket', jsonb_build_object('category_id', (select id from agent_ids where label = 'category'),
    'subject', 'x', 'priority', 'urgent'), 'invalid');
  assert (audit_agent.ok('m-all', 'list_tickets')->'tickets') @> jsonb_build_array(jsonb_build_object('id', _ticket->>'ticket_id')), 'own ticket listed';
  perform audit_agent.ok('head3', 'set_ticket_status', jsonb_build_object('ticket_id', _ticket->>'ticket_id', 'status', 'resolved'));
  perform audit_agent.ok('m-all', 'stop_routine', jsonb_build_object('routine_id', (select id from agent_ids where label = 'routine')));
end $$;
reset role;
reset session authorization;
do $$ begin
  assert exists(select 1 from public.help_requests where id = (select id from agent_ids where label = 'request')
    and status = 'Accepted' and decided_by = audit_developer.id(7,15) and task_id is not null), 'acceptance recorded under the receiving head';
  assert exists(select 1 from public.help_requests where requested_by = audit_developer.id(7,11) and status = 'Cancelled'), 'cancel is a status';
  assert exists(select 1 from public.tickets where id = (select id from agent_ids where label = 'ticket') and status = 'Resolved'), 'ticket status changed';
  assert (select count(*) from public.routine_items i join public.routine_sets s on s.id = i.routine_id
    where s.employee_id = audit_developer.id(7,13) and i.deleted_at is not null) = 0, 'no routine job was removed';
  assert exists(select 1 from public.routine_sets where employee_id = audit_developer.id(7,13) and retired_on is not null), 'stopping retires the routine';
end $$;
select 'PASS: routines (no job removal), department requests and tickets go through their checked RPCs' as result;

-- Leave, assets, goals ----------------------------------------------------------------------------
set session authorization api_gateway_sim;
set role anon;
do $$ declare _waiting jsonb; _asset jsonb; _goal jsonb;
begin
  _waiting := audit_agent.ok('m-all', 'list_leave_requests');
  assert _waiting->'leave_requests' @> jsonb_build_array(jsonb_build_object('id', audit_developer.id(9,1), 'can_decide', true)), 'leave waiting for the manager';
  assert jsonb_array_length(audit_agent.ok('outsider', 'list_leave_requests', '{"view":"all_open"}')->'leave_requests') = 0, 'outsider sees no leave';
  perform audit_agent.fails('m-all', 'decide_leave', jsonb_build_object('leave_id', audit_developer.id(9,1), 'decision', 'Approved'), 'invalid');
  perform audit_agent.fails('m-all', 'decide_leave', jsonb_build_object('leave_id', audit_developer.id(9,1), 'decision', 'Pending', 'remarks', 'x'), 'invalid');
  perform audit_agent.ok('m-all', 'decide_leave', jsonb_build_object('leave_id', audit_developer.id(9,1), 'decision', 'approved', 'remarks', 'Enjoy the function'));

  -- A department head can read assets but not manage them; the entity admin can.
  perform audit_agent.fails('m-all', 'add_asset', jsonb_build_object('name', 'Laptop', 'owner_entity_id', audit_developer.id(1,1)), 'forbidden');
  _asset := audit_agent.ok('ea-all', 'add_asset', jsonb_build_object('name', 'Billing laptop', 'category', 'hardware', 'code', 'AG-LT-1',
    'serial', 'SN-1', 'owner_entity_id', audit_developer.id(1,1), 'owner_branch_id', audit_developer.id(3,1)));
  insert into agent_ids values ('asset', (_asset->>'asset_id')::uuid);
  perform audit_agent.ok('ea-all', 'assign_asset', jsonb_build_object('asset_id', _asset->>'asset_id', 'employee_id', audit_developer.id(7,13), 'condition', 'Good'));
  assert (audit_agent.ok('ea-all', 'list_assets', jsonb_build_object('holder_id', audit_developer.id(7,13)))->'assets')
    @> jsonb_build_array(jsonb_build_object('id', _asset->>'asset_id', 'status', 'Allocated')), 'custody trigger allocates';
  perform audit_agent.fails('ea-all', 'update_asset', jsonb_build_object('asset_id', _asset->>'asset_id', 'status', 'Allocated'), 'invalid');
  perform audit_agent.fails('ea-all', 'update_asset', jsonb_build_object('asset_id', _asset->>'asset_id', 'licence_key', 'x'), 'invalid');
  perform audit_agent.ok('ea-all', 'return_asset', jsonb_build_object('asset_id', _asset->>'asset_id', 'condition', 'Scratched'));
  perform audit_agent.fails('ea-all', 'return_asset', jsonb_build_object('asset_id', _asset->>'asset_id'), 'not_found');
  perform audit_agent.ok('ea-all', 'update_asset', jsonb_build_object('asset_id', _asset->>'asset_id', 'location', 'Back office', 'status', 'Under Repair'));
  assert not (audit_agent.ok('ea-all', 'list_assets')::text ~ 'licence'), 'licence keys never returned';

  _goal := audit_agent.ok('m-all', 'create_goal', jsonb_build_object('employee_id', audit_developer.id(7,13), 'title', 'Close 20 sales', 'weight', 40));
  insert into agent_ids values ('goal', (_goal->>'goal_id')::uuid);
  perform audit_agent.ok('m-all', 'update_goal', jsonb_build_object('goal_id', _goal->>'goal_id', 'progress', 50));
  perform audit_agent.fails('m-all', 'update_goal', jsonb_build_object('goal_id', _goal->>'goal_id', 'progress', 150), 'invalid');
  perform audit_agent.fails('outsider', 'update_goal', jsonb_build_object('goal_id', _goal->>'goal_id', 'progress', 90), 'not_found');
  perform audit_agent.ok('m-all', 'update_goal', jsonb_build_object('goal_id', _goal->>'goal_id', 'status', 'dropped'));
  assert (audit_agent.ok('m-all', 'list_goals', jsonb_build_object('employee_id', audit_developer.id(7,13)))->'goals')
    @> jsonb_build_array(jsonb_build_object('id', _goal->>'goal_id', 'status', 'Dropped', 'progress', 50)), 'goal retired by status';
end $$;
reset role;
reset session authorization;
do $$ begin
  assert exists(select 1 from public.leave_decisions where leave_id = audit_developer.id(9,1)
    and actor_user_id = audit_developer.id(6,11)), 'leave decision recorded under the manager';
  assert exists(select 1 from public.asset_assignments where asset_id = (select id from agent_ids where label = 'asset')
    and assigned_by = audit_developer.id(6,12) and returned_by = audit_developer.id(6,12) and condition_in = 'Scratched'), 'custody names the entity admin';
  assert exists(select 1 from public.assets where id = (select id from agent_ids where label = 'asset')
    and status = 'Under Repair' and employee_id is null and location = 'Back office'), 'asset free and updated';
  assert exists(select 1 from public.goals where id = (select id from agent_ids where label = 'goal')
    and created_by = audit_developer.id(7,11) and progress = 50 and status = 'Dropped'), 'goal authored by the manager';
end $$;
select 'PASS: leave decisions, asset custody and goals follow the owner''s role and record their name' as result;

-- Rate budget: refused actions still count and are audited ---------------------------------------
set session authorization api_gateway_sim;
set role anon;
do $$ begin
  for i in 1..30 loop perform audit_agent.fails('agent-rate', 'list_tasks', '{"bogus":true}', 'invalid'); end loop;
  for i in 1..30 loop perform audit_agent.ok('agent-rate', 'whoami'); end loop;
end $$;
select audit_developer.expect_error($q$select audit_agent.call('agent-rate','whoami')$q$, 'PT429');
reset role;
reset session authorization;
do $$ begin
  assert (select count(*) from public.audit_log where row_id = audit_developer.key_id('agent-rate') and action = 'API_CALL_FAILED'
    and table_name = 'api:list_tasks' and actor = audit_developer.id(6,11)) = 30, 'refused calls audited';
  assert (select count(*) from public.audit_log where row_id = audit_developer.key_id('agent-rate') and action = 'API_CALL') = 30, 'successful calls audited';
  assert not exists(select from public.audit_log a cross join audit_developer.keys k
    where position(k.response->>'api_key' in to_jsonb(a)::text) > 0), 'no plaintext key in audit';
end $$;

-- No tool removed a row, anywhere, during all of the above.
do $$ begin
  assert not exists(select 1 from pg_stat_xact_user_tables s left join agent_delete_baseline b on b.relid = s.relid
    where s.n_tup_del > coalesce(b.n_tup_del, 0)), 'no row deleted by any assistant action: ' ||
    (select string_agg(s.schemaname || '.' || s.relname, ', ') from pg_stat_xact_user_tables s
      left join agent_delete_baseline b on b.relid = s.relid where s.n_tup_del > coalesce(b.n_tup_del, 0));
  assert not exists(select 1 from public.tasks where deleted_at is not null), 'no task trashed';
end $$;
commit;
select 'PASS: failed calls are charged and audited; nothing was deleted by any assistant action' as result;

-- Losing access ------------------------------------------------------------------------------------
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000011';
set role authenticated;
select public.revoke_my_api_key(audit_developer.key_id('m-tasks'));
reset role;
set request.jwt.claim.sub = '';
update app.developer_api_keys set expires_at = clock_timestamp() - interval '1 second' where id = audit_developer.key_id('filler-1');
set session authorization api_gateway_sim;
set role anon;
select audit_developer.expect_error($q$select audit_agent.call('m-tasks','whoami')$q$, 'PT401');
select audit_developer.expect_error($q$select audit_agent.call('filler-1','whoami')$q$, 'PT401');
reset role;
reset session authorization;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set role authenticated;
select public.set_agent_api_enabled(false);
reset role;
set request.jwt.claim.sub = '';
set session authorization api_gateway_sim;
set role anon;
select audit_developer.expect_error($q$select audit_agent.call('m-all','whoami')$q$, 'PT503');
reset role;
reset session authorization;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set role authenticated;
select public.set_agent_api_enabled(true);
-- The super admin can switch off anybody's personal key.
select public.revoke_developer_api_key(audit_developer.key_id('filler-3'));
reset role;
set request.jwt.claim.sub = '';
delete from public.role_permissions where permission_id = (select id from public.permissions where key = 'api.connect')
  and role_id = (select id from public.roles where key = 'dept_head');
update auth.users set banned_until = clock_timestamp() + interval '1 day' where id = audit_developer.id(6,12);
update public.employees set status = 'Inactive' where id = audit_developer.id(7,15);
set session authorization api_gateway_sim;
set role anon;
select audit_developer.expect_error($q$select audit_agent.call('m-all','whoami')$q$, 'PT401');
select audit_developer.expect_error($q$select audit_agent.call('outsider','whoami')$q$, 'PT401');
select audit_developer.expect_error($q$select audit_agent.call('filler-3','whoami')$q$, 'PT401');
select audit_developer.expect_error($q$select audit_agent.call('ea-all','whoami')$q$, 'PT401');
select audit_developer.expect_error($q$select audit_agent.call('head3','whoami')$q$, 'PT401');
reset role;
reset session authorization;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000011';
set role authenticated;
do $$ begin
  assert (select count(*) from public.list_my_api_keys()) = 6, 'a person who lost the permission still sees their keys';
  perform public.revoke_my_api_key(audit_developer.key_id('m-all'));
end $$;
select audit_developer.expect_error($q$select public.create_my_api_key('again',array['tasks:manage'])$q$, 'PT403');
reset role;
set request.jwt.claim.sub = '';
select 'PASS: revoke, expiry, the switch, super admin revoke, permission removal, ban and inactive employee all stop a key' as result;
