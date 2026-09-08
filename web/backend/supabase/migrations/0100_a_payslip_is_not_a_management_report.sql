-- 0100_a_payslip_is_not_a_management_report.sql
--
-- 0080 made seniority cumulative: "each role gains everything held by any role ranked strictly
-- below it". That was right, and the reason it gave was self-service — a branch manager "could not
-- see their own payslip". Their OWN payslip.
--
-- But a permission is granted to a ROLE and its reach comes from the ROLE ASSIGNMENT. A branch
-- manager is assigned at branch scope, so payslip.read arrived as payslip.read AT BRANCH SCOPE, and
-- app.has_perm matched it against every row in that branch. The same happened to document.read.
-- The result, which nobody chose:
--
--   * a branch manager could read every published payslip in their branch — names and net pay
--   * and every document filed against anyone in it — PAN and Aadhaar scans, contracts, photographs
--
-- Neither permission is in those roles' own grant lists. 0008 gave payslip.read and document.read
-- to entity_admin, hr_manager and employee, and deliberately not to zonal, branch or department
-- managers. This restores that decision.
--
-- NOBODY LOSES THEIR OWN PAYSLIP. 0096 gives every manager login that is linked to an employee an
-- `employee` role at SELF scope, and payslip.read/document.read sit on that role. Self-service —
-- the thing 0080 set out to fix — keeps working through the assignment that was designed for it,
-- at the scope that was designed for it. What goes away is only the accidental widening.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. take back the two that should never have cascaded
-- ---------------------------------------------------------------------------
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key in ('zonal_manager', 'branch_manager', 'dept_head')
  and p.key in ('payslip.read', 'document.read');

-- ---------------------------------------------------------------------------
-- 2. stop the ladder handing them straight back
--
-- 0080's own comment invites re-running it "after editing any single role's grants", and re-running
-- its raw insert would undo section 1 silently. So the ladder becomes a function with the exclusion
-- written into it: repair the hierarchy as often as you like, and these two stay where they belong.
--
-- A permission belongs on this list when holding it "at my scope" means something categorically
-- different from holding it "for myself" — a personal file rather than a piece of the operation.
-- ---------------------------------------------------------------------------
create or replace function app.repair_role_ladder()
returns void language plpgsql security definer set search_path = app, public as $$
begin
  insert into public.role_permissions (role_id, permission_id)
  select distinct senior.id, rp.permission_id
    from public.roles senior
    join public.roles junior
      on junior.rank < senior.rank
     -- Built-in ladder on both sides. A custom role defaults to rank 20 (0044); letting one pull
     -- its permissions up into every manager above it would re-grant authority across the org.
     and junior.key in ('entity_admin','hr_manager','zonal_manager','branch_manager','dept_head','employee')
    join public.role_permissions rp on rp.role_id = junior.id
    join public.permissions p on p.id = rp.permission_id
   where senior.key in ('super_admin','entity_admin','hr_manager','zonal_manager','branch_manager','dept_head')
     -- The exclusion. Reading somebody else's payslip or personal documents is not something you
     -- inherit by outranking them; it is HR's job, and entity_admin and hr_manager hold both in
     -- their own right from 0008. Every manager still reads their own through employee@self.
     and not (
       p.key in ('payslip.read', 'document.read')
       and senior.key in ('zonal_manager', 'branch_manager', 'dept_head')
     )
  on conflict do nothing;
end $$;

revoke all on function app.repair_role_ladder() from public, anon, authenticated;

-- Re-assert the ladder now, so anything else 0080 was meant to cascade is present and correct.
select app.repair_role_ladder();

commit;
