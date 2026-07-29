-- A heartbeat that beats whether or not there was anything to fetch.
--
-- THE PROBLEM THIS SOLVES
-- sync_runs was doing two jobs at once and doing the second one badly. It is the log of what the
-- sync did, and it was also the only evidence that the service is alive at all. Those need
-- opposite things from it.
--
-- As a log it is 81% noise: of 206 punch-sync runs in a day, 8 brought punches in, 30 failed, and
-- 167 succeeded having found nothing. On 29 July that wall of green successes is precisely what
-- made a dead terminal look healthy — every row said "success" and not one of them had a punch
-- behind it. The rows nobody needs are burying the rows somebody does.
--
-- But simply stopping the empty rows would break the other job. "No runs recently" is how the
-- status screen tells a stopped service from a quiet one, and without a row every couple of
-- minutes those two become indistinguishable — the worst possible pair to confuse, because one
-- needs somebody to go and look at the laptop and the other needs nothing at all.
--
-- So the two jobs are separated. This column beats on every attempt, success or failure, found
-- something or not. sync_runs is then free to record only what is worth reading.
--
-- WHY NOT last_success_at, WHICH ALREADY EXISTS
-- Because it stops moving when Easy Time Pro stops answering, and at that moment the service is
-- still perfectly alive and still needs to be reported as such. Distinguishing "the service is
-- down" from "the service is up but Easy Time Pro is not answering" is the whole point of the
-- three-link status, and it needs a signal that survives a failing poll. That is this one:
--
--   last_poll_at     moves every attempt          -> is the SERVICE alive?
--   last_success_at  moves when the pull worked   -> is EASY TIME PRO answering?
--   last_punch_time  moves when punches arrive    -> is the MACHINE delivering?

alter table public.sync_state
  add column if not exists last_poll_at timestamptz;

comment on column public.sync_state.last_poll_at is
  'Last time the service attempted this sync, whatever the outcome. The liveness signal: it keeps '
  'beating through failures and through quiet periods, so a stopped service can be told apart from '
  'a service with nothing to do. Contrast last_success_at, which stops the moment Easy Time Pro '
  'stops answering even though the service is still running.';

-- Seed it so the status screen has something to read before the service next polls, rather than
-- reporting "never heard from" for a service that is running perfectly well.
update public.sync_state
   set last_poll_at = greatest(
         coalesce(last_success_at, updated_at, now() - interval '1 day'),
         coalesce(updated_at, now() - interval '1 day'))
 where last_poll_at is null;
