-- 0112 — Saving an employee gives them a login.
--
-- HR fills in the employee, and the login should follow from it rather than being a second job
-- somebody has to remember. The convention is the company's:
--
--   email     {first}.{last}@parakkatjewels.com
--   password  {First}{last four digits of their phone}
--
-- DERIVED HERE, NOT IN THE BROWSER
-- The Directory form is not the only way an employee arrives — there is a bulk import, and there
-- will be more. A rule written in the client is a rule the import does not have, so this is one
-- function both call, and the convention has one definition.
--
-- The password IS RETURNED, deliberately. HR has to read it out to the person, and a password
-- nobody can see is a login nobody can use. It is a handover credential with a life measured in
-- one sign-in: 0111 flags the account and the app refuses to go anywhere until it is replaced.
--
-- Idempotent: safe to re-run, and safe to call twice for the same employee — the second call
-- reports the existing login rather than resetting anybody's password.

begin;

/*
 * Strip a name down to something that can sit left of an @.
 *
 * unaccent would be the tidier answer but the extension is not guaranteed here, so this maps the
 * Latin-1 letters that actually turn up in transliterated Malayalam names and drops anything else.
 */
create or replace function app.slug_name(_s text)
returns text language sql immutable as $$
  select regexp_replace(
           lower(translate(coalesce(_s, ''),
             'ÁÀÂÄÃÅáàâäãåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
             'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc')),
           '[^a-z0-9]+', '', 'g');
$$;

/*
 * The login email for an employee.
 *
 * first.last@parakkatjewels.com, and where two people share a name — which they will, at this
 * headcount — the employee code joins the local part rather than a bare number, so the address
 * still says who it belongs to. 0030 already refuses to hand one person's login to another, so a
 * collision that slipped through would fail loudly; this is what stops it arising.
 */
create or replace function app.derive_login_email(_employee_id uuid)
returns text language plpgsql stable security definer set search_path = app, public as $$
declare
  e         record;
  _first    text;
  _last     text;
  _base     text;
  _taken_by uuid;
begin
  select id, full_name, employee_code into e from public.employees where id = _employee_id;
  if e.id is null then
    raise exception 'employee not found';
  end if;

  _first := app.slug_name(split_part(btrim(e.full_name), ' ', 1));
  _last  := app.slug_name(
              nullif(split_part(btrim(e.full_name), ' ',
                array_length(regexp_split_to_array(btrim(e.full_name), '\s+'), 1)), ''));

  if _first = '' then
    -- No usable name at all. The code is always there and always unique.
    _first := app.slug_name(e.employee_code);
  end if;
  if _first = '' then
    raise exception 'this employee has neither a usable name nor a code to build a login from';
  end if;

  _base := case when _last is null or _last = '' or _last = _first
                then _first else _first || '.' || _last end;

  -- Is the plain form already somebody else's?
  select p.employee_id into _taken_by
    from auth.users u
    join public.profiles p on p.user_id = u.id
   where lower(u.email) = _base || '@parakkatjewels.com';

  if _taken_by is null or _taken_by = _employee_id then
    return _base || '@parakkatjewels.com';
  end if;

  return _base || '.' || app.slug_name(e.employee_code) || '@parakkatjewels.com';
end $$;

/*
 * The handover password: {First}{last four digits of the phone}.
 *
 * No phone on the record falls back to the last four of the employee code, which is always
 * present. Both are short and guessable, and both are meant to be — 0111 is what makes that
 * acceptable, by refusing to let the account go anywhere until the password is replaced.
 *
 * Padded to eight characters when a short name and a short code would otherwise produce something
 * GoTrue's own minimum rejects, which would fail the whole save for an employee whose only sin is
 * a three-letter name.
 */
create or replace function app.derive_login_password(_employee_id uuid)
returns text language plpgsql stable security definer set search_path = app, public as $$
declare
  e       record;
  _name   text;
  _digits text;
  _out    text;
begin
  select full_name, phone, employee_code into e from public.employees where id = _employee_id;

  _name := app.slug_name(split_part(btrim(coalesce(e.full_name, '')), ' ', 1));
  if _name = '' then _name := 'parakkat'; end if;
  _name := upper(left(_name, 1)) || substr(_name, 2);

  _digits := right(regexp_replace(coalesce(e.phone, ''), '[^0-9]', '', 'g'), 4);
  if length(_digits) < 4 then
    _digits := right(regexp_replace(coalesce(e.employee_code, ''), '[^0-9]', '', 'g'), 4);
  end if;
  if length(_digits) < 4 then
    _digits := lpad(coalesce(_digits, ''), 4, '0');
  end if;

  _out := _name || _digits;
  -- Pad ONLY when short. rpad also truncates, which turned Ramesh4821 into Ramesh48 and quietly
  -- broke the convention this function exists to implement — HR would read out one password and
  -- the account would have another.
  return case when length(_out) < 8 then rpad(_out, 8, '0') else _out end;
end $$;

/*
 * Give a saved employee their login, deriving both halves.
 *
 * Returns what HR needs to read out, plus whether it created anything — calling this for somebody
 * who already has a login reports the address and says so, rather than resetting a password
 * they have since chosen for themselves.
 *
 * The role defaults to employee@self: everyone gets their own workspace, and anything beyond that
 * is a deliberate act in Users & Access. Authorisation is grant_app_access's, unchanged — it
 * refuses an employee outside the caller's scope.
 */
create or replace function public.provision_employee_login(
  _employee_id uuid,
  _role_key    text default 'employee'
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare
  _email    text;
  _password text;
  _existing uuid;
  _result   jsonb;
begin
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
    _employee_id, _email, _password,
    _role_key,
    case when _role_key = 'employee' then 'self'::public.scope_type else 'entity'::public.scope_type end,
    case when _role_key = 'employee' then null
         else (select entity_id from public.employees where id = _employee_id) end
  );

  return jsonb_build_object(
    'created', true,
    'email', _email,
    'password', _password,
    'grant', _result,
    'note', 'Read these out once. They will be asked to choose their own password when they sign in.'
  );
end $$;

revoke all on function public.provision_employee_login(uuid, text) from public, anon;
grant execute on function public.provision_employee_login(uuid, text) to authenticated;

commit;
