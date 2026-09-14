-- Pins and favourites belong to the employee who sets them. Conversation monitoring never
-- grants access to another person's preferences, and membership removal deletes those choices.
begin;

create table if not exists public.chat_preferences (
  employee_id uuid not null,
  conversation_id uuid not null,
  is_pinned boolean not null default false,
  is_favourite boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (employee_id, conversation_id),
  foreign key (conversation_id, employee_id)
    references public.conversation_members(conversation_id, employee_id) on delete cascade
);

alter table public.chat_preferences enable row level security;
drop policy if exists chat_preferences_select on public.chat_preferences;
create policy chat_preferences_select on public.chat_preferences for select to authenticated
  using (employee_id = app.current_employee_id() and app.is_conversation_member(conversation_id));
-- The RPC is the only client mutation route; no client-supplied employee identifier is trusted.
revoke all on public.chat_preferences from public, anon, authenticated;
grant select on public.chat_preferences to authenticated;

create or replace function public.set_chat_preference(
  _conversation_id uuid, _is_pinned boolean default null, _is_favourite boolean default null
) returns table (conversation_id uuid, is_pinned boolean, is_favourite boolean)
language plpgsql security definer set search_path = pg_catalog as $$
declare _employee_id uuid := app.current_employee_id();
begin
  if auth.uid() is null or _employee_id is null then
    raise exception using errcode = '42501', message = 'sign in as an employee to change chat preferences';
  end if;
  if _conversation_id is null then
    raise exception using errcode = '22023', message = 'a conversation is required';
  end if;
  -- Hold the membership until the preference write commits. An administrator who can read a
  -- conversation but has not joined it has no personal settings for that conversation.
  perform 1 from public.conversation_members cm
    where cm.conversation_id = _conversation_id and cm.employee_id = _employee_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'only conversation members can change chat preferences';
  end if;
  if _is_pinned is null and _is_favourite is null then
    raise exception using errcode = '22023', message = 'choose a chat preference to update';
  end if;

  -- Merge on the server so changing one flag never overwrites a concurrent change to the other.
  return query insert into public.chat_preferences as pref (
    employee_id, conversation_id, is_pinned, is_favourite
  ) values (_employee_id, _conversation_id, coalesce(_is_pinned, false), coalesce(_is_favourite, false))
  on conflict on constraint chat_preferences_pkey do update set
    is_pinned = coalesce(_is_pinned, pref.is_pinned),
    is_favourite = coalesce(_is_favourite, pref.is_favourite),
    updated_at = now()
  returning pref.conversation_id, pref.is_pinned, pref.is_favourite;
end $$;

revoke all on function public.set_chat_preference(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_chat_preference(uuid, boolean, boolean) to authenticated;
comment on table public.chat_preferences is
  'Private employee pins and favourites for conversations they belong to. Not included in monitoring access.';
comment on function public.set_chat_preference(uuid, boolean, boolean) is
  'Set the authenticated employee''s chat preferences. Omitted/null flags keep existing values; explicit false clears a flag.';

-- Search the authorized conversation's full history, not just messages loaded in the browser.
-- The literal substring match treats %, _ and * as ordinary text rather than query wildcards.
create or replace function public.search_chat_messages(
  _conversation_id uuid, _query text, _before_at timestamptz default null,
  _before_id uuid default null, _limit integer default 51
) returns setof public.messages language plpgsql stable security definer set search_path = pg_catalog as $$
declare _search text := lower(regexp_replace(coalesce(_query, ''), '^\s+|\s+$', '', 'g'));
begin
  if auth.uid() is null or not app.can_read_conversation(_conversation_id) then
    raise exception using errcode = '42501', message = 'you are not allowed to search this conversation';
  end if;
  if (_before_at is null) <> (_before_id is null) then
    raise exception using errcode = '22023', message = 'both search cursor fields are required';
  end if;
  if _search = '' then return; end if;
  return query select m.* from public.messages m
    where m.conversation_id = _conversation_id and m.deleted_at is null
      and strpos(lower(coalesce(m.body, '')), _search) > 0
      and (_before_at is null or (m.created_at, m.id) < (_before_at, _before_id))
    order by m.created_at desc, m.id desc
    limit greatest(1, least(51, coalesce(_limit, 51)));
end $$;
revoke all on function public.search_chat_messages(uuid, text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.search_chat_messages(uuid, text, timestamptz, uuid, integer) to authenticated;
comment on function public.search_chat_messages(uuid, text, timestamptz, uuid, integer) is
  'Search non-deleted messages with a literal case-insensitive substring, authorized by conversation access, newest first with a paired timestamp/UUID cursor.';

notify pgrst, 'reload schema';
commit;
