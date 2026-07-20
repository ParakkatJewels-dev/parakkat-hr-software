-- 0008_seed_rbac.sql
-- Seed the 7 system roles and the permission catalog, then map permissions to roles.
-- Idempotent: safe to re-run.

insert into public.roles (key, name, description, is_system) values
  ('super_admin',   'Super Admin',      'Global root access to all entities and settings', true),
  ('entity_admin',  'Entity Admin',     'Full admin within one legal entity', true),
  ('hr_manager',    'HR Manager',       'HR operations; grantable at entity/zone/branch/department scope', true),
  ('zonal_manager', 'Zonal Manager',    'Read + approvals across all branches in a zone', true),
  ('branch_manager','Branch Manager',   'Manages one branch (Shop-in-Charge)', true),
  ('dept_head',     'Department Head',  'Manages one department', true),
  ('employee',      'Employee (ESS)',   'Self-service: own records only', true)
on conflict (key) do nothing;

insert into public.permissions (key, resource, action, description) values
  ('employee.read',      'employee',   'read',    'View employees'),
  ('employee.create',    'employee',   'create',  'Add employees'),
  ('employee.update',    'employee',   'update',  'Edit employees'),
  ('employee.delete',    'employee',   'delete',  'Remove employees'),
  ('leave.read',         'leave',      'read',    'View leave requests'),
  ('leave.create',       'leave',      'create',  'Apply for leave'),
  ('leave.approve',      'leave',      'approve', 'Approve/reject leave'),
  ('expense.read',       'expense',    'read',    'View expense claims'),
  ('expense.create',     'expense',    'create',  'Submit expense claims'),
  ('expense.approve',    'expense',    'approve', 'Approve/reject expenses'),
  ('attendance.read',    'attendance', 'read',    'View attendance'),
  ('attendance.punch',   'attendance', 'punch',   'Check in/out'),
  ('attendance.manage',  'attendance', 'manage',  'Edit/regularize attendance'),
  ('ticket.read',        'ticket',     'read',    'View helpdesk tickets'),
  ('ticket.create',      'ticket',     'create',  'Raise tickets'),
  ('ticket.manage',      'ticket',     'manage',  'Handle/resolve tickets'),
  ('asset.read',         'asset',      'read',    'View assets'),
  ('asset.manage',       'asset',      'manage',  'Allocate/manage assets'),
  ('payslip.read',       'payslip',    'read',    'View payslips'),
  ('document.read',      'document',   'read',    'View documents'),
  ('org.manage',         'org',        'manage',  'Manage org hierarchy'),
  ('rbac.manage',        'rbac',       'manage',  'Manage users, roles and grants'),
  ('report.read',        'report',     'read',    'View reports'),
  ('performance.manage', 'performance','manage',  'Manage performance reviews'),
  ('recruitment.manage', 'recruitment','manage',  'Manage recruitment'),
  ('onboarding.manage',  'onboarding', 'manage',  'Manage onboarding'),
  ('exit.manage',        'exit',       'manage',  'Manage exits')
on conflict (key) do nothing;

-- super_admin gets everything (also short-circuited in app.is_super_admin, this is for completeness)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'super_admin'
on conflict do nothing;

-- helper: map a role to a set of permission keys
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = any (array[
  'org.manage','rbac.manage',
  'employee.read','employee.create','employee.update','employee.delete',
  'leave.read','leave.create','leave.approve',
  'expense.read','expense.create','expense.approve',
  'attendance.read','attendance.punch','attendance.manage',
  'ticket.read','ticket.create','ticket.manage',
  'asset.read','asset.manage','payslip.read','document.read','report.read',
  'performance.manage','recruitment.manage','onboarding.manage','exit.manage'
])
where r.key = 'entity_admin'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = any (array[
  'employee.read','employee.create','employee.update',
  'leave.read','leave.approve',
  'expense.read','expense.approve',
  'attendance.read','attendance.manage',
  'ticket.read','ticket.manage',
  'asset.read','payslip.read','document.read','report.read',
  'onboarding.manage','exit.manage'
])
where r.key = 'hr_manager'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = any (array[
  'employee.read','leave.read','leave.approve',
  'expense.read','expense.approve','attendance.read','ticket.read','report.read'
])
where r.key = 'zonal_manager'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = any (array[
  'employee.read','leave.read','leave.approve',
  'attendance.read','attendance.manage',
  'expense.read','expense.approve','ticket.read','ticket.manage','asset.read'
])
where r.key = 'branch_manager'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = any (array[
  'employee.read','leave.read','leave.approve',
  'attendance.read','performance.manage','report.read'
])
where r.key = 'dept_head'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = any (array[
  'employee.read','leave.read','leave.create',
  'expense.read','expense.create',
  'attendance.read','attendance.punch',
  'ticket.read','ticket.create','payslip.read','document.read'
])
where r.key = 'employee'
on conflict do nothing;
