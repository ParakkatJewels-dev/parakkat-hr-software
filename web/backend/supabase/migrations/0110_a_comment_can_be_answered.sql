-- 0110 — A comment can be answered.
--
-- The thread was flat: fifteen remarks in a row, and the one answering the question from four
-- comments ago was indistinguishable from the one starting a new subject. On a task that is
-- blocked, "why?" and the answer to it are the whole point of the thread.
--
-- ONE LEVEL, DELIBERATELY.
-- A reply to a reply is stored against the same top-level comment, not against the reply — the
-- shape Instagram and every comment section that stays readable on a phone uses. Arbitrary nesting
-- looks tidy in a mock with three comments and turns into a staircase with thirty, indenting the
-- most recent (and most relevant) remark off the right edge of a 360px screen. The trigger below
-- enforces it rather than trusting the client, because the client is not the only writer.
--
-- Threading is a display property, so the RLS stays exactly as it was: a reply is a comment on the
-- same task, and task_comments_select already inherits visibility from tasks.

begin;

alter table public.task_comments
  add column if not exists parent_id uuid references public.task_comments(id) on delete cascade;

comment on column public.task_comments.parent_id is
  'The top-level comment this answers. Null for a top-level comment. One level only — see the trigger.';

-- Reading a thread means fetching a parent and its replies together.
create index if not exists task_comments_parent_idx
  on public.task_comments (parent_id, created_at);

/*
 * Flatten a reply-to-a-reply onto its top-level comment.
 *
 * Not an error: somebody answering the third reply in a conversation is doing a reasonable thing,
 * and refusing it would be the interface's failure to explain itself. Instagram resolves this the
 * same way — the reply joins the thread it belongs to rather than starting a deeper one.
 *
 * Also refuses a reply that crosses tasks, which would otherwise let a comment on a task you can
 * read attach itself to a thread on one you cannot.
 */
create or replace function app.tg_task_comment_one_level()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _parent_task   uuid;
  _grandparent   uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'A comment cannot answer itself.' using errcode = '22023';
  end if;

  select task_id, parent_id into _parent_task, _grandparent
    from public.task_comments where id = new.parent_id;

  if _parent_task is null then
    raise exception 'That comment no longer exists.' using errcode = '23503';
  end if;

  if _parent_task <> new.task_id then
    raise exception 'A reply belongs to the same task as the comment it answers.' using errcode = '22023';
  end if;

  -- Answering a reply attaches to the top of that thread, not to the reply.
  if _grandparent is not null then
    new.parent_id := _grandparent;
  end if;

  return new;
end $$;

drop trigger if exists task_comment_one_level on public.task_comments;
create trigger task_comment_one_level
  before insert or update of parent_id on public.task_comments
  for each row execute function app.tg_task_comment_one_level();

commit;
