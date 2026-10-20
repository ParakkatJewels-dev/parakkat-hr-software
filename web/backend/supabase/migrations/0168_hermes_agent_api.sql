-- Personal assistant keys: a manager connects an AI assistant (Hermes) that acts AS THEM.
--
-- Every call runs under the key owner's own identity, so the existing row policies, triggers and
-- checked RPCs decide what is allowed exactly as they do in the app. Nothing here re-implements a
-- permission rule. The public entry point validates the key in SQL (it is reachable directly through
-- anonymous PostgREST), switches to the owner's identity only for the duration of one whitelisted
-- tool, and switches back. No tool deletes, trashes or removes anything.
-- Idempotent: safe to re-run.
begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Permission and switch
-- ---------------------------------------------------------------------------------------------
insert into public.permissions (key, resource, action, description) values
  ('api.connect', 'api', 'connect', 'Connect an AI assistant such as Hermes with a personal key that acts as you')
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'api.connect'
where r.key = 'super_admin'
on conflict do nothing;

-- Separate from the read API switch: turning on assistant access must not open the org-wide
-- read endpoints, and the reverse.
alter table app.developer_settings add column if not exists agent_enabled boolean not null default false;

-- ---------------------------------------------------------------------------------------------
-- 2. Keys: read keys (super admin, org-wide read endpoints) and manage keys (personal, act as owner)
-- ---------------------------------------------------------------------------------------------
alter table app.developer_api_keys add column if not exists kind text not null default 'read';
do $$ declare _constraint record; begin
  for _constraint in select conname from pg_constraint
    where conrelid = 'app.developer_api_keys'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%scopes%'
  loop
    execute format('alter table app.developer_api_keys drop constraint %I', _constraint.conname);
  end loop;
end $$;
-- The two kinds never share a scope, so developer_api_read's scope check already refuses manage
-- keys, and a manage key can never carry a company restriction that RLS would silently ignore.
alter table app.developer_api_keys add constraint developer_api_keys_scopes_by_kind check (
  (kind = 'read' and cardinality(scopes) between 1 and 3
    and scopes <@ array['employees:read','organization:read','attendance:read']::text[])
  or (kind = 'manage' and entity_id is null and cardinality(scopes) between 1 and 4
    and scopes <@ array['tasks:manage','leave:manage','assets:manage','goals:manage']::text[])
);
create index if not exists developer_api_keys_owner_idx on app.developer_api_keys(created_by, created_at desc);

