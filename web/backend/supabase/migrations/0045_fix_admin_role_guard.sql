-- 0045 — Narrow the "administrative role" guard added in 0044.
--
-- 0044 refused to let anyone below entity admin grant a role carrying rbac.manage/org.manage. That
-- guard exists for one specific hole: a *custom* role can be given rbac.manage while keeping the
-- default rank of 20, which would make it grantable by any manager and route straight around the
-- rank ladder.
--
-- But 0044 also granted rbac.manage to the built-in manager roles, so the guard caught them too —
-- a Branch Manager could no longer grant Dept Head, which is the exact delegation the migration was
-- written to enable. The built-in ladder is already ordered by rank, so the guard only needs to
-- cover roles that sit outside it.

begin;

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
  -- minting another Branch Manager is the lateral-escalation case this guards.
  if _rank >= app.max_role_rank() then
    return false;
  end if;

  -- Guard 2, narrowed: a CUSTOM role carrying administrative authority is not covered by the rank
  -- ladder (custom roles all default to rank 20), so passing one on requires entity admin or
  -- above. Built-in roles are ordered by rank and already handled by guard 1.
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

commit;
