-- 0111 — A default password is a temporary one.
--
-- Logins are provisioned in bulk from the employee record, so the first password is derived from
-- data the person's colleagues already know. That is an acceptable way to HAND OVER an account and
-- an unacceptable way to keep one: this app holds payslips, bank accounts, IFSC, PAN, Aadhaar and
-- UAN, and a password anybody in the office can compute reopens all of it far wider than the
-- payslip grant 0100 closed.
--
-- So the derived password gets somebody in once, and the app makes them replace it before they can
-- reach anything.
--
-- WHY A TRIGGER ON THE PASSWORD, AND NOT AN RPC THE CLIENT CALLS
-- The obvious shape is "client changes the password, then calls clear_must_change()". That flag is
-- then only as reliable as the client remembering to call it — a failed second request, a closed
-- tab, or simply a different client leaves somebody who HAS changed their password still being
-- asked to. Worse, the RPC is callable on its own, so the flag can be cleared without changing
-- anything. Watching auth.users.encrypted_password instead means the fact and the record of it
-- cannot disagree: the flag clears because the password actually changed, whoever changed it and
-- through whatever route.
--
-- Idempotent: safe to re-run.

begin;

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

comment on column public.profiles.must_change_password is
  'The password is still the provisioned default. Cleared by a trigger when auth.users.encrypted_password actually changes — never by the client.';

-- Everyone who already has a login chose their own password, or was given one before this rule
-- existed. Flagging them retrospectively would lock the whole company out of their own app on the
-- next deploy to prove a point about accounts that are already in use.
-- New logins are flagged at creation, below.

create or replace function app.tg_clear_must_change_password()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.profiles
       set must_change_password = false
     where user_id = new.id
       and must_change_password;
  end if;
  return new;
end $$;

drop trigger if exists clear_must_change_password on auth.users;
create trigger clear_must_change_password
  after update of encrypted_password on auth.users
  for each row execute function app.tg_clear_must_change_password();

-- Tell the client, with the rest of the access payload, so the gate needs no extra round trip and
-- refreshes through the subscription AuthContext already holds on profiles.
create or replace function public.get_my_access()
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'is_super_admin', app.is_super_admin(),
    'rank', app.max_role_rank(),
    'must_change_password', coalesce(
      (select p.must_change_password from public.profiles p where p.user_id = auth.uid()), false),
    'employee', (
      select to_jsonb(e) from (
        select emp.id, emp.full_name, emp.email, emp.employee_code, emp.status,
               emp.entity_id, emp.zone_id, emp.branch_id, emp.department_id, emp.designation_id
        from public.profiles p
        join public.employees emp on emp.id = p.employee_id
        where p.user_id = auth.uid()
      ) e
    ),
    'assignments', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
        'role', r.key, 'scope_type', ra.scope_type, 'scope_id', ra.scope_id))
      from public.role_assignments ra
      join public.roles r on r.id = ra.role_id
      where ra.user_id = auth.uid()
    ), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
        'permission', p.key, 'scope_type', ra.scope_type, 'scope_id', ra.scope_id))
      from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
      where ra.user_id = auth.uid()
    ), '[]'::jsonb),
    'hidden_screens', case
      when app.is_super_admin() then '[]'::jsonb
      else coalesce((
        select jsonb_agg(o.screen_id order by o.screen_id)
        from public.user_screen_overrides o
        where o.user_id = auth.uid()
      ), '[]'::jsonb)
    end
  ) into result;
  return result;
end $$;

-- Flag the login provisioning creates.
--
-- On the INSERT rather than inside grant_app_access, so it holds for admin_create_user and the SQL
-- editor too — every route that mints a login with a password already set, not just the one screen.
-- It fires alongside 0003's on_auth_user_created, which inserts the same profile row with ON
-- CONFLICT DO NOTHING, so neither clobbers the other whichever order they run in.
--
-- A login grant_app_access REUSES is left alone. That person already chose a password of their
-- own, and re-running provisioning to add them a second role must not demand they change it again.
create or replace function app.tg_flag_provisioned_login()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  -- Only a brand-new auth user, and only one created with a password already set — a login made
  -- through an invite or a magic link has no derived password to replace.
  if new.encrypted_password is not null and new.encrypted_password <> '' then
    insert into public.profiles (user_id, must_change_password)
    values (new.id, true)
    on conflict (user_id) do update set must_change_password = true;
  end if;
  return new;
end $$;

drop trigger if exists flag_provisioned_login on auth.users;
create trigger flag_provisioned_login
  after insert on auth.users
  for each row execute function app.tg_flag_provisioned_login();

commit;
