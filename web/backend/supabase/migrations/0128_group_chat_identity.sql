-- Group pictures use the existing private chat-media bucket and membership policies.
-- Direct messages continue to display employee identities; API clients can edit only group
-- names and pictures. Conversation kind, authorship and activity remain server-owned.
begin;

alter table public.conversations add column if not exists photo_path text;
alter table public.conversations drop constraint if exists conversation_group_photo_path;
alter table public.conversations add constraint conversation_group_photo_path check (
  photo_path is null or (
    kind = 'group' and photo_path ~ ('^' || id::text || '/group-photo/[A-Za-z0-9_.-]+$')
  )
);
revoke update on public.conversations from authenticated;
grant update (title, photo_path) on public.conversations to authenticated;
drop policy if exists conversations_update on public.conversations;
create policy conversations_update on public.conversations for update to authenticated
  using (kind = 'group' and app.is_conversation_member(id))
  with check (kind = 'group' and app.is_conversation_member(id));

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
  last_msg.deleted_at is not null as last_deleted,
  c.photo_path
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


create or replace view public.conversation_overview
with (security_invoker = true) as
select
  c.id,
  c.kind,
  c.title,
  c.created_by,
  c.created_at,
  c.last_message_at,
  last_msg.body      as last_body,
  last_msg.kind      as last_kind,
  last_msg.sender_id as last_sender_id,
  last_msg.deleted_at is not null as last_deleted,
  c.photo_path
from public.conversations c
left join lateral (
  select m.body, m.kind, m.sender_id, m.deleted_at
    from public.messages m
   where m.conversation_id = c.id
   order by m.created_at desc
   limit 1
) last_msg on true;

grant select on public.conversation_overview to authenticated;


commit;
