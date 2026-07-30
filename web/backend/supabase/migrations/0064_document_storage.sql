-- Actually storing the file.
--
-- Document Management has been a register, not a store: you could record a title, a category and a
-- URL you typed yourself, and there was no way to attach anything. There was no file upload
-- anywhere in the application — not one call to Supabase Storage, and the only <input type="file">
-- in the codebase belongs to the employee importer, which parses a spreadsheet in the browser and
-- never uploads it. The screen said as much in a footnote. Nobody had used the feature: zero rows.
--
-- HOW ACCESS IS DECIDED
-- Files live in a PRIVATE bucket and are reached only through short-lived signed URLs. Nothing is
-- readable by URL alone, which matters for the contents of an HR document folder — contracts,
-- identity papers, warning letters.
--
-- The permission question is deliberately NOT answered twice. Every object is stored under the id
-- of its documents row:
--
--   documents/<document_id>/<filename>
--
-- and the storage policies below resolve that id back to the row and defer to app.has_perm on it,
-- exactly as public.documents already does. So a file is visible to precisely the people who can
-- see its record — scoped by entity, zone, branch, department or employee — and there is one place
-- where that is decided. A second copy of the rule in storage policy form would drift from the
-- first, and the direction it drifts is somebody seeing a document they should not.

-- --- 1. the bucket ----------------------------------------------------------------------------
-- Private. 25 MB is generous for a scan or a PDF contract and small enough that a mis-picked video
-- fails at the door rather than after four minutes of upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false, 26214400,
  array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- --- 2. what the row needs to know about its file ----------------------------------------------
-- `url` stays for what it always was: a link to something held elsewhere. A document is now one or
-- the other, never both, and storage_path being null is what says "this one is just a link".
alter table public.documents
  add column if not exists storage_path text,
  add column if not exists file_name    text,
  add column if not exists mime_type    text,
  add column if not exists size_bytes   bigint,
  add column if not exists uploaded_by  uuid references auth.users(id) on delete set null,
  add column if not exists uploaded_at  timestamptz;

comment on column public.documents.storage_path is
  'Object path in the private `documents` bucket, always <document_id>/<filename>. Null means this '
  'record points at an external url instead. The storage policies parse the id out of this path to '
  'decide who may read the file, so the path shape is load-bearing — see migration 0064.';

-- A record with neither a file nor a link is a title and nothing else, which is how the register
-- filled up with entries nobody could open.
alter table public.documents drop constraint if exists documents_has_content_check;
alter table public.documents add constraint documents_has_content_check
  check (storage_path is not null or url is not null);

create index if not exists idx_documents_storage_path
  on public.documents(storage_path) where storage_path is not null;

-- --- 3. who may touch the objects --------------------------------------------------------------
-- Each policy resolves the leading path segment to a documents row and asks the same question that
-- table asks. split_part on '/' is safe because the path is written by us, and a path whose first
-- segment is not a uuid simply matches no row and is therefore denied.
create or replace function public.document_for_object(object_name text)
returns public.documents
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.*
    from public.documents d
   where d.id::text = split_part(object_name, '/', 1)
   limit 1
$$;

comment on function public.document_for_object(text) is
  'The documents row an object path belongs to. security definer so the storage policies can find '
  'the row before deciding on it — the decision itself is still app.has_perm against that row.';

drop policy if exists documents_object_read   on storage.objects;
drop policy if exists documents_object_insert on storage.objects;
drop policy if exists documents_object_update on storage.objects;
drop policy if exists documents_object_delete on storage.objects;

create policy documents_object_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.document_for_object(name) d
       where app.has_perm('document.read', d.entity_id, d.zone_id, d.branch_id, d.department_id, d.employee_id)
    )
  );

create policy documents_object_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and exists (
      select 1 from public.document_for_object(name) d
       where app.has_perm('document.manage', d.entity_id, d.zone_id, d.branch_id, d.department_id, d.employee_id)
    )
  );

create policy documents_object_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.document_for_object(name) d
       where app.has_perm('document.manage', d.entity_id, d.zone_id, d.branch_id, d.department_id, d.employee_id)
    )
  );

create policy documents_object_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.document_for_object(name) d
       where app.has_perm('document.manage', d.entity_id, d.zone_id, d.branch_id, d.department_id, d.employee_id)
    )
  );

-- --- 4. the file goes when the record goes -----------------------------------------------------
-- Deleting the row alone would leave the object behind: still stored, still billable, and now
-- unreachable by any policy because the row it resolved through is gone. Orphaned private files
-- are the worst kind — nobody can see them to know they need deleting.
create or replace function public.delete_document_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
begin
  if old.storage_path is not null then
    delete from storage.objects where bucket_id = 'documents' and name = old.storage_path;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_documents_delete_object on public.documents;
create trigger trg_documents_delete_object
  after delete on public.documents
  for each row execute function public.delete_document_object();
