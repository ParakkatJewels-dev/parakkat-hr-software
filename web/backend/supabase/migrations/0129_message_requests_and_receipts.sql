-- New cross-branch direct conversations start as recipient-approved message requests.
-- Existing direct conversations and groups remain accepted. Receipt cursors advance only through
-- an authenticated recipient acknowledging real messages; API clients cannot forge their dates.
begin;

alter table public.conversations
  add column if not exists request_status text not null default 'accepted',
  add column if not exists request_recipient_id uuid references public.employees(id) on delete set null;
alter table public.conversations drop constraint if exists conversations_request_status_check;
alter table public.conversations add constraint conversations_request_status_check check (
  request_status in ('accepted', 'pending', 'declined')
  and (kind = 'direct' or (request_status = 'accepted' and request_recipient_id is null and direct_key is null))
);
create index if not exists conversations_request_recipient_idx
  on public.conversations (request_recipient_id, last_message_at desc)
  where request_status = 'pending';

alter table public.conversation_members
  add column if not exists last_delivered_at timestamptz,
  add column if not exists last_delivered_message_id uuid,
  add column if not exists last_read_message_id uuid;
-- A legacy read position already establishes delivery. A NULL cursor id denotes an inclusive
-- timestamp from the old client; new acknowledgments also store the UUID to resolve timestamp ties.
update public.conversation_members set last_delivered_at = last_read_at
 where last_delivered_at is null and last_read_at is not null;

create or replace function app.can_send_conversation(_conversation uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.is_conversation_member(_conversation) and exists (
    select 1 from public.conversations c where c.id = _conversation and (
      c.request_status = 'accepted'
      or (c.kind = 'direct' and c.request_status = 'pending' and c.created_by = app.current_employee_id())
    )
  );
$$;

create or replace function app.can_manage_group_members(_conversation uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select exists (select 1 from public.conversations c where c.id = _conversation and c.kind = 'group')
    and (app.is_conversation_member(_conversation) or app.is_conversation_creator(_conversation));
$$;
revoke all on function app.can_send_conversation(uuid), app.can_manage_group_members(uuid) from public, anon;
grant execute on function app.can_send_conversation(uuid), app.can_manage_group_members(uuid) to authenticated;

-- Direct conversations and their two memberships are created atomically by the RPC below.
-- Removing either direct membership, adding a third, or rewriting the request state via tables
-- would otherwise bypass the recipient's choice. Group creation and membership management remain.
drop policy if exists conversations_insert on public.conversations;
create policy conversations_insert on public.conversations for insert to authenticated
  with check (kind = 'group' and created_by = app.current_employee_id()
    and direct_key is null and request_status = 'accepted' and request_recipient_id is null);
revoke insert on public.conversations from authenticated;
grant insert (id, kind, title, created_by, direct_key, photo_path) on public.conversations to authenticated;
-- Restore only the established group identity editing surface on reruns as well.
revoke update on public.conversations from authenticated;
grant update (title, photo_path) on public.conversations to authenticated;

drop policy if exists conversation_members_insert on public.conversation_members;
create policy conversation_members_insert on public.conversation_members for insert to authenticated
  with check (app.can_manage_group_members(conversation_id));
drop policy if exists conversation_members_delete on public.conversation_members;
create policy conversation_members_delete on public.conversation_members for delete to authenticated
  using (app.can_manage_group_members(conversation_id));
revoke insert, update on public.conversation_members from authenticated;
grant insert (conversation_id, employee_id, role) on public.conversation_members to authenticated;
-- No direct table receipt updates: SECURITY DEFINER acknowledgment below updates only its caller.
drop policy if exists conversation_members_update on public.conversation_members;

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = app.current_employee_id() and app.can_send_conversation(conversation_id));
revoke insert, update on public.messages from authenticated;
grant insert (id, conversation_id, sender_id, kind, body, storage_path, mime_type, byte_size, duration_ms, reply_to)
  on public.messages to authenticated;
grant update (body, edited_at, deleted_at) on public.messages to authenticated;
-- A message's creation time is assigned by the server, including separate rows in one transaction.
alter table public.messages alter column created_at set default clock_timestamp();

-- A declined sender cannot continue communicating by rewriting or restoring their earlier
-- request. Taking back an existing message is still allowed by the own-message UPDATE policy.
create or replace function app.tg_guard_message_content_edit()
returns trigger language plpgsql set search_path = pg_catalog, public, app as $$
begin
  if auth.uid() is not null and (
    new.body is distinct from old.body or new.edited_at is distinct from old.edited_at
    or (old.deleted_at is not null and new.deleted_at is null)
  ) and not app.can_send_conversation(old.conversation_id) then
    raise exception 'This conversation is not open for sending messages.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_messages_guard_content_edit on public.messages;
create trigger trg_messages_guard_content_edit before update on public.messages
  for each row execute function app.tg_guard_message_content_edit();

drop policy if exists chat_media_write on storage.objects;
create policy chat_media_write on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and app.can_send_conversation(app.chat_media_conversation(name)));

