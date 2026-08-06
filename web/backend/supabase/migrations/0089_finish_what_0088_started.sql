-- 0089 — The three tables 0088 missed.
--
-- 0088 replaced app.has_perm_org_wide with app.has_perm_globally in the `entity_id is null` branch
-- of ten policies, so that a row belonging to no company needs authority over the whole
-- organisation rather than over any one company. It rewrote pay_components_WRITE and left
-- pay_components_SELECT alone — and that policy is on an even weaker helper:
--
--     (entity_id is null) and app.has_perm_any_scope('payroll.manage')
--
-- has_perm_any_scope accepts ANY scope at all, including department and self. So a department-
-- scoped payroll manager in one company reads the group-wide pay components — the rates, the caps
-- and the gross bands — of every other company. Measured, not inferred: an hr_manager granted at
-- department scope in company B read a company-less component created for company A.
--
-- The same audit found shifts, holiday_calendars and holidays are `using (true)` on SELECT: every
-- authenticated user, including one holding no grants whatsoever, reads every company's shift
-- definitions, calendar names and holiday dates. That is not a 0088 regression — it predates it —
-- but it is the same question ("who may read a row that belongs to another company") and there is
-- no reason to leave it once a second company is a possibility.
--
-- READ, not write. The write halves were settled by 0088 and are untouched here.
--
-- These four tables are configuration everyone needs to interpret their own record: a shift's
-- start time, a holiday's date, the name of a pay component on a payslip. So the rule is "your own
-- company's, plus the group-wide ones", not "only what you administer" — locking these to
-- payroll.manage would leave an employee unable to see why they were paid what they were paid.

begin;

/**
 * Rows of `_table_entity` this caller may read, for reference data.
 *
 * Deliberately permissive within a company and strict across companies: anyone signed in who
 * belongs to, or holds any grant inside, a company may read that company's configuration. Nobody
 * reads another company's. Group-wide rows (entity_id null) are readable by everyone, because that
 * is what group-wide means — a shift pattern shared across the business is not a secret from the
 * people working it.
 */
create or replace function app.can_read_reference(_entity uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select _entity is null                      -- group-wide: shared by construction
      or app.can_read_org(_entity);           -- otherwise the same rule the org chart uses (0081)
$$;

grant execute on function app.can_read_reference(uuid) to authenticated;

-- pay_components: the one 0088 half-finished ------------------------------------------------------
--
-- NOT widened to everyone, unlike the three below. An employee never reads this table: payslip_lines
-- carries its own code, name, kind and amount, so a payslip renders without it, and the only caller
-- of usePayComponents is the manager-only Components tab. So the fix here is strictly the one 0088
-- meant to make — swap the weaker helper on the company-less branch — and nothing else. Checked
-- before writing it: widening a table of rates and caps because it was convenient would have been
-- the wrong trade.
drop policy if exists pay_components_select on public.pay_components;
create policy pay_components_select on public.pay_components
  for select to authenticated
  using (
    app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, null)
    or (entity_id is null and app.has_perm_globally('payroll.manage'))
  );

-- shifts, calendars and holidays: `using (true)` since they were created ---------------------------
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts
  for select to authenticated
  using (app.can_read_reference(entity_id));

drop policy if exists holiday_calendars_select on public.holiday_calendars;
drop policy if exists holcal_select on public.holiday_calendars;
create policy holcal_select on public.holiday_calendars
  for select to authenticated
  using (app.can_read_reference(entity_id));

-- A holiday has no entity of its own; it answers to the calendar that owns it.
drop policy if exists holidays_select on public.holidays;
create policy holidays_select on public.holidays
  for select to authenticated
  using (
    exists (
      select 1 from public.holiday_calendars hc
       where hc.id = holidays.calendar_id
         and app.can_read_reference(hc.entity_id)
    )
  );

commit;
