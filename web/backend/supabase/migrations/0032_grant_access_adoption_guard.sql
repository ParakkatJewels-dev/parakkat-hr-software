-- 0032_grant_access_adoption_guard.sql
-- SECURITY FIX for grant_app_access (0030).
--
-- The "reuse an existing login instead of failing on a duplicate email" path — added so the
-- orphaned logins from the old flow could be rescued — checked only that the login was not
-- already tied to a DIFFERENT employee. An UNLINKED login therefore looked adoptable to anyone.
--
-- Exploit (verified against a real entity-admin session before this fix): an entity admin passes
-- a super admin's email plus an employee inside their own scope. The super admin's login is
-- unlinked, so the check passed, the login was re-pointed at the attacker's chosen employee and
-- given a role. app.current_employee_id() reads profiles.employee_id, so this silently changes
-- whose records the victim's account resolves to as "self" — an admin outside the attacker's
-- scope having their account rewritten from inside it.
--
-- Adoption is now allowed only when it cannot cross a privilege boundary:
--   * the login already belongs to this same employee (a plain re-grant), or
--   * the caller is a super admin (the orphan-rescue case the feature exists for).
-- A super admin's login is never adoptable by a non-super-admin under any circumstance.
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
  _existing_sa  boolean;
  _privileged   boolean;
begin
  -- ---- the employee -------------------------------------------------------
  select * into e from public.employees where id = _employee_id;
  if e.id is null then
    raise exception 'employee not found';
  end if;

  -- Trusted server-side contexts (service_role, SQL editor, seed scripts) have no JWT and
  -- already bypass RLS, so they are treated as privileged. Same convention as 0019's guard.
  _privileged := auth.uid() is null or app.is_super_admin();

  -- ---- may the caller do this for THIS employee? --------------------------
  if not _privileged
     and not app.has_perm('rbac.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id) then
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
    select employee_id, is_super_admin into _existing_emp, _existing_sa
      from public.profiles where user_id = _uid;

    -- Never silently steal a login that already belongs to somebody else.
    if _existing_emp is not null and _existing_emp <> _employee_id then
      raise exception 'that email already belongs to a different employee''s login';
    end if;

    -- A super admin's account may only be touched by another super admin.
    if coalesce(_existing_sa, false) and not _privileged then
      raise exception 'that email belongs to an administrator account';
    end if;

    -- Adopting an UNLINKED login is the orphan-rescue path and is super-admin only; otherwise a
    -- scoped admin could re-point any existing account at an employee they control.
    if _existing_emp is null and not _privileged then
      raise exception 'a login already exists for that email — ask a super admin to link it';
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
