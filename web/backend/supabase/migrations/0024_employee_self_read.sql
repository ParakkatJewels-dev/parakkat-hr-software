-- 0024_employee_self_read.sql
-- The `employee` role (granted at self scope) was missing employee.read, so an ESS user could
-- not read even their OWN employees row: the Directory showed nothing, and embedded
-- `employee:employees(...)` joins on their own leaves/tasks returned null. At self scope
-- has_perm only ever matches app.current_employee_id(), so this exposes exactly one row: their own.
-- Idempotent: safe to re-run.

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'employee.read'
where r.key = 'employee'
on conflict do nothing;
