-- 0091_hr_does_not_appoint_managers.sql
--
-- Seniority is the wrong test for delegation.
--
-- 0044 settled who may hand out which role with one rule: strictly below your own rank. That is
-- right for stopping escalation and wrong for describing authority. HR Manager is rank 60 and
-- Zonal Manager is 50, so the rule let an HR manager appoint a zonal manager — and appointing a
-- zonal or a branch manager is not a people-operations decision. It decides who reports to whom
-- and who signs off on whose branch, which belongs to the entity admin.
--
-- HR hires, onboards, exits and keeps the records. The most senior thing they hand out is a
-- department head, so a small team can be stood up without waiting on an admin. Everything above
-- that goes back to entity_admin and super_admin, who were always the ones accountable for it.
--
-- Everyone else is unchanged: strictly-below still applies, expressed through the same function so
-- there is one place the ceiling lives rather than two rules that can drift.
--
-- The UI mirrors this in GrantAccessPanel.grantableRoles. This file is the one that is binding.

-- ---------------------------------------------------------------- the ceiling
create or replace function app.max_grantable_rank()
returns int language sql stable security definer set search_path = app, public as $$
  select case
    when app.is_super_admin() then 1000
    -- Capped only when HR is the WHOLE of what this person is. Somebody who is both an HR manager
    -- and an entity admin is an entity admin; the other hat they wear must not demote them.
    when app.max_role_rank() <= 60
     and exists (
           select 1
             from public.role_assignments ra
             join public.roles r on r.id = ra.role_id
            where ra.user_id = auth.uid() and r.key = 'hr_manager'
         )
    then 30
    -- The 0044 rule, restated: strictly below your own level. Ranks are spaced in tens, so minus
    -- one lands between them and admits everything genuinely beneath you.
    else app.max_role_rank() - 1
  end;
$$;

comment on function app.max_grantable_rank() is
  'Highest role rank the caller may grant. Below max_role_rank() for HR, who may not appoint branch or zonal managers.';

-- ---------------------------------------------------------------- apply it
-- Identical to 0044 apart from Guard 1, which now asks the ceiling instead of the rank directly.
create or replace function app.can_grant(_role_id uuid, _scope_type public.scope_type, _scope_id uuid)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare
  _key  text;
  _rank int;
  _sys  boolean;
  _e uuid; _z uuid; _b uuid; _d uuid;
  _admin_role boolean;
begin
  if app.is_super_admin() then return true; end if;

  select key, rank, is_system into _key, _rank, _sys from public.roles where id = _role_id;
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

  -- Guard 1: at or below the ceiling. For most roles that is still "strictly below your own
  -- level" — a Branch Manager minting another Branch Manager is the lateral-escalation case 0044
  -- guards. For HR it is lower than their rank, per the note at the top of this file.
  if _rank > app.max_grantable_rank() then
    return false;
  end if;

  -- Guard 2: only an entity admin or above may pass on CUSTOM rbac.manage / org.manage roles.
  -- Built-in roles are already controlled by rank and by app.max_grantable_rank().
  if _admin_role and not _sys and app.max_role_rank() < 80 then
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
