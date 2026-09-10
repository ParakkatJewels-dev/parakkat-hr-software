-- 0115 — A place to talk.
--
-- Everything in this app so far is a conversation ABOUT a record: a comment on a task, a note on a
-- leave request. There has been nowhere to simply talk to somebody, so people have been doing it on
-- WhatsApp, where the company has no copy of it and an employee who leaves takes the history with
-- them.
--
-- Three tables. A conversation is either between two people or among a group; membership is its own
-- table because that is the question every policy asks; messages hang off the conversation.
--
-- DECISIONS BAKED IN HERE, because they are expensive to change later
--
--   * A SUPER ADMIN CAN READ EVERY CONVERSATION. Asked and answered by the owner. It is written
--     into the select policies below rather than bolted on, and staff should be told it is the
--     case — a promise of privacy that turns out to be false later is worse than never making it.
--     Nobody else can read a conversation they are not in, including entity admins and HR.
--
--   * Anybody may start a conversation with anybody. Not scoped by branch or department: the whole
--     point is reaching a colleague, and an internal directory that will not let Kochi message
--     Kollam is a directory people work around rather than use.
--
--   * Messages are soft-deleted. A hole in a thread reads as a bug; "this message was deleted"
--     reads as what happened. It also means a deleted message is still there for the super admin
--     the paragraph above describes, which is the honest consequence of that decision.
--
--   * The media columns are here NOW even though the first release only sends text. They cost
--     nothing empty, and adding them later means a second migration against a table that by then
--     has rows in it and a realtime publication pointed at it.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. A conversation
-- ---------------------------------------------------------------------------------------------

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'direct' check (kind in ('direct', 'group')),
  -- Groups are named. A direct conversation is named by whoever is in it, so a title would only be
  -- one more thing to keep in step with the two people's names.
  title       text check (title is null or length(btrim(title)) between 1 and 120),
  created_by  uuid references public.employees(id) on delete set null,

  /*
   * The pair, sorted, for a direct conversation — 'aaa…:bbb…' with the lower uuid first.
   *
   * Two people pressing "message" on each other at the same moment would otherwise open two
   * separate threads between the same pair, and neither would contain the other's replies. Sorting
   * makes the key identical whichever of them acts first, and the unique index below makes the
   * second insert fail loudly instead of quietly creating a duplicate.
   */
  direct_key  text,

  -- Denormalised so the conversation LIST can sort without touching messages. Maintained by
  -- trg_conversations_touch below.
  last_message_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create unique index if not exists conversations_direct_key_idx
  on public.conversations (direct_key) where direct_key is not null;
create index if not exists conversations_recent_idx
  on public.conversations (last_message_at desc);

alter table public.conversations enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 2. Who is in it
-- ---------------------------------------------------------------------------------------------

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  employee_id     uuid not null references public.employees(id)     on delete cascade,
  role            text not null default 'member' check (role in ('member', 'owner')),
  /*
   * How far this person has read.
   *
   * One timestamp per person per conversation, not a receipt per message per person. For a company
   * of this size the second shape is thousands of rows a day to answer a question — "is there
   * anything new" — that a single timestamp answers exactly. It cannot say WHO read a given
   * message, which is a feature nobody asked for and a surveillance question nobody wants.
   */
  last_read_at    timestamptz not null default now(),
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, employee_id)
);

-- The conversation list is "every conversation I am in", which is a lookup by person.
create index if not exists conversation_members_employee_idx
  on public.conversation_members (employee_id);

alter table public.conversation_members enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 3. The messages
-- ---------------------------------------------------------------------------------------------

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references public.employees(id)     on delete cascade,

  kind            text not null default 'text'
                    check (kind in ('text', 'image', 'video', 'file', 'voice')),
  -- The words. Present on a text message, and optional as a caption on the others.
  body            text check (body is null or length(body) <= 4000),

  -- Media (unused until the next release; see the header for why they are here already).
  storage_path    text,
  mime_type       text,
  byte_size       bigint,
  -- Voice and video only. Lets the bubble draw "0:14" before the file itself is fetched.
  duration_ms     integer,

  reply_to        uuid references public.messages(id) on delete set null,

  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  -- Soft delete: the row stays so the thread keeps its shape and says what happened.
  deleted_at      timestamptz,

  -- A message has to BE something. Text needs words; every other kind needs a file. Without this a
  -- failed upload can leave an empty bubble in the thread that nothing can render.
  constraint message_has_content check (
    (kind = 'text' and body is not null and length(btrim(body)) > 0)
    or (kind <> 'text' and storage_path is not null)
  )
);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at desc);

alter table public.messages enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 4. Helpers
--
-- SECURITY DEFINER for the same reason 0114's are: conversations' policy asks about membership and
-- conversation_members' policy asks about the conversation, so plain subqueries would re-enter RLS
-- on each other and recurse. A definer function reads past RLS once and answers a boolean.
-- ---------------------------------------------------------------------------------------------