create or replace function public.start_direct_conversation(_employee_id uuid)
returns uuid language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare
  _me uuid := app.current_employee_id();
  _my_branch uuid;
  _their_branch uuid;
  _key text;
  _conversation uuid;
  _cross_branch boolean;
begin
  if auth.uid() is null or _me is null then
    raise exception 'Your account is not linked to an employee record.' using errcode = '42501';
  end if;
  if _employee_id is null or _employee_id = _me then
    raise exception 'Choose another colleague to start a conversation.' using errcode = '22023';
  end if;
  select e.branch_id into _my_branch from public.employees e where e.id = _me and e.status = 'Active';
  if not found then raise exception 'An active employee account is required.' using errcode = '42501'; end if;
  select e.branch_id into _their_branch from public.employees e where e.id = _employee_id and e.status = 'Active';
  if not found then raise exception 'This colleague is not available for messaging.' using errcode = '22023'; end if;

  _cross_branch := _my_branch is distinct from _their_branch;
  _key := least(_me::text, _employee_id::text) || ':' || greatest(_me::text, _employee_id::text);
  insert into public.conversations (kind, direct_key, created_by, request_status, request_recipient_id)
  values ('direct', _key, _me, case when _cross_branch then 'pending' else 'accepted' end,
          case when _cross_branch then _employee_id else null end)
  on conflict (direct_key) where direct_key is not null do nothing returning id into _conversation;
  if _conversation is null then
    select c.id into _conversation from public.conversations c where c.direct_key = _key and c.kind = 'direct' for update;
    if _conversation is null then raise exception 'This conversation could not be opened.' using errcode = '22023'; end if;
    -- Preserve existing accepted/request state, including a prior decline. Never accept a request
    -- merely because its recipient also searches for the sender or opens the conversation.
    if exists (select 1 from public.conversation_members cm
      where cm.conversation_id = _conversation and cm.employee_id not in (_me, _employee_id)) then
      raise exception 'This conversation has invalid direct membership.' using errcode = '42501';
    end if;
  end if;
  -- Also repair old conversations stranded by the former two-request creation flow.
  insert into public.conversation_members (conversation_id, employee_id, role)
  values (_conversation, _me, case when exists (
    select 1 from public.conversations c where c.id = _conversation and c.created_by = _me
  ) then 'owner' else 'member' end),
  (_conversation, _employee_id, case when exists (
    select 1 from public.conversations c where c.id = _conversation and c.created_by = _employee_id
  ) then 'owner' else 'member' end)
  on conflict (conversation_id, employee_id) do nothing;
  return _conversation;
end;
$$;

create or replace function public.respond_to_message_request(_conversation_id uuid, _accept boolean)
returns void language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare
  _me uuid := app.current_employee_id();
  _conversation public.conversations%rowtype;
begin
  if auth.uid() is null or _me is null or _accept is null then
    raise exception 'A signed-in recipient must choose a response.' using errcode = '42501';
  end if;
  select * into _conversation from public.conversations where id = _conversation_id for update;
  if not found or _conversation.kind <> 'direct' or _conversation.request_recipient_id is distinct from _me
     or not app.is_conversation_member(_conversation_id) then
    raise exception 'Only the recipient can respond to this message request.' using errcode = '42501';
  end if;
  if _conversation.request_status <> 'pending' then
    if _conversation.request_status = (case when _accept then 'accepted' else 'declined' end) then return; end if;
    raise exception 'This message request has already been answered.' using errcode = '22023';
  end if;
  update public.conversations set request_status = case when _accept then 'accepted' else 'declined' end
    where id = _conversation_id;
