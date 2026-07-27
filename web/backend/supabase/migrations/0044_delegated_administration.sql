-- 0044 — Delegated administration.
--
-- Until now only super_admin and entity_admin held rbac.manage, so a Branch Manager could approve
-- their branch's leave but could not onboard a single person into it. Every account had to be made
-- centrally. This migration lets a manager administer their own area: add employees, create their
-- logins, and grant roles — but only *below* their own level, and only inside their scope.
--
-- The scope half of that already works: app.has_perm matches a branch-scoped grant against the
-- row's branch_id, and app.can_grant resolves a target scope up to its entity/zone/branch before
-- checking rbac.manage. What was missing is a seniority ceiling. Without one, giving a Branch
-- Manager rbac.manage would let them grant branch_manager to a peer — or to a second account of
-- their own — which is lateral escalation with no audit signal.
--
-- So: every role gets a rank, and you may only grant a role ranked strictly below your own.

begin;

-- ---------------------------------------------------------------- role seniority
alter table public.roles add column if not exists rank int not null default 20;

comment on column public.roles.rank is
  'Seniority. You may only grant a role ranked strictly below your own highest rank. Custom roles '
  'default to 20 — above employee (10), below dept_head (30) — so they are grantable by any '
  'manager but can never be used to hand out authority over one.';

update public.roles set rank = case key
  when 'super_admin'    then 100
  when 'entity_admin'   then 80
  when 'hr_manager'     then 60
  when 'zonal_manager'  then 50
  when 'branch_manager' then 40
  when 'dept_head'      then 30
  when 'employee'       then 10
  else rank
end
where key in ('super_admin','entity_admin','hr_manager','zonal_manager','branch_manager','dept_head','employee');

-- The caller's own ceiling: the highest-ranked role they hold anywhere.
create or replace function app.max_role_rank()
returns int language sql stable security definer set search_path = app, public as $$
  select case
    when app.is_super_admin() then 1000
    else coalesce((
      select max(r.rank)
        from public.role_assignments ra
        join public.roles r on r.id = ra.role_id
       where ra.user_id = auth.uid()
    ), 0)
  end;
$$;

-- ---------------------------------------------------------------- delegate rbac.manage
-- Managers may now administer their own area. Scope is enforced separately by has_perm, so a
-- branch_manager's rbac.manage only ever resolves inside the branch they hold.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r
  join public.permissions p on p.key = any (array['rbac.manage','employee.create','employee.update'])
 where r.key in ('hr_manager','zonal_manager','branch_manager','dept_head')
on conflict do nothing;

-- ---------------------------------------------------------------- the escalation ceiling
-- Replaces 0025's version. Same scope logic, plus two guards:
--   1. rank      — never grant a role at or above your own level.
--   2. rbac/org  — never hand out administrative authority you were not explicitly trusted with.
--      Without this, a custom role carrying rbac.manage (rank 20) would be grantable by any
--      manager, which routes straight around guard 1.
create or replace function app.can_grant(_role_id uuid, _scope_type public.scope_type, _scope_id uuid)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare
  _key  text;
  _rank int;
  _e uuid; _z uuid; _b uuid; _d uuid;
  _admin_role boolean;
begin
  if app.is_super_admin() then return true; end if;

  select key, rank into _key, _rank from public.roles where id = _role_id;
  if _key is null then return false; end if;

  -- Does this role carry administrative authority?
  select exists (
    select 1 from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
     where rp.role_id = _role_id and p.key in ('rbac.manage','org.manage')
  ) into _admin_role;

  -- ESS convenience: the employee role at self scope may be granted (or revoked) by anyone who
  -- holds rbac.manage at any scope. It only ever exposes the grantee's own records, so there is
  -- no privilege to escalate. can_grant_to (0033) confines the *grantee* to the caller's scope.
  if _key = 'employee' and _scope_type = 'self' then
    return exists (
      select 1
      from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
      where ra.user_id = auth.uid() and p.key = 'rbac.manage'
    );
  end if;

  if _key = 'super_admin' or _scope_type in ('global', 'self') then
    return false;
  end if;

  -- Guard 1: strictly below your own level. Equality is refused on purpose — a Branch Manager
  -- minting another Branch Manager is the lateral-escalation case this whole migration guards.
  if _rank >= app.max_role_rank() then
    return false;
  end if;

  -- Guard 2: only an entity admin or above may pass on rbac.manage / org.manage.
  if _admin_role and app.max_role_rank() < 80 then
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

