-- 0093_assets_have_a_photograph.sql
--
-- A picture of the thing.
--
-- The register describes assets in words — "Dell Latitude 5420", a serial, a condition of "Good" —
-- and words are the wrong medium for the two jobs it actually does. Handing something over means
-- agreeing what it looked like at the time; taking it back means agreeing whether it still does.
-- "Fair" settles nothing when the argument is about a cracked lid. And on a register of a hundred
-- similar black laptops, a thumbnail identifies an item faster than any code on a sticker.
--
-- So the photograph is a property of the asset, not a document filed against it: one current
-- picture, replaced when it changes, shown wherever the asset is named. Documents are a list that
-- grows; this is a face.
--
-- HOW ACCESS IS DECIDED
-- The same shape as 0064, and for the same reason: the permission question is answered once.
-- Objects are stored under the asset's own id,
--
--   asset-photos/<asset_id>/<filename>
--
-- and the policies resolve that id back to the assets row and defer to app.has_perm on its
-- ancestry — so a photo is visible to exactly the people who can see the asset, and writable by
-- exactly the people who can manage it. A second copy of that rule, written in storage-policy
-- form, would drift from the first.

-- --- 1. the bucket ----------------------------------------------------------------------------
-- Private, images only. 8 MB takes a modern phone photograph without letting a video through.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'asset-photos', 'asset-photos', false, 8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- --- 2. where the asset remembers it ------------------------------------------------------------
alter table public.assets
  add column if not exists photo_path text;

comment on column public.assets.photo_path is
  'Object name in the asset-photos bucket. Null means no photograph; the category icon stands in.';

-- --- 3. resolving an object back to its asset ----------------------------------------------------
-- security definer so the lookup itself is not subject to the policy being defined with it, which
-- would be circular. It returns nothing a caller could not already read: the policies below are
-- what decide, and they ask app.has_perm about the row this hands back.
create or replace function public.asset_for_object(object_name text)
returns setof public.assets
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.*
    from public.assets a
   where a.id = nullif(split_part(object_name, '/', 1), '')::uuid;
$$;

revoke all on function public.asset_for_object(text) from public, anon;
grant execute on function public.asset_for_object(text) to authenticated;

-- --- 4. the policies ------------------------------------------------------------------------------
drop policy if exists asset_photo_read   on storage.objects;
drop policy if exists asset_photo_insert on storage.objects;
drop policy if exists asset_photo_update on storage.objects;
drop policy if exists asset_photo_delete on storage.objects;

create policy asset_photo_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'asset-photos'
    and exists (
      select 1 from public.asset_for_object(name) a
       where app.has_perm('asset.read', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
    )
  );

-- Writing a photograph is managing the asset, not reading it: it is a claim about the item's
-- condition, and the condition is what a handover argument turns on.
create policy asset_photo_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'asset-photos'
    and exists (
      select 1 from public.asset_for_object(name) a
       where app.has_perm('asset.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
    )
  );

create policy asset_photo_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'asset-photos'
    and exists (
      select 1 from public.asset_for_object(name) a
       where app.has_perm('asset.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
    )
  );

create policy asset_photo_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'asset-photos'
    and exists (
      select 1 from public.asset_for_object(name) a
       where app.has_perm('asset.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
    )
  );
