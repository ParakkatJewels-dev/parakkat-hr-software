-- 0007_rls.sql
-- Enable RLS on every table and define scope-based policies. This is the real gate:
-- the frontend's permission checks are only cosmetic; these policies are enforced by Postgres.

-- ---------- enable RLS everywhere ----------
alter table public.entities        enable row level security;
alter table public.zones           enable row level security;
alter table public.branches        enable row level security;
alter table public.departments     enable row level security;
alter table public.designations    enable row level security;
alter table public.employees       enable row level security;
alter table public.profiles        enable row level security;
alter table public.roles           enable row level security;
alter table public.permissions     enable row level security;
alter table public.role_permissions enable row level security;
alter table public.role_assignments enable row level security;
alter table public.leaves          enable row level security;
alter table public.expenses        enable row level security;
alter table public.attendance      enable row level security;
alter table public.tickets         enable row level security;
alter table public.assets          enable row level security;

-- ---------- org hierarchy ----------
-- Anyone logged in may read the hierarchy (needed for dropdowns). Writes require org.manage at scope.
create policy entities_read   on public.entities for select to authenticated using (true);
create policy entities_insert on public.entities for insert to authenticated with check (app.has_perm('org.manage', null, null, null, null, null));
create policy entities_update on public.entities for update to authenticated using (app.has_perm('org.manage', id, null, null, null, null)) with check (app.has_perm('org.manage', id, null, null, null, null));
create policy entities_delete on public.entities for delete to authenticated using (app.has_perm('org.manage', id, null, null, null, null));

create policy zones_read   on public.zones for select to authenticated using (true);
create policy zones_insert on public.zones for insert to authenticated with check (app.has_perm('org.manage', entity_id, null, null, null, null));
create policy zones_update on public.zones for update to authenticated using (app.has_perm('org.manage', entity_id, id, null, null, null)) with check (app.has_perm('org.manage', entity_id, id, null, null, null));
create policy zones_delete on public.zones for delete to authenticated using (app.has_perm('org.manage', entity_id, id, null, null, null));

create policy branches_read   on public.branches for select to authenticated using (true);
create policy branches_insert on public.branches for insert to authenticated with check (app.has_perm('org.manage', entity_id, zone_id, null, null, null));
create policy branches_update on public.branches for update to authenticated using (app.has_perm('org.manage', entity_id, zone_id, id, null, null)) with check (app.has_perm('org.manage', entity_id, zone_id, id, null, null));
create policy branches_delete on public.branches for delete to authenticated using (app.has_perm('org.manage', entity_id, zone_id, id, null, null));

create policy departments_read   on public.departments for select to authenticated using (true);
create policy departments_insert on public.departments for insert to authenticated with check (app.has_perm('org.manage', entity_id, null, branch_id, null, null));
create policy departments_update on public.departments for update to authenticated using (app.has_perm('org.manage', entity_id, null, branch_id, id, null)) with check (app.has_perm('org.manage', entity_id, null, branch_id, id, null));
create policy departments_delete on public.departments for delete to authenticated using (app.has_perm('org.manage', entity_id, null, branch_id, id, null));

create policy designations_read   on public.designations for select to authenticated using (true);
create policy designations_insert on public.designations for insert to authenticated with check (app.has_perm('org.manage', entity_id, null, null, department_id, null));
create policy designations_update on public.designations for update to authenticated using (app.has_perm('org.manage', entity_id, null, null, department_id, null)) with check (app.has_perm('org.manage', entity_id, null, null, department_id, null));
create policy designations_delete on public.designations for delete to authenticated using (app.has_perm('org.manage', entity_id, null, null, department_id, null));

-- ---------- employees ----------
create policy employees_select on public.employees for select to authenticated
  using (app.has_perm('employee.read', entity_id, zone_id, branch_id, department_id, id));
create policy employees_insert on public.employees for insert to authenticated
  with check (app.has_perm('employee.create', entity_id, zone_id, branch_id, department_id, id));
create policy employees_update on public.employees for update to authenticated
  using (app.has_perm('employee.update', entity_id, zone_id, branch_id, department_id, id))
  with check (app.has_perm('employee.update', entity_id, zone_id, branch_id, department_id, id));
create policy employees_delete on public.employees for delete to authenticated
  using (app.has_perm('employee.delete', entity_id, zone_id, branch_id, department_id, id));

-- ---------- profiles ----------
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or app.is_super_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());

-- ---------- roles / permissions catalog ----------
create policy roles_read on public.roles for select to authenticated using (true);
create policy permissions_read on public.permissions for select to authenticated using (true);
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);
-- Only a super admin edits the role/permission catalog.
create policy role_permissions_write on public.role_permissions for all to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());

