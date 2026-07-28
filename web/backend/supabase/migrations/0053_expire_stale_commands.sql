-- Stop a queued command from blocking its button forever.
--
-- The duplicate guard added in 0052 refuses to queue a second copy of work already in flight, which
-- is right: two backfills at once would flatten the on-prem BioTime box mid-morning. But it treated
-- 'pending' as in-flight unconditionally, and pending only means in-flight if something is actually
-- listening. When the service was still running a build without the command worker, three commands
-- sat pending indefinitely and every press of those buttons answered "already queued or running" —
-- with nothing to wait for, and no way back except editing the table by hand.
--
-- The worker polls every twenty seconds. So a command nobody has claimed after five minutes is not
-- queued behind anything; it is abandoned, and saying so is more useful than blocking on it. Same
-- for one that has been 'running' longer than any command could legitimately take.
--
-- Expiry happens inside the same function that queues, so it needs no scheduler of its own and
-- cannot itself stop working while the service is down — which is precisely when it is needed.

create or replace function public.expire_stale_service_commands()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  _n integer;
begin
  update public.service_commands
     set status = 'failed',
         finished_at = now(),
         error_message = case
           when status = 'pending'
             then 'nothing collected this within 5 minutes — the sync service is not running, or is running a build without the command worker'
           else 'still running after 2 hours — the service stopped before it finished'
         end
   where (status = 'pending' and requested_at < now() - interval '5 minutes')
      or (status = 'running' and claimed_at  < now() - interval '2 hours');

  get diagnostics _n = row_count;
  return _n;
end;
$$;

comment on function public.expire_stale_service_commands() is
  'Marks abandoned commands failed. Called before queueing so a dead service cannot permanently block a button.';

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
  _oldest   timestamptz;
begin
  if _kind = 'recompute' then
    if not app.has_perm_any_scope('attendance.manage') then
      raise exception 'You do not have permission to recompute attendance.' using errcode = '42501';
    end if;
  elsif not app.has_perm_org_wide('device.manage') then
    raise exception 'You do not have permission to run sync operations.' using errcode = '42501';
  end if;

  -- Clear anything abandoned before deciding whether this is a duplicate.
  perform public.expire_stale_service_commands();

  select count(*), min(requested_at) into _existing, _oldest
    from public.service_commands
   where kind = _kind and status in ('pending', 'running');

  if _existing > 0 then
    raise exception
      'A % is already in progress (queued % ago). Wait for it to finish.',
      replace(_kind, '_', ' '),
      case
        when now() - _oldest < interval '1 minute' then 'moments'
        else (extract(epoch from (now() - _oldest))/60)::int || ' minutes'
      end
      using errcode = '55006';
  end if;

  insert into public.service_commands (kind, params, requested_by)
  values (_kind, coalesce(_params, '{}'::jsonb), auth.uid())
  returning id into _id;

  return _id;
end;
$$;

revoke all on function public.expire_stale_service_commands() from public;
grant execute on function public.expire_stale_service_commands() to authenticated;

-- Clear the three that are wedged right now. They were never collected and never will be: the
-- build they were queued for does not have the worker.
select public.expire_stale_service_commands();
