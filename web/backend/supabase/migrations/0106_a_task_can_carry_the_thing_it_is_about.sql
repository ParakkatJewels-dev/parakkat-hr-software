-- 0106_a_task_can_carry_the_thing_it_is_about.sql
--
-- "Re-seal the damaged batch" is not much use without the photograph of the damage, and "check the
-- new spec" is not much use without the spec. Both were being sent separately and matched up by
-- memory. A task can now carry them.
--
-- TWO KINDS, ONE TABLE. A link costs nothing and covers most of it (a Drive folder, a Sheet, a
-- supplier page). A file matters when the thing does not live anywhere else — the photo somebody
-- took on the floor. They are one list on screen, so they are one table with a `kind`, rather than
-- two tables the UI would have to interleave and sort.
--
-- VISIBILITY IS THE TASK'S. Same inheritance as 0105: the policies ask whether the TASK is visible,
-- and that subquery runs under tasks' own RLS for this user. An attachment is therefore visible
-- exactly when the task is, with no second rule to drift.
--
-- Idempotent: safe to re-run.

begin;

create table if not exists public.task_attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  kind         text not null check (kind in ('file', 'link')),
  label        text,                     -- what to call it on screen
  url          text,                     -- kind = 'link'
  storage_path text,                     -- kind = 'file', inside the task-files bucket
  size_bytes   bigint,
  content_type text,
  added_by     uuid references public.employees(id) on delete set null,
  added_user   uuid,                     -- auth.uid() at write time
  created_at   timestamptz not null default now(),
  -- Each kind must carry the thing that makes it that kind, and nothing pretends to be both.
  constraint task_attachments_shape check (
    (kind = 'link' and url is not null and btrim(url) <> '' and storage_path is null)
 or (kind = 'file' and storage_path is not null and btrim(storage_path) <> '' and url is null)
  )
);

create index if not exists idx_task_attachments_task on public.task_attachments(task_id, created_at);
create unique index if not exists idx_task_attachments_path on public.task_attachments(storage_path)
  where storage_path is not null;

alter table public.task_attachments enable row level security;

drop policy if exists task_attachments_select on public.task_attachments;
create policy task_attachments_select on public.task_attachments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_attachments.task_id));

drop policy if exists task_attachments_insert on public.task_attachments;
create policy task_attachments_insert on public.task_attachments for insert to authenticated
  with check (
    added_user = auth.uid()
    and exists (select 1 from public.tasks t where t.id = task_attachments.task_id)
  );

-- Remove your own, or anything on a task you manage: a head clearing up after somebody who left.
drop policy if exists task_attachments_delete on public.task_attachments;
create policy task_attachments_delete on public.task_attachments for delete to authenticated
  using (
    added_user = auth.uid()
    or exists (
      select 1 from public.tasks t
       where t.id = task_attachments.task_id
         and app.has_perm('task.manage', t.entity_id, t.zone_id, t.branch_id, t.department_id, t.employee_id)
    )
  );

grant select, insert, delete on public.task_attachments to authenticated;

-- ---------------------------------------------------------------------------
-- the bucket
--
-- Its own, not the documents one. `documents` is the employee personal file — contracts, ID scans —
-- and its object policies are written against document_for_object(). Putting shop-floor photographs
-- in the same bucket would mean one policy trying to answer two different questions about who may
-- read what.
--
-- 10 MB and a short mime list: these are photographs and a PDF, taken on a phone, uploaded over a
-- branch connection.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'task-files', 'task-files', false, 10485760,
  array['application/pdf','image/jpeg','image/png','image/webp','image/heic',
        'text/csv','text/plain',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public = false;

-- An object is reachable exactly when the row that points at it is. One question, asked of the
-- table that already knows the answer.
create or replace function public.task_attachment_visible(_path text)
returns boolean language sql stable security invoker set search_path = public, app as $$
  select exists (select 1 from public.task_attachments a where a.storage_path = _path)
$$;

grant execute on function public.task_attachment_visible(text) to authenticated;

drop policy if exists task_files_object_read   on storage.objects;
drop policy if exists task_files_object_insert on storage.objects;
drop policy if exists task_files_object_delete on storage.objects;

create policy task_files_object_read on storage.objects
  for select to authenticated
  using (bucket_id = 'task-files' and public.task_attachment_visible(name));

-- The row is written first and the file second, so an insert cannot ask whether the row is
-- visible — it is not there yet. The path carries the task id, so ask about the task instead.
create policy task_files_object_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'task-files'
    and exists (
      select 1 from public.tasks t
       where t.id = nullif(split_part(name, '/', 1), '')::uuid
    )
  );

create policy task_files_object_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'task-files' and public.task_attachment_visible(name));

commit;
