-- 0092_regularizations_realtime.sql
-- Attendance regularization status drives the dashboard's actionable notification strip. Include
-- it in Realtime so "Needs attention" clears on every signed-in device when a request is decided.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'attendance_regularizations'
  ) then
    alter publication supabase_realtime add table public.attendance_regularizations;
  end if;

  alter table public.attendance_regularizations replica identity full;
end $$;
