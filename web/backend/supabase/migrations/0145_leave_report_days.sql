-- Use the same working-day, half-day and cancellation rules as leave balances.
-- The internal calculator is private, so the definer explicitly repeats leaves_select's
-- authorization before calling it. Neither dates nor leave IDs widen the caller's scope.
create or replace function public.report_leave_days(_from date, _to date)
returns table(leave_id uuid, period_days numeric)
language plpgsql stable security definer set search_path = public, app as $$
begin
  if not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode = '42501';
  end if;
  if _from is null or _to is null or _from > _to or _to - _from > 365 then
    raise exception 'Choose a report range of up to 366 days.' using errcode = '22023';
  end if;
  return query
    select l.id, app.leave_effective_working_days(l.employee_id,
      greatest(l.start_date, _from), least(l.end_date, _to), l.day_fraction, l.cancelled_dates)
    from public.leaves l
    where l.start_date <= _to and l.end_date >= _from
      and app.has_perm('leave.read', l.entity_id, l.zone_id, l.branch_id, l.department_id, l.employee_id);
end $$;
revoke all on function public.report_leave_days(date, date) from public, anon;
grant execute on function public.report_leave_days(date, date) to authenticated;
