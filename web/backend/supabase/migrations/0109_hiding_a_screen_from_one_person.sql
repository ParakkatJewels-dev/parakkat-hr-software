-- 0109 — Hide a screen from one person, without inventing a role for them.
--
-- THE PROBLEM THIS SOLVES, AND THE ONE IT DOES NOT
-- Roles are the right unit for access and the wrong unit for exceptions. A department head who
-- should not see the bulk Import is not a new role; making one for them means a second ladder to
-- keep in step with the first, and 0080 exists because the first one drifted. So: an override
-- list, keyed to a person and a screen.
--
-- It NARROWS ONLY. There is no "allow" here — you cannot grant somebody a screen their role does
-- not already reach, because that would be a second, weaker path to the same authority and the
-- database would still refuse the data when they got there. Every row means "hide this".
--
-- IT IS NOT A SECURITY BOUNDARY, AND MUST NOT BE SOLD AS ONE.
-- Hiding Import from a head does not take away employee.create. They keep the permission; RLS will
-- still hand over the rows to anything that asks, and the API is reachable with a browser console.
-- What this buys is that the screen is not offered and the route guard turns it away — the right
-- tool for "this is not part of your job", the wrong tool for "this person must not have it".
-- For the second case, take the role away. The Administration panel says exactly this on screen,
-- because an administrator who believes otherwise is worse off than one who has no override at all.
--
-- WHY SCREEN IDS AND NOT PERMISSIONS
-- The unit an administrator thinks in is the sidebar entry, not the permission key behind it. The
-- ids are the ones in web/src/lib/navMap.js. They are deliberately NOT constrained to a lookup
-- table: a stale row for a renamed screen is inert (nothing matches it), whereas a foreign key
-- would make renaming a screen a migration.

begin;

create table if not exists public.user_screen_overrides (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  screen_id   text not null check (screen_id ~ '^[a-z0-9-]{1,64}$'),
  reason      text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null,
  unique (user_id, screen_id)
);

comment on table public.user_screen_overrides is
  'Screens hidden from one user on top of their role. Narrows only; never grants. Not a security boundary — the permission is untouched, so RLS still serves the data.';

create index if not exists user_screen_overrides_user_idx
  on public.user_screen_overrides (user_id);

alter table public.user_screen_overrides enable row level security;

-- RLS decides which rows; this decides whether the role may touch the table at all. Without it the
-- policies below are unreachable and every query returns "permission denied for table", which
-- reads like a policy bug and is not one. 0074 revoked the default privileges that would otherwise
-- have covered this, so each table says so for itself — as 0101, 0105, 0106 and 0107 all do.
grant select, insert, update, delete on public.user_screen_overrides to authenticated;

-- READ: your own, so the sidebar can apply them; plus anyone who administers you, so the panel can
-- show what is already hidden. app.can_admin_user is the same seniority test that decides whether
-- they may take this person's roles away, which is the right bar: hiding a screen from somebody
-- should not be easier than revoking their role. It already treats the super-admin flag as the top
-- of the ladder, so a branch manager cannot narrow the founder.
--
-- has_perm_any_scope, NOT has_perm(..., null, null, null, null, null): an override row has no
-- place in the org tree, and the all-null form asks "do you hold this over a row belonging to
-- nowhere", which an entity-scoped grant does not satisfy. The first version of this policy
-- refused an entity admin hiding a screen from their own department head.
drop policy if exists user_screen_overrides_select on public.user_screen_overrides;
create policy user_screen_overrides_select on public.user_screen_overrides
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      app.has_perm_any_scope('rbac.manage')
      and app.can_admin_user(user_id)
    )
  );

drop policy if exists user_screen_overrides_write on public.user_screen_overrides;
create policy user_screen_overrides_write on public.user_screen_overrides
  for all to authenticated
  using (
    app.has_perm_any_scope('rbac.manage')
    and app.can_admin_user(user_id)
    -- Nobody hides a screen from themselves by accident and then cannot find the screen that
    -- would let them put it back.
    and user_id <> auth.uid()
  )
  with check (
    app.has_perm_any_scope('rbac.manage')
    and app.can_admin_user(user_id)
    and user_id <> auth.uid()
  );

-- A super admin must stay reachable. Locking the Administration section away from the only account
-- that can unlock it is a one-way door, and it would be opened by a mis-click.
create or replace function app.tg_protect_super_admin_screens()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if exists (
    select 1 from public.profiles p
     where p.user_id = new.user_id and coalesce(p.is_super_admin, false)
  ) then
    raise exception 'A super admin''s screens cannot be hidden.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists protect_super_admin_screens on public.user_screen_overrides;
create trigger protect_super_admin_screens
  before insert or update on public.user_screen_overrides
  for each row execute function app.tg_protect_super_admin_screens();

-- Deliver the list with the rest of the access payload: one round trip, and it refreshes through
-- the same realtime hook that already watches role_assignments and profiles.
create or replace function public.get_my_access()
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'is_super_admin', app.is_super_admin(),
    'rank', app.max_role_rank(),
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
    -- Screens this person is not offered. A super admin is never narrowed, matching the trigger.
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

-- The sidebar has to repaint the moment an override is added or removed, the same way it does for
-- a role change. AuthContext already listens per-user; this puts the rows on the wire.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'user_screen_overrides'
  ) then
    alter publication supabase_realtime add table public.user_screen_overrides;
  end if;
end $$;

alter table public.user_screen_overrides replica identity full;

commit;
