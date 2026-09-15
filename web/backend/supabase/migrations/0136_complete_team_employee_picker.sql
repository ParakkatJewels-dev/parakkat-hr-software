-- The team picker pages its matching employees. A SQL LIMIT inside the RPC hid everyone
-- after the first 50 before PostgREST could apply the requested page range.
-- Keep the existing department permission and company boundaries; order ties by id.
create or replace function public.assignable_employees(_department uuid, _q text default null)
returns table (
  id uuid, full_name text, employee_code text,
  department_id uuid, department_name text, branch_code text
)
language plpgsql stable security definer set search_path = public, app, pg_temp as $$
declare
  _entity uuid; _branch uuid;
begin
  select d.entity_id, d.branch_id into _entity, _branch
  from public.departments d where d.id = _department;

  if _entity is null then
    raise exception 'That department does not exist.' using errcode = '42704';
  end if;

  -- The real boundary. Runs before anything is read, every time.
  if not app.has_perm('employee.assign', _entity, null, _branch, _department, null) then
    raise exception 'You cannot add people to that department.' using errcode = '42501';
  end if;

  return query
    select e.id, e.full_name, e.employee_code, e.department_id, d.name, b.code
      from public.employees e
      left join public.departments d on d.id = e.department_id
      left join public.branches    b on b.id = e.branch_id
     where e.entity_id = _entity
       and e.status = 'Active'
       and (e.department_id is distinct from _department)
       and (
         _q is null or btrim(_q) = ''
         or e.full_name ilike '%' || btrim(_q) || '%'
         or e.employee_code ilike '%' || btrim(_q) || '%'
       )
     order by e.full_name, e.id;
end $$;

revoke all on function public.assignable_employees(uuid, text) from public, anon;
grant execute on function public.assignable_employees(uuid, text) to authenticated;