create or replace function app.is_conversation_member(_conversation uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select _conversation is not null and exists (
    select 1 from public.conversation_members cm
     where cm.conversation_id = _conversation
       and cm.employee_id = app.current_employee_id()
  );
$$;

/*
 * May this person read this conversation at all?
 *
 * Membership, or super admin. Named separately from is_conversation_member because the difference
 * matters: reading is allowed to the super admin, WRITING is not. Nobody gets to post as somebody
 * else's conversation partner, and an oversight power that can also speak is a different and much
 * worse thing than one that can only read.
 */
create or replace function app.can_read_conversation(_conversation uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.is_super_admin() or app.is_conversation_member(_conversation);
$$;

grant execute on function app.is_conversation_member(uuid) to authenticated;
grant execute on function app.can_read_conversation(uuid)  to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Policies
-- ---------------------------------------------------------------------------------------------

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (app.can_read_conversation(id));

/*
 * Starting one.
 *
 * `created_by` must be you. The membership rows cannot exist yet — the conversation has no id until
 * this statement returns — so the check is on authorship, and conversation_members_insert below
 * lets the author add the people immediately after.
 */
drop policy if exists conversations_insert on public.conversations;
create policy conversations_insert on public.conversations for insert to authenticated
  with check (created_by = app.current_employee_id());

-- Renaming a group. Members only: a super admin may read the room, not retitle it.
drop policy if exists conversations_update on public.conversations;
create policy conversations_update on public.conversations for update to authenticated
  using (app.is_conversation_member(id))
  with check (app.is_conversation_member(id));

drop policy if exists conversation_members_select on public.conversation_members;
create policy conversation_members_select on public.conversation_members for select to authenticated
  using (app.can_read_conversation(conversation_id));

/*
 * Adding somebody: you are already in it, or you are the person who just created it.
 *
 * The second arm is what makes creating a conversation possible at all, and it is narrow — it reads
 * created_by off the row, so it only ever applies to a conversation this person authored.
 */
drop policy if exists conversation_members_insert on public.conversation_members;
create policy conversation_members_insert on public.conversation_members for insert to authenticated
  with check (
       app.is_conversation_member(conversation_id)
    or exists (
         select 1 from public.conversations c
          where c.id = conversation_id and c.created_by = app.current_employee_id()
       )
  );

-- Marking your place. Only ever your own row: last_read_at is the one column here that a person
-- writes constantly, and nobody else's reading position is theirs to move.
drop policy if exists conversation_members_update on public.conversation_members;
create policy conversation_members_update on public.conversation_members for update to authenticated
  using (employee_id = app.current_employee_id())
  with check (employee_id = app.current_employee_id());

-- Leaving, or removing somebody from a group you are in.
drop policy if exists conversation_members_delete on public.conversation_members;
create policy conversation_members_delete on public.conversation_members for delete to authenticated
  using (app.is_conversation_member(conversation_id));

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (app.can_read_conversation(conversation_id));

/*
 * Sending. Both halves matter.
 *
 * `is_conversation_member` and NOT `can_read_conversation`: a super admin reads every room and must
 * not be able to speak in one. `sender_id = me` stops anybody putting words in a colleague's mouth
 * — without it, being in a group would be enough to post as any other member of it.
 */
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    app.is_conversation_member(conversation_id)
    and sender_id = app.current_employee_id()
  );

-- Editing and deleting are your own words only, whoever else is in the room.
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (sender_id = app.current_employee_id())
  with check (sender_id = app.current_employee_id());

-- No delete policy at all, deliberately: messages are soft-deleted through messages_update, so
-- there is no way to actually remove a row and leave a hole in somebody else's thread.

-- ---------------------------------------------------------------------------------------------
-- 6. Keeping the conversation list in order
-- ---------------------------------------------------------------------------------------------

create or replace function app.tg_conversation_touch()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id;
  return new;
end $$;

drop trigger if exists trg_conversations_touch on public.messages;
create trigger trg_conversations_touch
  after insert on public.messages
  for each row execute function app.tg_conversation_touch();

-- ---------------------------------------------------------------------------------------------
-- 7. Telling somebody they were spoken to
--
-- The in-app bell, which is what exists today. Real push to a locked phone is a later piece of work
-- and needs Firebase and Apple credentials that do not live in this repository.
--
-- One notification per other member PER CONVERSATION, refreshed rather than repeated — see the
-- function for why a chat cannot notify the way a leave approval does. The sender never gets one
-- about their own message.
-- ---------------------------------------------------------------------------------------------

create or replace function app.tg_notify_message()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _sender text; _kind text; _preview text; _rec record; _actor uuid;
begin
  _actor := auth.uid();
  select e.full_name into _sender from public.employees e where e.id = new.sender_id;

  -- A media message has no words to preview, and a long one should not become a long notification.
  _kind := case new.kind
             when 'image' then 'sent a photo'
             when 'video' then 'sent a video'
             when 'voice' then 'sent a voice note'
             when 'file'  then 'sent a file'
             else null
           end;
  _preview := coalesce(_kind, left(new.body, 120));

  for _rec in
    select cm.employee_id, e.user_id
      from public.conversation_members cm
      join public.employees e on e.id = cm.employee_id
     where cm.conversation_id = new.conversation_id
       and cm.employee_id <> new.sender_id
  loop
    -- Skip the actor, the way app.notify_user does. Not called here because of the collapse below.
    continue when _rec.user_id is null or _rec.user_id = _actor;

    /*
     * ONE bell entry per conversation, refreshed — not one per message.
     *
     * notify_user inserts unconditionally, which is right for a leave approval (it happens once)
     * and wrong for a chat: twenty messages in a group of six is a hundred and twenty rows, and a
     * notification list that is entirely one conversation is a notification list nobody reads.
     *
     * So an UNREAD notification already pointing at this conversation is updated in place — newest
     * preview, moved to the top. Once the person has read it, the next message makes a new one,
     * which is what makes the bell light up again.
     */
    update public.notifications
       set title = coalesce(_sender, 'Somebody'),
           body = _preview,
           created_at = now()
     where user_id = _rec.user_id
       and tab = 'messages'
       and ref_id = new.conversation_id
       and read_at is null;

    if not found then
      insert into public.notifications (user_id, type, title, body, tab, ref_id)
      values (_rec.user_id, 'message', coalesce(_sender, 'Somebody'), _preview,
              'messages', new.conversation_id);
    end if;
  end loop;

  return new;
end $$;

drop trigger if exists trg_messages_notify on public.messages;
create trigger trg_messages_notify
  after insert on public.messages
  for each row execute function app.tg_notify_message();

-- ---------------------------------------------------------------------------------------------
-- 8. Where the media will live
--
-- Private, like every other bucket here — objects are reached through a signed URL, never a public
-- one. The path is `<conversation_id>/<file>`, so the policies below can ask the one question that
-- matters by reading the first folder.
--
-- 25MB: a minute of voice is well under 1MB and a phone photo is 2-5MB, so this is really a bound
-- on video. Larger than the 10MB task-files bucket because a video clip is the point.
-- ---------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media', 'chat-media', false, 26214400,
  array[
    'image/jpeg','image/png','image/webp','image/gif','image/heic',
    'video/mp4','video/quicktime','video/webm',
    'audio/webm','audio/mpeg','audio/mp4','audio/aac','audio/ogg',
    'application/pdf',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','text/csv'
  ]
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/*
 * Reading and writing an object is the same question as reading and writing the conversation.
 *
 * The folder is cast to uuid only when it actually looks like one — a stray object at the bucket
 * root would otherwise make the cast throw, and a policy that errors denies every request against
 * the bucket rather than just that one.
 */
create or replace function app.chat_media_conversation(_name text)
returns uuid language sql immutable as $$
  select case
    when (storage.foldername(_name))[1] ~ '^[0-9a-fA-F-]{36}$'
    then ((storage.foldername(_name))[1])::uuid
    else null
  end;
$$;

grant execute on function app.chat_media_conversation(text) to authenticated;

drop policy if exists chat_media_read on storage.objects;
create policy chat_media_read on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-media'
    and app.can_read_conversation(app.chat_media_conversation(name))
  );

