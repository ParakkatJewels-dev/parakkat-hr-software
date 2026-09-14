-- Ephemeral typing metadata for accepted conversations. No draft text, online status or history.
begin;

create table if not exists public.chat_typing (
  -- Realtime DELETE bypasses RLS. DEFAULT replica identity exposes only this opaque identifier,
  -- never the conversation/employee pair, when a membership cascade removes a row.
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  employee_id uuid not null,
  is_typing boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp(),
  unique (conversation_id, employee_id),
  foreign key (conversation_id, employee_id)
    references public.conversation_members(conversation_id, employee_id) on delete cascade
);
alter table public.chat_typing replica identity default;
alter table public.chat_typing enable row level security;
revoke all on public.chat_typing from public, anon, authenticated;
grant select on public.chat_typing to authenticated;

create or replace function app.can_use_chat_typing(_conversation uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and app.is_conversation_member(_conversation)
    and exists (select 1 from public.conversations c where c.id = _conversation and c.request_status = 'accepted');
$$;
revoke all on function app.can_use_chat_typing(uuid) from public, anon;
grant execute on function app.can_use_chat_typing(uuid) to authenticated;

drop policy if exists chat_typing_read on public.chat_typing;
create policy chat_typing_read on public.chat_typing for select to authenticated using (
  app.can_use_chat_typing(conversation_id) and (not is_typing or expires_at > statement_timestamp())
);

create or replace function public.set_chat_typing(_conversation_id uuid, _typing boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  _me uuid := app.current_employee_id();
  _now timestamptz := clock_timestamp();
begin
  if _typing is null then raise exception 'Typing state must be true or false' using errcode = '22023'; end if;
  if _me is null or not app.can_use_chat_typing(_conversation_id) then
    raise exception 'Only members of an accepted conversation can share typing state' using errcode = '42501';
  end if;
  if _typing then
    insert into public.chat_typing (conversation_id, employee_id, is_typing, updated_at, expires_at)
      values (_conversation_id, _me, true, _now, _now + interval '6 seconds')
    on conflict (conversation_id, employee_id) do update
      set is_typing = true, updated_at = _now, expires_at = _now + interval '6 seconds'
      -- Repeated keystrokes need at most one update every ~2 seconds, including hostile clients.
      where not chat_typing.is_typing or chat_typing.updated_at <= _now - interval '1500 milliseconds';
  else
    update public.chat_typing set is_typing = false, updated_at = _now, expires_at = _now
      where conversation_id = _conversation_id and employee_id = _me and is_typing;
  end if;
end;
$$;
revoke all on function public.set_chat_typing(uuid, boolean) from public, anon;
grant execute on function public.set_chat_typing(uuid, boolean) to authenticated;

create or replace function app.clear_typing_after_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.chat_typing set is_typing = false, updated_at = clock_timestamp(), expires_at = clock_timestamp()
    where conversation_id = new.conversation_id and employee_id = new.sender_id and is_typing;
  return new;
end;
$$;
revoke all on function app.clear_typing_after_message() from public, anon, authenticated;
drop trigger if exists messages_clear_typing on public.messages;
create trigger messages_clear_typing after insert on public.messages for each row execute function app.clear_typing_after_message();

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'chat_typing') then
    alter publication supabase_realtime add table public.chat_typing;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
