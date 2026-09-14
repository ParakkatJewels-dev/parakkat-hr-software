-- An administrator can hand over a temporary password without knowing the old password or
-- depending on email delivery. Keep this operation inside the existing scoped RBAC boundary.
-- Like admin_create_user, this uses the project's pgcrypto/Supabase Auth SQL integration.
begin;

-- Mirror web/src/lib/passwordRules.js for a password supplied by an administrator. Validation
-- lives on the server as well as in the form: calling the RPC directly must not weaken it.
create or replace function app.password_problem(_password text, _name text, _email text)
returns text language plpgsql immutable set search_path = pg_catalog as $$
declare _normalized text;
begin
  if length(coalesce(_password, '')) < 8 then return 'password must be at least 8 characters'; end if;
  -- bcrypt only accepts 72 bytes; pgcrypto silently truncates longer input.
  if octet_length(_password) > 72 then return 'password must be at most 72 UTF-8 bytes'; end if;
  _normalized := regexp_replace(lower(_password), '[^a-z0-9]', '', 'g');
  if exists (
    select 1 from (
      select regexp_replace(lower(part), '[^a-z0-9]', '', 'g') as part
        from (
          select coalesce(_name, '') as part
          union all select regexp_split_to_table(coalesce(_name, ''), '\s+')
          union all select split_part(coalesce(_email, ''), '@', 1)
        ) words
    ) normalized where length(part) >= 3 and position(part in _normalized) > 0
  ) then return 'password must not contain the person''s name or email name'; end if;
  if _password ~ '^[0-9]*$' then return 'password must not contain only numbers'; end if;
  return null;
end $$;
revoke all on function app.password_problem(text, text, text) from public, anon, authenticated;

-- A password set by another authenticated administrator is temporary. The existing trigger
-- must not clear the gate during that reset. GoTrue self-service updates use its Auth database
-- connection (no PostgREST JWT), and keep the existing automatic clearing behavior.
create or replace function app.tg_clear_must_change_password()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and (auth.uid() is null or auth.uid() = new.id) then
    update public.profiles set must_change_password = false
     where user_id = new.id and must_change_password;
  end if;
  return new;
end $$;
revoke all on function app.tg_clear_must_change_password() from public, anon, authenticated;

create or replace function public.admin_set_user_password(_user_id uuid, _password text)
returns void language plpgsql security definer set search_path = pg_catalog, extensions as $$
declare
  _actor uuid := auth.uid();
  _login auth.users%rowtype;
  _profile public.profiles%rowtype;
  _employee public.employees%rowtype;
  _problem text;
begin
  -- No anonymous/service-without-a-user shortcut for password administration.
  if _actor is null or not exists (select 1 from public.profiles where user_id = _actor) then
    raise exception using errcode = '42501', message = 'sign in to reset a password';
  end if;
  if _user_id is null then
    raise exception using errcode = '22023', message = 'a user is required';
  end if;
  if _user_id = _actor then
    raise exception using errcode = '42501', message = 'change your own password from account settings';
  end if;
  select * into _login from auth.users where id = _user_id for update;
  select * into _profile from public.profiles where user_id = _user_id for update;
  if _login.id is null or _profile.user_id is null then
    raise exception using errcode = '22023', message = 'login not found';
  end if;
  select * into _employee from public.employees where id = _profile.employee_id for share;
  if not app.is_super_admin() then
    if not app.can_admin_user(_user_id) then
      raise exception using errcode = '42501', message = 'this login belongs to someone at or above your own level';
    end if;
    if _employee.id is null then
      raise exception using errcode = '42501', message = 'only a super admin may reset a login that is not linked to an employee';
    end if;
    if not app.has_perm('rbac.manage', _employee.entity_id, _employee.zone_id,
                       _employee.branch_id, _employee.department_id, _employee.id) then
      raise exception using errcode = '42501', message = 'you are not allowed to reset this login outside your scope';
    end if;
  end if;
  if coalesce(_login.email, '') = '' or not exists (
    select 1 from auth.identities where user_id = _user_id and provider = 'email'
  ) then
    raise exception using errcode = '22023', message = 'this account does not have an email login';
  end if;
  _problem := app.password_problem(_password, _employee.full_name, _login.email);
  if _problem is not null then raise exception using errcode = '22023', message = _problem; end if;

  -- Cost 10 matches GoTrue's bcrypt default, avoiding a sign-in-time rehash. Clear pending
  -- authentication tokens just as GoTrue's User.UpdatePassword does; never change the email,
  -- identity providers, MFA factors, roles, employee link, confirmation or banned status.
  update auth.users set
    encrypted_password = extensions.crypt(_password, extensions.gen_salt('bf', 10)),
    updated_at = now(),
    confirmation_token = '', confirmation_sent_at = null,
    recovery_token = '', recovery_sent_at = null,
    email_change_token_current = '', email_change_token_new = '', email_change_sent_at = null,
    phone_change_token = '', phone_change_sent_at = null,
    reauthentication_token = '', reauthentication_sent_at = null
  where id = _user_id;
  update public.profiles set must_change_password = true where user_id = _user_id;
  delete from auth.one_time_tokens where user_id = _user_id;
  -- refresh_tokens.user_id is text in Supabase Auth. Delete legacy tokens without a session too.
  delete from auth.refresh_tokens where user_id = _user_id::text;
  delete from auth.sessions where user_id = _user_id;

  -- Only actor, target and scope enter the audit trail. Never store plaintext or password hashes.
  insert into public.audit_log(actor, actor_email, action, table_name, row_id, entity_id, branch_id)
    select _actor, email, 'PASSWORD_RESET', 'profiles', _user_id, _employee.entity_id, _employee.branch_id
      from auth.users where id = _actor;
end $$;
revoke all on function public.admin_set_user_password(uuid, text) from public, anon, service_role;
grant execute on function public.admin_set_user_password(uuid, text) to authenticated;

comment on function public.admin_set_user_password(uuid, text) is
  'Set another managed email login''s temporary password, require replacement, revoke sessions and audit the reset. No email is sent. Existing access JWTs expire normally.';
comment on column public.profiles.must_change_password is
  'The login has a provisioned or administrator-set temporary password. Cleared automatically when the user changes their password through Auth.';

notify pgrst, 'reload schema';
commit;
