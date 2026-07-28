-- Ask the sync service to do something, without being able to reach it.
--
-- WHY
-- The service dials out: to Easy Time Pro on the LAN, and to Supabase in the cloud. Nothing dials
-- in — which is why punches keep arriving no matter where anyone is sitting. The one exception was
-- the admin screen's buttons, which called the service's HTTP API directly on the HR laptop. That
-- single inbound connection is what forced a firewall rule, a CORS allowlist, and the requirement
-- to be on the office network, and it can never work at all from an HTTPS page, because a browser
-- refuses to call http://192.168.1.45:8091 from one.
--
-- Both sides already trust Supabase. So the request travels through it instead:
--
--   browser  -> insert a row here          (HTTPS, works from anywhere, RLS-checked)
--   service  -> polls, claims, runs it     (still only dials out)
--   browser  -> reads status and result    (same row)
--
-- Nothing about the work changes; only who initiates the connection. The direct API stays for
-- anyone on the LAN who wants an immediate answer, but it is no longer the only route.

create table if not exists public.service_commands (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,
  params        jsonb not null default '{}'::jsonb,

  status        text not null default 'pending',
  requested_by  uuid references auth.users(id) on delete set null,
  requested_at  timestamptz not null default now(),
  claimed_at    timestamptz,
  finished_at   timestamptz,

  result        jsonb,
  error_message text,

  constraint service_commands_kind_values
    check (kind in ('sync_transactions', 'sync_employees', 'backfill', 'recompute', 'refresh_suggestions')),
  constraint service_commands_status_values
    check (status in ('pending', 'running', 'done', 'failed', 'cancelled'))
);

comment on table public.service_commands is
  'Work requested of the attendance service from the browser. The service polls this rather than being called, so no inbound connection to the HR laptop is ever needed.';

-- The service's poll is "oldest pending first", and it runs every few seconds.
create index if not exists service_commands_pending_idx
  on public.service_commands (requested_at)
  where status = 'pending';

-- The screen shows recent history.
create index if not exists service_commands_recent_idx
  on public.service_commands (requested_at desc);

alter table public.service_commands enable row level security;

-- Reading is for whoever can administer devices; that is already who sees the sync screen.
drop policy if exists service_commands_select on public.service_commands;
create policy service_commands_select on public.service_commands
  for select using (app.has_perm_org_wide('device.manage'));

-- No direct INSERT policy on purpose. Everything goes through request_service_command() below,
-- so the permission for each kind of work is checked in one place rather than being duplicated
-- into a policy expression that would drift from it.

/**
 * Queue a piece of work for the service.
 *
 * Returns the new row's id. The caller polls service_commands for the outcome.
 */
create or replace function public.request_service_command(
  _kind   text,
  _params jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  _id       uuid;
  _existing int;
begin
  -- Recompute is an attendance correction; the rest are device/sync administration.
  if _kind = 'recompute' then
    if not app.has_perm_any_scope('attendance.manage') then
      raise exception 'You do not have permission to recompute attendance.' using errcode = '42501';
    end if;
  elsif not app.has_perm_org_wide('device.manage') then
    raise exception 'You do not have permission to run sync operations.' using errcode = '42501';
  end if;

  -- Pressing the button twice should not queue the work twice. A backfill in particular is minutes
  -- of load on the on-prem BioTime box, and two of them at once is how you take it down during
  -- business hours.
  select count(*) into _existing
    from public.service_commands
   where kind = _kind and status in ('pending', 'running');

  if _existing > 0 then
    raise exception 'A % is already queued or running. Wait for it to finish.', replace(_kind, '_', ' ')
      using errcode = '55006';
  end if;

  insert into public.service_commands (kind, params, requested_by)
  values (_kind, coalesce(_params, '{}'::jsonb), auth.uid())
  returning id into _id;

  return _id;
end;
$$;

comment on function public.request_service_command(text, jsonb) is
  'Queue work for the attendance service. Checks the caller''s permission and refuses to queue a second copy of work already in flight.';

revoke all on function public.request_service_command(text, jsonb) from public;
grant execute on function public.request_service_command(text, jsonb) to authenticated;

grant select on public.service_commands to authenticated;
