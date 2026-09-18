-- Administration belongs to Super Admin, Entity Admin and HR Manager among the standard roles.
-- 0044 delegated rbac.manage to every manager, which also exposed Users & Access and Roles.
-- Remove that account/role authority at its source so direct RPCs and RLS agree with navigation.
-- Keep operational employee permissions and explicitly configured custom roles unchanged.
begin;

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key in ('zonal_manager', 'branch_manager', 'dept_head', 'employee')
  and p.key = 'rbac.manage';

-- Check authority before the existing-login shortcut as well as before creating a login.
-- Otherwise a removed manager could still call this RPC to discover an employee's login email.
create or replace function public.provision_employee_login(
  _employee_id uuid,
  _role_key text default 'employee'
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare
  _employee public.employees%rowtype;
  _email text;
  _password text;
  _existing uuid;
  _result jsonb;
begin
  if auth.uid() is not null and not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select * into _employee from public.employees where id = _employee_id;
  if not found then raise exception 'employee not found'; end if;
  if auth.uid() is not null and not app.has_perm('rbac.manage', _employee.entity_id,
      _employee.zone_id, _employee.branch_id, _employee.department_id, _employee.id) then
    raise exception 'you are not allowed to give app access to this employee' using errcode='42501';
  end if;

  select u.id into _existing
    from public.profiles p join auth.users u on u.id = p.user_id
   where p.employee_id = _employee_id;

  _email := app.derive_login_email(_employee_id);
  if _existing is not null then
    return jsonb_build_object(
      'created', false,
      'email', (select email from auth.users where id = _existing),
      'password', null,
      'note', 'This employee already has a login. Their password is unchanged.'
    );
  end if;

  _password := app.derive_login_password(_employee_id);
  _result := public.grant_app_access(
    _employee_id, _email, _password, _role_key,
    case when _role_key = 'employee' then 'self'::public.scope_type else 'entity'::public.scope_type end,
    case when _role_key = 'employee' then null else _employee.entity_id end
  );
  return jsonb_build_object(
    'created', true,
    'email', _email,
    'password', _password,
    'grant', _result,
    'note', 'Read these out once. They will be asked to choose their own password when they sign in.'
  );
end $$;

commit;
