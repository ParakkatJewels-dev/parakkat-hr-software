-- 0009_admin_rpcs.sql
-- RPCs for the User & Role Management screen. Role assignment/revocation happens directly against
-- role_assignments (RLS + the escalation guard protect it). These two functions cover what the
-- browser CANNOT do directly: read auth.users emails, and atomically link a login to an employee.

-- List users the caller is allowed to manage, with their linked employee and scoped roles.
-- Super admin sees everyone; an rbac.manage holder sees users whose employee falls in their scope.
create or replace function public.list_managed_users()
returns jsonb language sql stable security definer set search_path = app, public as $$
  select coalesce(jsonb_agg(u order by u.email), '[]'::jsonb)
  from (
    select
      p.user_id,
      au.email,
      p.is_super_admin,
      p.employee_id,
      e.full_name  as employee_name,
      e.employee_code,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'assignment_id', ra.id,
          'role_key',      r.key,
          'scope_type',    ra.scope_type,
          'scope_id',      ra.scope_id))
        from public.role_assignments ra
        join public.roles r on r.id = ra.role_id
        where ra.user_id = p.user_id
      ), '[]'::jsonb) as roles
    from public.profiles p
    join auth.users au on au.id = p.user_id
    left join public.employees e on e.id = p.employee_id
    where app.is_super_admin()
       or (e.id is not null and app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id))
  ) u;
$$;

-- Link (or unlink, when _employee is null) a login to an employee record, keeping both sides in sync.
create or replace function public.link_user_to_employee(_user uuid, _employee uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare e record;
begin
  if _employee is not null then
    select * into e from public.employees where id = _employee;
    if e.id is null then raise exception 'employee not found'; end if;
    if not (app.is_super_admin()
            or app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id)) then
      raise exception 'not authorized to link this employee';
    end if;
  elsif not app.is_super_admin() then
    raise exception 'not authorized';
  end if;

  update public.profiles set employee_id = _employee where user_id = _user;
  -- release any employee previously tied to this login, then tie the chosen one
  update public.employees set user_id = null where user_id = _user and id is distinct from _employee;
  if _employee is not null then
    update public.employees set user_id = _user where id = _employee;
  end if;
end $$;

grant execute on function public.list_managed_users() to authenticated;
grant execute on function public.link_user_to_employee(uuid, uuid) to authenticated;
