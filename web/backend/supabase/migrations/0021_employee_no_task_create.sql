-- 0021_employee_no_task_create.sql
-- In the task hierarchy, work flows DOWN: managers assign tasks; employees receive them and update
-- progress. Employees should not create/assign tasks, so revoke task.create from the employee role
-- (they keep task.read + task.update). RLS then blocks inserts, and the app hides the New-Task and
-- Add-Sub-task buttons (both gated on task.create). Managerial roles keep task.create.
-- Idempotent: safe to re-run.

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key = 'employee'
  and p.key = 'task.create';
