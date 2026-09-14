-- Administrator-managed, read-only integration credentials. The public API RPC validates the
-- credential and its scope itself, including when called directly through anonymous PostgREST.
begin;

create table if not exists app.developer_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into app.developer_settings(singleton) values (true) on conflict do nothing;

create table if not exists app.developer_api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  key_prefix text not null,
  secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null check (cardinality(scopes) between 1 and 3 and
    scopes <@ array['employees:read','organization:read','attendance:read']::text[]),
  -- Deleting an entity removes its keys rather than turning them into unrestricted keys.
  entity_id uuid references public.entities(id) on delete cascade,
  created_by uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  rate_window_at timestamptz,
  rate_count integer not null default 0 check (rate_count >= 0)
);
alter table app.developer_settings enable row level security;
alter table app.developer_api_keys enable row level security;
revoke all on app.developer_settings, app.developer_api_keys from public, anon, authenticated, service_role;

-- Both profile-flag and role-granted super administrators qualify. A banned, soft-deleted,
-- deleted or demoted creator cannot keep using integration keys issued under their old authority.
create or replace function app.developer_admin_active(_user uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select exists (
    select 1 from auth.users u join public.profiles p on p.user_id = u.id
    where u.id = _user and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and (p.is_super_admin or exists (
        select 1 from public.role_assignments ra join public.roles r on r.id = ra.role_id
        where ra.user_id = u.id and r.key = 'super_admin' and ra.scope_type = 'global'
      ))
  );
$$;
revoke all on function app.developer_admin_active(uuid) from public, anon, authenticated, service_role;

-- Explicit allowlist: adding a private column later cannot expose it in management responses.
create or replace function app.developer_key_metadata(_key app.developer_api_keys)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object('id', _key.id, 'name', _key.name, 'key_prefix', _key.key_prefix,
    'scopes', _key.scopes, 'entity_id', _key.entity_id, 'created_at', _key.created_at,
    'expires_at', _key.expires_at, 'last_used_at', _key.last_used_at, 'revoked_at', _key.revoked_at);
$$;
revoke all on function app.developer_key_metadata(app.developer_api_keys) from public, anon, authenticated, service_role;

create or replace function public.get_developer_settings()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null or not app.developer_admin_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Only a super administrator can manage developer settings.';
  end if;
  return (select jsonb_build_object('enabled', enabled, 'updated_at', updated_at) from app.developer_settings where singleton);
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
  return jsonb_build_object('enabled', _settings.enabled, 'updated_at', _settings.updated_at);
end $$;

create or replace function public.list_developer_api_keys()
returns table (id uuid, name text, key_prefix text, scopes text[], entity_id uuid, created_at timestamptz,
  expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null or not app.developer_admin_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Only a super administrator can manage API keys.';
  end if;
  return query select k.id, k.name, k.key_prefix, k.scopes, k.entity_id, k.created_at,
    k.expires_at, k.last_used_at, k.revoked_at from app.developer_api_keys k order by k.created_at desc, k.id;
end $$;

create or replace function public.create_developer_api_key(
  _name text, _scopes text[], _entity_id uuid default null, _expires_in_days integer default 90
) returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _key app.developer_api_keys%rowtype; _secret text; _scoped text[]; _id uuid := gen_random_uuid();
begin
  if auth.uid() is null or not app.developer_admin_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Only a super administrator can create API keys.';
  end if;
  if length(btrim(coalesce(_name, ''))) not between 1 and 80 then
    raise exception using errcode = 'PT400', message = 'API key name must contain 1 to 80 characters.';
  end if;
  if _expires_in_days is null or _expires_in_days not between 1 and 365 then
    raise exception using errcode = 'PT400', message = 'API key expiry must be between 1 and 365 days.';
  end if;
  if _scopes is null or cardinality(_scopes) = 0 or exists (
    select 1 from unnest(_scopes) s where s is null or s not in ('employees:read','organization:read','attendance:read')
  ) then raise exception using errcode = 'PT400', message = 'Choose one or more supported read permissions.'; end if;
  select array_agg(distinct s order by s) into _scoped from unnest(_scopes) s;
  if _entity_id is not null and not exists(select 1 from public.entities where id = _entity_id) then
    raise exception using errcode = 'PT400', message = 'Choose an existing company.';
  end if;
  -- The displayed prefix contains only the non-secret key id. All 256 random secret bits remain
  -- hidden after this one response; neither the raw key nor its random suffix is stored.
  _secret := 'phr_' || replace(_id::text, '-', '') || '_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into app.developer_api_keys(id, name, key_prefix, secret_hash, scopes, entity_id, created_by, expires_at)
    values (_id, btrim(_name), 'phr_' || left(replace(_id::text, '-', ''), 8),
      encode(extensions.digest(_secret, 'sha256'), 'hex'), _scoped, _entity_id, auth.uid(),
      clock_timestamp() + make_interval(days => _expires_in_days)) returning * into _key;
  insert into public.audit_log(actor, actor_email, action, table_name, row_id, entity_id)
    select auth.uid(), email, 'API_KEY_CREATE', 'developer_api_keys', _key.id, _key.entity_id
      from auth.users where id = auth.uid();
  return jsonb_build_object('api_key', _secret, 'key', app.developer_key_metadata(_key));
end $$;

create or replace function public.revoke_developer_api_key(_key_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _key app.developer_api_keys%rowtype;
begin
  if auth.uid() is null or not app.developer_admin_active(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Only a super administrator can revoke API keys.';
  end if;
  select * into _key from app.developer_api_keys where id = _key_id for update;
  if not found then raise exception using errcode = 'PT400', message = 'API key not found.'; end if;
  if _key.revoked_at is not null then return; end if;
  update app.developer_api_keys set revoked_at = clock_timestamp() where id = _key.id;
  insert into public.audit_log(actor, actor_email, action, table_name, row_id, entity_id)
    select auth.uid(), email, 'API_KEY_REVOKE', 'developer_api_keys', _key.id, _key.entity_id
      from auth.users where id = auth.uid();
end $$;

create or replace function public.developer_api_read(
  _api_key text, _resource text, _limit integer default 50, _offset integer default 0,
  _from date default null, _to date default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  _key app.developer_api_keys%rowtype;
  _enabled boolean;
  _now timestamptz;
  _data jsonb;
  _has_more boolean;
  _take integer := coalesce(_limit, 50);
  _skip integer := coalesce(_offset, 0);
begin
  if coalesce(_api_key, '') !~ '^phr_[0-9a-f]{32}_[0-9a-f]{64}$' then
    raise exception using errcode = 'PT401', message = 'Invalid or inactive API key.';
  end if;
  -- Hold the setting/key through the read so a completed disable or revoke cannot race a new
  -- request. The key lock also serializes the per-key rate counter across concurrent callers.
  select enabled into _enabled from app.developer_settings where singleton for share;
  if not coalesce(_enabled, false) then
    raise exception using errcode = 'PT503', message = 'The developer API is disabled.';
  end if;
  select * into _key from app.developer_api_keys
    where secret_hash = encode(extensions.digest(_api_key, 'sha256'), 'hex') for update;
  _now := clock_timestamp();
  if not found or _key.revoked_at is not null or _key.expires_at <= _now
     or not app.developer_admin_active(_key.created_by) then
    raise exception using errcode = 'PT401', message = 'Invalid or inactive API key.';
  end if;
  if _resource is null or _resource not in ('employees','organization','attendance') then
    raise exception using errcode = 'PT400', message = 'Choose a supported API resource.';
  end if;
  if not ((_resource || ':read') = any(_key.scopes)) then
    raise exception using errcode = 'PT403', message = 'This API key does not allow that resource.';
  end if;
  if _take not between 1 and 100 or _skip not between 0 and 1000000 then
    raise exception using errcode = 'PT400', message = 'Use a limit from 1 to 100 and an offset from 0 to 1000000.';
  end if;
  if _resource = 'attendance' then
    if _from is null or _to is null or not isfinite(_from) or not isfinite(_to)
       or _to < _from or _to - _from > 30 then
      raise exception using errcode = 'PT400', message = 'Attendance requires a valid from/to date range of at most 31 days.';
    end if;
  elsif _from is not null or _to is not null then
    raise exception using errcode = 'PT400', message = 'Date filters are supported only for attendance.';
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

  if _resource = 'employees' then
    with page as (
      select e.id, e.employee_code, e.full_name, e.email, e.status, e.entity_id, e.zone_id,
        e.branch_id, e.department_id, e.designation_id, e.join_date
      from public.employees e where _key.entity_id is null or e.entity_id = _key.entity_id
      order by e.id limit _take + 1 offset _skip
    ), numbered as (select to_jsonb(p) as item, row_number() over(order by p.id) as ordinal from page p)
    select coalesce(jsonb_agg(item order by ordinal) filter(where ordinal <= _take), '[]'::jsonb),
      count(*) > _take into _data, _has_more from numbered;
  elsif _resource = 'organization' then
    with organization as (
      select 'entity'::text as kind, e.id, e.name, e.code, e.id as entity_id,
        null::uuid as zone_id, null::uuid as branch_id, e.is_active from public.entities e
      union all select 'zone', z.id, z.name, z.code, z.entity_id, z.id, null, z.is_active from public.zones z
      union all select 'branch', b.id, b.name, b.code, b.entity_id, b.zone_id, b.id, b.is_active from public.branches b
      union all select 'department', d.id, d.name, d.code, d.entity_id, b.zone_id, d.branch_id, d.is_active
        from public.departments d left join public.branches b on b.id = d.branch_id
      union all select 'designation', d.id, d.title, d.code, d.entity_id, b.zone_id, dep.branch_id, d.is_active
        from public.designations d left join public.departments dep on dep.id = d.department_id
        left join public.branches b on b.id = dep.branch_id
    ), page as (
      select * from organization where _key.entity_id is null or entity_id = _key.entity_id
      order by kind, id limit _take + 1 offset _skip
    ), numbered as (select to_jsonb(p) as item, row_number() over(order by p.kind, p.id) as ordinal from page p)
    select coalesce(jsonb_agg(item order by ordinal) filter(where ordinal <= _take), '[]'::jsonb),
      count(*) > _take into _data, _has_more from numbered;
  else
    with page as (
      select a.id, a.employee_id, a.work_date, a.status, a.hours, a.worked_minutes, a.late_minutes,
        a.early_exit_minutes, a.ot_minutes, a.entity_id, a.branch_id
      from public.attendance a join public.employees e on e.id = a.employee_id
      where a.work_date between _from and _to
        -- Do not expose a previous company's attendance after an employee has transferred.
        and (_key.entity_id is null or (a.entity_id = _key.entity_id and e.entity_id = _key.entity_id))
      order by a.work_date, a.id limit _take + 1 offset _skip
    ), numbered as (select to_jsonb(p) as item, row_number() over(order by p.work_date, p.id) as ordinal from page p)
    select coalesce(jsonb_agg(item order by ordinal) filter(where ordinal <= _take), '[]'::jsonb),
      count(*) > _take into _data, _has_more from numbered;
  end if;
  return jsonb_build_object('data', _data, 'pagination',
    jsonb_build_object('limit', _take, 'offset', _skip, 'has_more', _has_more));
end $$;

revoke all on function public.get_developer_settings() from public, anon, service_role;
revoke all on function public.set_developer_settings(boolean) from public, anon, service_role;
revoke all on function public.list_developer_api_keys() from public, anon, service_role;
revoke all on function public.create_developer_api_key(text,text[],uuid,integer) from public, anon, service_role;
revoke all on function public.revoke_developer_api_key(uuid) from public, anon, service_role;
grant execute on function public.get_developer_settings(), public.set_developer_settings(boolean),
  public.list_developer_api_keys(), public.create_developer_api_key(text,text[],uuid,integer),
  public.revoke_developer_api_key(uuid) to authenticated;
revoke all on function public.developer_api_read(text,text,integer,integer,date,date) from public, service_role;
grant execute on function public.developer_api_read(text,text,integer,integer,date,date) to anon, authenticated;

comment on table app.developer_api_keys is 'Private SHA256 digests of 256-bit random integration credentials. No recoverable plaintext keys.';
comment on function public.developer_api_read(text,text,integer,integer,date,date) is
  'Read-only integration API. Validates the opaque key, current creator authority, expiry, master switch, scope/entity restriction and per-key rate limit before selecting explicitly allowed fields.';
notify pgrst, 'reload schema';
commit;
