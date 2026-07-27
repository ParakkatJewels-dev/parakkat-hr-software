-- 0034_wire_email_guard_and_device_scope.sql
-- 1. Wire the email-squatting guard from 0033 into grant_app_access (it was defined but never
--    called, so a scoped admin could still pre-register an unrelated company address).
-- 2. device.manage is granted at ENTITY scope to entity_admin/hr_manager (0012), but the
--    sync_state / sync_runs / biotime_employees policies pass an all-NULL ancestry, which only a
--    GLOBAL grant can satisfy. Result: the sync-health widgets and the device mapping queue are
--    permanently empty for exactly the admins meant to use them — and worse, a dead sync looks
--    healthy ("0 failed runs"). These are process-wide resources with no ancestry of their own,
--    so the correct test is "holds device.manage at any scope".
-- Idempotent: safe to re-run.

create or replace function app.has_perm_any_scope(_perm text)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.is_super_admin()
      or exists (
        select 1
          from public.role_assignments ra
          join public.role_permissions rp on rp.role_id = ra.role_id
          join public.permissions p on p.id = rp.permission_id
         where ra.user_id = auth.uid() and p.key = _perm
      );
$$;

drop policy if exists sync_state_select on public.sync_state;
create policy sync_state_select on public.sync_state for select to authenticated
  using (app.has_perm_any_scope('device.manage'));

drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs for select to authenticated
  using (app.has_perm_any_scope('device.manage'));

drop policy if exists biotime_employees_select on public.biotime_employees;
create policy biotime_employees_select on public.biotime_employees for select to authenticated
  using (app.has_perm_any_scope('device.manage'));

drop policy if exists biotime_employees_update on public.biotime_employees;
create policy biotime_employees_update on public.biotime_employees for update to authenticated
  using (app.has_perm_any_scope('device.manage'))
  with check (app.has_perm_any_scope('device.manage'));

-- resolve_punch_links (0033) gated on the same all-NULL has_perm; align it.
create or replace function public.resolve_punch_links(_emp_code text)
returns table (punches_linked integer, employee_id uuid, first_date date, last_date date)
language plpgsql security definer set search_path = app, public as $$
declare
  _emp uuid;
  _n   integer := 0;
begin
  if auth.uid() is not null and not app.has_perm_any_scope('device.manage') then
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
-- grant_app_access: same body as 0032, plus the email guard
-- ---------------------------------------------------------------------------
create or replace function public.grant_app_access(
  _employee_id uuid,
  _email       text,
  _password    text,
  _role_key    text,
  _scope_type  public.scope_type,
  _scope_id    uuid
) returns jsonb
language plpgsql security definer set search_path = auth, public, extensions, app as $$
declare
  e             record;
  _clean        text := lower(trim(_email));
  _uid          uuid;
  _created      boolean := false;
  _role_id      uuid;
  _role_added   boolean := false;
  _existing_emp uuid;
  _existing_sa  boolean;
  _privileged   boolean;
begin
  select * into e from public.employees where id = _employee_id;
  if e.id is null then
    raise exception 'employee not found';
  end if;

  _privileged := auth.uid() is null or app.is_super_admin();

  if not _privileged
     and not app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id) then
    raise exception 'you are not allowed to give app access to this employee';
  end if;

  if _clean = '' or position('@' in _clean) = 0 then
    raise exception 'a valid login email is required';
  end if;

  -- Stops a scoped admin claiming an address that is not this employee's.
  perform app.assert_login_email_allowed(_employee_id, _clean);

  select id into _uid from auth.users where lower(email) = _clean;

  if _uid is null then
    if length(coalesce(_password, '')) < 6 then
      raise exception 'password must be at least 6 characters';
    end if;
    _uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', _uid, 'authenticated', 'authenticated',
      _clean, crypt(_password, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      '', '', '', ''
    );

    insert into auth.identities (
      id, provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), _uid, _uid,
      jsonb_build_object('sub', _uid::text, 'email', _clean),
      'email', now(), now(), now()
    );

    _created := true;
  else
    select employee_id, is_super_admin into _existing_emp, _existing_sa
      from public.profiles where user_id = _uid;

    if _existing_emp is not null and _existing_emp <> _employee_id then
      raise exception 'that email already belongs to a different employee''s login';
    end if;
    if coalesce(_existing_sa, false) and not _privileged then
      raise exception 'that email belongs to an administrator account';
    end if;
    if _existing_emp is null and not _privileged then
      raise exception 'a login already exists for that email — ask a super admin to link it';
    end if;
  end if;

  insert into public.profiles (user_id, employee_id)
  values (_uid, _employee_id)
  on conflict (user_id) do update set employee_id = excluded.employee_id;

  update public.employees set user_id = null where user_id = _uid and id <> _employee_id;
  update public.employees set user_id = _uid where id = _employee_id;

  select id into _role_id from public.roles where key = _role_key;
  if _role_id is null then
    raise exception 'unknown role %', _role_key;
  end if;

  if not exists (
    select 1 from public.role_assignments
     where user_id = _uid and role_id = _role_id
       and scope_type = _scope_type and scope_id is not distinct from _scope_id
  ) then
    insert into public.role_assignments (user_id, role_id, scope_type, scope_id, granted_by)
    values (_uid, _role_id, _scope_type, _scope_id, auth.uid());
    _role_added := true;
  end if;

  return jsonb_build_object(
    'user_id', _uid,
    'created', _created,
    'role_added', _role_added,
    'email', _clean
  );
end $$;

grant execute on function public.grant_app_access(uuid, text, text, text, public.scope_type, uuid)
  to authenticated;
