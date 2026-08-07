-- 0095_grant_rules_do_not_drift.sql
--
-- 0091 correctly introduced the HR grant ceiling, but it recreated app.can_grant from the older
-- 0044 body and lost 0045's narrowed custom-role guard. The result was a function that could refuse
-- built-in delegated grants because those roles carry rbac.manage themselves. Put the final rule in
-- one place:
--   - HR as the top role may grant through Department Head only.
--   - Everyone else keeps the strictly-below-rank ceiling.
--   - Custom roles carrying rbac.manage/org.manage still require entity-admin seniority.
--   - get_my_access exposes assignment rank so the client can mirror the same ceiling.

begin;

create or replace function app.max_grantable_rank()
returns int language sql stable security definer set search_path = app, public as $$
  select case
    when app.is_super_admin() then 1000
    when app.max_role_rank() <= 60
     and exists (
           select 1
             from public.role_assignments ra
             join public.roles r on r.id = ra.role_id
            where ra.user_id = auth.uid() and r.key = 'hr_manager'
         )
    then 30
    else app.max_role_rank() - 1
  end;
$$;

comment on function app.max_grantable_rank() is
  'Highest role rank the caller may grant. HR as the top role may not appoint branch or zonal managers.';

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

  -- ESS convenience: employee@self may be granted/revoked by an rbac.manage holder, with
  -- app.can_grant_to constraining the grantee to the caller's scope.
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

  if _rank > app.max_grantable_rank() then
    return false;
  end if;

  -- Custom administrative roles are outside the built-in rank ladder, so passing one on still needs
  -- entity-admin seniority. Built-in manager roles are already ordered by rank and handled above.
  if _admin_role and not coalesce(_sys, false) and app.max_role_rank() < 80 then
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

create or replace function public.get_my_access()
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'is_super_admin', app.is_super_admin(),
    'rank', app.max_role_rank(),
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
        'role', r.key,
        'rank', r.rank,
        'is_system', r.is_system,
        'scope_type', ra.scope_type,
        'scope_id', ra.scope_id
      ))
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

grant execute on function public.get_my_access() to authenticated;

commit;
