-- 0027_report_summary.sql
-- Branch-wise attendance summary for the Reports screen, aggregated in the database.
-- SECURITY INVOKER on purpose: RLS on public.attendance applies to the caller, so a branch
-- manager gets their branch, a zonal manager their zone, and the admin everything — the same
-- Role × Scope model as every other read. (A month of rows for the whole company is too heavy
-- to aggregate client-side through PostgREST's row limits.)
-- Idempotent: safe to re-run.

create or replace function public.report_attendance_summary(_from date, _to date)
returns table (
  branch_id       uuid,
  branch_code     text,
  branch_name     text,
  employees       bigint,
  present_days    bigint,
  half_days       bigint,
  absent_days     bigint,
  leave_days      bigint,
  lop_days        bigint,
  late_marks      bigint,
  missing_punches bigint,
  ot_minutes      bigint
)
language sql stable security invoker set search_path = public as $$
  select
    a.branch_id,
    coalesce(b.code, '—'),
    coalesce(b.name, 'Unassigned'),
    count(distinct a.employee_id),
    count(*) filter (where a.status = 'Present'),
    count(*) filter (where a.status = 'Half Day'),
    count(*) filter (where a.status = 'Absent'),
    count(*) filter (where a.status = 'On Leave'),
    count(*) filter (where a.is_lop),
    count(*) filter (where a.is_late),
    count(*) filter (where a.is_missing_punch),
    coalesce(sum(a.ot_minutes), 0)::bigint
  from public.attendance a
  left join public.branches b on b.id = a.branch_id
  where a.work_date between _from and _to
  group by a.branch_id, b.code, b.name
  order by coalesce(b.code, '—');
$$;

grant execute on function public.report_attendance_summary(date, date) to authenticated;