-- ---------- role assignments ----------
create policy role_assignments_select on public.role_assignments for select to authenticated
  using (user_id = auth.uid() or app.is_super_admin());
create policy role_assignments_insert on public.role_assignments for insert to authenticated
  with check (app.can_grant(role_id, scope_type, scope_id));
create policy role_assignments_update on public.role_assignments for update to authenticated
  using (app.can_grant(role_id, scope_type, scope_id)) with check (app.can_grant(role_id, scope_type, scope_id));
create policy role_assignments_delete on public.role_assignments for delete to authenticated
  using (app.can_grant(role_id, scope_type, scope_id));

-- ---------- modules ----------
-- leaves: employees create/read own; approvers approve within scope
create policy leaves_select on public.leaves for select to authenticated
  using (app.has_perm('leave.read', entity_id, zone_id, branch_id, department_id, employee_id));
create policy leaves_insert on public.leaves for insert to authenticated
  with check (app.has_perm('leave.create', entity_id, zone_id, branch_id, department_id, employee_id));
create policy leaves_update on public.leaves for update to authenticated
  using (app.has_perm('leave.approve', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('leave.approve', entity_id, zone_id, branch_id, department_id, employee_id));
create policy leaves_delete on public.leaves for delete to authenticated
  using (app.has_perm('leave.approve', entity_id, zone_id, branch_id, department_id, employee_id));

-- expenses
create policy expenses_select on public.expenses for select to authenticated
  using (app.has_perm('expense.read', entity_id, zone_id, branch_id, department_id, employee_id));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (app.has_perm('expense.create', entity_id, zone_id, branch_id, department_id, employee_id));
create policy expenses_update on public.expenses for update to authenticated
  using (app.has_perm('expense.approve', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('expense.approve', entity_id, zone_id, branch_id, department_id, employee_id));

-- attendance: employee punches own; managers manage within scope
create policy attendance_select on public.attendance for select to authenticated
  using (app.has_perm('attendance.read', entity_id, zone_id, branch_id, department_id, employee_id));
create policy attendance_insert on public.attendance for insert to authenticated
  with check (app.has_perm('attendance.punch', entity_id, zone_id, branch_id, department_id, employee_id)
           or app.has_perm('attendance.manage', entity_id, zone_id, branch_id, department_id, employee_id));
create policy attendance_update on public.attendance for update to authenticated
  using (app.has_perm('attendance.manage', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('attendance.manage', entity_id, zone_id, branch_id, department_id, employee_id));

-- tickets: employee raises own; support handles within scope
create policy tickets_select on public.tickets for select to authenticated
  using (app.has_perm('ticket.read', entity_id, zone_id, branch_id, department_id, employee_id));
create policy tickets_insert on public.tickets for insert to authenticated
  with check (app.has_perm('ticket.create', entity_id, zone_id, branch_id, department_id, employee_id));
create policy tickets_update on public.tickets for update to authenticated
  using (app.has_perm('ticket.manage', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('ticket.manage', entity_id, zone_id, branch_id, department_id, employee_id));

-- assets: read within scope; managed by asset.manage holders
create policy assets_select on public.assets for select to authenticated
  using (app.has_perm('asset.read', entity_id, zone_id, branch_id, department_id, employee_id));
create policy assets_write on public.assets for all to authenticated
  using (app.has_perm('asset.manage', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('asset.manage', entity_id, zone_id, branch_id, department_id, employee_id));

-- ---------- grants ----------
-- Helper functions live in schema app and are referenced inside policies, so callers need usage+execute.
grant usage on schema app to authenticated, anon;
grant execute on function app.has_perm(text, uuid, uuid, uuid, uuid, uuid) to authenticated, anon;
grant execute on function app.is_super_admin() to authenticated, anon;
grant execute on function app.current_employee_id() to authenticated, anon;
grant execute on function app.visible_branch_ids() to authenticated;
grant execute on function app.can_grant(uuid, public.scope_type, uuid) to authenticated;
grant execute on function public.get_my_access() to authenticated;

-- Table privileges (RLS still restricts the actual rows). Deliberately NOT granted to anon.
grant select, insert, update, delete on
  public.entities, public.zones, public.branches, public.departments, public.designations,
  public.employees, public.leaves, public.expenses, public.attendance, public.tickets, public.assets,
  public.role_assignments, public.role_permissions
  to authenticated;
grant select on public.roles, public.permissions to authenticated;
grant select, update on public.profiles to authenticated;

-- bootstrap_super_admin must NOT be callable by ordinary users (it would let anyone self-promote).
-- Only the SQL editor / service_role (postgres) may run it.
revoke execute on function public.bootstrap_super_admin(text) from public;