end;
$$;

-- The messaging picker must span branches without expanding employee/HR table permissions.
-- Table-returning RPC permits ordinary PostgREST range pagination, with no fixed directory cap.
create or replace function public.messaging_directory(_query text default '')
returns table (id uuid, full_name text, employee_code text, branch_id uuid, branch_code text)
language plpgsql stable security definer set search_path = pg_catalog, public, app as $$
begin
  if auth.uid() is null or app.current_employee_id() is null then
    raise exception 'A linked employee account is required.' using errcode = '42501';
  end if;
  return query select e.id, e.full_name, e.employee_code, e.branch_id, b.code
    from public.employees e left join public.branches b on b.id = e.branch_id
    where e.status = 'Active' and e.id <> app.current_employee_id()
      and (coalesce(btrim(_query), '') = ''
        or e.full_name ilike '%' || left(btrim(_query), 200) || '%'
        or e.employee_code ilike '%' || left(btrim(_query), 200) || '%'
        or b.code ilike '%' || left(btrim(_query), 200) || '%')
    order by e.full_name, e.id;
end;
$$;

-- Safe identities and receipts for conversations the caller can already read. Inactive former
-- participants remain named in their history; the directory above offers active colleagues only.
create or replace function public.messaging_members(_conversation_ids uuid[])
returns table (conversation_id uuid, employee_id uuid, role text, joined_at timestamptz,
  last_delivered_at timestamptz, last_delivered_message_id uuid,
  last_read_at timestamptz, last_read_message_id uuid, employee jsonb)
language plpgsql stable security definer set search_path = pg_catalog, public, app as $$
begin
  if auth.uid() is null then raise exception 'Sign in to view conversation members.' using errcode = '42501'; end if;
  return query select cm.conversation_id, cm.employee_id, cm.role, cm.joined_at,
    cm.last_delivered_at, cm.last_delivered_message_id, cm.last_read_at, cm.last_read_message_id,
    jsonb_build_object('id', e.id, 'full_name', e.full_name, 'employee_code', e.employee_code,
      'branch', case when b.id is null then null else jsonb_build_object('code', b.code) end)
    from public.conversation_members cm join public.employees e on e.id = cm.employee_id
    left join public.branches b on b.id = e.branch_id
    where cm.conversation_id = any(_conversation_ids) and app.can_read_conversation(cm.conversation_id)
    order by cm.conversation_id, cm.employee_id;
end;
$$;

create or replace function public.acknowledge_message_receipts(
  _conversation_id uuid, _message_ids uuid[], _seen boolean default false
)
returns void language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare
  _me uuid := app.current_employee_id();
  _latest_at timestamptz;
  _latest_id uuid;
  _allow_seen boolean;
