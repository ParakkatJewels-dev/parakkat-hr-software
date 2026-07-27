-- 0030_grant_app_access.sql
-- One atomic "give app access" operation, replacing the four separate client-side calls
-- (admin_create_user -> link_user_to_employee -> role_assignments insert -> ESS grant).
--
-- Why: the client-side sequence is not a transaction. If the role insert failed after the login
-- was created, the operator was left with a login that has no employee and no role — it can sign
-- in and see nothing — and retrying failed with "a user with this email already exists", a dead
-- end with no path out. The live database already contains three such orphans.
--
-- This function does the whole thing in ONE transaction: either the person ends up with a login,
-- a link and a role, or nothing changed at all. It is also idempotent: run it again for the same
-- employee and it reuses the existing login and skips a role they already hold.
--
-- Authorization is unchanged in spirit but correctly scoped: a super admin may do anything; an
-- rbac.manage holder (entity admins) may do it for employees inside their own scope. Role/scope
-- escalation is still blocked by app.can_grant + the role_assignments guard trigger.
-- Idempotent: safe to re-run.

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
begin
  -- ---- the employee -------------------------------------------------------
  select * into e from public.employees where id = _employee_id;
  if e.id is null then
    raise exception 'employee not found';
  end if;

  -- ---- may the caller do this for THIS employee? --------------------------
  -- Trusted server-side contexts (service_role, SQL editor, seed scripts) have no JWT, so
  -- auth.uid() is null; they already bypass RLS entirely, so gate only real user sessions.
  -- Same convention as app.tg_role_assignment_guard (0019).
  if auth.uid() is not null
     and not (app.is_super_admin()
              or app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id)) then
    raise exception 'you are not allowed to give app access to this employee';
  end if;

  if _clean = '' or position('@' in _clean) = 0 then
    raise exception 'a valid login email is required';
  end if;

  -- ---- find or create the login -------------------------------------------
  select id into _uid from auth.users where lower(email) = _clean;

  if _uid is null then
    if length(coalesce(_password, '')) < 6 then
      raise exception 'password must be at least 6 characters';
    end if;
    _uid := gen_random_uuid();

    -- Empty-string token columns (not null) avoid GoTrue's null-scan sign-in bug.
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
    -- Reusing an existing login is how the orphans get rescued — but never silently steal a
    -- login that already belongs to somebody else.
    select employee_id into _existing_emp from public.profiles where user_id = _uid;
    if _existing_emp is not null and _existing_emp <> _employee_id then
      raise exception 'that email already belongs to a different employee''s login';
    end if;
  end if;

  -- The on_auth_user_created trigger creates the profile row; make sure one exists either way.
  insert into public.profiles (user_id, employee_id)
  values (_uid, _employee_id)
  on conflict (user_id) do update set employee_id = excluded.employee_id;

  -- Keep both sides of the link consistent, releasing any previous pairing.
  update public.employees set user_id = null where user_id = _uid and id <> _employee_id;
  update public.employees set user_id = _uid where id = _employee_id;

  -- ---- the role ------------------------------------------------------------
  select id into _role_id from public.roles where key = _role_key;
  if _role_id is null then
    raise exception 'unknown role %', _role_key;
  end if;

  -- app.can_grant (and the guard trigger on insert) enforce role<->scope rules and block
  -- escalation, so no extra check is needed here.
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