-- has_perm reads auth.uid(), which is still empty while a key is being checked. Same arms as
-- app.has_perm_any_scope, for an explicit user, including current account state.
create or replace function app.api_connect_allowed(_user uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select _user is not null and app.account_is_active(_user) and (
    coalesce((select p.is_super_admin from public.profiles p where p.user_id = _user), false)
    or exists (select 1 from public.role_assignments ra join public.roles r on r.id = ra.role_id
      where ra.user_id = _user and r.key = 'super_admin' and ra.scope_type = 'global')
    or exists (select 1 from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
      where ra.user_id = _user and p.key = 'api.connect'));
$$;
revoke all on function app.api_connect_allowed(uuid) from public, anon, authenticated, service_role;

create or replace function app.agent_key_metadata(_key app.developer_api_keys)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object('id', _key.id, 'name', _key.name, 'key_prefix', _key.key_prefix,
    'scopes', _key.scopes, 'created_at', _key.created_at, 'expires_at', _key.expires_at,
    'last_used_at', _key.last_used_at, 'revoked_at', _key.revoked_at);
$$;
revoke all on function app.agent_key_metadata(app.developer_api_keys) from public, anon, authenticated, service_role;

create or replace function public.get_developer_settings()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null or not app.developer_admin_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Only a super administrator can manage developer settings.';
  end if;
  return (select jsonb_build_object('enabled', enabled, 'agent_enabled', agent_enabled, 'updated_at', updated_at)
    from app.developer_settings where singleton);
end $$;

create or replace function public.set_developer_settings(_enabled boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _settings app.developer_settings%rowtype;
begin
  if auth.uid() is null or not app.developer_admin_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Only a super administrator can manage developer settings.';
  end if;
  if _enabled is null then raise exception using errcode = 'PT400', message = 'Choose whether the developer API is enabled.'; end if;
  select * into _settings from app.developer_settings where singleton for update;
  if _settings.enabled is distinct from _enabled then
    update app.developer_settings set enabled = _enabled, updated_at = clock_timestamp() where singleton returning * into _settings;
    insert into public.audit_log(actor, actor_email, action, table_name)
      select auth.uid(), email, case when _enabled then 'DEVELOPER_API_ENABLE' else 'DEVELOPER_API_DISABLE' end,
        'developer_settings' from auth.users where id = auth.uid();
  end if;
  return jsonb_build_object('enabled', _settings.enabled, 'agent_enabled', _settings.agent_enabled, 'updated_at', _settings.updated_at);
end $$;

create or replace function public.set_agent_api_enabled(_enabled boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _settings app.developer_settings%rowtype;
begin
  if auth.uid() is null or not app.developer_admin_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Only a super administrator can manage developer settings.';
  end if;
  if _enabled is null then raise exception using errcode = 'PT400', message = 'Choose whether assistant access is enabled.'; end if;
  select * into _settings from app.developer_settings where singleton for update;
  if _settings.agent_enabled is distinct from _enabled then
    update app.developer_settings set agent_enabled = _enabled, updated_at = clock_timestamp() where singleton returning * into _settings;
    insert into public.audit_log(actor, actor_email, action, table_name)
      select auth.uid(), email, case when _enabled then 'AGENT_API_ENABLE' else 'AGENT_API_DISABLE' end,
        'developer_settings' from auth.users where id = auth.uid();
  end if;
  return jsonb_build_object('enabled', _settings.enabled, 'agent_enabled', _settings.agent_enabled, 'updated_at', _settings.updated_at);
end $$;

-- Super admin overview: every key, with its kind and whose name it acts under.
drop function if exists public.list_developer_api_keys();
create function public.list_developer_api_keys()
returns table (id uuid, name text, key_prefix text, scopes text[], entity_id uuid, created_at timestamptz,
  expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz, kind text, owner_name text)
language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null or not app.developer_admin_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Only a super administrator can manage API keys.';
  end if;
  return query select k.id, k.name, k.key_prefix, k.scopes, k.entity_id, k.created_at,
    k.expires_at, k.last_used_at, k.revoked_at, k.kind,
    coalesce((select e.full_name from public.profiles p join public.employees e on e.id = p.employee_id
      where p.user_id = k.created_by), (select u.email from auth.users u where u.id = k.created_by))::text
    from app.developer_api_keys k order by k.created_at desc, k.id;
end $$;

-- What the Settings screen needs to decide whether to offer personal keys at all.
create or replace function public.get_my_agent_access()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null or not app.account_is_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Sign in with an active account.';
  end if;
  return jsonb_build_object(
    'enabled', coalesce((select agent_enabled from app.developer_settings where singleton), false),
    'allowed', app.api_connect_allowed(auth.uid()));
end $$;

create or replace function public.create_my_api_key(_name text, _scopes text[], _expires_in_days integer default 30)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _key app.developer_api_keys%rowtype; _secret text; _scoped text[]; _id uuid := gen_random_uuid();
begin
  if auth.uid() is null or not app.api_connect_allowed(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Your role does not allow connecting an AI assistant.';
  end if;
  if not coalesce((select agent_enabled from app.developer_settings where singleton), false) then
    raise exception using errcode = 'PT503', message = 'AI assistant access is turned off by the administrator.';
  end if;
  if length(btrim(coalesce(_name, ''))) not between 1 and 80 then
    raise exception using errcode = 'PT400', message = 'Key name must contain 1 to 80 characters.';
  end if;
  if _expires_in_days is null or _expires_in_days not between 1 and 90 then
    raise exception using errcode = 'PT400', message = 'Key expiry must be between 1 and 90 days.';
  end if;
  if _scopes is null or cardinality(_scopes) = 0 or exists (
    select 1 from unnest(_scopes) s where s is null or s not in ('tasks:manage','leave:manage','assets:manage','goals:manage')
  ) then raise exception using errcode = 'PT400', message = 'Choose one or more areas: tasks, leave, assets or goals.'; end if;
  select array_agg(distinct s order by s) into _scoped from unnest(_scopes) s;
  -- One person's concurrent requests queue here so the active-key cap cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('agent-key:' || auth.uid()::text, 0));
  if (select count(*) from app.developer_api_keys k where k.created_by = auth.uid() and k.kind = 'manage'
      and k.revoked_at is null and k.expires_at > clock_timestamp()) >= 5 then
    raise exception using errcode = 'PT400', message = 'You already have 5 active keys. Revoke one before creating another.';
  end if;
  _secret := 'phr_' || replace(_id::text, '-', '') || '_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into app.developer_api_keys(id, name, key_prefix, secret_hash, scopes, entity_id, created_by, expires_at, kind)
    values (_id, btrim(_name), 'phr_' || left(replace(_id::text, '-', ''), 8),
      encode(extensions.digest(_secret, 'sha256'), 'hex'), _scoped, null, auth.uid(),
      clock_timestamp() + make_interval(days => _expires_in_days), 'manage') returning * into _key;
  insert into public.audit_log(actor, actor_email, action, table_name, row_id)
    select auth.uid(), email, 'API_KEY_CREATE', 'developer_api_keys', _key.id from auth.users where id = auth.uid();
  return jsonb_build_object('api_key', _secret, 'key', app.agent_key_metadata(_key));
end $$;

-- Listing and revoking need only an active account, so somebody whose permission was removed can
-- still see and switch off keys they made earlier (which have already stopped working).
create or replace function public.list_my_api_keys()
returns table (id uuid, name text, key_prefix text, scopes text[], created_at timestamptz,
  expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null or not app.account_is_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Sign in with an active account.';
  end if;
  return query select k.id, k.name, k.key_prefix, k.scopes, k.created_at, k.expires_at, k.last_used_at, k.revoked_at
    from app.developer_api_keys k where k.created_by = auth.uid() and k.kind = 'manage'
    order by k.created_at desc, k.id;
end $$;

create or replace function public.revoke_my_api_key(_key_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _key app.developer_api_keys%rowtype;
begin
  if auth.uid() is null or not app.account_is_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Sign in with an active account.';
  end if;
  select * into _key from app.developer_api_keys
    where id = _key_id and created_by = auth.uid() and kind = 'manage' for update;
  if not found then raise exception using errcode = 'PT400', message = 'API key not found.'; end if;
  if _key.revoked_at is not null then return; end if;
  update app.developer_api_keys set revoked_at = clock_timestamp() where id = _key.id;
  insert into public.audit_log(actor, actor_email, action, table_name, row_id)
    select auth.uid(), email, 'API_KEY_REVOKE', 'developer_api_keys', _key.id from auth.users where id = auth.uid();
end $$;

revoke all on function public.set_agent_api_enabled(boolean), public.list_developer_api_keys(),
  public.get_my_agent_access(), public.create_my_api_key(text,text[],integer),
  public.list_my_api_keys(), public.revoke_my_api_key(uuid) from public, anon, service_role;
grant execute on function public.set_agent_api_enabled(boolean), public.list_developer_api_keys(),
  public.get_my_agent_access(), public.create_my_api_key(text,text[],integer),
  public.list_my_api_keys(), public.revoke_my_api_key(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Which area each tool belongs to. The dispatcher below handles exactly these names.
-- ---------------------------------------------------------------------------------------------
create or replace function app.agent_tool_scope(_tool text)
returns text language sql immutable set search_path = pg_catalog as $$
  select case
    when _tool in ('whoami','find_employees','list_departments') then 'any'
    when _tool in ('list_tasks','get_task','create_task','update_task','add_task_helpers','comment_on_task',
      'add_subtask','tick_subtask','list_routines','create_routine','update_routine','stop_routine',
      'list_help_requests','request_help','answer_help_request','cancel_help_request',
      'list_ticket_categories','list_tickets','create_ticket','set_ticket_status') then 'tasks:manage'
    when _tool in ('list_leave_requests','decide_leave') then 'leave:manage'
    when _tool in ('list_assets','add_asset','update_asset','assign_asset','return_asset') then 'assets:manage'
    when _tool in ('list_goals','create_goal','update_goal') then 'goals:manage'
  end;
$$;
revoke all on function app.agent_tool_scope(text) from public, anon, authenticated, service_role;

-- The anonymous gateway may enter only this schema, never `app` (closed to anon since 0033). It is
-- not exposed through PostgREST; the public entry point below is the only caller.
create schema if not exists agent_gateway;
revoke all on schema agent_gateway from public, authenticated, service_role;
grant usage on schema agent_gateway to anon;

-- Validates the key and charges its rate budget. Returns the user the call will act as.
create or replace function agent_gateway.authorize(_api_key text, _tool text)
returns table(actor uuid, key_id uuid, scopes text[])
language plpgsql security definer set search_path = pg_catalog as $$
declare _key app.developer_api_keys%rowtype; _enabled boolean; _now timestamptz; _scope text;
begin
  if coalesce(_api_key, '') !~ '^phr_[0-9a-f]{32}_[0-9a-f]{64}$' then
    raise exception using errcode = 'PT401', message = 'Invalid or inactive API key.';
  end if;
  select agent_enabled into _enabled from app.developer_settings where singleton for share;
  if not coalesce(_enabled, false) then
    raise exception using errcode = 'PT503', message = 'AI assistant access is turned off.';
  end if;
  select * into _key from app.developer_api_keys
    where secret_hash = encode(extensions.digest(_api_key, 'sha256'), 'hex') for update;
  _now := clock_timestamp();
  if not found or _key.kind <> 'manage' or _key.revoked_at is not null or _key.expires_at <= _now
     or not app.api_connect_allowed(_key.created_by) then
    raise exception using errcode = 'PT401', message = 'Invalid or inactive API key.';
  end if;
  _scope := app.agent_tool_scope(_tool);
  if _scope is null then
    raise exception using errcode = 'PT400', message = 'Unknown tool.';
  end if;
  if _scope <> 'any' and not (_scope = any(_key.scopes)) then
    raise exception using errcode = 'PT403', message = 'This key does not include that area.';
  end if;
  if _key.rate_window_at is null or _key.rate_window_at <= _now - interval '1 minute' then
    _key.rate_window_at := _now;
    _key.rate_count := 0;
  end if;
  if _key.rate_count >= 60 then
    raise exception using errcode = 'PT429', message = 'API rate limit reached. Try again in one minute.';
  end if;
  update app.developer_api_keys set last_used_at = _now,
    rate_window_at = _key.rate_window_at, rate_count = _key.rate_count + 1 where id = _key.id;
  return query select _key.created_by, _key.id, _key.scopes;
end $$;

create or replace function agent_gateway.audit(_api_key text, _tool text, _ok boolean)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _key app.developer_api_keys%rowtype;
begin
  select * into _key from app.developer_api_keys
    where secret_hash = encode(extensions.digest(coalesce(_api_key, ''), 'sha256'), 'hex') and kind = 'manage';
  if not found then return; end if;
  insert into public.audit_log(actor, actor_email, action, table_name, row_id)
    select _key.created_by, u.email, case when _ok then 'API_CALL' else 'API_CALL_FAILED' end,
      'api:' || left(coalesce(_tool, ''), 60), _key.id
    from auth.users u where u.id = _key.created_by;
end $$;
revoke all on function agent_gateway.authorize(text,text), agent_gateway.audit(text,text,boolean)
  from public, authenticated, service_role;
grant execute on function agent_gateway.authorize(text,text), agent_gateway.audit(text,text,boolean) to anon;

-- Database detail never reaches the assistant: known application messages pass through, the
-- rest become a plain sentence.
create or replace function agent_gateway.error(_state text, _message text)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select case
    when _state = 'P0002' then jsonb_build_object('code', 'not_found', 'message', _message)
    when _state = '42501' then jsonb_build_object('code', 'forbidden', 'message',
      case when _message like 'new row violates row-level security policy%' or _message like 'permission denied%'
        then 'Your role does not allow this action.' else _message end)
    when _state = '23505' then jsonb_build_object('code', 'invalid', 'message', 'That already exists.')
    when _state = '23503' then jsonb_build_object('code', 'invalid', 'message', 'A referenced record does not exist.')
    when _state like '23%' then jsonb_build_object('code', 'invalid', 'message', 'One of the values is not allowed.')
    when _state like '22%' or _state in ('P0001','PT400') then jsonb_build_object('code', 'invalid', 'message', _message)
    when _state = '55000' then jsonb_build_object('code', 'conflict', 'message', _message)
    when _state = '40001' or _state = '40P01' then jsonb_build_object('code', 'conflict', 'message', 'The record was busy. Try again.')
    else jsonb_build_object('code', 'failed', 'message', 'The action could not be completed.')
  end;
$$;
revoke all on function agent_gateway.error(text,text) from public, authenticated, service_role;
grant execute on function agent_gateway.error(text,text) to anon;

-- ---------------------------------------------------------------------------------------------
-- 4. Tools. Invoker functions, executable only by `authenticated`: they run solely after the
--    identity switch and can never do more than the key owner could do in the app.
-- ---------------------------------------------------------------------------------------------
create schema if not exists hr_agent;
revoke all on schema hr_agent from public, anon, service_role;
grant usage on schema hr_agent to authenticated;

-- Argument helpers -----------------------------------------------------------------------------
create or replace function hr_agent.only_keys(_args jsonb, _allowed text[])
returns void language plpgsql immutable set search_path = pg_catalog as $$
declare _extra text;
begin
  select string_agg(k, ', ' order by k) into _extra from jsonb_object_keys(_args) k where not (k = any(_allowed));
  if _extra is not null then
    raise exception using errcode = '22023', message = format('Unknown argument(s): %s.', _extra);
  end if;
end $$;

create or replace function hr_agent.arg_text(_args jsonb, _name text, _max integer default 2000, _required boolean default false)
returns text language plpgsql immutable set search_path = pg_catalog as $$
declare _value text;
begin
  if _args ? _name and jsonb_typeof(_args->_name) not in ('string','null') then
    raise exception using errcode = '22023', message = format('"%s" must be text.', _name);
  end if;
  _value := nullif(btrim(_args->>_name), '');
  if _value is null and _required then
    raise exception using errcode = '22023', message = format('"%s" is required.', _name);
  end if;
  if length(_value) > _max then
    raise exception using errcode = '22023', message = format('"%s" can be at most %s characters.', _name, _max);
  end if;
  return _value;
end $$;

create or replace function hr_agent.to_uuid(_value text, _name text)
returns uuid language plpgsql immutable set search_path = pg_catalog as $$
begin
  if _value is null then return null; end if;
  if _value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = format('"%s" must be an id like 1b4e28ba-2fa1-11d2-883f-0016d3cca427.', _name);
  end if;
  return _value::uuid;
end $$;

create or replace function hr_agent.arg_uuid(_args jsonb, _name text, _required boolean default false)
returns uuid language sql immutable set search_path = pg_catalog as $$
  select hr_agent.to_uuid(hr_agent.arg_text(_args, _name, 64, _required), _name);
$$;

create or replace function hr_agent.arg_uuids(_args jsonb, _name text, _max integer default 20)
returns uuid[] language plpgsql immutable set search_path = pg_catalog as $$
declare _result uuid[];
begin
  if not (_args ? _name) or jsonb_typeof(_args->_name) = 'null' then return '{}'; end if;
  if jsonb_typeof(_args->_name) <> 'array' or jsonb_array_length(_args->_name) > _max
     or exists(select 1 from jsonb_array_elements(_args->_name) v where jsonb_typeof(v) <> 'string') then
    raise exception using errcode = '22023', message = format('"%s" must be a list of at most %s ids.', _name, _max);
  end if;
  select coalesce(array_agg(distinct hr_agent.to_uuid(btrim(v), _name)), '{}') into _result
    from jsonb_array_elements_text(_args->_name) v;
  return _result;
end $$;

create or replace function hr_agent.arg_texts(_args jsonb, _name text, _max_items integer, _max_length integer)
returns text[] language plpgsql immutable set search_path = pg_catalog as $$
declare _result text[];
begin
  if not (_args ? _name) or jsonb_typeof(_args->_name) = 'null' then return '{}'; end if;
  if jsonb_typeof(_args->_name) <> 'array' or jsonb_array_length(_args->_name) > _max_items
     or exists(select 1 from jsonb_array_elements(_args->_name) v where jsonb_typeof(v) <> 'string') then
    raise exception using errcode = '22023', message = format('"%s" must be a list of at most %s texts.', _name, _max_items);
  end if;
  select coalesce(array_agg(btrim(v) order by n), '{}') into _result
    from jsonb_array_elements_text(_args->_name) with ordinality t(v, n) where btrim(v) <> '';
  if exists(select 1 from unnest(_result) v where length(v) > _max_length) then
    raise exception using errcode = '22023', message = format('Each "%s" entry can be at most %s characters.', _name, _max_length);
  end if;
  return _result;
end $$;

create or replace function hr_agent.arg_date(_args jsonb, _name text, _required boolean default false)
returns date language plpgsql immutable set search_path = pg_catalog as $$
declare _text text := hr_agent.arg_text(_args, _name, 10, _required);
begin
  if _text is null then return null; end if;
  if _text !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = '22023', message = format('"%s" must be a date like 2026-10-31.', _name);
  end if;
  return _text::date;
exception when datetime_field_overflow or invalid_datetime_format then
  raise exception using errcode = '22023', message = format('"%s" is not a real calendar date.', _name);
end $$;

create or replace function hr_agent.arg_int(_args jsonb, _name text, _min integer, _max integer, _required boolean default false)
returns integer language plpgsql immutable set search_path = pg_catalog as $$
declare _number numeric;
begin
  if not (_args ? _name) or jsonb_typeof(_args->_name) = 'null' then
    if _required then raise exception using errcode = '22023', message = format('"%s" is required.', _name); end if;
    return null;
  end if;
  if jsonb_typeof(_args->_name) <> 'number' then
    raise exception using errcode = '22023', message = format('"%s" must be a whole number.', _name);
  end if;
  _number := (_args->>_name)::numeric;
  if _number <> trunc(_number) or _number < _min or _number > _max then
    raise exception using errcode = '22023', message = format('"%s" must be a whole number from %s to %s.', _name, _min, _max);
  end if;
  return _number::integer;
end $$;

create or replace function hr_agent.arg_bool(_args jsonb, _name text, _default boolean default null)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
begin
  if not (_args ? _name) or jsonb_typeof(_args->_name) = 'null' then return _default; end if;
  if jsonb_typeof(_args->_name) <> 'boolean' then
    raise exception using errcode = '22023', message = format('"%s" must be true or false.', _name);
  end if;
  return (_args->>_name)::boolean;
end $$;

-- Accepts "done", "in_progress", "To Do"… and returns the app's own spelling.
create or replace function hr_agent.pick(_value text, _options text[], _name text)
returns text language plpgsql immutable set search_path = pg_catalog as $$
declare _match text;
begin
  if _value is null then return null; end if;
  select o into _match from unnest(_options) o
    where regexp_replace(lower(o), '[^a-z]', '', 'g') = regexp_replace(lower(_value), '[^a-z]', '', 'g');
  if _match is null then
    raise exception using errcode = '22023', message = format('"%s" must be one of: %s.', _name, array_to_string(_options, ', '));
  end if;
  return _match;
end $$;

create or replace function hr_agent.like_pattern(_value text)
returns text language sql immutable set search_path = pg_catalog as $$
  select '%' || replace(replace(replace(_value, '\', '\\'), '%', '\%'), '_', '\_') || '%';
$$;

create or replace function hr_agent.page(_args jsonb)
returns integer[] language sql immutable set search_path = pg_catalog as $$
  select array[coalesce(hr_agent.arg_int(_args, 'limit', 1, 50), 20), coalesce(hr_agent.arg_int(_args, 'offset', 0, 10000), 0)];
$$;

-- Fetches limit+1 rows; trims to limit and reports whether more exist.
create or replace function hr_agent.paged(_key text, _rows jsonb, _page integer[])
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object(_key, case when jsonb_array_length(coalesce(_rows, '[]')) > _page[1]
      then coalesce(_rows, '[]') - _page[1] else coalesce(_rows, '[]') end,
    'limit', _page[1], 'offset', _page[2], 'has_more', jsonb_array_length(coalesce(_rows, '[]')) > _page[1]);
$$;

create or replace function hr_agent.person(_employee uuid)
returns jsonb language sql stable set search_path = pg_catalog, public as $$
  select case when _employee is null then null else coalesce(
    (select jsonb_build_object('id', e.id, 'name', e.full_name, 'code', e.employee_code) from public.employees e where e.id = _employee),
    jsonb_build_object('id', _employee)) end;
$$;

-- Basics --------------------------------------------------------------------------------------
create or replace function hr_agent.whoami(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _me uuid := app.current_employee_id();
begin
  perform hr_agent.only_keys(_args, '{}');
  return jsonb_build_object('user_id', auth.uid(), 'employee', (
    select jsonb_build_object('id', e.id, 'name', e.full_name, 'code', e.employee_code,
      'department', d.name, 'designation', g.title)
    from public.employees e left join public.departments d on d.id = e.department_id
      left join public.designations g on g.id = e.designation_id where e.id = _me));
end $$;

create or replace function hr_agent.find_employees(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _query text; _department uuid; _inactive boolean; _page integer[]; _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['query','department_id','include_inactive','limit','offset']);
  _query := hr_agent.arg_text(_args, 'query', 100);
  _department := hr_agent.arg_uuid(_args, 'department_id');
  _inactive := hr_agent.arg_bool(_args, 'include_inactive', false);
  _page := hr_agent.page(_args);
  select jsonb_agg(r.item order by r.name, r.id) into _rows from (
    select jsonb_build_object('id', e.id, 'name', e.full_name, 'code', e.employee_code, 'status', e.status,
      'department', d.name, 'designation', g.title) as item, e.full_name as name, e.id
    from public.employees e left join public.departments d on d.id = e.department_id
      left join public.designations g on g.id = e.designation_id
    where (_inactive or e.status = 'Active')
      and (_department is null or e.department_id = _department)
      and (_query is null or e.full_name ilike hr_agent.like_pattern(_query) or e.employee_code ilike hr_agent.like_pattern(_query))
    order by e.full_name, e.id limit _page[1] + 1 offset _page[2]) r;
  return hr_agent.paged('employees', _rows, _page);
end $$;

create or replace function hr_agent.list_departments(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _query text; _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['query']);
  _query := hr_agent.arg_text(_args, 'query', 100);
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'code', d.code, 'branch', b.name)
      order by d.name, d.id), '[]') into _rows
    from public.departments d left join public.branches b on b.id = d.branch_id
    where coalesce(d.is_active, true) and (_query is null or d.name ilike hr_agent.like_pattern(_query));
  return jsonb_build_object('departments', _rows);
end $$;

-- Tasks ---------------------------------------------------------------------------------------
create or replace function hr_agent.task_statuses() returns text[] language sql immutable as $$
  select array['To Do','In Progress','Blocked','Done','Cancelled'];
$$;
create or replace function hr_agent.task_priorities() returns text[] language sql immutable as $$
  select array['Low','Medium','High','Urgent'];
$$;

create or replace function hr_agent.task_summary(_task public.tasks)
returns jsonb language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object('id', _task.id, 'title', _task.title, 'status', _task.status, 'priority', _task.priority,
    'due_date', _task.due_date, 'created_at', _task.created_at, 'completed_at', _task.completed_at,
    'assignee', hr_agent.person(_task.employee_id), 'assigned_by', hr_agent.person(_task.assigned_by),
    'parent_task_id', _task.parent_task_id,
    'subtasks', (select jsonb_build_object('total', count(*), 'done', count(*) filter (where c.completed_at is not null))
      from public.task_checklist_items c where c.task_id = _task.id));
$$;

create or replace function hr_agent.list_tasks(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _assignee uuid; _status text; _view text; _due_before date; _closed boolean; _query text;
  _page integer[]; _me uuid := app.current_employee_id(); _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['assignee_id','status','view','due_before','include_closed','query','limit','offset']);
  _assignee := hr_agent.arg_uuid(_args, 'assignee_id');
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 40), hr_agent.task_statuses(), 'status');
  _view := coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'view', 40), array['all','assigned_to_me','created_by_me'], 'view'), 'all');
  _due_before := hr_agent.arg_date(_args, 'due_before');
  _closed := hr_agent.arg_bool(_args, 'include_closed', false);
  _query := hr_agent.arg_text(_args, 'query', 100);
  _page := hr_agent.page(_args);
  select jsonb_agg(hr_agent.task_summary(r.t) order by (r.t).due_date nulls last, (r.t).created_at desc, (r.t).id) into _rows from (
    select t from public.tasks t
    where t.deleted_at is null
      and (_status is not null or _closed or t.status not in ('Done','Cancelled'))
      and (_status is null or t.status = _status)
      and (_assignee is null or t.employee_id = _assignee
        or exists(select 1 from public.task_assignees a where a.task_id = t.id and a.employee_id = _assignee))
      and (_view = 'all'
        or (_view = 'assigned_to_me' and (t.employee_id = _me
          or exists(select 1 from public.task_assignees a where a.task_id = t.id and a.employee_id = _me)))
        or (_view = 'created_by_me' and t.assigned_by = _me))
      and (_due_before is null or t.due_date <= _due_before)
      and (_query is null or t.title ilike hr_agent.like_pattern(_query))
    order by t.due_date nulls last, t.created_at desc, t.id limit _page[1] + 1 offset _page[2]) r;
  return hr_agent.paged('tasks', _rows, _page);
end $$;

create or replace function hr_agent.get_task(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _task public.tasks;
begin
  perform hr_agent.only_keys(_args, array['task_id']);
  select * into _task from public.tasks where id = hr_agent.arg_uuid(_args, 'task_id', true) and deleted_at is null;
  if _task.id is null then
    raise exception using errcode = 'P0002', message = 'Task not found, or you cannot see it.';
  end if;
  return hr_agent.task_summary(_task) || jsonb_build_object(
    'description', _task.description,
    'people', coalesce((select jsonb_agg(hr_agent.person(a.employee_id) order by a.added_at, a.employee_id)
      from public.task_assignees a where a.task_id = _task.id), '[]'),
    'subtask_list', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title,
        'done', c.completed_at is not null, 'done_by', hr_agent.person(c.completed_by), 'owner', hr_agent.person(c.assigned_to))
      order by c.position, c.created_at, c.id) from public.task_checklist_items c where c.task_id = _task.id), '[]'),
    'comments', coalesce((select jsonb_agg(x.item order by x.created_at, x.id) from (
      select jsonb_build_object('id', m.id, 'reply_to', m.parent_id, 'author', m.author_name, 'body', m.body,
        'created_at', m.created_at) as item, m.created_at, m.id
      from public.task_comments m where m.task_id = _task.id order by m.created_at desc, m.id desc limit 30) x), '[]'),
    'help_request_id', (select h.id from public.help_requests h where h.task_id = _task.id limit 1));
