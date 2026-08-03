-- Two SECURITY DEFINER functions in `public` were reachable by `anon` and `authenticated` with no
-- authorization check of their own. Both were meant to be internal; neither was.
--
-- The root cause is not either function. Supabase's default post-migration
--   grant execute on all functions in schema public to anon, authenticated
-- re-grants EXECUTE across the whole schema, silently undoing the targeted revoke in
-- 0007_rls.sql:153. A revoke alone is therefore not durable — the next blanket grant undoes it
-- again. So each function gets a check *inside* it, which no grant can override, and the revoke is
-- kept as a second line rather than the only one.

-- 1. bootstrap_super_admin ------------------------------------------------------------------------
--
-- This is the "make this email a super admin" function used once, by hand, to create the first
-- administrator. It is SECURITY DEFINER and had no caller check at all, so with EXECUTE granted to
-- `authenticated` any signed-in employee could call
--   supabase.rpc('bootstrap_super_admin', { _email: <their own login> })
-- and hold every permission in the system. It was granted to `anon` as well, and the anon key ships
-- inside the web bundle, so the same call could be made by anyone who has an email that exists in
-- auth.users.
--
-- Nothing was exploited: today auth.users holds exactly one row, admin@parakkat.com, who is already
-- a super admin, so the call could not raise anyone's privileges. That stops being true the moment
-- employee logins are created.
--
-- The guard allows auth.uid() IS NULL through on purpose. That is the SQL editor and service_role,
-- which is the only context this function is supposed to be used from — including the very first
-- run, when no super admin exists yet and a check for one would lock the system out of itself.
create or replace function public.bootstrap_super_admin(_email text)
returns void
language plpgsql
security definer
set search_path = app, public
as $$
declare _uid uuid;
begin
  if auth.uid() is not null and not app.is_super_admin() then
    raise exception 'only a super admin may appoint another super admin'
      using errcode = '42501';
  end if;

  select id into _uid from auth.users where lower(email) = lower(_email);
  if _uid is null then
    raise exception 'no auth user with email %, have them sign up/accept the invite first', _email;
  end if;
  insert into public.profiles (user_id, is_super_admin) values (_uid, true)
  on conflict (user_id) do update set is_super_admin = true;
end $$;

revoke execute on function public.bootstrap_super_admin(text) from public, anon, authenticated;

-- 2. document_for_object --------------------------------------------------------------------------
--
-- This exists to be called from inside the storage.objects RLS policies, which map a storage object
-- name back to its documents row and then check has_perm over that row's scope. Called directly it
-- returned the row unconditionally, so any signed-in user who knew a document's UUID could read its
-- metadata — employee_id, title, category, file name, storage path — for any document in the
-- company, straight past the RLS on public.documents.
--
-- The fix is the check, NOT a revoke. An RLS policy expression is evaluated as the querying user, so
-- `authenticated` genuinely needs EXECUTE here; revoking it would break every document read and
-- upload in the app. Only `anon` is revoked, which has no business reading documents at all.
--
-- Both permissions are tested, because the two policies that call this ask for different ones:
-- documents_object_read gates on document.read, documents_object_insert on document.manage. A
-- read-only guard here would have blocked uploads for anyone holding manage without read.
create or replace function public.document_for_object(object_name text)
returns setof public.documents
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.*
    from public.documents d
   where d.id::text = split_part(object_name, '/', 1)
     and (
          app.has_perm('document.read',   d.entity_id, d.zone_id, d.branch_id, d.department_id, d.employee_id)
       or app.has_perm('document.manage', d.entity_id, d.zone_id, d.branch_id, d.department_id, d.employee_id)
     )
   limit 1
$$;

revoke execute on function public.document_for_object(text) from public, anon;
grant execute on function public.document_for_object(text) to authenticated;
