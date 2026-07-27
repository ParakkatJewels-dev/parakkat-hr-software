-- 0031_delete_login.sql
-- Remove a login entirely. The admin screen could create logins and grant roles but never take
-- one away, so a leaver's account could only be stripped of roles and left behind forever — and
-- the orphaned logins created by the old non-transactional flow had no cleanup path at all.
--
-- Deleting auth.users cascades to profiles and role_assignments (both reference it with
-- on delete cascade), and employees.user_id is `on delete set null`, so the employee record and
-- all their attendance/leave history are untouched. Only the ability to sign in is removed.
-- Idempotent: safe to re-run.

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

grant execute on function public.delete_login(uuid) to authenticated;
