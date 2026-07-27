-- 0039_email_binding_guard.sql
-- Closes the self-referential part of the login-email guard.
--
-- app.assert_login_email_allowed (0033) compares the requested login address against
-- public.employees.email — but entity_admin holds employee.update over the same employees, so the
-- guard read a value the caller could rewrite: set email -> grant login -> revert. The NULL case
-- skipped the check entirely, which is common because the spreadsheet import leaves email empty.
--
-- Two changes:
--   1. Once a login exists for an employee, only a super admin may change that employee's email.
--      The guard then reads a value scoped admins cannot tamper with.
--   2. grant_app_access BINDS the address: when the employee record has no email, the address used
--      to create the login is written onto the record. The first grant is therefore recorded and
--      every later one must match it.
-- Idempotent: safe to re-run.

create or replace function app.tg_employee_email_guard()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.email is distinct from old.email
     and auth.uid() is not null
     and not app.is_super_admin()
     and old.user_id is not null then
    raise exception 'this employee already has a login; only a super admin may change their email';
  end if;
  return new;
end $$;

drop trigger if exists trg_employee_email_guard on public.employees;
create trigger trg_employee_email_guard
  before update on public.employees
  for each row execute function app.tg_employee_email_guard();

-- Bind the address on first use so it stops being a free choice afterwards.
create or replace function app.bind_login_email(_employee_id uuid, _clean text)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  update public.employees
     set email = _clean
   where id = _employee_id
     and (email is null or btrim(email) = '');
end $$;

-- The guard itself: unchanged comparison, plus the binding when no address is on file.
create or replace function app.assert_login_email_allowed(_employee_id uuid, _clean text)
returns void language plpgsql security definer set search_path = app, public as $$
declare _emp_email text;
begin
  if auth.uid() is null or app.is_super_admin() then return; end if;
  select lower(btrim(email)) into _emp_email from public.employees where id = _employee_id;
  if _emp_email is not null and _emp_email <> '' and _emp_email <> _clean then
    raise exception 'the login email must match the address on the employee record (%)', _emp_email;
  end if;
  -- No address on file: bind this one so it cannot be chosen freely a second time.
  if _emp_email is null or _emp_email = '' then
    perform app.bind_login_email(_employee_id, _clean);
  end if;
end $$;