end $$;

create or replace function hr_agent.create_task(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid := gen_random_uuid(); _me uuid := app.current_employee_id(); _assignee uuid; _people uuid[];
  _steps text[]; _priority text;
begin
  perform hr_agent.only_keys(_args, array['title','description','assignee_id','helper_ids','priority','due_date','subtasks']);
  _assignee := hr_agent.arg_uuid(_args, 'assignee_id', true);
  _priority := coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'priority', 20), hr_agent.task_priorities(), 'priority'), 'Medium');
  _steps := hr_agent.arg_texts(_args, 'subtasks', 50, 200);
  select array_agg(p order by p = _assignee desc) into _people
    from (select distinct unnest(array_prepend(_assignee, hr_agent.arg_uuids(_args, 'helper_ids', 20))) p) x;
  insert into public.tasks(id, employee_id, assigned_by, title, description, priority, due_date, status)
    values (_id, _assignee, _me, hr_agent.arg_text(_args, 'title', 200, true), hr_agent.arg_text(_args, 'description', 4000),
      _priority, hr_agent.arg_date(_args, 'due_date'), 'To Do');
  insert into public.task_assignees(task_id, employee_id, added_by)
    select _id, p, _me from unnest(_people) p;
  insert into public.task_checklist_items(task_id, title, position, created_by)
    select _id, s, (n - 1)::integer, _me from unnest(_steps) with ordinality t(s, n);
  return jsonb_build_object('task_id', _id);
