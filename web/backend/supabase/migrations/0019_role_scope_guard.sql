-- 0019_role_scope_guard.sql
-- Enforce role↔scope compatibility for the built-in roles: a role may only be granted at a scope
-- level that makes sense for it (Employee only at 'self', Branch Manager only at 'branch', HR
-- Manager at entity/zone/branch/department, etc.). Custom (non-system) roles stay grantable at any
-- scope. This complements the escalation guard: can_grant controls WHO may grant WHERE; this
-- controls WHICH role fits WHICH scope level. Rewrites the guard from 0005 (the trigger binding is
-- unchanged). Idempotent: safe to re-run.

create or replace function app.tg_role_assignment_guard()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _rkey text;
  _rsys boolean;
begin
  -- Trusted server-side contexts (service_role import, SQL editor) have no JWT: skip all guards.
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

  -- role ↔ scope compatibility (built-in roles only; custom roles are unrestricted)
  select key, is_system into _rkey, _rsys from public.roles where id = new.role_id;
  if _rsys then
    if not (
         (_rkey = 'super_admin'    and new.scope_type = 'global')
      or (_rkey = 'entity_admin'   and new.scope_type = 'entity')
      or (_rkey = 'hr_manager'     and new.scope_type in ('entity', 'zone', 'branch', 'department'))
      or (_rkey = 'zonal_manager'  and new.scope_type = 'zone')
      or (_rkey = 'branch_manager' and new.scope_type = 'branch')
      or (_rkey = 'dept_head'      and new.scope_type = 'department')
      or (_rkey = 'employee'       and new.scope_type = 'self')
    ) then
      raise exception '% cannot be granted at % scope', _rkey, new.scope_type;
    end if;
  end if;

  -- privilege-escalation guard
  if not app.can_grant(new.role_id, new.scope_type, new.scope_id) then
    raise exception 'not authorized to grant this role at this scope';
  end if;

  return new;
end $$;
