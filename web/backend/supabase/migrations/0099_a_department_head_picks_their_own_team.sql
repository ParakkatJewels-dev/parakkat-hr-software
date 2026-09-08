-- 0099_a_department_head_picks_their_own_team.sql
--
-- A department head can see their department and act on nearly everything in it — leave approvals,
-- attendance, tasks, goals — but has never been able to change WHO IS IN IT. That is deliberate:
-- employees.update belongs to HR, and it must stay that way, because `salary`, `pan`, `aadhaar` and
-- `bank_account` all live on the same row. Handing a department head employee.update to let them
-- fix a department assignment would hand them the payroll file with it.
--
-- WHY NOW. The department each person sits in came from Easy Time Pro's enrolment data, and a good
-- deal of it is wrong. Easy Time Pro will be corrected at source later; until then the people who
-- know who works for them need to be able to say so here.
--
-- WHAT THIS IS NOT. It is not an override layer, and there is no second copy of team membership.
-- employees.department_id stays the one place membership lives — every scope in this system reads
-- it (RLS, attendance, payroll, leave routing, tasks), so a parallel "teams" table would mean every
-- one of those checks having to choose between two answers. This migration adds a narrow way to
-- CHANGE that column and a log of who changed it, and nothing else.
--
-- NOTHING HERE TOUCHES EASY TIME PRO. It could not: the sync service is read-only towards the
-- device by construction (see services/attendance/src/sync/syncEmployees.ts — "BioTime is the
-- DEVICE layer, and public.employees is owned by HR"). Correcting a department here has no effect
-- on any terminal, which is exactly what was asked for.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. the permission
-- ---------------------------------------------------------------------------
insert into public.permissions (key, resource, action, description) values
  ('employee.assign', 'employee', 'assign', 'Move employees into or out of a department')
on conflict (key) do nothing;

-- super_admin holds the whole catalog (it short-circuits anyway, but the catalog stays complete).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'super_admin' and p.key = 'employee.assign'
on conflict do nothing;

-- Everyone who already runs a slice of the org. A department head is the point of this file; the
-- roles above them get it too, because each can already do strictly more than the one below.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'employee.assign'
where r.key in ('entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. the log
--
-- A record of what was moved by hand, NOT a second source of truth. employees.department_id is
-- still the answer to "which team is this person on"; this only answers "was that set here, by
-- whom, and what was it before" — which is the question that has to be answerable when Easy Time
-- Pro is finally corrected and the two have to be reconciled.
--
-- public.audit_log already fires on employees, but it records only "somebody updated row X": no
-- before, no after. That is enough to notice a change and not enough to undo one.
-- ---------------------------------------------------------------------------
create table if not exists public.department_moves (
  id                 uuid primary key default gen_random_uuid(),
  employee_id        uuid not null references public.employees(id) on delete cascade,
  from_department_id uuid references public.departments(id) on delete set null,
  to_department_id   uuid references public.departments(id) on delete set null,
  entity_id          uuid,   -- stamped at write time so RLS can scope the read, as audit_log does
  branch_id          uuid,
  moved_by           uuid,   -- auth.uid() of whoever pressed the button
  moved_at           timestamptz not null default now()
);

create index if not exists idx_department_moves_employee on public.department_moves(employee_id);
create index if not exists idx_department_moves_at       on public.department_moves(moved_at desc);

alter table public.department_moves enable row level security;

-- Readable by anyone who may read the employee it concerns. No insert/update/delete policy and no
-- write grant: the only thing that writes this table is the definer function below, so the log
-- cannot be edited by the people it records.
drop policy if exists department_moves_select on public.department_moves;
create policy department_moves_select on public.department_moves for select to authenticated
  using (app.has_perm('employee.read', entity_id, null, branch_id, to_department_id, employee_id)
      or app.has_perm('employee.read', entity_id, null, branch_id, from_department_id, employee_id));

grant select on public.department_moves to authenticated;

-- ---------------------------------------------------------------------------
-- 3. who can I add?
--
-- A department head holds employee.read at DEPARTMENT scope, so RLS shows them their own
-- department and nobody else — which means that without this function they cannot see a single
-- person they might want to add. Widening their employee.read instead would open the whole
-- directory row to them, salary and statutory ids included, on every screen.
--
-- So: a purpose-built picker. It returns the five fields a picker needs and no more, only to
-- someone who may already assign into the destination, and only within the SAME COMPANY. Entities
-- are four separately registered companies here (PPL, PKT, HO90, PJT) that file their own returns;
-- moving a person between them is a business decision with tax consequences, not a team edit.
-- ---------------------------------------------------------------------------
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
     order by e.full_name
     limit 50;
end $$;

revoke all on function public.assignable_employees(uuid, text) from public, anon;
grant execute on function public.assignable_employees(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. the move
--
-- Writes exactly one column. Not a general employee update with a filter on top: a general update
-- is one forgotten column away from being an edit of somebody's salary, and this is being handed to
-- people who are deliberately not trusted with that.
--
-- Passing null for _department takes the person off your team without putting them on another —
-- allowed only to someone who may assign in the department they are currently in, so you can empty
-- your own team but not somebody else's.
--
-- Claiming a person who is currently in ANOTHER department is allowed, and is the point: the whole
-- reason this exists is that the imported assignments are wrong and the head who actually manages
-- the person needs to say so. Every such move is logged with where they came from.
-- ---------------------------------------------------------------------------
create or replace function public.move_employee_to_department(_employee uuid, _department uuid)
returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  _emp_entity uuid; _emp_branch uuid; _emp_dept uuid; _emp_status text;
  _dest_entity uuid; _dest_branch uuid;
begin
  select e.entity_id, e.branch_id, e.department_id, e.status
    into _emp_entity, _emp_branch, _emp_dept, _emp_status
  from public.employees e where e.id = _employee;

  if _emp_entity is null then
    raise exception 'That employee does not exist.' using errcode = '42704';
  end if;
  if _emp_status is distinct from 'Active' then
    raise exception 'Only an active employee can be moved between departments.' using errcode = '42501';
  end if;
  if _emp_dept is not distinct from _department then
    return;   -- already there; nothing to do and nothing to log
  end if;

  if _department is null then
    -- Removing from a team: you must run the team they are leaving.
    if not app.has_perm('employee.assign', _emp_entity, null, _emp_branch, _emp_dept, null) then
      raise exception 'You cannot remove that person from their department.' using errcode = '42501';
    end if;
  else
    select d.entity_id, d.branch_id into _dest_entity, _dest_branch
    from public.departments d where d.id = _department;

    if _dest_entity is null then
      raise exception 'That department does not exist.' using errcode = '42704';
    end if;
    -- Four separate registered companies. A cross-company move is a payroll and tax decision.
    if _dest_entity is distinct from _emp_entity then
      raise exception 'That person belongs to a different company. Ask HR to move them.' using errcode = '42501';
    end if;
    if not app.has_perm('employee.assign', _dest_entity, null, _dest_branch, _department, null) then
      raise exception 'You cannot add people to that department.' using errcode = '42501';
    end if;
  end if;

  -- The one column. trg_employees_ancestry restamps entity/zone from it; trg_audit records that
  -- the row changed; department_moves records what it changed FROM.
  update public.employees set department_id = _department, updated_at = now()
   where id = _employee;

  insert into public.department_moves
    (employee_id, from_department_id, to_department_id, entity_id, branch_id, moved_by)
  values (_employee, _emp_dept, _department, _emp_entity, _emp_branch, auth.uid());
end $$;

revoke all on function public.move_employee_to_department(uuid, uuid) from public, anon;
grant execute on function public.move_employee_to_department(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. which departments do I actually run?
--
-- The screen needs to know which teams to offer. Derived from role_assignments rather than asked
-- of the client, so the answer cannot be widened by whoever is calling.
-- ---------------------------------------------------------------------------
create or replace function public.my_departments()
returns table (id uuid, name text, code text, entity_id uuid, branch_id uuid, headcount bigint)
language sql stable security definer set search_path = public, app, pg_temp as $$
  select d.id, d.name, d.code, d.entity_id, d.branch_id,
         (select count(*) from public.employees e
           where e.department_id = d.id and e.status = 'Active')
    from public.departments d
   where d.is_active
     and app.has_perm('employee.assign', d.entity_id, null, d.branch_id, d.id, null)
   order by d.name
$$;

revoke all on function public.my_departments() from public, anon;
grant execute on function public.my_departments() to authenticated;