end $$;

create or replace function hr_agent.update_task(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid; _status text; _priority text; _due date; _clear boolean; _title text; _description text;
begin
  perform hr_agent.only_keys(_args, array['task_id','status','priority','due_date','clear_due_date','title','description']);
  _id := hr_agent.arg_uuid(_args, 'task_id', true);
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 40), hr_agent.task_statuses(), 'status');
  _priority := hr_agent.pick(hr_agent.arg_text(_args, 'priority', 20), hr_agent.task_priorities(), 'priority');
  _due := hr_agent.arg_date(_args, 'due_date');
  _clear := hr_agent.arg_bool(_args, 'clear_due_date', false);
  _title := hr_agent.arg_text(_args, 'title', 200);
  _description := hr_agent.arg_text(_args, 'description', 4000);
  if _status is null and _priority is null and _due is null and not _clear and _title is null and not (_args ? 'description') then
    raise exception using errcode = '22023', message = 'Give at least one change: status, priority, due_date, clear_due_date, title or description.';
  end if;
  if _due is not null and _clear then
    raise exception using errcode = '22023', message = 'Use either due_date or clear_due_date, not both.';
  end if;
  update public.tasks t set
      status = coalesce(_status, t.status),
      completed_at = case when _status is null then t.completed_at
        when _status = 'Done' then coalesce(t.completed_at, clock_timestamp()) else null end,
      priority = coalesce(_priority, t.priority),
      due_date = case when _clear then null else coalesce(_due, t.due_date) end,
      title = coalesce(_title, t.title),
      description = case when _args ? 'description' then _description else t.description end
    where t.id = _id and t.deleted_at is null;
  if not found then
    -- The requesting side of a department request edits through its own checked RPC.
    if _status is null and exists(select 1 from public.help_requests h where h.task_id = _id) then
      perform public.update_requested_task(_id, _title, _description, _priority, _due, _clear);
    else
      raise exception using errcode = 'P0002', message = 'Task not found, or you cannot change it.';
    end if;
  end if;
  return jsonb_build_object('task_id', _id, 'updated', true);
