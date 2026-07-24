-- 0018_admin_create_user.sql
-- Let a super admin create logins directly from the app (email + password they choose) instead of
-- going through the invite-user Edge Function or the CLI script. Creating an auth user needs elevated
-- rights, so this is a SECURITY DEFINER function (runs as its owner) locked to super admins. The
-- on_auth_user_created trigger (0003) still fires, so the new login gets its profile automatically.
-- No email is sent — the account is confirmed on creation and can sign in immediately.
-- Idempotent: safe to re-run.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.admin_create_user(_email text, _password text)
returns uuid
language plpgsql security definer set search_path = auth, public, extensions as $$
declare
  _uid   uuid := gen_random_uuid();
  _clean text := lower(trim(_email));
begin
  if not app.is_super_admin() then
    raise exception 'only a super admin may create users';
  end if;
  if _clean = '' or position('@' in _clean) = 0 then
    raise exception 'a valid email is required';
  end if;
  if length(coalesce(_password, '')) < 6 then
    raise exception 'password must be at least 6 characters';
  end if;
  if exists (select 1 from auth.users where lower(email) = _clean) then
    raise exception 'a user with this email already exists';
  end if;

  -- Create the login. Empty-string token columns (not null) avoid GoTrue's null-scan sign-in bug.
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

  -- Matching email identity (required for email/password sign-in).
  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), _uid, _uid,
    jsonb_build_object('sub', _uid::text, 'email', _clean),
    'email', now(), now(), now()
  );

  return _uid;
end $$;

grant execute on function public.admin_create_user(text, text) to authenticated;
