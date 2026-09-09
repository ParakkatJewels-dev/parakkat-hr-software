-- 0102_a_request_answers_itself_on_screen.sql
--
-- help_requests was created in 0101 but never added to the realtime publication, so the one screen
-- in the app where two people are looking at the same row at the same time was the one screen that
-- did not update. A head raises a request and watches it; the other head accepts; nothing happens
-- until the 5-minute safety poll in main.jsx comes round.
--
-- The client half is realtime.js, which maps the table to the caches it invalidates. This is the
-- database half: without the table in the publication there is no event to receive.
--
-- RLS still applies to the stream (0022's note), so each head is only told about rows they may
-- already read — which help_requests_select limits to the two departments involved.
--
-- Idempotent: safe to re-run.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if to_regclass('public.help_requests') is not null
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'help_requests'
     ) then
    alter publication supabase_realtime add table public.help_requests;
  end if;

  -- Realtime needs the whole old row to work out who was watching what changed.
  if to_regclass('public.help_requests') is not null then
    alter table public.help_requests replica identity full;
  end if;
end $$;