end $$;

create or replace function hr_agent.add_task_helpers(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid; _people uuid[]; _added integer;
begin
  perform hr_agent.only_keys(_args, array['task_id','employee_ids']);
  _id := hr_agent.arg_uuid(_args, 'task_id', true);
  _people := hr_agent.arg_uuids(_args, 'employee_ids', 20);
  if cardinality(_people) = 0 then raise exception using errcode = '22023', message = '"employee_ids" needs at least one id.'; end if;
  if not exists(select 1 from public.tasks where id = _id and deleted_at is null) then
    raise exception using errcode = 'P0002', message = 'Task not found, or you cannot see it.';
  end if;
  insert into public.task_assignees(task_id, employee_id, added_by)
    select _id, p, app.current_employee_id() from unnest(_people) p
    where not exists(select 1 from public.task_assignees a where a.task_id = _id and a.employee_id = p);
  get diagnostics _added = row_count;
  return jsonb_build_object('task_id', _id, 'added', _added);
end $$;

create or replace function hr_agent.comment_on_task(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid := gen_random_uuid(); _task uuid;
begin
  perform hr_agent.only_keys(_args, array['task_id','body','reply_to']);
  _task := hr_agent.arg_uuid(_args, 'task_id', true);
  insert into public.task_comments(id, task_id, body, author_id, author_user, parent_id)
    values (_id, _task, hr_agent.arg_text(_args, 'body', 4000, true), app.current_employee_id(), auth.uid(),
      hr_agent.arg_uuid(_args, 'reply_to'));
  return jsonb_build_object('comment_id', _id, 'task_id', _task);
end $$;

create or replace function hr_agent.add_subtask(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid := gen_random_uuid(); _task uuid;
begin
  perform hr_agent.only_keys(_args, array['task_id','title','owner_id']);
  _task := hr_agent.arg_uuid(_args, 'task_id', true);
  insert into public.task_checklist_items(id, task_id, title, position, created_by, assigned_to)
    values (_id, _task, hr_agent.arg_text(_args, 'title', 200, true),
      coalesce((select max(c.position) + 1 from public.task_checklist_items c where c.task_id = _task), 0),
      app.current_employee_id(), hr_agent.arg_uuid(_args, 'owner_id'));
  return jsonb_build_object('subtask_id', _id, 'task_id', _task);
end $$;

create or replace function hr_agent.tick_subtask(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid; _done boolean;
begin
  perform hr_agent.only_keys(_args, array['subtask_id','done']);
  _id := hr_agent.arg_uuid(_args, 'subtask_id', true);
  _done := hr_agent.arg_bool(_args, 'done', true);
  update public.task_checklist_items set
      completed_by = case when _done then app.current_employee_id() end,
      completed_at = case when _done then clock_timestamp() end
    where id = _id;
  if not found then raise exception using errcode = 'P0002', message = 'Subtask not found, or you cannot change it.'; end if;
  return jsonb_build_object('subtask_id', _id, 'done', _done);
end $$;

-- Routines ------------------------------------------------------------------------------------
create or replace function hr_agent.routine_jobs(_args jsonb, _keep_ids boolean)
returns jsonb language plpgsql immutable set search_path = pg_catalog as $$
begin
  if jsonb_typeof(_args->'jobs') is distinct from 'array'
     or exists(select 1 from jsonb_array_elements(_args->'jobs') j where jsonb_typeof(j) <> 'object'
       or exists(select 1 from jsonb_object_keys(j) k where k not in ('id','title','detail'))) then
    raise exception using errcode = '22023', message = '"jobs" must be a list of {title, detail} items (plus id for existing jobs).';
  end if;
  return (select coalesce(jsonb_agg(case when _keep_ids then j else j - 'id' end order by n), '[]')
    from jsonb_array_elements(_args->'jobs') with ordinality t(j, n));
end $$;

create or replace function hr_agent.list_routines(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['employee_id','include_stopped']);
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'detail', r.detail,
      'employee', jsonb_build_object('id', r.employee_id, 'name', coalesce(r.employee->>'full_name', r.employee->>'name')),
      'frequency', r.frequency, 'start_date', r.start_date, 'end_date', r.end_date, 'weekdays', r.weekdays,
      'month_day', r.month_day, 'interval_days', r.interval_days, 'stopped_on', r.retired_on, 'can_manage', r.can_manage,
      'jobs', (select coalesce(jsonb_agg(jsonb_build_object('id', j->'id', 'title', j->'title', 'detail', j->'detail')
        order by (j->>'sort_order')::integer), '[]') from jsonb_array_elements(r.jobs) j where (j->>'is_active')::boolean))
    order by r.created_at desc, r.id), '[]') into _rows
  from (select * from public.list_routine_sets(hr_agent.arg_uuid(_args, 'employee_id'),
      hr_agent.arg_bool(_args, 'include_stopped', false)) where replaced_by is null limit 50) r;
  return jsonb_build_object('routines', _rows);
end $$;

create or replace function hr_agent.create_routine(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _people uuid[];
begin
  perform hr_agent.only_keys(_args, array['employee_ids','title','jobs','schedule','detail']);
  _people := hr_agent.arg_uuids(_args, 'employee_ids', 50);
  if cardinality(_people) = 0 then raise exception using errcode = '22023', message = '"employee_ids" needs at least one id.'; end if;
  if jsonb_typeof(_args->'schedule') is distinct from 'object' then
    raise exception using errcode = '22023', message = '"schedule" is required: {frequency, start_date, end_date?, weekdays?, month_day?, interval_days?}.';
  end if;
  return public.create_routine_set(_people, hr_agent.arg_text(_args, 'title', 120, true),
    hr_agent.routine_jobs(_args, false), _args->'schedule', hr_agent.arg_text(_args, 'detail', 2000));
end $$;

create or replace function hr_agent.update_routine(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid; _current jsonb; _jobs jsonb;
begin
  perform hr_agent.only_keys(_args, array['routine_id','title','jobs','schedule','detail']);
  _id := hr_agent.arg_uuid(_args, 'routine_id', true);
  if jsonb_typeof(_args->'schedule') is distinct from 'object' then
    raise exception using errcode = '22023', message = '"schedule" is required: {frequency, start_date, end_date?, weekdays?, month_day?, interval_days?}.';
  end if;
  _jobs := hr_agent.routine_jobs(_args, true);
  -- Read through the scope-checked listing: if the routine is not visible, nothing is changed.
  select r.jobs into _current from public.list_routine_sets(null, true) r where r.id = _id;
  if _current is null then
    raise exception using errcode = 'P0002', message = 'Routine not found, or you cannot see it.';
  end if;
  -- Leaving a job out would remove it. Removing is not allowed through the assistant.
  if exists(select 1 from jsonb_array_elements(_current) c where (c->>'is_active')::boolean
      and not exists(select 1 from jsonb_array_elements(_jobs) j where j->>'id' = c->>'id')) then
    raise exception using errcode = '22023', message = 'Keep every existing job (with its id). Removing jobs is not allowed through the assistant.';
  end if;
  return jsonb_build_object('routine_id', public.replace_routine_set(_id, hr_agent.arg_text(_args, 'title', 120, true),
    _jobs, _args->'schedule', hr_agent.arg_text(_args, 'detail', 2000)));
end $$;

create or replace function hr_agent.stop_routine(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid;
begin
  perform hr_agent.only_keys(_args, array['routine_id']);
  _id := hr_agent.arg_uuid(_args, 'routine_id', true);
  perform public.retire_routine_set(_id);
  return jsonb_build_object('routine_id', _id, 'stopped', true);
end $$;

-- Department requests -------------------------------------------------------------------------
create or replace function hr_agent.list_help_requests(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _direction text; _status text; _page integer[]; _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['direction','status','limit','offset']);
  _direction := coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'direction', 20), array['incoming','outgoing','all'], 'direction'), 'all');
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 20), array['Pending','Accepted','Declined','Cancelled'], 'status');
  _page := hr_agent.page(_args);
  select jsonb_agg(r.item order by r.created_at desc, r.id) into _rows from (
    select jsonb_build_object('id', h.id, 'title', h.title, 'description', h.description, 'priority', h.priority,
      'due_date', h.due_date, 'status', h.status, 'from_department', fd.name, 'to_department', td.name,
      'requested_by', hr_agent.person(h.requested_by), 'preferred', hr_agent.person(h.preferred_employee_id),
      'assigned', hr_agent.person(h.assigned_employee_id), 'task_id', h.task_id, 'decision_note', h.decision_note,
      'created_at', h.created_at) as item, h.created_at, h.id
    from public.help_requests h
      left join public.departments fd on fd.id = h.from_department_id
      left join public.departments td on td.id = h.to_department_id
    where (_status is null or h.status = _status)
      and (_direction = 'all'
        or (_direction = 'incoming' and app.has_perm('task.request', h.entity_id, null, h.to_branch_id, h.to_department_id, null))
        or (_direction = 'outgoing' and app.has_perm('task.request', h.entity_id, null, h.from_branch_id, h.from_department_id, null)))
    order by h.created_at desc, h.id limit _page[1] + 1 offset _page[2]) r;
  return hr_agent.paged('requests', _rows, _page);
