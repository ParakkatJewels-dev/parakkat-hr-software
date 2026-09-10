-- User creation and employee linking must either both succeed or neither happen.
-- Also prevent relinking a senior account or stealing an employee's existing login.
begin;

create or replace function public.link_user_to_employee(_user uuid, _employee uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  e record;
  c record;
  cur_emp uuid;
  target_sa boolean;
  privileged boolean;
begin
  privileged := auth.uid() is null or app.is_super_admin();
  select employee_id, is_super_admin into cur_emp, target_sa
    from public.profiles where user_id = _user for update;
  if not found then raise exception 'login not found'; end if;

  if not privileged then
    if coalesce(target_sa, false) or not app.can_admin_user(_user) then
      raise exception 'this login belongs to someone at or above your own level';
    end if;
    if cur_emp is null then
      raise exception 'that login is not linked to anyone — ask a super admin to link it';
    end if;
    if _employee is null then raise exception 'only a super admin may unlink a login'; end if;
    select * into c from public.employees where id = cur_emp;
    if c.id is null or not app.has_perm('rbac.manage', c.entity_id, c.zone_id, c.branch_id, c.department_id, c.id) then
      raise exception 'that login belongs to someone outside your scope';
    end if;
  end if;

  -- Serialize competing links, including two admins picking the same employee at once.
  perform id from public.employees where id in (cur_emp, _employee) order by id for update;
  if _employee is not null then
    select * into e from public.employees where id = _employee;
    if not found then raise exception 'employee not found'; end if;
    if not (privileged or app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id)) then
      raise exception 'not authorized to link this employee';
    end if;
    if (e.user_id is not null and e.user_id <> _user)
       or exists (select 1 from public.profiles where employee_id = _employee and user_id <> _user) then
      raise exception 'this employee already has a login — manage that login instead';
    end if;
  end if;

  update public.profiles set employee_id = _employee where user_id = _user;
  update public.employees set user_id = null where user_id = _user and id is distinct from _employee;
  if _employee is not null then
    update public.employees set user_id = _user where id = _employee;
  end if;
end $$;

create or replace function public.admin_create_user_with_employee(
  _email text, _password text, _employee uuid default null, _super_admin boolean default false
) returns uuid language plpgsql security definer set search_path = app, public as $$
declare _uid uuid;
begin
  if not app.is_super_admin() then raise exception 'only a super admin may create users'; end if;
  if coalesce(trim(_email), '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'a valid email is required';
  end if;
  if length(coalesce(_password, '')) < 8 then raise exception 'password must be at least 8 characters'; end if;
  _uid := public.admin_create_user(_email, _password);
  if _employee is not null then perform public.link_user_to_employee(_uid, _employee); end if;
  if coalesce(_super_admin, false) then perform public.set_super_admin(_uid, true); end if;
  -- 0111 also sets this for provisioned users; keep the transactional contract explicit.
  update public.profiles set must_change_password = true where user_id = _uid;
  return _uid;
end $$;

-- RPC-only guards miss direct role revocation and concurrent demotions. Protect the invariant
-- at the tables, counting BOTH profile flags and global super_admin role grants.
create or replace function app.tg_prevent_admin_lockout()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  omit_profile uuid;
  omit_user uuid;
  omit_assignment uuid;
begin
  if tg_table_name = 'profiles' then
    if tg_op = 'UPDATE' then
      if not old.is_super_admin or new.is_super_admin then return new; end if;
    elsif not old.is_super_admin and not exists (
      select 1 from public.role_assignments ra join public.roles r on r.id = ra.role_id
       where ra.user_id = old.user_id and r.key = 'super_admin' and ra.scope_type = 'global'
    ) then return old;
    end if;
    omit_profile := old.user_id;
    if tg_op = 'DELETE' then omit_user := old.user_id; end if;
  else
    if old.scope_type <> 'global' or not exists (
      select 1 from public.roles where id = old.role_id and key = 'super_admin'
    ) then
      if tg_op = 'DELETE' then return old; else return new; end if;
    end if;
    if tg_op = 'UPDATE' then
      if new.user_id = old.user_id and new.role_id = old.role_id and new.scope_type = 'global' then return new; end if;
    end if;
    omit_assignment := old.id;
  end if;

  -- All ways of removing admin authority serialize on the same transaction lock.
  perform pg_advisory_xact_lock(120, 1);
  if not exists (
    select 1 from public.profiles p
     where p.user_id is distinct from omit_user
       and ((p.is_super_admin and p.user_id is distinct from omit_profile) or exists (
         select 1 from public.role_assignments ra join public.roles r on r.id = ra.role_id
          where ra.user_id = p.user_id and ra.id is distinct from omit_assignment
            and r.key = 'super_admin' and ra.scope_type = 'global'
       ))
  ) then raise exception 'cannot remove the last super admin — promote another user first'; end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

drop trigger if exists protect_last_admin_profile on public.profiles;
create trigger protect_last_admin_profile before update of is_super_admin or delete on public.profiles
  for each row execute function app.tg_prevent_admin_lockout();
drop trigger if exists protect_last_admin_assignment on public.role_assignments;
create trigger protect_last_admin_assignment before update of role_id, user_id, scope_type or delete on public.role_assignments
  for each row execute function app.tg_prevent_admin_lockout();
revoke all on function app.tg_prevent_admin_lockout() from public, anon, authenticated;

revoke all on function public.link_user_to_employee(uuid, uuid) from public, anon;
grant execute on function public.link_user_to_employee(uuid, uuid) to authenticated, service_role;
revoke all on function public.admin_create_user_with_employee(text, text, uuid, boolean) from public, anon;
grant execute on function public.admin_create_user_with_employee(text, text, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
