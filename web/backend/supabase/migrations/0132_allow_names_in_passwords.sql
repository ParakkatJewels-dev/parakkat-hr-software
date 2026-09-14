-- Names, usernames and email addresses may be used in passwords. Keep the existing function
-- signature for callers, while enforcing the remaining length, byte-limit and numeric rules.
begin;

create or replace function app.password_problem(_password text, _name text, _email text)
returns text language plpgsql immutable set search_path = pg_catalog as $$
begin
  if length(coalesce(_password, '')) < 8 then return 'password must be at least 8 characters'; end if;
  if octet_length(_password) > 72 then return 'password must be at most 72 UTF-8 bytes'; end if;
  if _password ~ '^[0-9]*$' then return 'password must not contain only numbers'; end if;
  return null;
end $$;
revoke all on function app.password_problem(text, text, text) from public, anon, authenticated;

comment on function app.password_problem(text, text, text) is
  'Validate password length, bcrypt byte limit and non-numeric content. Name/email arguments are retained for caller compatibility and impose no restrictions.';

notify pgrst, 'reload schema';
commit;
