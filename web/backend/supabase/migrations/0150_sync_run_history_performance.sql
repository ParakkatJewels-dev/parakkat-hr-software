-- Sync history orders all run kinds by time and id. Its former kind-first index could not
-- provide that order, and the uncorrelated permission check ran once for every scanned row.
-- Keep the same authority and active-account guard while evaluating authority once per query.
begin;

create index if not exists idx_sync_runs_started_id
  on public.sync_runs(started_at desc, id desc);

drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs for select to authenticated
  using ((select app.has_perm_org_wide('device.manage')));

commit;
