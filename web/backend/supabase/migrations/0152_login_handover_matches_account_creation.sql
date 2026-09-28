-- Linking an existing unlinked login does not install a newly derived password.
-- Report what grant_app_access actually did so HR never hands over an unusable credential.
-- Existing passwords, scope checks and account-reset policy remain unchanged.
begin;

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
    'created', coalesce((_result->>'created')::boolean, false),
    'email', _result->>'email',
    'password', case when (_result->>'created')::boolean then _password else null end,
    'grant', _result,
    'note', case when (_result->>'created')::boolean
      then 'Read these out once. They will be asked to choose their own password when they sign in.'
      else 'The existing login was linked. Their password is unchanged; use account password management if a reset is needed.' end
  );
end $$;

commit;
