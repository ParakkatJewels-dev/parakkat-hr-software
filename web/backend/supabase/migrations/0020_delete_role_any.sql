-- 0020_delete_role_any.sql
-- Allow a super admin to delete any role (built-in or custom), not just custom ones. Two guards
-- remain: the structural super_admin role can never be deleted, and a role still assigned to
-- someone must have its grants revoked first (its role_permissions cascade away with it).
-- Idempotent: safe to re-run.

create or replace function public.delete_role(_role_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare _key text;
begin
  if not app.is_super_admin() then
    raise exception 'only a super admin may delete roles';
  end if;

  select key into _key from public.roles where id = _role_id;
  if _key is null then
    raise exception 'role not found';
  end if;
  if _key = 'super_admin' then
    raise exception 'the Super Admin role is structural and cannot be deleted';
  end if;
  if exists (select 1 from public.role_assignments where role_id = _role_id) then
    raise exception 'this role is still assigned to one or more users — revoke those grants first';
  end if;

  delete from public.roles where id = _role_id;  -- role_permissions cascade via FK
end $$;

grant execute on function public.delete_role(uuid) to authenticated;
