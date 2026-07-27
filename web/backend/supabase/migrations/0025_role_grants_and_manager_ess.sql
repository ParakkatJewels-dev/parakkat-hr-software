-- 0025_role_grants_and_manager_ess.sql
-- Role/sidebar tune-up per product decisions:
--   1. hr_manager     += recruitment.manage, performance.manage  (HR owns Recruit Hub + PMS)
--   2. branch_manager += report.read                             (branch-level Reports & Analytics)
--   3. dept_head      += ticket.read, ticket.create              (can raise & track own tickets)
--   4. Dual-role pattern: every manager also gets the `employee` role at self scope, so they see
--      their own payslips / expenses / documents alongside their oversight modules.
--        - app.can_grant now lets any rbac.manage holder grant/revoke employee@self (it was
--          super-admin only, which blocked the pattern). No escalation risk: ESS only ever
--          exposes the grantee's OWN records.
--        - A trigger auto-grants employee@self whenever a manager role is assigned to a login
--          that is linked to an employee record.
--        - Existing manager users are backfilled.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1..3: permission grants
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key = any (array['recruitment.manage', 'performance.manage'])
where r.key = 'hr_manager'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key = 'report.read'
where r.key = 'branch_manager'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key = any (array['ticket.read', 'ticket.create'])
where r.key = 'dept_head'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4a: can_grant — allow employee@self for rbac.manage holders
-- Both the RLS with-check on role_assignments AND the assignment guard trigger route through
-- this function, so one change covers both paths.
-- ---------------------------------------------------------------------------
create or replace function app.can_grant(_role_id uuid, _scope_type public.scope_type, _scope_id uuid)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare
  _key text;
  _e uuid; _z uuid; _b uuid; _d uuid;
begin
  if app.is_super_admin() then return true; end if;

  select key into _key from public.roles where id = _role_id;

  -- ESS convenience: the employee role at self scope may be granted (or revoked) by anyone who
  -- holds rbac.manage at any scope. It only ever exposes the grantee's own records, so there is
  -- no privilege to escalate.
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

-- ---------------------------------------------------------------------------
-- 4b: auto-grant employee@self alongside any manager-role grant
-- ---------------------------------------------------------------------------
create or replace function app.tg_autogrant_ess()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _mgr text;
  _emp_role uuid;
begin
  select key into _mgr from public.roles where id = new.role_id;
  if _mgr not in ('entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head') then
    return new;
  end if;

  -- ESS is meaningless for a login with no employee record behind it.
  if not exists (
    select 1 from public.profiles p where p.user_id = new.user_id and p.employee_id is not null
  ) then
    return new;
  end if;

  select id into _emp_role from public.roles where key = 'employee';
  if not exists (
    select 1 from public.role_assignments ra
    where ra.user_id = new.user_id and ra.role_id = _emp_role and ra.scope_type = 'self'
  ) then
    begin
      insert into public.role_assignments (user_id, role_id, scope_type, scope_id, granted_by)
      values (new.user_id, _emp_role, 'self', null, new.granted_by);
    exception when others then
      -- The convenience grant must never block the manager grant itself.
      null;
    end;
  end if;

  return new;
end $$;

drop trigger if exists trg_autogrant_ess on public.role_assignments;
create trigger trg_autogrant_ess
  after insert on public.role_assignments
  for each row execute function app.tg_autogrant_ess();

-- ---------------------------------------------------------------------------
-- 4c: backfill — existing manager users linked to an employee get employee@self
-- ---------------------------------------------------------------------------
insert into public.role_assignments (user_id, role_id, scope_type, scope_id)
select distinct ra.user_id, emp.id, 'self'::public.scope_type, null::uuid
from public.role_assignments ra
join public.roles r on r.id = ra.role_id
  and r.key in ('entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head')
join public.profiles p on p.user_id = ra.user_id and p.employee_id is not null
cross join (select id from public.roles where key = 'employee') emp
where not exists (
  select 1 from public.role_assignments x
  where x.user_id = ra.user_id and x.role_id = emp.id and x.scope_type = 'self'
);
