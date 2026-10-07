-- New employee records and their first dated shift are one transaction. Existing employees
-- retain their current assignments; this migration never invents historical assignments.
begin;
create temporary table employee_initial_shift_upgrade on commit drop as
 select not exists(select 1 from information_schema.columns where table_schema='public' and table_name='employees' and column_name='initial_shift_id') as required;
alter table public.employees add column if not exists initial_shift_id uuid references public.shifts(id) on delete restrict;
comment on column public.employees.initial_shift_id is 'Immutable creation provenance. Later schedule changes use dated employee_shift_assignments.';

-- A new joiner did not work the company's default night shift before joining. Match the
-- worker's effective-employment fence when resolving the adjacent ownership boundary.
create or replace function app.attendance_shift_for_date(_employee uuid,_work_date date)
returns uuid language sql stable security definer set search_path=pg_catalog,public,app as $$
  select coalesce(
    (select a.shift_id from public.employee_shift_assignments a where a.employee_id=e.id
      and a.effective_from<=_work_date and (a.effective_to is null or a.effective_to>=_work_date)
      order by a.effective_from desc,a.id limit 1),
    (select s.id from public.shifts s where s.entity_id=e.entity_id and s.is_default and s.is_active),
    (select s.id from public.shifts s where s.entity_id is null and s.is_default and s.is_active))
  from public.employees e where e.id=_employee and (e.join_date is null or _work_date>=e.join_date);
$$;

create or replace function app.default_employee_creation_shift(_entity uuid)
returns uuid language sql stable security definer set search_path=pg_catalog,public,app as $$
  select coalesce((select id from public.shifts where entity_id=_entity and is_default and is_active),
    (select id from public.shifts where entity_id is null and is_default and is_active));
$$;

create or replace function app.tg_employee_initial_shift_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _manual boolean:=auth.uid() is not null or coalesce(current_setting('role',true),'') in ('anon','authenticated');
  _shift public.shifts; _existing public.employees;
begin
  if tg_op='UPDATE' then
    if new.initial_shift_id is distinct from old.initial_shift_id then
      raise exception 'The creation shift is historical evidence. Use dated shift assignments to change a schedule.' using errcode='55000';
    end if;
    return new;
  end if;
  -- This trigger sorts after the existing ancestry stamper. Never accept an invented zone,
  -- or a department from a different company as a way to satisfy a scoped creation grant.
  if _manual then
    if new.user_id is not null then raise exception 'Create the employee first, then provision or link their login.' using errcode='42501'; end if;
    if new.branch_id is null then new.zone_id:=null; end if;
    if new.department_id is not null and not exists(select 1 from public.departments d
      where d.id=new.department_id and d.entity_id=new.entity_id
        and (d.branch_id is null or d.branch_id=new.branch_id)) then
      raise exception 'Choose a department within the selected company and branch.' using errcode='23514';
    end if;
    if new.designation_id is not null and not exists(select 1 from public.designations d where d.id=new.designation_id
      and (d.entity_id is null or d.entity_id=new.entity_id)
      and (d.department_id is null or d.department_id=new.department_id)) then
      raise exception 'Choose a designation within the selected company and department.' using errcode='23514';
    end if;
    if new.initial_shift_id is null then raise exception 'Choose an initial shift before creating an employee.' using errcode='23514'; end if;
    if new.join_date is null then raise exception 'Enter the joining date for the initial shift assignment.' using errcode='23514'; end if;
  end if;
  if new.join_date is not null and not isfinite(new.join_date) then
    raise exception 'Enter a valid joining date.' using errcode='22023';
  end if;
  perform app.lock_payroll(new.entity_id);
  if not _manual and new.initial_shift_id is null and new.employee_code is not null then
    select * into _existing from public.employees where entity_id=new.entity_id and employee_code=new.employee_code;
    if _existing.id is not null then
      -- INSERT ... ON CONFLICT updates are existing people, not a second onboarding event.
      -- Keep their provenance even if a default was retired after their original creation.
      new.initial_shift_id:=_existing.initial_shift_id;
      return new;
    end if;
  end if;
  -- Trusted imports and device provisioning may use only an explicitly configured default.
  -- The selected ID is persisted, so later default changes cannot silently move this person.
  new.initial_shift_id:=coalesce(new.initial_shift_id,app.default_employee_creation_shift(new.entity_id));
  if new.initial_shift_id is null then
    raise exception 'Configure an active company or shared default shift before importing employees, or choose an initial shift explicitly.' using errcode='23514';
  end if;
  select * into _shift from public.shifts where id=new.initial_shift_id;
  if _shift.id is null or not _shift.is_active or (_shift.entity_id is not null and _shift.entity_id<>new.entity_id) then
    raise exception 'Choose an active shift belonging to this company or a shared shift.' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists zz_employee_initial_shift_guard on public.employees;
