-- A task participant may read its comments without permission to read another participant's
-- employee record. Keep only the display name on the comment, under the existing task RLS.
-- Resolve it on the server so a client cannot impersonate another employee. Historical names
-- survive a later employee/account unlink or deletion. Safe to re-run.
begin;

alter table public.task_comments add column if not exists author_name text;
comment on column public.task_comments.author_name is
  'Server-resolved display name when the comment was posted; visible only with the task.';
drop trigger if exists task_comment_author on public.task_comments;

-- Older clients sometimes posted without author_id (and administrators need not be employees).
-- Prefer the account's employee link, retaining the original employee as a historical fallback.
with names as (
  select c.id, coalesce(
    nullif(btrim(e.full_name), ''), nullif(btrim(original.full_name), ''),
    nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
    nullif(btrim(u.raw_user_meta_data->>'name'), ''),
    nullif(btrim(u.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(u.email, '@', 1), '')
  ) as name
  from public.task_comments c
  left join public.profiles p on p.user_id = c.author_user
  left join lateral (
    select employee.full_name from public.employees employee
    where employee.id = p.employee_id or employee.user_id = c.author_user
    order by (employee.id = p.employee_id) desc nulls last, employee.created_at, employee.id
    limit 1
  ) e on true
  left join public.employees original on original.id = c.author_id
  left join auth.users u on u.id = c.author_user
  where c.author_name is null
)
update public.task_comments c set author_name = names.name
from names where c.id = names.id and names.name is not null;

create or replace function app.tg_task_comment_author()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if tg_op = 'UPDATE' then
    if new.author_user is distinct from old.author_user
      or new.author_name is distinct from old.author_name
      -- ON DELETE SET NULL must still work when an employee is removed.
      or (new.author_id is not null and new.author_id is distinct from old.author_id) then
      raise exception 'A comment author cannot be changed.' using errcode = '42501';
    end if;
    return new;
  end if;

  select e.id, nullif(btrim(e.full_name), '') into new.author_id, new.author_name
  from public.employees e
  left join public.profiles p on p.user_id = new.author_user
  where e.id = p.employee_id or e.user_id = new.author_user
  order by (e.id = p.employee_id) desc nulls last, e.created_at, e.id
  limit 1;

  if new.author_name is null then
    select coalesce(
      nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
      nullif(btrim(u.raw_user_meta_data->>'name'), ''),
      nullif(btrim(u.raw_user_meta_data->>'display_name'), ''),
      nullif(split_part(u.email, '@', 1), '')
    ) into new.author_name from auth.users u where u.id = new.author_user;
  end if;
  return new;
end $$;
revoke all on function app.tg_task_comment_author() from public, anon, authenticated;

create trigger task_comment_author before insert or update on public.task_comments
  for each row execute function app.tg_task_comment_author();

commit;
