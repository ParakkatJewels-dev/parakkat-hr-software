-- 0108 — task_attachments was wired for realtime on the client and never published.
--
-- realtime.js maps task_attachments to ['task-attachments'] and ['task-attachment-counts'], so the
-- client is already listening. The database half was never written: 0106 created the table and
-- 0105 remembered the publication for task_comments, but attachments were missed. The result is
-- the exact bug 0102 fixed for help_requests, still live for files — one person attaches a
-- specification, the other is looking at the same task, and the paperclip count does not move
-- until the five-minute safety poll.
--
-- This is the last of the 0099-0107 tables to be missing from the publication. department_moves is
-- deliberately absent: nothing subscribes to it, it is an audit trail read on demand.
--
-- RLS still applies to the stream (0022's note), so a viewer is only told about attachments on
-- tasks they can already read — task_attachments_select inherits that from tasks.
--
-- Idempotent: safe to re-run.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if to_regclass('public.task_attachments') is not null
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'task_attachments'
     ) then
    alter publication supabase_realtime add table public.task_attachments;
  end if;

  -- Realtime needs the whole old row to decide who was watching what changed.
  if to_regclass('public.task_attachments') is not null then
    alter table public.task_attachments replica identity full;
  end if;
end $$;
