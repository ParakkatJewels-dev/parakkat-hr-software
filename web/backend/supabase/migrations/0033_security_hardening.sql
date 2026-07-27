-- 0033_security_hardening.sql
-- Fixes found by the second security audit, each verified against a live entity-admin session
-- before and after. Idempotent: safe to re-run.
--
--  C1  link_user_to_employee validated only the target EMPLOYEE, never the target LOGIN, so a
--      scoped admin could re-point ANY login (including a super admin's) at an employee they
--      control. Same class as the hole 0032 closed in grant_app_access — this was its twin.
--  C2  delete_login resolved the victim's scope THROUGH profiles.employee_id, which C1 let the
--      attacker set; and its last-super-admin guard ignored role-granted super admins.
--  H1  enqueue_recompute had no authorization at all: any authenticated user could queue
--      millions of rows for any employee.
--  H2  resolve_punch_links had no authorization: any authenticated user could rewrite the
--      employee link on raw punches (a table they may only read) and probe device codes.
--  M1  can_grant ignores WHO is being granted, so any rbac.manage holder could add/remove the
--      employee@self role for any user in the system.
--  M2  app.* helper functions were EXECUTE-able by anon/authenticated (PUBLIC default), letting
--      a direct-Postgres caller forge notifications or rewrite leave balances.
--  M3  grant_app_access let a scoped admin squat any not-yet-registered email address.
--  L2  tg_set_updated_at had no search_path.

-- ---------------------------------------------------------------------------
-- C1: validate the LOGIN as well as the employee
-- ---------------------------------------------------------------------------
create or replace function public.link_user_to_employee(_user uuid, _employee uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  e           record;
  cur_emp     uuid;
  target_sa   boolean;
  privileged  boolean;
begin
  privileged := auth.uid() is null or app.is_super_admin();

  -- Who is this login today? Re-pointing it is an identity change, so it needs its own check.
  select employee_id, is_super_admin into cur_emp, target_sa
    from public.profiles where user_id = _user;

  if not privileged then
    -- Never touch an administrator's account from a scoped role.
    if coalesce(target_sa, false) then
      raise exception 'that login belongs to an administrator account';
    end if;
    -- Re-pointing a login that is already linked requires authority over its CURRENT employee
    -- too, otherwise the check could be satisfied purely by the attacker's chosen target.
    if cur_emp is not null and cur_emp is distinct from _employee then
      declare c record;
      begin
        select * into c from public.employees where id = cur_emp;
        if c.id is null or not app.has_perm('rbac.manage', c.entity_id, c.zone_id, c.branch_id, c.department_id, c.id) then
          raise exception 'that login belongs to someone outside your scope';
        end if;
      end;
    end if;
    -- Adopting an unlinked login is a super-admin action (mirrors grant_app_access, 0032).
    if cur_emp is null and _employee is not null then
      raise exception 'that login is not linked to anyone — ask a super admin to link it';
    end if;
  end if;

  if _employee is not null then
    select * into e from public.employees where id = _employee;
    if e.id is null then raise exception 'employee not found'; end if;
    if not (privileged
            or app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id)) then
      raise exception 'not authorized to link this employee';
    end if;
  elsif not privileged then
    raise exception 'not authorized';
  end if;

  update public.profiles set employee_id = _employee where user_id = _user;
  update public.employees set user_id = null where user_id = _user and id is distinct from _employee;
  if _employee is not null then
    update public.employees set user_id = _user where id = _employee;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- C2: delete_login — count role-granted super admins too, and refuse admin targets outright
-- ---------------------------------------------------------------------------
create or replace function public.delete_login(_user uuid)
returns void
language plpgsql security definer set search_path = auth, public, app as $$
declare
  _emp        record;
  _target_sa  boolean;
  _privileged boolean;
  _sa_total   int;
begin
  if _user is null then raise exception 'no user given'; end if;
  if _user = auth.uid() then raise exception 'you cannot delete your own login'; end if;

  _privileged := auth.uid() is null or app.is_super_admin();

  -- A super admin is anyone with the profile flag OR a global super_admin role grant; the old
  -- check only knew about the flag, so a role-granted super admin had no protection at all.
  select coalesce(p.is_super_admin, false)
         or exists (select 1 from public.role_assignments ra
                      join public.roles r on r.id = ra.role_id
                     where ra.user_id = _user and r.key = 'super_admin')
    into _target_sa
    from public.profiles p where p.user_id = _user;

  if coalesce(_target_sa, false) and not _privileged then
    raise exception 'only a super admin may delete an administrator login';
  end if;

  if not _privileged then
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

  if coalesce(_target_sa, false) then
    select count(*) into _sa_total
      from public.profiles p
     where p.is_super_admin
        or exists (select 1 from public.role_assignments ra
                     join public.roles r on r.id = ra.role_id
                    where ra.user_id = p.user_id and r.key = 'super_admin');
    if _sa_total <= 1 then
      raise exception 'this is the only super admin — promote another one first';
    end if;
  end if;

  update public.employees set user_id = null where user_id = _user;
  -- NO ACTION foreign keys: clear them or the delete fails outright.
  update public.role_assignments set granted_by = null where granted_by = _user;
  update public.org_settings set updated_by = null where updated_by = _user;

  delete from auth.users where id = _user;
end $$;

-- ---------------------------------------------------------------------------
-- H1: enqueue_recompute — authorize, and bound the range
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_recompute(
  _employee_id uuid, _from date, _to date default null, _reason text default 'manual'
) returns integer
language plpgsql security definer set search_path = app, public as $$
declare
  e     record;
  _end  date := coalesce(_to, _from);
  _n    integer;
begin
  if _from is null then raise exception 'a start date is required'; end if;
  if _end < _from then raise exception 'the end date is before the start date'; end if;
  -- A queue entry per employee-day: an unbounded range is a denial-of-service vector.
  if _end - _from > 366 then raise exception 'range too large (max 366 days)'; end if;

  if auth.uid() is not null and not app.is_super_admin() then
    if _employee_id is null then
      raise exception 'not authorized to recompute every employee';
    end if;
    select * into e from public.employees where id = _employee_id;
    if e.id is null then raise exception 'employee not found'; end if;
    if not app.has_perm('attendance.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id) then
      raise exception 'not authorized to recompute this employee''s attendance';
    end if;
  end if;

  insert into public.attendance_recompute_queue (employee_id, work_date, reason)
  select _employee_id, d::date, left(coalesce(_reason, 'manual'), 200)
    from generate_series(_from, _end, interval '1 day') d
  on conflict do nothing;

  get diagnostics _n = row_count;
  return _n;
end $$;

-- ---------------------------------------------------------------------------
-- H2: resolve_punch_links — device.manage only
-- ---------------------------------------------------------------------------
create or replace function public.resolve_punch_links(_emp_code text)
returns table (punches_linked integer, employee_id uuid, first_date date, last_date date)
language plpgsql security definer set search_path = app, public as $$
declare
  _emp uuid;
  _n   integer := 0;
begin
  if auth.uid() is not null
     and not app.has_perm('device.manage', null, null, null, null, null) then
    raise exception 'not authorized to manage device mappings';
  end if;

  select be.employee_id into _emp
    from public.biotime_employees be
   where be.emp_code = _emp_code and be.employee_id is not null;

  if _emp is null then
    return query select 0, null::uuid, null::date, null::date;
    return;
  end if;

  update public.raw_punches rp
     set employee_id = _emp
   where rp.emp_code = _emp_code and rp.employee_id is null;
  get diagnostics _n = row_count;

  return query
    select _n, _emp,
           min((rp.punch_time at time zone 'Asia/Kolkata')::date),
           max((rp.punch_time at time zone 'Asia/Kolkata')::date)
      from public.raw_punches rp
     where rp.emp_code = _emp_code;
end $$;

-- ---------------------------------------------------------------------------
-- M1: constrain WHO may be granted employee@self
-- ---------------------------------------------------------------------------
create or replace function app.can_grant_to(
  _grantee uuid, _role_id uuid, _scope_type public.scope_type, _scope_id uuid
) returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare
  _key text;
  e    record;
begin
  if app.is_super_admin() then return true; end if;
  select key into _key from public.roles where id = _role_id;

  -- ESS at self scope: allowed, but only for a person inside the caller's own scope. Without
  -- this the grantee was unconstrained — any rbac.manage holder could add or REVOKE ESS for
  -- anybody in the company, including users in other entities.
  if _key = 'employee' and _scope_type = 'self' then
    select emp.* into e
      from public.profiles p join public.employees emp on emp.id = p.employee_id
     where p.user_id = _grantee;
    if e.id is null then return false; end if;
    return app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id);
  end if;

  return app.can_grant(_role_id, _scope_type, _scope_id);
end $$;

-- Route the RLS policies and the guard trigger through the grantee-aware check.
drop policy if exists role_assignments_insert on public.role_assignments;
create policy role_assignments_insert on public.role_assignments for insert to authenticated
  with check (app.can_grant_to(user_id, role_id, scope_type, scope_id));
drop policy if exists role_assignments_update on public.role_assignments;
create policy role_assignments_update on public.role_assignments for update to authenticated
  using (app.can_grant_to(user_id, role_id, scope_type, scope_id))
  with check (app.can_grant_to(user_id, role_id, scope_type, scope_id));
drop policy if exists role_assignments_delete on public.role_assignments;
create policy role_assignments_delete on public.role_assignments for delete to authenticated
  using (app.can_grant_to(user_id, role_id, scope_type, scope_id));

create or replace function app.tg_role_assignment_guard()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _rkey text;
  _rsys boolean;
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.scope_type = 'entity' and not exists (select 1 from public.entities where id = new.scope_id) then
    raise exception 'scope_id % is not a valid entity', new.scope_id;
  elsif new.scope_type = 'zone' and not exists (select 1 from public.zones where id = new.scope_id) then
    raise exception 'scope_id % is not a valid zone', new.scope_id;
  elsif new.scope_type = 'branch' and not exists (select 1 from public.branches where id = new.scope_id) then
    raise exception 'scope_id % is not a valid branch', new.scope_id;
  elsif new.scope_type = 'department' and not exists (select 1 from public.departments where id = new.scope_id) then
    raise exception 'scope_id % is not a valid department', new.scope_id;
  end if;

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

  if not app.can_grant_to(new.user_id, new.role_id, new.scope_type, new.scope_id) then
    raise exception 'not authorized to grant this role at this scope';
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- M3: stop a scoped admin claiming an arbitrary unregistered address
-- ---------------------------------------------------------------------------
create or replace function app.assert_login_email_allowed(_employee_id uuid, _clean text)
returns void language plpgsql stable security definer set search_path = app, public as $$
declare _emp_email text;
begin
  if auth.uid() is null or app.is_super_admin() then return; end if;
  select lower(trim(email)) into _emp_email from public.employees where id = _employee_id;
  -- When the employee record carries an email, a scoped admin must use exactly that address;
  -- otherwise they could pre-register (and hold the password for) any company address.
  if _emp_email is not null and _emp_email <> '' and _emp_email <> _clean then
    raise exception 'the login email must match the address on the employee record (%)', _emp_email;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- M2 / L2: lock down helper execution and fix the missing search_path
-- ---------------------------------------------------------------------------
create or replace function app.tg_set_updated_at()
returns trigger language plpgsql set search_path = app, public as $$
begin
  new.updated_at := now();
  return new;
end $$;

revoke usage on schema app from anon;
do $$
declare fn text;
begin
  foreach fn in array array[
    'app.notify_user(uuid, text, text, text, text, uuid)',
    'app.notify_perm_holders(text, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid)',
    'app.apply_leave_balance(uuid)',
    'app.release_leave_balance(uuid)',
    'app.link_biotime_employee(text)'
  ] loop
    begin
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    exception when undefined_function then
      -- signature differs in this deployment; skip rather than fail the migration
      null;
    end;
  end loop;
end $$;