-- ---------------------------------------------------------------- deleting a login
-- delete_login (0031) authorised on scope alone. With managers now holding rbac.manage, that would
-- let a Branch Manager delete their own manager's login if that person happened to sit in the
-- branch. Deleting an account belonging to someone at or above your level is not administration.
create or replace function app.can_admin_user(_target uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.is_super_admin()
      or (
        -- Super admin is a flag on profiles, not a role_assignment, so ranking the target purely
        -- from role_assignments would score one at 0 — lower than everybody. A Branch Manager
        -- could then delete the founder's login if the founder's employee record sat in their
        -- branch. Treat the flag as the top of the ladder.
        greatest(
          coalesce((
            select max(r.rank)
              from public.role_assignments ra
              join public.roles r on r.id = ra.role_id
             where ra.user_id = _target
          ), 0),
          coalesce((select 1000 from public.profiles where user_id = _target and is_super_admin), 0)
        ) < app.max_role_rank()
      );
$$;

comment on function app.can_admin_user(uuid) is
  'True when the caller outranks the target user. Pair with a scope check — this answers "may I '
  'act on this person at all", not "is this person in my area".';

-- delete_login, taken verbatim from 0031 with one guard added (see below).
create or replace function public.delete_login(_user uuid)
returns void
language plpgsql security definer set search_path = auth, public, app as $$
declare
  _emp record;
begin
  if _user is null then
    raise exception 'no user given';
  end if;
  if _user = auth.uid() then
    raise exception 'you cannot delete your own login';
  end if;

  -- Authorization mirrors grant_app_access: super admins anywhere, rbac.manage holders only for
  -- logins belonging to an employee inside their scope. A login with no employee behind it is
  -- super-admin-only, since there is no scope to check it against.
  if auth.uid() is not null and not app.is_super_admin() then
    select e.* into _emp
      from public.profiles p
      join public.employees e on e.id = p.employee_id
     where p.user_id = _user;

    if _emp.id is null then
      raise exception 'only a super admin may delete a login that is not linked to an employee';
    end if;
    if not app.has_perm('rbac.manage', _emp.entity_id, _emp.zone_id, _emp.branch_id, _emp.department_id, _emp.id) then
      raise exception 'you are not allowed to delete this login';
    end if;
    -- New in 0044: scope alone is no longer enough now that managers hold rbac.manage. Without
    -- this, a Branch Manager could delete the login of an HR Manager who happens to sit in their
    -- branch.
    if not app.can_admin_user(_user) then
      raise exception 'this login belongs to someone at or above your own level';
    end if;
  end if;

  -- Never leave the last super admin locked out of the system.
  if exists (select 1 from public.profiles where user_id = _user and is_super_admin)
     and (select count(*) from public.profiles where is_super_admin) <= 1 then
    raise exception 'this is the only super admin — promote another one first';
  end if;

  -- Release the employee link explicitly; the FK would do it, but being explicit keeps both
  -- sides consistent even if that FK is ever changed.
  update public.employees set user_id = null where user_id = _user;

  -- These two FKs are NO ACTION, not cascade/set-null: without clearing them first, deleting
  -- anyone who has ever granted a role (i.e. every admin) fails with a foreign-key violation.
  -- They are audit breadcrumbs, so nulling them loses nothing the audit_log does not keep.
  update public.role_assignments set granted_by = null where granted_by = _user;
  update public.org_settings set updated_by = null where updated_by = _user;

  delete from auth.users where id = _user;
end $$;

revoke all on function public.delete_login(uuid) from public, anon;
grant execute on function public.delete_login(uuid) to authenticated;

commit;
