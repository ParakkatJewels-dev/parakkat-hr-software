-- Push the command queue to the browser instead of polling it.
--
-- Twenty tables are already in the supabase_realtime publication, which is why the attendance
-- screen updates the moment the engine writes a row. service_commands was added after that and
-- never joined them, so the Requests panel falls back to asking every five seconds — for a table
-- that changes a handful of times a day, and only while somebody is watching it.
--
-- The rows carry no personal data (a kind, a status, a result count) and RLS still applies to
-- Realtime, so only someone with device.manage receives them — the same people who can already
-- read the table.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_commands'
  ) then
    alter publication supabase_realtime add table public.service_commands;
  end if;
end $$;

-- Realtime sends the changed row on UPDATE; default replica identity carries the primary key plus
-- the new values, which is all the panel needs (status, error, result). `full` would additionally
-- ship the previous version of every row on every status change, for no benefit here.
alter table public.service_commands replica identity default;
