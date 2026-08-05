-- 0079 — Name the person who handed the asset over, and the one who took it back.
--
-- 0076 already records WHO acted: assigned_by and returned_by hold auth.users ids. Nothing could
-- read them. PostgREST does not expose the `auth` schema, so `assigned_by:users(email)` is not an
-- embed the client can ask for, and there is no foreign key from asset_assignments to anything in
-- `public` that would carry a name. The custody trail said when and to whom, never by whom.
--
-- WHY THE NAME IS STORED, NOT LOOKED UP
-- Denormalising a name is usually a mistake. Here it is the point: this is a log. "Allocated by
-- Anitha on 4 April" must keep saying that after Anitha marries, changes her display name, leaves
-- the company, or has her auth user deleted — at which point the id is nulled by ON DELETE SET NULL
-- and a live join would render the row anonymous. The name is frozen at the moment of the act,
-- which is what a custody record is for.
--
-- Resolved by trigger rather than sent by the client, because a client-supplied "who did this" is
-- worth nothing: anyone can type any name into an insert. security definer so it can read
-- auth.users for the email fallback.

begin;

alter table public.asset_assignments
  add column if not exists assigned_by_name text,
  add column if not exists returned_by_name text;

comment on column public.asset_assignments.assigned_by_name is
  'Who handed it over, as they were named at the time. Frozen on purpose — see 0079. Written by '
  'app.tg_asset_assignment_actor; never accept this from a client.';

-- The best name available for a user: their employee record, then their login, then nothing.
create or replace function app.actor_name(_uid uuid)
returns text language plpgsql stable security definer set search_path = app, public as $$
declare _name text;
begin
  if _uid is null then return null; end if;

  select e.full_name into _name
    from public.profiles p
    join public.employees e on e.id = p.employee_id
   where p.user_id = _uid;

  if _name is not null and length(btrim(_name)) > 0 then return _name; end if;

  select u.email into _name from auth.users u where u.id = _uid;
  return _name;
end $$;

comment on function app.actor_name(uuid) is
  'Employee full name for a login, falling back to the email address. Used to stamp custody rows '
  'at write time so the record survives the person being renamed or removed.';

-- Stamps whichever half of the row is being written. On insert that is the handover; on the update
-- that closes it, the return. Each is written once and then left alone.
create or replace function app.tg_asset_assignment_actor()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'INSERT' then
    new.assigned_by := coalesce(new.assigned_by, auth.uid());
    new.assigned_by_name := app.actor_name(new.assigned_by);
  elsif tg_op = 'UPDATE' and new.returned_at is not null and old.returned_at is null then
    new.returned_by := coalesce(new.returned_by, auth.uid());
    new.returned_by_name := app.actor_name(new.returned_by);
  end if;
  return new;
end $$;

drop trigger if exists trg_asset_assignment_actor on public.asset_assignments;
create trigger trg_asset_assignment_actor
  before insert or update on public.asset_assignments
  for each row execute function app.tg_asset_assignment_actor();

-- Rows written between 0076 and now carry an id but no name. Fill what can still be resolved;
-- anything whose user has since been deleted stays null and renders as "not recorded".
update public.asset_assignments
   set assigned_by_name = app.actor_name(assigned_by)
 where assigned_by is not null and assigned_by_name is null;

update public.asset_assignments
   set returned_by_name = app.actor_name(returned_by)
 where returned_by is not null and returned_by_name is null;

commit;
