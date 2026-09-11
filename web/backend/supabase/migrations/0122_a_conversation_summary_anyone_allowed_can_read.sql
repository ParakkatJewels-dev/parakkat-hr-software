-- 0122 — A conversation summary anyone allowed can read.
--
-- This file is a RECORD, written after the fact. The view below was applied to the database on
-- 2026-09-10, directly, while building the "Viewing" switcher in Messages, and no migration file was
-- written for it at the time. Anybody rebuilding a database from this folder would have ended up
-- without it, and the switcher would have broken the first time a super admin picked somebody.
-- The definition here is copied from the live database (pg_get_viewdef), not reconstructed.
--
-- WHY IT EXISTS
--   The switcher shows another employee's conversations in the SAME list component the inbox uses,
--   and that component draws a preview line: the last thing said. my_conversations cannot supply
--   it for somebody else, because it is joined through the viewer's own membership (0120). Reading
--   the bare conversations table gives rows with no preview, so every watched conversation rendered
--   as "No messages yet" whether or not it had any. This view carries the last message.
--
-- WHAT IT DOES NOT DO
--   It grants nothing. security_invoker means every table under it is read as the person querying,
--   so conversations_select and messages_select still decide which rows come back: a super admin
--   sees every conversation through app.can_read_conversation's super-admin arm (0119), and
--   everybody else sees only conversations they are in. It is a shape over the tables, not a way
--   around them.
--
-- Idempotent: safe to re-run. `create or replace` matches the live definition column for column.

begin;

create or replace view public.conversation_overview
with (security_invoker = true) as
select
  c.id,
  c.kind,
  c.title,
  c.created_by,
  c.created_at,
  c.last_message_at,
  last_msg.body      as last_body,
  last_msg.kind      as last_kind,
  last_msg.sender_id as last_sender_id,
  last_msg.deleted_at is not null as last_deleted
from public.conversations c
left join lateral (
  select m.body, m.kind, m.sender_id, m.deleted_at
    from public.messages m
   where m.conversation_id = c.id
   order by m.created_at desc
   limit 1
) last_msg on true;

grant select on public.conversation_overview to authenticated;

commit;
