-- 0096_manager_links_get_employee_workspace.sql
--
-- Managers are also employees, so every linked manager login needs employee@self for the "Work as
-- Employee" switch. 0025 covered manager grants created after the employee link already existed,
-- and backfilled what existed at that moment. It missed the opposite order: grant HR/manager first,
-- link the employee record later. Add the profile-link trigger and backfill those rows.

begin;

create or replace function app.ensure_employee_self_role(_user uuid, _granted_by uuid default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  _emp_role uuid;
begin
  if _user is null then
    return;
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.user_id = _user
      and p.employee_id is not null
  ) then
    return;
  end if;

  if not exists (
    select 1
    from public.role_assignments ra
    join public.roles r on r.id = ra.role_id
    where ra.user_id = _user
      and r.key in ('entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head')
  ) then
    return;
  end if;

  select id into _emp_role from public.roles where key = 'employee';
  if _emp_role is null then
    return;
  end if;

  if not exists (
    select 1
    from public.role_assignments ra
    where ra.user_id = _user
      and ra.role_id = _emp_role
      and ra.scope_type = 'self'
  ) then
    begin
      insert into public.role_assignments (user_id, role_id, scope_type, scope_id, granted_by)
      values (_user, _emp_role, 'self', null, _granted_by);
    exception when others then
      -- This is a convenience repair. A duplicate/race must not block granting or linking the user.
      null;
    end;
  end if;
end $$;

create or replace function app.tg_autogrant_ess()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _role text;
begin
  select key into _role from public.roles where id = new.role_id;
  if _role in ('entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head') then
    perform app.ensure_employee_self_role(new.user_id, new.granted_by);
  end if;
  return new;
end $$;

drop trigger if exists trg_autogrant_ess on public.role_assignments;
create trigger trg_autogrant_ess
  after insert or update of user_id, role_id on public.role_assignments
  for each row execute function app.tg_autogrant_ess();

create or replace function app.tg_profile_autogrant_ess()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.employee_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform app.ensure_employee_self_role(new.user_id, null);
  elsif old.employee_id is distinct from new.employee_id then
    perform app.ensure_employee_self_role(new.user_id, null);
  end if;
  return new;
end $$;

drop trigger if exists trg_profile_autogrant_ess on public.profiles;
create trigger trg_profile_autogrant_ess
  after insert or update of employee_id on public.profiles
  for each row execute function app.tg_profile_autogrant_ess();

select app.ensure_employee_self_role(p.user_id, null)
from public.profiles p
where p.employee_id is not null
  and exists (
    select 1
    from public.role_assignments ra
    join public.roles r on r.id = ra.role_id
    where ra.user_id = p.user_id
      and r.key in ('entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head')
  );

commit;
