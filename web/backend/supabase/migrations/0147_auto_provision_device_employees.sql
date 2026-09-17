-- A new Easy Time Pro enrolment should appear in the HR directory on the next roster sync.
-- Keep this boundary in the database so the already-running sync worker also gets the rule.
-- Only trusted roster refreshes provision people; mapping-screen edits never do. Existing HR
-- records remain authoritative, and uncertain identities stay in Devices & Mapping for review.
-- Installation deliberately does not refresh existing rows: historical backfill is explicit.
-- A trusted backfill may SET LOCAL app.provision_device_backfill = 'on' and touch link_status
-- on selected rows, preserving their actual source-sync timestamps. JWT/role guards still apply.

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

revoke all on function app.tg_auto_provision_device_employee() from public, anon, authenticated;

create or replace function app.tg_adopt_auto_device_punches()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, app, public
as $$
begin
  if auth.uid() is not null
     or coalesce(current_setting('role', true), '') in ('anon', 'authenticated')
     or new.link_status <> 'auto' or new.employee_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if (new.last_synced_at is not distinct from old.last_synced_at
        and coalesce(current_setting('app.provision_device_backfill', true), '') <> 'on')
       or old.link_status in ('manual', 'ignored') then
      return new;
    end if;
  end if;

  -- Adopt only orphan punches. Assigned history belongs to its current employee until HR
  -- explicitly remaps it. Queue actual local dates and their preceding day for overnight shifts.
  -- Sweep even an unchanged automatic link: an overlapping transaction sync can have cached
  -- the pre-link roster and insert an orphan just after the first sweep. An empty sweep is a no-op.
  with adopted as (
    update public.raw_punches rp set employee_id = new.employee_id
     where rp.emp_code = new.emp_code and rp.employee_id is null
    returning (rp.punch_time at time zone 'Asia/Kolkata')::date as work_date
  ), affected as (
    select a.work_date from adopted a
    union
    select a.work_date - 1 from adopted a
  )
  insert into public.attendance_recompute_queue (employee_id, work_date, reason)
  select new.employee_id, a.work_date, left(format('Easy Time Pro code %s linked automatically', new.emp_code), 200)
    from affected a
  on conflict (employee_id, work_date) where processed_at is null do update
    set generation = public.attendance_recompute_queue.generation + 1,
        reason = excluded.reason;

  return new;
end;
$$;

revoke all on function app.tg_adopt_auto_device_punches() from public, anon, authenticated;

drop trigger if exists trg_auto_provision_device_employee on public.biotime_employees;
create trigger trg_auto_provision_device_employee
  before insert or update of last_synced_at, employee_id, link_status on public.biotime_employees
  for each row execute function app.tg_auto_provision_device_employee();

drop trigger if exists trg_adopt_auto_device_punches on public.biotime_employees;
create trigger trg_adopt_auto_device_punches
  after insert or update of last_synced_at, employee_id, link_status on public.biotime_employees
  for each row execute function app.tg_adopt_auto_device_punches();
