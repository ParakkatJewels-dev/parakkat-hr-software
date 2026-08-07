-- 0094_asset_assignments_realtime.sql
-- Custody history changes when an asset is assigned or returned. Publish those changes so every
-- signed-in device refreshes the register and the employee profile history without a reload.

do $$
begin
  if to_regclass('public.asset_assignments') is not null then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'asset_assignments'
    ) then
      alter publication supabase_realtime add table public.asset_assignments;
    end if;

    alter table public.asset_assignments replica identity full;
  end if;
end $$;
