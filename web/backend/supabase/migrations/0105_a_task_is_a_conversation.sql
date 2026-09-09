-- 0105_a_task_is_a_conversation.sql
--
-- A task could be assigned, progressed and closed without anyone being able to say a word about it.
-- "Blocked" was a status with no room for WHY, so the answer happened on WhatsApp and never reached
-- the record. This gives a task the thing it was missing: the people involved talking on it.
--
-- WHO MAY SPEAK. Anyone who can READ the task. That is wider than "the assigner and the assignee",
-- deliberately: the branch manager who can already see a blocked task is exactly who you want
-- unblocking it, and a rule that named only two people would have them watching in silence. RLS on
-- the task is already the boundary, so this inherits it rather than inventing a second one.
--
-- HOW IT INHERITS IT is worth writing down. The policies below say
--   exists (select 1 from public.tasks t where t.id = task_comments.task_id)
-- and that subquery runs under TASKS' own row-level security for the same user (the same property
-- 0095 relied on for payslip_lines). So a comment is visible exactly when its task is — including
-- the help-request clause from 0101, which means the head who ASKED for a task can talk on it
-- without a single extra rule here. Checked, not assumed.
--
-- Idempotent: safe to re-run.

begin;

create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  author_id   uuid references public.employees(id) on delete set null,
  author_user uuid,                       -- auth.uid() at write time; survives an employee unlink
  body        text not null,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  constraint task_comments_body_not_empty check (btrim(body) <> '')
);

create index if not exists idx_task_comments_task on public.task_comments(task_id, created_at);

alter table public.task_comments enable row level security;

drop policy if exists task_comments_select on public.task_comments;
create policy task_comments_select on public.task_comments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_comments.task_id));

-- You may add a comment to a task you can see, as yourself. `author_user = auth.uid()` is what
-- stops a comment being filed under somebody else's name.
drop policy if exists task_comments_insert on public.task_comments;
create policy task_comments_insert on public.task_comments for insert to authenticated
  with check (
    author_user = auth.uid()
    and exists (select 1 from public.tasks t where t.id = task_comments.task_id)
  );

-- Your own words, and only yours. A manager who can see the thread cannot rewrite what somebody
-- else said in it.
drop policy if exists task_comments_update on public.task_comments;
create policy task_comments_update on public.task_comments for update to authenticated
  using (author_user = auth.uid()) with check (author_user = auth.uid());

drop policy if exists task_comments_delete on public.task_comments;
create policy task_comments_delete on public.task_comments for delete to authenticated
  using (author_user = auth.uid());

grant select, insert, update, delete on public.task_comments to authenticated;

-- ---------------------------------------------------------------------------
-- telling the other party
--
-- A comment is only useful if the person it is aimed at hears about it. Both ends of the task get
-- told — the assignee and whoever delegated it — and notify_user skips the actor, so commenting on
-- your own task does not notify you.
-- ---------------------------------------------------------------------------
create or replace function app.tg_notify_task_comment()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _t record; _author text; _assignee_user uuid; _assigner_user uuid;
begin
  select t.title, t.employee_id, t.assigned_by into _t
  from public.tasks t where t.id = new.task_id;
  if _t.title is null then return new; end if;

  select full_name into _author from public.employees where id = new.author_id;
  select user_id into _assignee_user from public.employees where id = _t.employee_id;
  select user_id into _assigner_user from public.employees where id = _t.assigned_by;

  perform app.notify_user(_assignee_user, 'task', 'New comment on a task',
    coalesce(_author, 'Somebody') || ' commented on "' || _t.title || '": ' || left(btrim(new.body), 120),
    'tasks', new.task_id);

  if _assigner_user is distinct from _assignee_user then
    perform app.notify_user(_assigner_user, 'task', 'New comment on a task',
      coalesce(_author, 'Somebody') || ' commented on "' || _t.title || '": ' || left(btrim(new.body), 120),
      'tasks', new.task_id);
  end if;

  return new;
end $$;

drop trigger if exists trg_task_comments_notify on public.task_comments;
create trigger trg_task_comments_notify
  after insert on public.task_comments
  for each row execute function app.tg_notify_task_comment();

-- ---------------------------------------------------------------------------
-- realtime: a conversation that needs a refresh is not a conversation
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_comments'
  ) then
    alter publication supabase_realtime add table public.task_comments;
  end if;
  alter table public.task_comments replica identity full;
end $$;

commit;