create trigger zz_employee_initial_shift_guard before insert or update of initial_shift_id on public.employees
  for each row execute function app.tg_employee_initial_shift_guard();

create or replace function app.tg_employee_initial_shift_assign()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _from date:=coalesce(new.join_date,(now() at time zone 'Asia/Kolkata')::date);
begin
  -- Only the just-inserted employee is writable here. The employee INSERT has already passed
  -- RLS. This deliberately grants no general shift.manage authority to employee creators.
  insert into public.employee_shift_assignments(employee_id,shift_id,effective_from,note)
    values(new.id,new.initial_shift_id,_from,case when new.join_date is null
      then 'Initial configured shift from creation date; joining date is unknown and must be reviewed.'
      when auth.uid() is null then 'Initial configured shift from recorded joining date during trusted import or device creation.'
      else 'Initial shift selected when the employee was created, effective from the joining date.' end);
  perform app.validate_employee_shift_boundaries(new.id,_from,_from);
  return new;
end $$;
drop trigger if exists employee_initial_shift_assign on public.employees;
create trigger employee_initial_shift_assign after insert on public.employees
  for each row execute function app.tg_employee_initial_shift_assign();

-- SECURITY INVOKER intentionally retains the existing scoped employee INSERT RLS policy.
-- The column list is generated exclusively from the allow-list; no caller-supplied identifier
-- reaches SQL. Defaults (including id, status and timestamps) remain table-owned.
create or replace function public.create_employee_with_shift(_employee jsonb,_shift_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,app as $$
declare _allowed text[]:=array[
  'full_name','employee_code','email','phone','join_date','status','entity_id','branch_id','department_id','designation_id',
  'date_of_birth','gender','father_name','mother_name','personal_email','address','blood_group',
  'pan','aadhaar','uan','pf_number','esi_number','bank_name','bank_account','bank_ifsc','account_holder',
  'emergency_name','emergency_phone','emergency_relation'];
  _payload jsonb; _columns text; _values text; _id uuid:=gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Sign in to create an employee.' using errcode='42501'; end if;
  if _employee is null or jsonb_typeof(_employee)<>'object' then raise exception 'Employee details must be an object.' using errcode='22023'; end if;
  if exists(select 1 from jsonb_object_keys(_employee) k where not k=any(_allowed)) then
    raise exception 'The employee payload contains unsupported fields.' using errcode='22023';
  end if;
  if _shift_id is null then raise exception 'Choose an initial shift before creating an employee.' using errcode='23514'; end if;
  if nullif(btrim(_employee->>'full_name'),'') is null or nullif(btrim(_employee->>'entity_id'),'') is null then
    raise exception 'Enter the employee name and company.' using errcode='23514';
  end if;
  if nullif(btrim(_employee->>'join_date'),'') is null then raise exception 'Enter the joining date for the initial shift assignment.' using errcode='23514'; end if;
  _payload:=_employee||jsonb_build_object('id',_id,'initial_shift_id',_shift_id,'full_name',btrim(_employee->>'full_name'));
  select string_agg(format('%I',k),',' order by k),string_agg(format('r.%I',k),',' order by k)
    into _columns,_values from jsonb_object_keys(_payload) k;
  execute format('insert into public.employees(%s) select %s from jsonb_populate_record(null::public.employees,$1) r',_columns,_values) using _payload;
  -- Return only the newly authored identifiers. INSERT RETURNING would unnecessarily require
  -- employee.read in addition to employee.create for a custom creation-only role.
  return jsonb_build_object('id',_id,'full_name',_payload->>'full_name','employee_code',_payload->>'employee_code','initial_shift_id',_shift_id);
end $$;

-- Missing default configuration must leave a device enrolment visible for HR review,
-- rather than losing the roster refresh or creating an employee without a schedule.
create or replace function app.tg_auto_provision_device_employee()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, app, public
as $$
declare
  _code text;
  _name text;
  _normalized_name text;
  _identity_ids uuid[];
  _employee_id uuid;
  _entity_ids uuid[];
  _entity_id uuid;
  _department_ids uuid[];
  _department_id uuid;
begin
  -- SECURITY DEFINER must not turn an authenticated device UPDATE into employee.create.
  -- The worker connects directly without an end-user JWT; service_role is also trusted.
  if auth.uid() is not null
     or coalesce(current_setting('role', true), '') in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.last_synced_at is not distinct from old.last_synced_at
       and coalesce(current_setting('app.provision_device_backfill', true), '') <> 'on' then
      return new;
    end if;

    -- Refreshing source details cannot undo an explicit HR mapping or ignored enrolment.
    if old.link_status in ('manual', 'ignored') then
      new.employee_id := old.employee_id;
      new.link_status := old.link_status;
      new.linked_at := old.linked_at;
      new.linked_by := old.linked_by;
      return new;
    end if;
  end if;

  if new.link_status in ('manual', 'ignored') then
    return new;
  end if;

  -- Old workers match only active employee_code values. An HR correction to that field (or
  -- an exit) must not sever the stable link established by automatic provisioning.
  if tg_op = 'UPDATE' and old.link_status = 'auto' and old.employee_id is not null then
    if exists (
      select 1 from public.employees e
       where e.id = old.employee_id
         and e.meta ->> 'device_emp_code' = new.emp_code
    ) then
      new.employee_id := old.employee_id;
      new.link_status := 'auto';
      new.linked_at := old.linked_at;
      new.linked_by := old.linked_by;
      return new;
    end if;
  end if;

  if new.employee_id is not null then
    return new;
  end if;

  _code := lower(btrim(coalesce(new.emp_code, '')));
  _name := nullif(btrim(new.full_name), '');
  _normalized_name := regexp_replace(lower(coalesce(_name, '')), '[[:space:][:punct:]]+', '', 'g');

  if not new.is_active or _code = '' or _name is null or _normalized_name = ''
     or _normalized_name in ('admin', 'administrator', 'superadmin', 'superadministrator')
     -- Source admin enrolments use their role/position itself as the person's name.
     or lower(_name) = lower(nullif(btrim(new.position_name), '')) then
    return new;
  end if;

  -- Serializing this small roster operation also protects name checks across different device
  -- codes. The employee's (entity_id, employee_code) unique constraint is the final write guard.
  perform pg_advisory_xact_lock(hashtext('app.auto_provision_device_employee'), 0);

  select array_agg(distinct e.id) into _identity_ids
    from public.employees e
   where lower(btrim(coalesce(e.employee_code, ''))) = _code
      or lower(btrim(coalesce(e.meta ->> 'device_emp_code', ''))) = _code;

  if coalesce(cardinality(_identity_ids), 0) > 1 then
    new.link_status := 'ambiguous';
    return new;
  end if;

  if cardinality(_identity_ids) = 1 then
    _employee_id := _identity_ids[1];
    -- Do not combine two device identities into one employee's attendance automatically.
    if exists (
      select 1 from public.biotime_employees be
       where be.employee_id = _employee_id and be.emp_code <> new.emp_code
    ) then
      new.link_status := 'ambiguous';
      return new;
    end if;
  else
    -- A likely duplicate requires a person's decision. Suggestions are advisory only: no
    -- fuzzy name match ever chooses the employee whose attendance will receive these punches.
    if exists (
      select 1 from public.employees e
       where regexp_replace(lower(btrim(e.full_name)), '[[:space:][:punct:]]+', '', 'g') = _normalized_name
    ) or exists (
      select 1
        from jsonb_array_elements(
          case when jsonb_typeof(new.match_suggestions) = 'array'
               then new.match_suggestions else '[]'::jsonb end
        ) suggestion
       where jsonb_typeof(suggestion -> 'score') = 'number'
         and case when jsonb_typeof(suggestion -> 'score') = 'number'
                  then (suggestion ->> 'score')::numeric >= 0.78 else false end
         and exists (
           select 1 from public.employees e
            where e.id::text = suggestion ->> 'employee_id'
         )
    ) then
      new.link_status := 'ambiguous';
      return new;
    end if;

    -- Easy Time Pro does not identify the legal entity. A sole active company is unambiguous;
    -- when several companies exist, HR must map the enrolment instead of us guessing one.
    select array_agg(e.id) into _entity_ids from public.entities e where e.is_active;
    if coalesce(cardinality(_entity_ids), 0) <> 1 then
      return new;
    end if;
    _entity_id := _entity_ids[1];

    -- "Department" is the source system's unset placeholder. Only existing, unique department
    -- names within the selected entity are usable, and a department does not imply a branch.
    if nullif(btrim(new.department_name), '') is not null
       and lower(btrim(new.department_name)) <> 'department' then
      select array_agg(d.id) into _department_ids
        from public.departments d
       where d.entity_id = _entity_id and d.is_active
         and lower(btrim(d.name)) = lower(btrim(new.department_name));
      if cardinality(_department_ids) = 1 then
        _department_id := _department_ids[1];
      end if;
    end if;

    if app.default_employee_creation_shift(_entity_id) is null then
      new.link_status := 'ambiguous';
      return new;
    end if;

    insert into public.employees (
      entity_id, department_id, employee_code, full_name, join_date, status, meta
    ) values (
      _entity_id, _department_id, new.emp_code, _name, new.hire_date, 'Active',
      jsonb_build_object(
        'source', 'biotime',
        'device_emp_code', new.emp_code,
        'biotime_id', new.biotime_id::text,
        'device_department_name', new.department_name,
        'device_area_name', new.area_name,
        'auto_provisioned_at', now(),
        'needs_hr_review', true
      )
    )
    on conflict (entity_id, employee_code) do nothing
    returning id into _employee_id;

    -- A concurrent HR insert may win the unique key. Reuse it without changing HR fields.
    if _employee_id is null then
      select e.id into _employee_id from public.employees e
       where e.entity_id = _entity_id and e.employee_code = new.emp_code;
      if _employee_id is null or exists (
        select 1 from public.biotime_employees be
         where be.employee_id = _employee_id and be.emp_code <> new.emp_code
      ) then
        new.link_status := 'ambiguous';
        return new;
      end if;
    end if;
  end if;

  new.employee_id := _employee_id;
  new.link_status := 'auto';
  new.linked_at := now();
  new.linked_by := null;
  new.match_suggestions := '[]'::jsonb;
  return new;
end;
$$;

revoke all on function app.default_employee_creation_shift(uuid),app.tg_employee_initial_shift_guard(),app.tg_employee_initial_shift_assign(),app.tg_auto_provision_device_employee() from public,anon,authenticated,service_role;
revoke all on function public.create_employee_with_shift(jsonb,uuid) from public,anon;
grant execute on function public.create_employee_with_shift(jsonb,uuid) to authenticated;
-- Existing join-day attendance can have used the old, imaginary pre-employment duty.
-- Re-derive only that recorded day once; no employee or assignment history is backfilled.
insert into public.attendance_recompute_queue(employee_id,work_date,reason)
 select e.id,e.join_date,'Employment boundary excludes pre-joining shift'
 from public.employees e join public.attendance a on a.employee_id=e.id and a.work_date=e.join_date
 where (select required from employee_initial_shift_upgrade) and not a.is_locked
   and not exists(select 1 from public.payslips p where p.employee_id=e.id and p.period=to_char(e.join_date,'YYYY-MM') and p.status='Published')
on conflict(employee_id,work_date) where processed_at is null do update
 set generation=public.attendance_recompute_queue.generation+1,reason=excluded.reason;
update public.payroll_runs r set needs_recalculation=true
 where r.status='Draft' and (select required from employee_initial_shift_upgrade)
   and exists(select 1 from public.attendance_recompute_queue q join public.employees e on e.id=q.employee_id
     where e.entity_id=r.entity_id and to_char(q.work_date,'YYYY-MM')=r.period and q.processed_at is null
       and q.reason='Employment boundary excludes pre-joining shift');
notify pgrst,'reload schema';
commit;