begin
  if auth.uid() is null or _me is null or not app.is_conversation_member(_conversation_id) then
    raise exception 'Only a conversation member can acknowledge their messages.' using errcode = '42501';
  end if;
  if coalesce(cardinality(_message_ids), 0) = 0 then return; end if;
  if cardinality(_message_ids) > 1000 then
    raise exception 'Acknowledge at most 1000 messages at a time.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(_message_ids) supplied(id) where supplied.id is null or not exists (
    select 1 from public.messages m where m.id = supplied.id and m.conversation_id = _conversation_id
  )) then raise exception 'Messages must belong to this conversation.' using errcode = '22023'; end if;

  -- Server-owned rows determine the cursor. Sender messages cannot advance recipient receipts,
  -- and a future-dated legacy row cannot cause acknowledgments of messages that do not exist yet.
  select m.created_at, m.id into _latest_at, _latest_id from public.messages m
    where m.conversation_id = _conversation_id and m.id = any(_message_ids)
      and m.sender_id <> _me and m.created_at <= clock_timestamp()
    order by m.created_at desc, m.id desc limit 1;
  if _latest_id is null then return; end if;
  select c.request_status = 'accepted' into _allow_seen from public.conversations c where c.id = _conversation_id;

  update public.conversation_members cm set last_delivered_at = _latest_at, last_delivered_message_id = _latest_id
    where cm.conversation_id = _conversation_id and cm.employee_id = _me
      and (cm.last_delivered_at is null or cm.last_delivered_at < _latest_at
        or (cm.last_delivered_at = _latest_at and cm.last_delivered_message_id is not null
          and cm.last_delivered_message_id < _latest_id));
  -- Opening a request can acknowledge delivery, but it cannot expose a Seen receipt before consent.
  if coalesce(_seen, false) and _allow_seen then
    update public.conversation_members cm set last_read_at = _latest_at, last_read_message_id = _latest_id
      where cm.conversation_id = _conversation_id and cm.employee_id = _me
        and (cm.last_read_at is null or cm.last_read_at < _latest_at
          or (cm.last_read_at = _latest_at and cm.last_read_message_id is not null
            and cm.last_read_message_id < _latest_id));
  end if;
end;
$$;

-- SECURITY DEFINER entry points are never anonymously executable, including on migration reruns.
revoke all on function public.start_direct_conversation(uuid),
  public.respond_to_message_request(uuid, boolean), public.messaging_directory(text),
  public.messaging_members(uuid[]), public.acknowledge_message_receipts(uuid, uuid[], boolean)
  from public, anon;
grant execute on function public.start_direct_conversation(uuid),
  public.respond_to_message_request(uuid, boolean), public.messaging_directory(text),
  public.messaging_members(uuid[]), public.acknowledge_message_receipts(uuid, uuid[], boolean)
  to authenticated;

create or replace view public.my_conversations
with (security_invoker = true) as
select c.id, c.kind, c.title, c.created_by, c.created_at, c.last_message_at, cm.last_read_at,
  (select count(*) from public.messages m where m.conversation_id = c.id
    and (m.created_at > cm.last_read_at
      or (m.created_at = cm.last_read_at and m.id > cm.last_read_message_id))
    and m.sender_id <> cm.employee_id and m.deleted_at is null) as unread_count,
  last_msg.body as last_body, last_msg.kind as last_kind, last_msg.sender_id as last_sender_id,
  last_msg.deleted_at is not null as last_deleted, c.photo_path,
  c.request_status, c.request_recipient_id,
  last_msg.id as last_message_id, last_msg.created_at as last_message_created_at,
  cm.last_delivered_at, cm.last_delivered_message_id, cm.last_read_message_id,
  incoming.id as last_incoming_message_id, incoming.created_at as last_incoming_message_created_at
from public.conversations c join public.conversation_members cm
  on cm.conversation_id = c.id and cm.employee_id = app.current_employee_id()
left join lateral (
  select m.id, m.body, m.kind, m.sender_id, m.deleted_at, m.created_at from public.messages m
    where m.conversation_id = c.id order by m.created_at desc, m.id desc limit 1
) last_msg on true
left join lateral (
  select m.id, m.created_at from public.messages m
    where m.conversation_id = c.id and m.sender_id <> cm.employee_id
    order by m.created_at desc, m.id desc limit 1
) incoming on true;
grant select on public.my_conversations to authenticated;

create or replace view public.conversation_overview
with (security_invoker = true) as
select c.id, c.kind, c.title, c.created_by, c.created_at, c.last_message_at,
  last_msg.body as last_body, last_msg.kind as last_kind, last_msg.sender_id as last_sender_id,
  last_msg.deleted_at is not null as last_deleted, c.photo_path,
  c.request_status, c.request_recipient_id,
  last_msg.id as last_message_id, last_msg.created_at as last_message_created_at
from public.conversations c
left join lateral (
  select m.id, m.body, m.kind, m.sender_id, m.deleted_at, m.created_at from public.messages m
    where m.conversation_id = c.id order by m.created_at desc, m.id desc limit 1
) last_msg on true;
grant select on public.conversation_overview to authenticated;

notify pgrst, 'reload schema';
commit;
