-- 0005_functions.sql
-- Security-definer helpers. These bypass RLS internally (that is intentional and safe: they only
-- ever read the CALLER's own grants via auth.uid()), which also avoids RLS recursion on role_assignments.

-- The employee row linked to the current login (or null).
create or replace function app.current_employee_id()
returns uuid language sql stable security definer set search_path = app, public as $$
  select employee_id from public.profiles where user_id = auth.uid()
$$;

-- Global super admin? (either the profile flag or a global super_admin role assignment)
create or replace function app.is_super_admin()
returns boolean language sql stable security definer set search_path = app, public as $$
  select coalesce((select is_super_admin from public.profiles where user_id = auth.uid()), false)
      or exists (
        select 1 from public.role_assignments ra
        join public.roles r on r.id = ra.role_id
        where ra.user_id = auth.uid() and r.key = 'super_admin' and ra.scope_type = 'global'
      )
$$;

-- THE decision function. Does the current user hold `_perm` over a row with this ancestry?
-- Inheritance is implicit: an entity-scope grant matches any row carrying that entity_id
-- (i.e. all its zones/branches/departments); a zone grant matches any row with that zone_id; etc.
create or replace function app.has_perm(
  _perm text, _entity uuid, _zone uuid, _branch uuid, _dept uuid, _employee uuid
) returns boolean language sql stable security definer set search_path = app, public as $$
  select app.is_super_admin()
    or exists (
      select 1
      from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
      where ra.user_id = auth.uid()
        and p.key = _perm
        and (
             ra.scope_type = 'global'
          or (ra.scope_type = 'entity'     and ra.scope_id = _entity)
          or (ra.scope_type = 'zone'       and ra.scope_id = _zone)
          or (ra.scope_type = 'branch'     and ra.scope_id = _branch)
          or (ra.scope_type = 'department' and ra.scope_id = _dept)
          or (ra.scope_type = 'self'       and _employee is not null and _employee = app.current_employee_id())
        )
    )
$$;

-- Branch ids the current user can see (any grant covering them) — for UI filters / dashboards.
create or replace function app.visible_branch_ids()
returns setof uuid language sql stable security definer set search_path = app, public as $$
  select b.id from public.branches b
  where app.is_super_admin()
     or exists (
       select 1 from public.role_assignments ra
       where ra.user_id = auth.uid() and (
            ra.scope_type = 'global'
         or (ra.scope_type = 'entity' and ra.scope_id = b.entity_id)
         or (ra.scope_type = 'zone'   and ra.scope_id = b.zone_id)
         or (ra.scope_type = 'branch' and ra.scope_id = b.id)
       )
     )
$$;

-- Can the current user grant `_role_id` at (_scope_type,_scope_id)?
-- Rules: super admin can grant anything; nobody else can grant super_admin or a global scope;
-- otherwise the granter must hold rbac.manage at an equal-or-higher scope covering the target
-- (a branch admin cannot grant an entity-wide role — falls out of has_perm naturally).
create or replace function app.can_grant(_role_id uuid, _scope_type public.scope_type, _scope_id uuid)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare
  _key text;
  _e uuid; _z uuid; _b uuid; _d uuid;
begin
  if app.is_super_admin() then return true; end if;

  select key into _key from public.roles where id = _role_id;
  if _key = 'super_admin' or _scope_type in ('global','self') then
    return false;
  end if;

  if _scope_type = 'entity' then
    _e := _scope_id;
  elsif _scope_type = 'zone' then
    select entity_id into _e from public.zones where id = _scope_id;
    _z := _scope_id;
  elsif _scope_type = 'branch' then
    select entity_id, zone_id into _e, _z from public.branches where id = _scope_id;
    _b := _scope_id;
  elsif _scope_type = 'department' then
    select d.entity_id, b.zone_id, d.branch_id into _e, _z, _b
    from public.departments d
    left join public.branches b on b.id = d.branch_id
    where d.id = _scope_id;
    _d := _scope_id;
  end if;

  return app.has_perm('rbac.manage', _e, _z, _b, _d, null);
end $$;

-- Validate the polymorphic scope_id points at the right table, and enforce grant rules on write.
create or replace function app.tg_role_assignment_guard()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  -- Trusted server-side contexts (service_role import, SQL editor / postgres) have no JWT, so
  -- auth.uid() is null. Reaching this trigger with a null uid means grants+RLS were bypassed by a
  -- privileged role, which we allow. (Ordinary anon has no privileges on role_assignments at all.)
  if auth.uid() is null then
    return new;
  end if;

  -- referential integrity for the polymorphic scope_id
  if new.scope_type = 'entity' and not exists (select 1 from public.entities where id = new.scope_id) then
    raise exception 'scope_id % is not a valid entity', new.scope_id;
  elsif new.scope_type = 'zone' and not exists (select 1 from public.zones where id = new.scope_id) then
    raise exception 'scope_id % is not a valid zone', new.scope_id;
  elsif new.scope_type = 'branch' and not exists (select 1 from public.branches where id = new.scope_id) then
    raise exception 'scope_id % is not a valid branch', new.scope_id;
  elsif new.scope_type = 'department' and not exists (select 1 from public.departments where id = new.scope_id) then
    raise exception 'scope_id % is not a valid department', new.scope_id;
  end if;

  -- privilege-escalation guard (skipped for the service_role seed path, which runs as a superuser
  -- with auth.uid() = null and is_super_admin() true only via bypass; the check below still holds)
  if not app.can_grant(new.role_id, new.scope_type, new.scope_id) then
    raise exception 'not authorized to grant this role at this scope';
  end if;

  return new;
end $$;

create trigger trg_role_assignment_guard
  before insert or update on public.role_assignments
  for each row execute function app.tg_role_assignment_guard();

-- Single RPC the frontend calls after login to hydrate the AuthContext.
create or replace function public.get_my_access()
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'is_super_admin', app.is_super_admin(),
    'employee', (
      select to_jsonb(e) from (
        select emp.id, emp.full_name, emp.email, emp.employee_code, emp.status,
               emp.entity_id, emp.zone_id, emp.branch_id, emp.department_id, emp.designation_id
        from public.profiles p
        join public.employees emp on emp.id = p.employee_id
        where p.user_id = auth.uid()
      ) e
    ),
    'assignments', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
        'role', r.key, 'scope_type', ra.scope_type, 'scope_id', ra.scope_id))
      from public.role_assignments ra
      join public.roles r on r.id = ra.role_id
      where ra.user_id = auth.uid()
    ), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
        'permission', p.key, 'scope_type', ra.scope_type, 'scope_id', ra.scope_id))
      from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
      where ra.user_id = auth.uid()
    ), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- Bootstrap helper: promote a login to global super admin by email (run once in the SQL editor
-- AFTER that person has signed up / been invited). Example:
--   select public.bootstrap_super_admin('prteam@parakkatjewels.com');
create or replace function public.bootstrap_super_admin(_email text)
returns void language plpgsql security definer set search_path = app, public as $$
declare _uid uuid;
begin
  select id into _uid from auth.users where lower(email) = lower(_email);
  if _uid is null then
    raise exception 'no auth user with email %, have them sign up/accept the invite first', _email;
  end if;
  insert into public.profiles (user_id, is_super_admin) values (_uid, true)
  on conflict (user_id) do update set is_super_admin = true;
end $$;
