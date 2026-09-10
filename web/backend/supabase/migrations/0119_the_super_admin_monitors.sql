-- 0119 — The super admin monitors.
--
-- Third and final position on this, and the history is worth keeping in one place because anybody
-- reading these files in order will otherwise think somebody could not make up their mind:
--
--   0115  super admin can read every conversation           (asked for: disputes, investigations)
--   0118  membership only, nobody reads a room they are in not
--   0119  super admin reads AND sees every conversation listed
--
-- This one goes further than 0115 did. 0115 gave read access but left the conversation LIST joined
-- through membership, so a super admin could open a room by id and see nothing at all in their own
-- sidebar. That is an audit power, not a monitoring one — it answers "show me this conversation"
-- and cannot answer "what conversations exist". Monitoring needs the list.
--
-- WHAT A SUPER ADMIN CAN DO AFTER THIS
--   * See every conversation in the app, in their own chat list.
--   * Read its messages, its members and its attachments.
--
-- WHAT THEY STILL CANNOT DO, deliberately
--   * Post in a conversation they are not a member of. messages_insert asks is_conversation_member,
--     not can_read_conversation, and this migration does not touch it. Reading somebody's
--     conversation is oversight; writing in it under their colleague's nose is something else, and
--     no monitoring requirement needs it.
--   * Be hidden. `is_member` is added to the view precisely so the screen can mark a conversation
--     the viewer is only monitoring, rather than presenting it as one of their own chats.
--
-- STILL TRUE, and still worth telling staff: this is enforcement in the application. Anybody with
-- the Supabase dashboard or service key reads public.messages regardless of any policy here.
--
-- Idempotent: safe to re-run.

begin;

-- Reading: back to super admin OR membership, reversing 0118.
create or replace function app.can_read_conversation(_conversation uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.is_super_admin() or app.is_conversation_member(_conversation);
$$;

/*
 * The conversation list.
 *
 * Two changes from 0115's version:
 *
 *   1. The membership join becomes a LEFT join with a WHERE that keeps a row when you are a member
 *      OR you are the super admin. Previously an INNER join through your own membership row, which
 *      is why a super admin's list was empty however much they could read.
 *
 *   2. `is_member` is exposed, so the screen can tell "my conversation" from "one I am watching"
 *      without guessing. Without it the two are indistinguishable, and a super admin would open a
 *      colleague's chat, type a reply and be refused by a policy with no warning.
 *
 * unread_count is 0 for a conversation you are only monitoring, and that is correct rather than a
 * gap: unread is measured from YOUR last_read_at, and you have never read a room you are not in.
 * Counting somebody else's unread as your own would put a badge on the sidebar for every message
 * every employee sends.
 *
 * security_invoker stays on, so this view can never show more than the policies allow. It is a
 * shape over the tables, not a way around them — if 0118 is ever re-applied, this list narrows
 * back to membership on its own.
 */
create or replace view public.my_conversations
with (security_invoker = true) as
select
  c.id,
  c.kind,
  c.title,
  c.created_by,
  c.created_at,
  c.last_message_at,
  cm.last_read_at,
  (cm.employee_id is not null) as is_member,
  case
    when cm.employee_id is null then 0
    else (
      select count(*)
        from public.messages m
       where m.conversation_id = c.id
         and m.created_at > cm.last_read_at
         and m.sender_id <> cm.employee_id
         and m.deleted_at is null
    )
  end as unread_count,
  last_msg.body      as last_body,
  last_msg.kind      as last_kind,
  last_msg.sender_id as last_sender_id,
  last_msg.deleted_at is not null as last_deleted
from public.conversations c
left join public.conversation_members cm
  on cm.conversation_id = c.id
 and cm.employee_id = app.current_employee_id()
left join lateral (
  select m.body, m.kind, m.sender_id, m.deleted_at
    from public.messages m
   where m.conversation_id = c.id
   order by m.created_at desc
   limit 1
) last_msg on true
where cm.employee_id is not null
   or app.is_super_admin();

grant select on public.my_conversations to authenticated;

commit;