drop policy if exists chat_media_write on storage.objects;
create policy chat_media_write on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    -- Member, not reader: the super admin who can read every room cannot put a file in one.
    and app.is_conversation_member(app.chat_media_conversation(name))
  );

drop policy if exists chat_media_delete on storage.objects;
create policy chat_media_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'chat-media'
    and app.is_conversation_member(app.chat_media_conversation(name))
  );

-- ---------------------------------------------------------------------------------------------
-- 8b. The conversation list, in one query
--
-- The list needs, per conversation: its name, when it last moved, how much of it I have not read,
-- and a one-line preview. Asked from the client that is a query for the conversations and then two
-- more per conversation — twenty rooms is forty-one round trips before the screen can paint.
--
-- security_invoker, so this is NOT a way around the policies above: every table it touches is read
-- as the person querying, so a conversation you are not in contributes nothing. It is a shape, not
-- a grant.
--
-- Note this view is the one place a super admin does NOT see everything, and that is deliberate: it
-- is "my conversations", joined through my own membership row. Reading somebody else's room is a
-- direct query against messages, which is a deliberate act rather than a list that quietly contains
-- the whole company.
-- ---------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------
-- 9. Live delivery
--
-- Without this the app polls and a message takes up to five minutes to appear, which is not a chat.
-- RLS applies to realtime too, so a subscriber is only sent rows they may already read.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_members'
  ) then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
end $$;

commit;
