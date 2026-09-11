-- A second correction must survive if it arrives after the worker loaded the first request.
-- Workers acknowledge (id, generation), so an enqueue during computation remains pending.
alter table public.attendance_recompute_queue
  add column if not exists generation bigint not null default 1;

create or replace function app.enqueue_recompute_internal(
  _employee_id uuid, _from date, _to date, _reason text default 'system'
) returns integer
language plpgsql security definer set search_path = app, public as $$
declare
  _end date := coalesce(_to, _from);
  _n integer;
begin
  if _employee_id is null then raise exception 'an employee is required'; end if;
  if _from is null then raise exception 'a start date is required'; end if;
  if _end < _from then raise exception 'the end date is before the start date'; end if;
  if _end - _from > 366 then raise exception 'range too large (max 366 days)'; end if;

  insert into public.attendance_recompute_queue (employee_id, work_date, reason)
  select _employee_id, d::date, left(coalesce(_reason, 'system'), 200)
    from generate_series(_from, _end, interval '1 day') d
  on conflict (employee_id, work_date) where processed_at is null do update
    set generation = public.attendance_recompute_queue.generation + 1,
        reason = excluded.reason;

  get diagnostics _n = row_count;
  return _n;
end $$;

revoke execute on function app.enqueue_recompute_internal(uuid, date, date, text)
  from public, anon, authenticated;

create or replace function public.enqueue_recompute(
  _employee_id uuid, _from date, _to date default null, _reason text default 'manual'
) returns integer
language plpgsql security definer set search_path = app, public as $$
declare
  e record;
  _end date := coalesce(_to, _from);
  _n integer;
begin
  if _from is null then raise exception 'a start date is required'; end if;
  if _end < _from then raise exception 'the end date is before the start date'; end if;
  if _end - _from > 366 then raise exception 'range too large (max 366 days)'; end if;

  if auth.uid() is not null and not app.is_super_admin() then
    if _employee_id is null then raise exception 'not authorized to recompute every employee'; end if;
    select * into e from public.employees where id = _employee_id;
    if e.id is null then raise exception 'employee not found'; end if;
    if not app.has_perm('attendance.manage', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id) then
      raise exception 'not authorized to recompute this employee''s attendance';
    end if;
  end if;

  insert into public.attendance_recompute_queue (employee_id, work_date, reason)
  select _employee_id, d::date, left(coalesce(_reason, 'manual'), 200)
    from generate_series(_from, _end, interval '1 day') d
  on conflict (employee_id, work_date) where processed_at is null do update
    set generation = public.attendance_recompute_queue.generation + 1,
        reason = excluded.reason;

  get diagnostics _n = row_count;
  return _n;
end $$;
