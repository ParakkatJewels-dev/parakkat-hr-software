-- 0080 — A senior role holds everything its juniors hold.
--
-- The ladder in 0044 gives every role a rank — super_admin 100 down to employee 10 — and the whole
-- delegation model reads that rank as seniority: app.can_grant lets you hand out only roles ranked
-- strictly below your own. But the permission matrix was written by hand, role by role, and never
-- checked against the ladder it is supposed to express. It came out non-monotonic:
--
--   zonal_manager (rank 50) held 18 permissions
--   branch_manager (rank 40) held 22 — four of them the role above it did not have
--
-- A zonal manager oversees branches, and could not read an asset, manage attendance, take a
-- helpdesk ticket or file a punch correction that any of their branch managers could. Rank said
-- one thing, permissions said another, and the interface followed the permissions.
--
-- THE SELF-SERVICE HALF IS WORSE
-- Every manager is also an employee. They punch in, file their own leave, read their own payslip,
-- raise their own helpdesk ticket. None of the manager roles held attendance.punch, leave.create,
-- expense.create, payslip.read or ticket.create — those sat on `employee` alone. A branch manager
-- could approve their team's leave and not request their own, and could not see their own payslip.
-- It only went unnoticed because nobody has been assigned a manager role yet: this deployment has
-- one super admin and one self-scoped employee.
--
-- THE RULE, RATHER THAN ANOTHER HAND-WRITTEN LIST
-- Each role gains everything held by any role ranked strictly below it. That is what a hierarchy
-- means, it is stated once here instead of being re-derived per role, and re-running it after
-- editing any single role's grants repairs the ladder rather than drifting from it again.
--
-- WHAT THIS DOES NOT CHANGE
-- Scope. A branch manager gaining attendance.manage holds it at BRANCH scope — app.has_perm still
-- matches the grant's scope_id against the row's ancestry, so it reaches their branch and no other.
-- Seniority is about WHAT you may do; scope is about WHOSE records. Only the first is cumulative.
--
-- rbac.manage is deliberately left where it is: 0044 put it on the manager roles on purpose, so a
-- branch can be administered locally, with app.can_grant's rank ceiling preventing lateral
-- escalation. That is a designed feature, not an oversight.

begin;

insert into public.role_permissions (role_id, permission_id)
select distinct senior.id, rp.permission_id
  from public.roles senior
  join public.roles junior
    on junior.rank < senior.rank
   -- Only the built-in ladder on both sides. Custom roles default to rank 20 (0044), and letting
   -- one of those pull its permissions up into every manager above it would mean creating a custom
   -- role silently re-granted authority across the whole hierarchy.
   and junior.key in ('entity_admin','hr_manager','zonal_manager','branch_manager','dept_head','employee')
  join public.role_permissions rp on rp.role_id = junior.id
 where senior.key in ('super_admin','entity_admin','hr_manager','zonal_manager','branch_manager','dept_head')
on conflict do nothing;

commit;
