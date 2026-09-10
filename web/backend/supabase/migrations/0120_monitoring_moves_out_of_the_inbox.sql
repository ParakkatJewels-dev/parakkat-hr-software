-- 0120 — Monitoring moves out of the inbox.
--
-- 0119 made a super admin's chat list contain every conversation in the company. That satisfied
-- "monitor all" literally and was the wrong shape: their own conversations with their own
-- colleagues were buried in a list of everybody else's, and the screen they use to TALK became the
-- screen they use to WATCH. Two jobs, one list, neither done well.
--
-- Monitoring is oversight, so it goes where the other oversight screens are: Administration, as a
-- browse-by-person view — every employee, then who that person talks to, then the conversation.
--
-- So this migration is a narrowing of the LIST only:
--   * my_conversations goes back to conversations you are a member of. For everybody, super admin
--     included. It is an inbox again.
--   * app.can_read_conversation KEEPS its super-admin arm. That is what the monitor reads through,
--     and it is the whole of the oversight power — messages, members and attachments in one place.
--
-- `is_member` is dropped with the same reasoning: in a membership-only list it is true on every row
-- and answers a question nobody is asking any more. The monitor knows it is monitoring.
--
-- Still true: this is enforcement in the application. Anybody with the Supabase dashboard or the
-- service key reads public.messages regardless of any policy here.
--
-- Idempotent: safe to re-run.

begin;

/*
 * Your inbox. Conversations you are in, and nothing else.
 *
 * security_invoker stays on, so RLS still applies underneath — but the membership join is what
 * actually decides the contents here, which is why a super admin sees their own chats and not the
 * company's despite being able to read every one of them.
 */
drop view if exists public.my_conversations;
create view public.my_conversations
with (security_invoker = true) as
select
  c.id,
  c.kind,
  c.title,
  c.created_by,
  c.created_at,
  c.last_message_at,
  cm.last_read_at,
  (select count(*)
     from public.messages m
    where m.conversation_id = c.id
      and m.created_at > cm.last_read_at
      and m.sender_id <> cm.employee_id
      and m.deleted_at is null) as unread_count,
  last_msg.body      as last_body,
  last_msg.kind      as last_kind,
  last_msg.sender_id as last_sender_id,
  last_msg.deleted_at is not null as last_deleted
from public.conversations c
join public.conversation_members cm
  on cm.conversation_id = c.id
 and cm.employee_id = app.current_employee_id()
left join lateral (
  select m.body, m.kind, m.sender_id, m.deleted_at
    from public.messages m
   where m.conversation_id = c.id
   order by m.created_at desc
   limit 1
) last_msg on true;

grant select on public.my_conversations to authenticated;

commit;
