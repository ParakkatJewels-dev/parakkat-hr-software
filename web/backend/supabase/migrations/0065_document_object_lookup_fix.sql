-- document_for_object must return NO ROWS when the path matches nothing.
--
-- 0064 declared it `returns public.documents` — a single composite value rather than a set. When the
-- query inside finds nothing, PostgreSQL does not return zero rows for that shape; it returns ONE
-- row whose every column is null. Which meant:
--
--   select * from document_for_object('not-a-uuid/x.pdf')      -> 1 row, all nulls
--   select * from document_for_object('<unused-uuid>/x.pdf')   -> 1 row, all nulls
--
-- and the storage policies, which are all `exists (select 1 from document_for_object(name) d where
-- app.has_perm(..., d.entity_id, ...))`, then evaluated has_perm with every scope null instead of
-- short-circuiting to denied. For anyone holding document.manage org-wide, an all-null scope is
-- satisfied, so the check the policy exists to make was not being made: authorisation stopped
-- depending on the document row and became "do you hold the permission anywhere at all".
--
-- Not a way into other people's files — an object still has to exist in the bucket to be read, and
-- ours are only ever written under a real row's id. But it is a lock that was not turning, and the
-- next person to add a narrower-scoped role would have inherited a hole rather than a policy.
--
-- `setof` is the fix: no match, no rows, exists() is false, denied. The return type cannot be
-- changed by create or replace, hence the drop — and the policies that depend on it have to be
-- dropped and rebuilt with it.

drop policy if exists documents_object_read   on storage.objects;
drop policy if exists documents_object_insert on storage.objects;
drop policy if exists documents_object_update on storage.objects;
drop policy if exists documents_object_delete on storage.objects;

drop function if exists public.document_for_object(text);

create function public.document_for_object(object_name text)
returns setof public.documents
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
  'The documents row an object path belongs to, or NO ROWS if the path names nothing — see 0065, '
  'where returning a single all-null row instead stopped the storage policies from checking scope. '
  'security definer so the policies can find the row before deciding on it; the decision itself is '
  'still app.has_perm against that row.';

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

-- Assert it, because the failure is silent in both directions: a lookup that always resolves grants
-- too much, and one that never resolves makes every document unopenable with no error to read.
do $$
declare
  n int;
begin
  select count(*) into n from public.document_for_object('not-a-uuid/x.pdf');
  if n <> 0 then raise exception 'document_for_object resolved a non-uuid path (% rows)', n; end if;

  select count(*) into n from public.document_for_object('00000000-0000-0000-0000-000000000000/x.pdf');
  if n <> 0 then raise exception 'document_for_object resolved an unused uuid (% rows)', n; end if;
end $$;
