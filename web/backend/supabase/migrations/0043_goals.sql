-- 0043_goals.sql
-- Performance = goal / KRA tracking only: no review cycles, self-appraisal or ratings (the company
-- does not run formal appraisals). The old Performance screen was a hardcoded useState array with
-- no table behind it, visible to every Dept Head, HR and Entity Admin.
--
-- Scoped like every other module: an employee sees and progresses their own goals; a manager with
-- performance.manage sets and reviews goals for their team.
-- Idempotent: safe to re-run.

create table if not exists public.goals (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  title         text not null,
  description   text,
  target_date   date,
  weight        int check (weight between 0 and 100),
  progress      int not null default 0 check (progress between 0 and 100),
  status        text not null default 'Active'
                  check (status in ('Active', 'Completed', 'Dropped')),
  created_by    uuid references public.employees(id),
  -- denormalised ancestry, stamped by the shared trigger, so RLS matches the rest of the schema
  entity_id     uuid references public.entities(id),
  zone_id       uuid references public.zones(id),
  branch_id     uuid references public.branches(id),
  department_id uuid references public.departments(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_goals_employee on public.goals(employee_id, status);
create index if not exists idx_goals_branch on public.goals(branch_id);

drop trigger if exists trg_goals_ancestry on public.goals;
create trigger trg_goals_ancestry before insert or update of employee_id on public.goals
  for each row execute function app.tg_stamp_ancestry();
drop trigger if exists trg_goals_updated on public.goals;
create trigger trg_goals_updated before update on public.goals
  for each row execute function app.tg_set_updated_at();

-- Employees need to see and progress their own goals, so give the ESS role read+update at self.
insert into public.permissions (key, resource, action, description) values
  ('goal.read',   'goal', 'read',   'View goals'),
  ('goal.update', 'goal', 'update', 'Update goal progress')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key in ('goal.read', 'goal.update')
where r.key in ('super_admin', 'entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head', 'employee')
on conflict do nothing;

alter table public.goals enable row level security;

drop policy if exists goals_select on public.goals;
create policy goals_select on public.goals for select to authenticated
  using (app.has_perm('goal.read', entity_id, zone_id, branch_id, department_id, employee_id));

-- Setting a goal for someone is a management act; progressing your own is not.
drop policy if exists goals_insert on public.goals;
create policy goals_insert on public.goals for insert to authenticated
  with check (app.has_perm('performance.manage', entity_id, zone_id, branch_id, department_id, employee_id));

drop policy if exists goals_update on public.goals;
create policy goals_update on public.goals for update to authenticated
  using (
    app.has_perm('performance.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or (employee_id = app.current_employee_id()
        and app.has_perm('goal.update', entity_id, zone_id, branch_id, department_id, employee_id))
  )
  with check (
    app.has_perm('performance.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or employee_id = app.current_employee_id()
  );

drop policy if exists goals_delete on public.goals;
create policy goals_delete on public.goals for delete to authenticated
  using (app.has_perm('performance.manage', entity_id, zone_id, branch_id, department_id, employee_id));

grant select, insert, update, delete on public.goals to authenticated;