end $$;

create or replace function hr_agent.request_help(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
begin
  perform hr_agent.only_keys(_args, array['from_department_id','to_department_id','title','description','preferred_employee_id','priority','due_date']);
  return jsonb_build_object('request_id', public.request_department_help(
    hr_agent.arg_uuid(_args, 'from_department_id', true), hr_agent.arg_uuid(_args, 'to_department_id', true),
    hr_agent.arg_text(_args, 'title', 200, true), hr_agent.arg_text(_args, 'description', 4000),
    hr_agent.arg_uuid(_args, 'preferred_employee_id'),
    coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'priority', 20), hr_agent.task_priorities(), 'priority'), 'Medium'),
    hr_agent.arg_date(_args, 'due_date')));
end $$;

create or replace function hr_agent.answer_help_request(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _accept boolean;
begin
  perform hr_agent.only_keys(_args, array['request_id','accept','assignee_id','note','priority']);
  _accept := hr_agent.arg_bool(_args, 'accept');
  if _accept is null then raise exception using errcode = '22023', message = '"accept" is required (true or false).'; end if;
  return jsonb_build_object('request_id', hr_agent.arg_uuid(_args, 'request_id', true), 'accepted', _accept,
    'result', public.respond_to_help_request(hr_agent.arg_uuid(_args, 'request_id', true), _accept,
      hr_agent.arg_uuid(_args, 'assignee_id'), hr_agent.arg_text(_args, 'note', 2000),
      hr_agent.pick(hr_agent.arg_text(_args, 'priority', 20), hr_agent.task_priorities(), 'priority')));
end $$;

create or replace function hr_agent.cancel_help_request(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid;
begin
  perform hr_agent.only_keys(_args, array['request_id']);
  _id := hr_agent.arg_uuid(_args, 'request_id', true);
  perform public.cancel_help_request(_id);
  return jsonb_build_object('request_id', _id, 'cancelled', true);
end $$;

-- Tickets -------------------------------------------------------------------------------------
create or replace function hr_agent.list_ticket_categories(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
begin
  perform hr_agent.only_keys(_args, '{}');
  return jsonb_build_object('categories', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
      'department', coalesce(c.department->>'name', null), 'is_hr_queue', c.is_hr_queue) order by c.name, c.id), '[]')
    from public.list_ticket_categories() c where c.is_active));
end $$;

create or replace function hr_agent.list_tickets(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _status text; _page integer[]; _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['status','since','limit','offset']);
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 20), array['Open','In Progress','On Hold','Resolved'], 'status');
  _page := hr_agent.page(_args);
  select jsonb_agg(r.item order by r.created_at desc, r.id) into _rows from (
    select jsonb_build_object('id', t.id, 'category', t.category, 'subject', t.subject, 'description', t.description,
      'priority', t.priority, 'status', t.status, 'created_at', t.created_at,
      'raised_by', jsonb_build_object('id', t.employee_id, 'name', coalesce(t.employee->>'full_name', t.employee->>'name')),
      'department', coalesce(t.routed_department->>'name', null), 'can_manage', t.can_manage) as item, t.created_at, t.id
    from public.list_tickets(coalesce(hr_agent.arg_date(_args, 'since'), current_date - 180)) t
    where _status is null or t.status = _status
    order by t.created_at desc, t.id limit _page[1] + 1 offset _page[2]) r;
  return hr_agent.paged('tickets', _rows, _page);
end $$;

create or replace function hr_agent.create_ticket(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
begin
  perform hr_agent.only_keys(_args, array['category_id','subject','priority','description']);
  return jsonb_build_object('ticket_id', public.create_ticket(hr_agent.arg_uuid(_args, 'category_id', true),
    hr_agent.arg_text(_args, 'subject', 200, true),
    coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'priority', 20), array['Low','Medium','High'], 'priority'), 'Medium'),
    hr_agent.arg_text(_args, 'description', 4000)));
end $$;

create or replace function hr_agent.set_ticket_status(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid; _status text;
begin
  perform hr_agent.only_keys(_args, array['ticket_id','status']);
  _id := hr_agent.arg_uuid(_args, 'ticket_id', true);
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 20, true), array['Open','In Progress','On Hold','Resolved'], 'status');
  perform public.set_ticket_status(_id, _status);
  return jsonb_build_object('ticket_id', _id, 'status', _status);
end $$;

-- Leave ---------------------------------------------------------------------------------------
create or replace function hr_agent.list_leave_requests(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _view text; _employee uuid; _page integer[]; _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['view','employee_id','limit','offset']);
  _view := coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'view', 30), array['waiting_for_me','all_open','recent'], 'view'), 'waiting_for_me');
  _employee := hr_agent.arg_uuid(_args, 'employee_id');
  _page := hr_agent.page(_args);
  select jsonb_agg(r.item order by r.start_date, r.id) into _rows from (
    select jsonb_build_object('id', l.id, 'employee', hr_agent.person(l.employee_id), 'type', l.type,
      'start_date', l.start_date, 'end_date', l.end_date, 'days', l.days, 'day_fraction', l.day_fraction,
      'reason', l.reason, 'status', l.status, 'stage', public.leave_effective_stage(l),
      'can_decide', public.leave_can_decide(l)) as item, l.start_date, l.id
    from public.leaves l
    where (_employee is null or l.employee_id = _employee)
      and case _view
        when 'waiting_for_me' then public.leave_can_decide(l)
        when 'all_open' then l.status in ('Pending','On Hold')
        else l.start_date >= current_date - 60 end
    order by l.start_date, l.id limit _page[1] + 1 offset _page[2]) r;
  return hr_agent.paged('leave_requests', _rows, _page);
