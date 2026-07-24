-- 0017_tasks.sql
-- Task management with the org-hierarchy flow. A task is owned by its ASSIGNEE (employee_id) —
-- its ancestry (entity/zone/branch/department) is stamped from that employee, exactly like the
-- other module tables, so the same scope-based RLS lets a manager see/assign tasks down their
-- branch/zone/entity while an employee sees only their own. parent_task_id lets a directive be
-- broken into sub-tasks that cascade further down the hierarchy.
-- Idempotent: safe to re-run.

create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id) on delete cascade,   -- the assignee
  entity_id      uuid, zone_id uuid, branch_id uuid, department_id uuid,            -- stamped by trigger
  assigned_by    uuid references public.employees(id) on delete set null,          -- who delegated it
  parent_task_id uuid references public.tasks(id) on delete set null,              -- sub-task of…
  title          text not null,
  description    text,
  priority       text not null default 'Medium',   -- Low/Medium/High/Urgent
  status         text not null default 'To Do',     -- To Do/In Progress/Blocked/Done/Cancelled
  due_date       date,
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists idx_tasks_employee on public.tasks(employee_id);
create index if not exists idx_tasks_branch   on public.tasks(branch_id);
create index if not exists idx_tasks_parent   on public.tasks(parent_task_id);
create index if not exists idx_tasks_status   on public.tasks(status);

-- Reuse the shared ancestry stamper (defined in 0006).
drop trigger if exists trg_tasks_ancestry on public.tasks;
create trigger trg_tasks_ancestry
  before insert or update of employee_id on public.tasks
  for each row execute function app.tg_stamp_ancestry();

-- ---------- permission catalog ----------
insert into public.permissions (key, resource, action, description) values
  ('task.read',   'task', 'read',   'View tasks'),
  ('task.create', 'task', 'create', 'Create / assign tasks'),
  ('task.update', 'task', 'update', 'Update task progress'),
  ('task.manage', 'task', 'manage', 'Reassign / delete tasks in scope')
on conflict (key) do nothing;

-- super_admin: keep the catalog complete (it is short-circuited anyway).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'super_admin' and p.key like 'task.%'
on conflict do nothing;

-- Managers get the full task lifecycle within their scope.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = any (array[
  'task.read','task.create','task.update','task.manage'
])
where r.key in ('entity_admin','hr_manager','zonal_manager','branch_manager','dept_head')
on conflict do nothing;

-- Employees (ESS): see tasks assigned to them, raise their own, and update progress.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = any (array[
  'task.read','task.create','task.update'
])
where r.key = 'employee'
on conflict do nothing;

-- ---------- RLS ----------
alter table public.tasks enable row level security;

create policy tasks_select on public.tasks for select to authenticated
  using (app.has_perm('task.read', entity_id, zone_id, branch_id, department_id, employee_id));

create policy tasks_insert on public.tasks for insert to authenticated
  with check (app.has_perm('task.create', entity_id, zone_id, branch_id, department_id, employee_id));

-- An assignee may progress their own task (self scope, task.update); a manager may update within scope.
create policy tasks_update on public.tasks for update to authenticated
  using (
       app.has_perm('task.update', entity_id, zone_id, branch_id, department_id, employee_id)
    or app.has_perm('task.manage', entity_id, zone_id, branch_id, department_id, employee_id)
  )
  with check (
       app.has_perm('task.update', entity_id, zone_id, branch_id, department_id, employee_id)
    or app.has_perm('task.manage', entity_id, zone_id, branch_id, department_id, employee_id)
  );

create policy tasks_delete on public.tasks for delete to authenticated
  using (app.has_perm('task.manage', entity_id, zone_id, branch_id, department_id, employee_id));

grant select, insert, update, delete on public.tasks to authenticated;
