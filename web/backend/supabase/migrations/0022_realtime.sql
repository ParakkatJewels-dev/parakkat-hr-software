-- 0022_realtime.sql
-- Enable Supabase Realtime for the operational tables so changes stream to every connected client
-- (the app subscribes and refreshes live — see web/src/lib/realtime.js). Realtime honours RLS, so
-- each user only receives changes to rows they may select. REPLICA IDENTITY FULL lets update/delete
-- events carry the old row so RLS can be evaluated on them too.
-- Idempotent: safe to re-run.

do $$
declare
  t text;
  tables text[] := array[
    'tasks','leaves','expenses','attendance','punches','tickets','assets','employees',
    'documents','exits','onboarding','role_assignments','roles','role_permissions',
    'profiles','entities','zones','branches','departments','designations'
  ];
begin
  -- The publication exists on every Supabase project, but guard just in case.
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
      execute format('alter table public.%I replica identity full', t);
    end if;
  end loop;
end $$;