end $$;

create or replace function hr_agent.decide_leave(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _leave public.leaves;
begin
  perform hr_agent.only_keys(_args, array['leave_id','decision','remarks']);
  -- Reopening (back to Pending) is an HR correction and stays in the app.
  _leave := public.decide_leave(hr_agent.arg_uuid(_args, 'leave_id', true),
    hr_agent.pick(hr_agent.arg_text(_args, 'decision', 20, true), array['Approved','Rejected','On Hold','Cancelled'], 'decision'),
    hr_agent.arg_text(_args, 'remarks', 2000, true));
  return jsonb_build_object('leave_id', _leave.id, 'status', _leave.status, 'stage', _leave.approval_stage);
end $$;

-- Assets --------------------------------------------------------------------------------------
create or replace function hr_agent.asset_summary(_asset public.assets)
returns jsonb language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object('id', _asset.id, 'code', _asset.asset_code, 'name', _asset.name, 'category', _asset.category,
    'type', _asset.asset_type, 'make', _asset.make, 'model', _asset.model, 'serial', _asset.serial,
    'status', _asset.status, 'condition', _asset.condition, 'location', _asset.location,
    'holder', hr_agent.person(_asset.employee_id), 'warranty_expires', _asset.warranty_expires);
$$;

create or replace function hr_agent.list_assets(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _status text; _category text; _query text; _holder uuid; _page integer[]; _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['status','category','query','holder_id','limit','offset']);
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 20),
    array['Available','Allocated','Under Repair','Damaged','Lost','Retired'], 'status');
  _category := hr_agent.pick(hr_agent.arg_text(_args, 'category', 20), array['Hardware','Software','Furniture','Vehicle','Other'], 'category');
  _query := hr_agent.arg_text(_args, 'query', 100);
  _holder := hr_agent.arg_uuid(_args, 'holder_id');
  _page := hr_agent.page(_args);
  select jsonb_agg(hr_agent.asset_summary(r.a) order by (r.a).name, (r.a).id) into _rows from (
    select a from public.assets a
    where (_status is null or a.status = _status) and (_category is null or a.category = _category)
      and (_holder is null or a.employee_id = _holder)
      and (_query is null or a.name ilike hr_agent.like_pattern(_query) or a.asset_code ilike hr_agent.like_pattern(_query)
        or a.serial ilike hr_agent.like_pattern(_query))
    order by a.name, a.id limit _page[1] + 1 offset _page[2]) r;
  return hr_agent.paged('assets', _rows, _page);
end $$;

create or replace function hr_agent.add_asset(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid := gen_random_uuid();
begin
  perform hr_agent.only_keys(_args, array['name','category','type','code','make','model','serial','condition','location',
    'notes','purchase_date','vendor','warranty_expires','owner_entity_id','owner_branch_id']);
  insert into public.assets(id, name, category, asset_type, asset_code, make, model, serial, condition, location, notes,
      purchase_date, vendor, warranty_expires, owner_entity_id, owner_branch_id)
    values (_id, hr_agent.arg_text(_args, 'name', 200, true),
      coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'category', 20), array['Hardware','Software','Furniture','Vehicle','Other'], 'category'), 'Hardware'),
      hr_agent.arg_text(_args, 'type', 100), hr_agent.arg_text(_args, 'code', 100), hr_agent.arg_text(_args, 'make', 100),
      hr_agent.arg_text(_args, 'model', 100), hr_agent.arg_text(_args, 'serial', 100), hr_agent.arg_text(_args, 'condition', 200),
      hr_agent.arg_text(_args, 'location', 200), hr_agent.arg_text(_args, 'notes', 2000), hr_agent.arg_date(_args, 'purchase_date'),
      hr_agent.arg_text(_args, 'vendor', 200), hr_agent.arg_date(_args, 'warranty_expires'),
      hr_agent.arg_uuid(_args, 'owner_entity_id'), hr_agent.arg_uuid(_args, 'owner_branch_id'));
  return jsonb_build_object('asset_id', _id);
end $$;

create or replace function hr_agent.update_asset(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid; _status text; _fields text[] := array['name','category','type','code','make','model','serial','condition',
  'location','notes','purchase_date','vendor','warranty_expires'];
begin
  perform hr_agent.only_keys(_args, array_append(array_append(_fields, 'asset_id'), 'status'));
  _id := hr_agent.arg_uuid(_args, 'asset_id', true);
  -- Allocated is owned by the custody trigger: use assign_asset / return_asset instead.
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 20), array['Available','Under Repair','Damaged','Lost','Retired'], 'status');
  if not (_args ?| array_append(_fields, 'status')) then
    raise exception using errcode = '22023', message = 'Give at least one field to change.';
  end if;
  if _args ? 'name' then perform hr_agent.arg_text(_args, 'name', 200, true); end if;
  update public.assets a set
      name = coalesce(hr_agent.arg_text(_args, 'name', 200), a.name),
      category = case when _args ? 'category' then coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'category', 20),
        array['Hardware','Software','Furniture','Vehicle','Other'], 'category'), a.category) else a.category end,
      asset_type = case when _args ? 'type' then hr_agent.arg_text(_args, 'type', 100) else a.asset_type end,
      asset_code = case when _args ? 'code' then hr_agent.arg_text(_args, 'code', 100) else a.asset_code end,
      make = case when _args ? 'make' then hr_agent.arg_text(_args, 'make', 100) else a.make end,
      model = case when _args ? 'model' then hr_agent.arg_text(_args, 'model', 100) else a.model end,
      serial = case when _args ? 'serial' then hr_agent.arg_text(_args, 'serial', 100) else a.serial end,
      condition = case when _args ? 'condition' then hr_agent.arg_text(_args, 'condition', 200) else a.condition end,
      location = case when _args ? 'location' then hr_agent.arg_text(_args, 'location', 200) else a.location end,
      notes = case when _args ? 'notes' then hr_agent.arg_text(_args, 'notes', 2000) else a.notes end,
      purchase_date = case when _args ? 'purchase_date' then hr_agent.arg_date(_args, 'purchase_date') else a.purchase_date end,
      vendor = case when _args ? 'vendor' then hr_agent.arg_text(_args, 'vendor', 200) else a.vendor end,
      warranty_expires = case when _args ? 'warranty_expires' then hr_agent.arg_date(_args, 'warranty_expires') else a.warranty_expires end,
      status = coalesce(_status, a.status)
    where a.id = _id;
  if not found then raise exception using errcode = 'P0002', message = 'Asset not found, or you cannot change it.'; end if;
  return jsonb_build_object('asset_id', _id, 'updated', true);
end $$;

