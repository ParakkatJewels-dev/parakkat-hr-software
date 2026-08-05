-- 0077 — A payroll run belongs to one company, and only that company should see its totals.
--
-- THE HOLE
-- payroll_runs_select (0040_payroll_core.sql:156) reads:
--
--   using (app.has_perm('payroll.manage', entity_id, null, null, null, null)
--          or app.has_perm_org_wide('payroll.manage'));
--
-- The second disjunct carries no scope predicate. app.has_perm_org_wide (0036) answers only "do
-- you hold this permission at global or entity scope?" — it never compares the grant's scope_id to
-- the row's entity_id. So holding payroll.manage for ONE company satisfies the clause for EVERY
-- row in the table.
--
-- This is not theoretical. 0019_role_scope_guard.sql forces entity_admin to be grantable only at
-- 'entity' scope, and 0040 grants payroll.manage to super_admin, entity_admin and hr_manager — so
-- every entity admin that can exist matches the unguarded clause for every run in the group.
--
-- WHAT LEAKED
-- usePayrollRuns queries payroll_runs with no entity filter, relying entirely on RLS, and selects
-- total_gross, total_net, employees and published_at alongside the entity's name (entities_read is
-- `using (true)`). The Payroll screen renders every row it gets back. An entity admin for one
-- company therefore read the monthly salary bill, headcount and publication status of all four.
--
-- Payslip rows themselves stayed hidden — payslips_select is correctly scoped — so nothing errored
-- and nothing looked wrong, which is what let this sit. The totals are the sensitive part.
--
-- READ AND WRITE ALREADY DISAGREED
-- payroll_runs_write, four lines below the leak, is scoped correctly. So the same admin could see
-- another company's run and not touch it; publish_payroll (0041) guards the same way. This aligns
-- the read with the write that was always right.
--
-- Every other policy in the codebase writes this escape hatch with the null-guard attached — 0036
-- lines 38, 42 and 49, 0040 line 141, 0076. The bare form appears only on tables that genuinely
-- have no entity column (leave_types, the recompute queue, the device and sync telemetry tables),
-- where org-wide authority is the whole point. payroll_runs is not one of those: entity_id is a
-- real foreign key and run_payroll has always supplied it.
--
-- 0071 fixed exactly this class of bug on pay_components_select and did not revisit this policy.

begin;

drop policy if exists payroll_runs_select on public.payroll_runs;
create policy payroll_runs_select on public.payroll_runs for select to authenticated
  using (
    app.has_perm('payroll.manage', entity_id, null, null, null, null)
    -- Kept for shape-consistency with the rest of the codebase rather than because it is
    -- reachable: entity_id is set on every run the engine creates, so this is dead in practice.
    -- If a run ever did arrive without a company, only a global or entity-scoped holder sees it.
    or (entity_id is null and app.has_perm_org_wide('payroll.manage'))
  );

comment on table public.payroll_runs is
  'One payroll run per company per period. Visible only to payroll.manage holders whose grant '
  'covers that company — see 0077. Read and write are deliberately identical in scope.';

commit;
