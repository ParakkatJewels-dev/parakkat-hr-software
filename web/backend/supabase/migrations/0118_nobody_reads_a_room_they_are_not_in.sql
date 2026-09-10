-- 0118 — Nobody reads a room they are not in.
--
-- 0115 shipped with the super admin able to read every conversation. That was asked for and
-- answered at the time — "useful for disputes and investigations" — and it is now reversed by the
-- same owner. Membership is the whole of the rule from here.
--
-- WHAT THIS CHANGES
--   app.can_read_conversation loses its super-admin arm, and that one function is what four things
--   ask, so all four move together:
--     * conversations_select        — the conversation row itself
--     * conversation_members_select — who is in it
--     * messages_select             — what was said
--     * chat_media_read (storage)   — the photos, files and voice notes attached to it
--   Nothing else consults it, so there is no other surface left open by accident.
--
-- WHAT THIS DOES NOT CHANGE, and is worth being honest about
--   This governs what the APPLICATION will show. It is not a privacy guarantee against the person
--   who owns the database: anyone holding the Supabase service key or dashboard access can read
--   public.messages directly, and RLS does not apply to them. So the real effect is "an admin must
--   go to the database to read a chat" rather than "an admin cannot read a chat".
--   That distinction matters for what staff are told. Promising privacy the database does not
--   provide is worse than not promising it.
--
--   A super admin also keeps read access to their OWN conversations, because they are a member of
--   those. Nothing here isolates them from their own messages.
--
-- The header of 0115 still describes the original decision. It is left as written: it records what
-- was true when it ran, and this file records the change.
--
-- Idempotent: safe to re-run.

begin;

/*
 * May this person read this conversation?
 *
 * Membership. Nothing else.
 *
 * Kept as a function rather than inlined into four policies for the reason it was written that way:
 * the next person to change who may read a conversation should have exactly one place to do it,
 * and should not be able to change the messages without also changing the attachments.
 */
create or replace function app.can_read_conversation(_conversation uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.is_conversation_member(_conversation);
$$;

commit;
