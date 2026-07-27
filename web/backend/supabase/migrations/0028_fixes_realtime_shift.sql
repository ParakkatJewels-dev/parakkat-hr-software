-- 0028_fixes_realtime_shift.sql
-- Two fixes surfaced by the pre-rollout bug hunt. Idempotent: safe to re-run.

-- 1) 0022 added a table named 'punches' to the realtime publication, but the real table is
--    raw_punches — the to_regclass guard silently skipped the typo, so punch drill-downs never
--    refreshed live. Add the actual table.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'raw_punches'
  ) then
    alter publication supabase_realtime add table public.raw_punches;
  end if;
end $$;

-- 2) The seeded GEN shift (09:30-18:30, 60 min break) has a maximum achievable working time of
--    exactly 480 minutes — and full_day_minutes was seeded at 480, so leaving even ONE minute
--    early marked the day a half day and would have halved the first payroll. 420 (7h) is a
--    forgiving default; tune per shift in Attendance Setup.
update public.shifts
   set full_day_minutes = 420
 where code = 'GEN' and full_day_minutes = 480;
