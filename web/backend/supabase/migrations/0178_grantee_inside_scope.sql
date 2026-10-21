-- 0178 Who receives a role must be inside the giver's own area too.
--
-- app.can_grant checks WHERE a role applies (the giver needs rbac.manage over that place). The
-- person receiving it was checked only for employee@self, so a company admin or HR manager of one
-- company could give a person from another company a role inside their own company. The screens
-- never offered it (an admin only sees their own company's people), but the database allowed it
-- (found by tests/role_grant_matrix.sql). Now, when the grantee has an employee record, that record
-- must sit inside the giver's rbac.manage area as well. A login with no employee record keeps the
-- old rule, so "Create login, then give a role" still works. Super admins are unaffected.
-- The same function guards revoking (role_assignments delete policy), so the rule is symmetric.
begin;

create or replace function app.can_grant_to(
  _grantee uuid, _role_id uuid, _scope_type public.scope_type, _scope_id uuid
) returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare
  _key text;
  e    record;
begin
  if app.is_super_admin() then return true; end if;
  select key into _key from public.roles where id = _role_id;

  select emp.* into e
    from public.profiles p join public.employees emp on emp.id = p.employee_id
   where p.user_id = _grantee;

  -- ESS at self scope: allowed, but only for a person inside the caller's own scope.
  if _key = 'employee' and _scope_type = 'self' then
    if e.id is null then return false; end if;
    return app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id);
  end if;

  -- Every other role: the place must be grantable, and so must the person when they are an employee.
  if e.id is not null
     and not app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id) then
    return false;
  end if;
  return app.can_grant(_role_id, _scope_type, _scope_id);
end $$;

notify pgrst, 'reload schema';
commit;
