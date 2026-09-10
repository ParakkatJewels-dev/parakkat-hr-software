-- 0116 — You may join the room you built.
--
-- 0115 shipped a messaging module in which nobody could start a conversation. Two policies, each
-- correct on its own, formed a cycle:
--
--   * conversations_select asks app.can_read_conversation(id), which is membership or super admin.
--     PostgREST reads a row back after inserting it, and at that instant the person who just
--     created the conversation is not a member of it — so `insert ... returning id` came back with
--     nothing and the client had no id to attach anybody to.
--
--   * conversation_members_insert allowed the creator through an EXISTS over `conversations`. That
--     subquery runs under the CALLER's rights, so it was filtered by conversations_select above —
--     which asks whether they are a member, which is precisely what the insert was trying to make
--     them. Denied, every time.
--
-- The shape of the bug is worth naming, because it will happen again in any table where the right
-- to do something is derived from a row that does not exist yet: a policy that reads another table
-- gets that table's RLS applied to it, so "check the parent" silently means "check the parent, as
-- filtered by whether you can already see the parent".
--
-- The fix is the same one 0114 and 0115 already use everywhere else and that I failed to apply
-- here: ask the question through a SECURITY DEFINER function, which reads past RLS once and returns
-- a boolean.
--
-- Idempotent: safe to re-run.

begin;

/*
 * Did this person create this conversation?
 *
 * SECURITY DEFINER, so it answers about the actual row rather than about the row as the caller can
 * currently see it. Scoped to a single conversation id and returns a boolean, so it widens nothing:
 * it cannot be used to read a title, a member list or a message.
 */
create or replace function app.is_conversation_creator(_conversation uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select _conversation is not null and exists (
    select 1 from public.conversations c
     where c.id = _conversation
       and c.created_by is not null
       and c.created_by = app.current_employee_id()
  );
$$;

grant execute on function app.is_conversation_creator(uuid) to authenticated;

/*
 * Seeing it.
 *
 * The creator arm is what lets `insert ... returning id` come back with the id. It outlives the
 * bootstrap window — somebody who creates a group and later leaves it keeps sight of the
 * conversation ROW — and that is deliberate rather than overlooked:
 *
 *   * They know it exists. They made it. There is nothing to leak to them about its existence.
 *   * It is only the row. messages_select still asks can_read_conversation, which is membership or
 *     super admin, so a creator who has left reads no messages, and the my_conversations view joins
 *     through membership, so it does not appear in their list either.
 *
 * The alternative — a window that closes once the conversation has members — is a policy whose
 * meaning changes over the life of a row, and that is a worse thing to leave behind than this.
 */
drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (
       app.can_read_conversation(id)
    or app.is_conversation_creator(id)
  );

/*
 * Adding people.
 *
 * Identical in intent to 0115's version; the difference is that the creator test now goes through
 * the definer function instead of an EXISTS that RLS was quietly filtering to nothing.
 */
drop policy if exists conversation_members_insert on public.conversation_members;
create policy conversation_members_insert on public.conversation_members for insert to authenticated
  with check (
       app.is_conversation_member(conversation_id)
    or app.is_conversation_creator(conversation_id)
  );

commit;
