-- Replacing a shift is one transaction. The old browser flow closed/deleted the previous
-- assignment before trying to insert its replacement; a failed insert left a gap in attendance.
create or replace function public.assign_employee_shift(
  _employee_id uuid, _shift_id uuid, _effective_from date,
  _effective_to date default null, _note text default null
) returns uuid language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare
  employee public.employees%rowtype;
  shift public.shifts%rowtype;
  assignment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to assign a shift.' using errcode = '42501';
  end if;
  if _employee_id is null or _shift_id is null or _effective_from is null then
    raise exception 'Choose an employee, a shift and a start date.' using errcode = '22023';
  end if;
  if _effective_to is not null and _effective_to < _effective_from then
    raise exception 'The end date cannot be before the start date.' using errcode = '22023';
  end if;

  -- Concurrent submissions for the same employee must observe the preceding replacement.
  perform pg_advisory_xact_lock(hashtextextended(_employee_id::text, 121));
  -- Read ancestry privately: shift.manage alone authorizes assignment, without also exposing
  -- the employee's personal record through employee.read. Every write is explicitly scoped below.
  select * into employee from public.employees where id = _employee_id;
  if not found or not app.has_perm('shift.manage', employee.entity_id, employee.zone_id,
      employee.branch_id, employee.department_id, employee.id) then
    raise exception 'You cannot assign a shift to this employee.' using errcode = '42501';
  end if;
  select * into shift from public.shifts where id = _shift_id;
  if not found or not shift.is_active then
    raise exception 'Choose an active shift.' using errcode = '22023';
  end if;
  if shift.entity_id is not null and shift.entity_id <> employee.entity_id then
    raise exception 'The shift must belong to the employee''s company.' using errcode = '22023';
  end if;

  if exists (select 1 from public.employee_shift_assignments a
      where a.employee_id = _employee_id and a.effective_to is null
        and (_effective_to is null or a.effective_from <= _effective_to)
        and not app.has_perm('shift.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)) then
    raise exception 'You cannot replace this employee''s existing assignment.' using errcode = '42501';
  end if;

  delete from public.employee_shift_assignments
   where employee_id = _employee_id and effective_to is null and effective_from >= _effective_from
     and (_effective_to is null or effective_from <= _effective_to);
  update public.employee_shift_assignments set effective_to = _effective_from - 1
   where employee_id = _employee_id and effective_to is null and effective_from < _effective_from;
  insert into public.employee_shift_assignments(employee_id, shift_id, effective_from, effective_to, note)
  values (_employee_id, _shift_id, _effective_from, _effective_to, nullif(btrim(_note), ''))
  returning id into assignment_id;
  return assignment_id;
end;
$$;

revoke all on function public.assign_employee_shift(uuid, uuid, date, date, text) from public, anon;
grant execute on function public.assign_employee_shift(uuid, uuid, date, date, text) to authenticated;
notify pgrst, 'reload schema';