create or replace function hr_agent.assign_asset(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid := gen_random_uuid(); _asset uuid;
begin
  perform hr_agent.only_keys(_args, array['asset_id','employee_id','condition','notes']);
  _asset := hr_agent.arg_uuid(_args, 'asset_id', true);
  if not exists(select 1 from public.assets where id = _asset) then
    raise exception using errcode = 'P0002', message = 'Asset not found, or you cannot see it.';
  end if;
  -- assigned_by is left to the custody trigger, which records the acting user.
  insert into public.asset_assignments(id, asset_id, employee_id, condition_out, notes)
    values (_id, _asset, hr_agent.arg_uuid(_args, 'employee_id', true), hr_agent.arg_text(_args, 'condition', 200),
      hr_agent.arg_text(_args, 'notes', 2000));
  return jsonb_build_object('assignment_id', _id, 'asset_id', _asset);
end $$;

create or replace function hr_agent.return_asset(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _asset uuid;
begin
  perform hr_agent.only_keys(_args, array['asset_id','condition','notes']);
  _asset := hr_agent.arg_uuid(_args, 'asset_id', true);
  update public.asset_assignments set returned_at = clock_timestamp(),
      condition_in = hr_agent.arg_text(_args, 'condition', 200), return_notes = hr_agent.arg_text(_args, 'notes', 2000)
    where asset_id = _asset and returned_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'That asset is not currently with anyone, or you cannot manage it.';
  end if;
  return jsonb_build_object('asset_id', _asset, 'returned', true);
end $$;

-- Goals ---------------------------------------------------------------------------------------
create or replace function hr_agent.list_goals(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _employee uuid; _status text; _page integer[]; _rows jsonb;
begin
  perform hr_agent.only_keys(_args, array['employee_id','status','limit','offset']);
  _employee := hr_agent.arg_uuid(_args, 'employee_id');
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 20), array['Active','Completed','Dropped'], 'status');
  _page := hr_agent.page(_args);
  select jsonb_agg(r.item order by r.target_date nulls last, r.id) into _rows from (
    select jsonb_build_object('id', g.id, 'employee', hr_agent.person(g.employee_id), 'title', g.title,
      'description', g.description, 'target_date', g.target_date, 'weight', g.weight, 'progress', g.progress,
      'status', g.status) as item, g.target_date, g.id
    from public.goals g
    where (_employee is null or g.employee_id = _employee) and (_status is null or g.status = _status)
    order by g.target_date nulls last, g.id limit _page[1] + 1 offset _page[2]) r;
  return hr_agent.paged('goals', _rows, _page);
end $$;

create or replace function hr_agent.create_goal(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid := gen_random_uuid();
begin
  perform hr_agent.only_keys(_args, array['employee_id','title','description','target_date','weight']);
  insert into public.goals(id, employee_id, title, description, target_date, weight, created_by)
    values (_id, hr_agent.arg_uuid(_args, 'employee_id', true), hr_agent.arg_text(_args, 'title', 200, true),
      hr_agent.arg_text(_args, 'description', 4000), hr_agent.arg_date(_args, 'target_date'),
      hr_agent.arg_int(_args, 'weight', 0, 100), app.current_employee_id());
  return jsonb_build_object('goal_id', _id);
end $$;

create or replace function hr_agent.update_goal(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid;
begin
  perform hr_agent.only_keys(_args, array['goal_id','progress','status','title','description','target_date','weight']);
  _id := hr_agent.arg_uuid(_args, 'goal_id', true);
  if not (_args ?| array['progress','status','title','description','target_date','weight']) then
    raise exception using errcode = '22023', message = 'Give at least one field to change.';
  end if;
  if _args ? 'title' then perform hr_agent.arg_text(_args, 'title', 200, true); end if;
  update public.goals g set
      progress = coalesce(hr_agent.arg_int(_args, 'progress', 0, 100), g.progress),
      status = coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'status', 20), array['Active','Completed','Dropped'], 'status'), g.status),
      title = coalesce(hr_agent.arg_text(_args, 'title', 200), g.title),
      description = case when _args ? 'description' then hr_agent.arg_text(_args, 'description', 4000) else g.description end,
      target_date = case when _args ? 'target_date' then hr_agent.arg_date(_args, 'target_date') else g.target_date end,
      weight = case when _args ? 'weight' then hr_agent.arg_int(_args, 'weight', 0, 100) else g.weight end
    where g.id = _id;
  if not found then raise exception using errcode = 'P0002', message = 'Goal not found, or you cannot change it.'; end if;
  return jsonb_build_object('goal_id', _id, 'updated', true);
end $$;

revoke all on all functions in schema hr_agent from public, anon, service_role;
grant execute on all functions in schema hr_agent to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. The entry point
-- ---------------------------------------------------------------------------------------------
-- INVOKER on purpose: changing role is forbidden inside SECURITY DEFINER code. PostgREST's login
-- role is a member of `authenticated`, which is what lets this switch from `anon`. The switch and
-- the identity settings are transaction-local; they are restored explicitly on success, and a
-- failed tool's subtransaction rollback restores them too. Errors inside a tool are returned as
-- data, so the rate charge and the audit row survive a refused action.
create or replace function public.developer_api_call(_api_key text, _tool text, _args jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = pg_catalog as $$
declare
  _auth record;
  _result jsonb;
  _error jsonb;
  _state text;
  _message text;
  _role text := current_setting('role');
  _claims text := coalesce(current_setting('request.jwt.claims', true), '');
  _sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  _claim_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  select * into _auth from agent_gateway.authorize(_api_key, _tool);
  _args := coalesce(_args, '{}'::jsonb);
  begin
    if jsonb_typeof(_args) <> 'object' then
      raise exception using errcode = '22023', message = 'Arguments must be a JSON object.';
    end if;
    perform set_config('request.jwt.claim.sub', _auth.actor::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', _auth.actor, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    case _tool
      when 'whoami' then _result := hr_agent.whoami(_args) || jsonb_build_object('areas', to_jsonb(_auth.scopes));
      when 'find_employees' then _result := hr_agent.find_employees(_args);
      when 'list_departments' then _result := hr_agent.list_departments(_args);
      when 'list_tasks' then _result := hr_agent.list_tasks(_args);
      when 'get_task' then _result := hr_agent.get_task(_args);
      when 'create_task' then _result := hr_agent.create_task(_args);
      when 'update_task' then _result := hr_agent.update_task(_args);
      when 'add_task_helpers' then _result := hr_agent.add_task_helpers(_args);
      when 'comment_on_task' then _result := hr_agent.comment_on_task(_args);
      when 'add_subtask' then _result := hr_agent.add_subtask(_args);
      when 'tick_subtask' then _result := hr_agent.tick_subtask(_args);
      when 'list_routines' then _result := hr_agent.list_routines(_args);
      when 'create_routine' then _result := hr_agent.create_routine(_args);
      when 'update_routine' then _result := hr_agent.update_routine(_args);
      when 'stop_routine' then _result := hr_agent.stop_routine(_args);
      when 'list_help_requests' then _result := hr_agent.list_help_requests(_args);
      when 'request_help' then _result := hr_agent.request_help(_args);
      when 'answer_help_request' then _result := hr_agent.answer_help_request(_args);
      when 'cancel_help_request' then _result := hr_agent.cancel_help_request(_args);
      when 'list_ticket_categories' then _result := hr_agent.list_ticket_categories(_args);
      when 'list_tickets' then _result := hr_agent.list_tickets(_args);
      when 'create_ticket' then _result := hr_agent.create_ticket(_args);
      when 'set_ticket_status' then _result := hr_agent.set_ticket_status(_args);
      when 'list_leave_requests' then _result := hr_agent.list_leave_requests(_args);
      when 'decide_leave' then _result := hr_agent.decide_leave(_args);
      when 'list_assets' then _result := hr_agent.list_assets(_args);
      when 'add_asset' then _result := hr_agent.add_asset(_args);
      when 'update_asset' then _result := hr_agent.update_asset(_args);
      when 'assign_asset' then _result := hr_agent.assign_asset(_args);
      when 'return_asset' then _result := hr_agent.return_asset(_args);
      when 'list_goals' then _result := hr_agent.list_goals(_args);
      when 'create_goal' then _result := hr_agent.create_goal(_args);
      when 'update_goal' then _result := hr_agent.update_goal(_args);
      else raise exception using errcode = 'PT400', message = 'Unknown tool.';
    end case;
    perform set_config('role', _role, true);
    perform set_config('request.jwt.claim.sub', _sub, true);
    perform set_config('request.jwt.claim.role', _claim_role, true);
    perform set_config('request.jwt.claims', _claims, true);
  exception when others then
    get stacked diagnostics _state = returned_sqlstate, _message = message_text;
    _error := agent_gateway.error(_state, _message);
  end;
  perform agent_gateway.audit(_api_key, _tool, _error is null);
  if _error is not null then
    return jsonb_build_object('ok', false, 'error', _error);
  end if;
  return jsonb_build_object('ok', true, 'data', coalesce(_result, 'null'::jsonb));
end $$;
revoke all on function public.developer_api_call(text,text,jsonb) from public, authenticated, service_role;
grant execute on function public.developer_api_call(text,text,jsonb) to anon;

comment on function public.developer_api_call(text,text,jsonb) is
  'Personal assistant API. Validates a manage key, then runs one whitelisted hr_agent tool as the key owner under the app''s own row policies. No tool deletes data.';
notify pgrst, 'reload schema';
commit;
