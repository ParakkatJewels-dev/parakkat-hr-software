-- 0016_user_role_admin.sql
-- In-app user & role management. Everything here is browser-callable but locked to super admins,
-- so we route writes through SECURITY DEFINER RPCs (minimal direct-write surface) rather than
-- opening RLS on public.roles. The 7 seeded system roles keep their identity; only their
-- permission set is editable, and custom roles can be created/deleted freely.
-- Idempotent: safe to re-run.

-- Create a custom role, or update an existing role's permission set (and, for non-system roles,
-- its name/description). Pass _role_id = null to create. Returns the role id.
create or replace function public.save_role(
  _role_id uuid, _key text, _name text, _description text, _permission_keys text[]
) returns uuid
language plpgsql security definer set search_path = app, public as $$
declare _id uuid;
begin
  if not app.is_super_admin() then
    raise exception 'only a super admin may manage roles';
  end if;

  if _role_id is null then
    if coalesce(nullif(trim(_key), ''), '') = '' or coalesce(nullif(trim(_name), ''), '') = '' then
      raise exception 'a role needs both a key and a name';
    end if;
    insert into public.roles (key, name, description, is_system)
    values (lower(regexp_replace(trim(_key), '\s+', '_', 'g')), trim(_name), nullif(trim(_description), ''), false)
    returning id into _id;
  else
    select id into _id from public.roles where id = _role_id;
    if _id is null then raise exception 'role not found'; end if;
    -- The Super Admin role is short-circuited everywhere; its permission list is meaningless to edit.
    if exists (select 1 from public.roles where id = _id and key = 'super_admin') then
      raise exception 'the Super Admin role is managed automatically and cannot be edited';
    end if;
    -- System roles keep their key/name; only their permissions change. Custom roles are fully editable.
    if not exists (select 1 from public.roles where id = _id and is_system) then
      update public.roles set
        name        = coalesce(nullif(trim(_name), ''), name),
        description = nullif(trim(_description), '')
      where id = _id;
    end if;
  end if;

  -- Replace the permission set in full.
  delete from public.role_permissions where role_id = _id;
  insert into public.role_permissions (role_id, permission_id)
  select _id, p.id from public.permissions p where p.key = any (_permission_keys)
  on conflict do nothing;

  return _id;
end $$;

-- Delete a custom role. System roles and roles still granted to someone are refused.
create or replace function public.delete_role(_role_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if not app.is_super_admin() then
    raise exception 'only a super admin may delete roles';
  end if;
  if exists (select 1 from public.roles where id = _role_id and is_system) then
    raise exception 'system roles cannot be deleted';
  end if;
  if exists (select 1 from public.role_assignments where role_id = _role_id) then
    raise exception 'this role is still assigned to one or more users — revoke those grants first';
  end if;
  delete from public.roles where id = _role_id;
end $$;

-- Toggle a login's global super-admin flag. Guards against removing the final super admin.
create or replace function public.set_super_admin(_user uuid, _flag boolean)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if not app.is_super_admin() then
    raise exception 'only a super admin may change super admin status';
  end if;
  if not _flag
     and exists (select 1 from public.profiles where user_id = _user and is_super_admin)
     and (select count(*) from public.profiles where is_super_admin) <= 1 then
    raise exception 'cannot remove the last super admin';
  end if;
  insert into public.profiles (user_id, is_super_admin) values (_user, _flag)
  on conflict (user_id) do update set is_super_admin = excluded.is_super_admin;
end $$;

grant execute on function public.save_role(uuid, text, text, text, text[]) to authenticated;
grant execute on function public.delete_role(uuid) to authenticated;
grant execute on function public.set_super_admin(uuid, boolean) to authenticated;
