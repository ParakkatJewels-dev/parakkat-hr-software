-- 0117 — A row cannot look itself up yet.
--
-- 0116 fixed the circular policy that stopped conversations being created, and it worked when the
-- steps were run as separate statements. The client does not do that. supabase-js sends
--
--     insert into conversations (...) values (...) returning id
--
-- because it needs the new id to attach the members to, and a RETURNING clause makes Postgres apply
-- the SELECT policy to the row it is about to hand back. That is where 0116's fix failed:
--
--     conversations_select  ->  app.is_conversation_creator(id)  ->  select ... from conversations
--
-- app.is_conversation_creator is STABLE, so it runs against the snapshot taken at the START of the
-- statement — before the row it is being asked about existed. It looks for the row, cannot see it,
-- and returns false. The insert is then refused with 42501, which reaches the user as "You don't
-- have permission to make that change".
--
-- The lesson worth keeping: a policy that re-reads its own table cannot answer questions about the
-- row currently being written. `created_by` is a column ON the row under test, so comparing it
-- directly needs no snapshot, no subquery and no function — and is what this should have been from
-- the start.
--
-- app.is_conversation_creator stays, and stays STABLE, because conversation_members_insert uses it
-- to ask about a conversation inserted by an EARLIER statement — a different row, already committed
-- to the transaction's view, where the snapshot is not a problem.
--
-- Idempotent: safe to re-run.

begin;

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (
       app.can_read_conversation(id)
    -- No function call: `created_by` belongs to the row being checked, so this is true the instant
    -- the row exists, including inside the INSERT ... RETURNING that creates it.
    or (created_by is not null and created_by = app.current_employee_id())
  );

commit;
