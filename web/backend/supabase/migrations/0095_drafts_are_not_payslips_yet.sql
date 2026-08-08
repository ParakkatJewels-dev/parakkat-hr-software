-- 0095_drafts_are_not_payslips_yet.sql
--
-- A draft payslip is a working paper, not a statement.
--
-- run_payroll writes every payslip as Draft and publish_payroll is the deliberate act that makes
-- the run official — the UI promises exactly that ("employees see their payslips once published").
-- But payslips_select (0010) had no status predicate: it asked only payslip.read over the row,
-- which every employee holds at self scope. So the whole company could open their payslip the
-- instant the run computed, before anyone had reviewed a number — and a figure later corrected
-- and re-run read as "my salary was changed", which is a conversation nobody should have over a
-- draft.
--
-- The rule: payroll.manage sees everything, because reviewing drafts is what that permission is
-- for. Everyone else sees a payslip when it has been published, which is when it starts being one.
drop policy if exists payslips_select on public.payslips;
create policy payslips_select on public.payslips for select to authenticated
  using (
    app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or (status = 'Published'
        and app.has_perm('payslip.read', entity_id, zone_id, branch_id, department_id, employee_id))
  );

-- The lines behind a payslip follow it without an edit here, for a reason worth writing down:
-- payslip_lines_select (0040) is `exists (select 1 from public.payslips where …)`, and a policy's
-- subquery against another table runs under THAT table's RLS for the same user. Hide the draft
-- payslip and the exists() finds no parent, so its lines vanish with it. Checked, not assumed.
