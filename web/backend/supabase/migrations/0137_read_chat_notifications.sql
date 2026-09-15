-- Reading a conversation clears its corresponding message notification in the same transaction.
-- Delivery alone, a pending request, a partially read thread, and another user's notifications
-- remain untouched. Home reads actual inbox counts; the bell and notification history now agree.
begin;

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

  -- Message insertion locks this same conversation in trg_conversations_touch before refreshing
  -- its notification. Serialize here so a receipt cannot clear a concurrently refreshed preview.
  select c.request_status = 'accepted' into _allow_seen from public.conversations c
    where c.id = _conversation_id for update;

  -- Server-owned rows determine the cursor. Sender messages cannot advance recipient receipts,
  -- and a future-dated legacy row cannot cause acknowledgments of messages that do not exist yet.
  select m.created_at, m.id into _latest_at, _latest_id from public.messages m
    where m.conversation_id = _conversation_id and m.id = any(_message_ids)
      and m.sender_id <> _me and m.created_at <= clock_timestamp()
    order by m.created_at desc, m.id desc limit 1;
  if _latest_id is null then return; end if;

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
    -- One notification represents the conversation's latest unread activity. Keep it while any
    -- incoming message is still unread, including a later UUID sharing the same timestamp.
    update public.notifications n set read_at = clock_timestamp()
      from public.conversation_members cm
      where n.user_id = auth.uid() and n.type = 'message' and n.tab = 'messages'
        and n.ref_id = _conversation_id and n.read_at is null
        and cm.conversation_id = _conversation_id and cm.employee_id = _me
        and not exists (
          select 1 from public.messages m
          where m.conversation_id = _conversation_id and m.sender_id <> _me and m.deleted_at is null
            and (cm.last_read_at is null or m.created_at > cm.last_read_at
              or (m.created_at = cm.last_read_at and m.id > cm.last_read_message_id))
        );
  end if;
end;
$$;

revoke all on function public.acknowledge_message_receipts(uuid, uuid[], boolean) from public, anon;
grant execute on function public.acknowledge_message_receipts(uuid, uuid[], boolean) to authenticated;

-- Repair the stale notifications already left by earlier clients. Lock each conversation before
-- checking its latest messages, using a fresh statement snapshot after any concurrent send finishes.
do $$
declare _conversation uuid;
begin
  for _conversation in
    select distinct n.ref_id from public.notifications n
      join public.conversations c on c.id = n.ref_id and c.request_status = 'accepted'
      where n.type = 'message' and n.tab = 'messages' and n.read_at is null
      order by n.ref_id
  loop
    perform 1 from public.conversations c where c.id = _conversation for update;
    update public.notifications n set read_at = clock_timestamp()
      from public.conversation_members cm join public.employees e on e.id = cm.employee_id
      where n.user_id = e.user_id and n.type = 'message' and n.tab = 'messages'
        and n.ref_id = _conversation and n.read_at is null and cm.conversation_id = _conversation
        and not exists (
          select 1 from public.messages m
          where m.conversation_id = _conversation and m.sender_id <> cm.employee_id and m.deleted_at is null
            and (cm.last_read_at is null or m.created_at > cm.last_read_at
              or (m.created_at = cm.last_read_at and m.id > cm.last_read_message_id))
        );
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
