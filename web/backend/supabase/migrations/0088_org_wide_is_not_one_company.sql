-- 0088 — A row that belongs to no company is not every company admin's to see.
--
-- WHAT #3 ACTUALLY IS
-- Ten policies carry a clause shaped like this, for rows that belong to the group rather than to
-- one company — a shared asset, a group-wide shift, a holiday calendar used everywhere:
--
--     app.has_perm('asset.read', entity_id, …)  OR  (entity_id is null AND app.has_perm_org_wide('asset.read'))
--
-- The first half is scoped: it compares the row's company against the caller's grant. The second
-- half is not. app.has_perm_org_wide accepts `scope_type in ('global','entity')` and never looks at
-- WHICH entity the grant names — it cannot, it is given only a permission. So for a row with no
-- company, the admin of Company A qualifies, and so does the admin of Company B. Both see it, both
-- may write it, and neither is org-wide in any real sense.
--
-- "Org-wide" is the right idea and 'entity' is the wrong scope for it. An entity admin's authority
-- is one company; a row above every company is above their level. Only a global grant is genuinely
-- org-wide, so that is what the second half now asks for.
--
-- WHY IT IS SAFE TO CHANGE NOW
-- Nothing takes that branch today: assets, payroll_runs, pay_components, shifts, holiday_calendars
-- and devices all have zero rows with a null entity, and production has exactly one entity and one
-- entity-scoped grant. The clause is unreachable, so this migration changes no current behaviour —
-- which is precisely why it is worth doing before a second company exists and makes it reachable.
--
-- The narrow-first policies (leave_types, sync_state, sync_runs, biotime_employees,
-- attendance_recompute_queue, service_commands) are left alone: they gate operations that are
-- genuinely org-wide by nature — the device sync, the recompute queue — where admitting an entity
-- admin is the documented intent rather than an oversight.

begin;

/**
 * Held over the whole organisation, and only that.
 *
 * The distinction from has_perm_org_wide is the entire point: that one also accepts an
 * entity-scoped grant, which is correct when you are asking "may this person act across their
 * company" and wrong when you are asking "does this person outrank every company".
 */
create or replace function app.has_perm_globally(_perm text)
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select app.is_super_admin()
      or exists (
        select 1
          from public.role_assignments ra
          join public.role_permissions rp on rp.role_id = ra.role_id
          join public.permissions p on p.id = rp.permission_id
         where ra.user_id = auth.uid()
           and p.key = _perm
           and ra.scope_type = 'global'
      );
$$;

grant execute on function app.has_perm_globally(text) to authenticated;

-- assets ------------------------------------------------------------------------------------------
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select to authenticated
  using (
    app.has_perm('asset.read', entity_id, zone_id, branch_id, department_id, employee_id)
    or (entity_id is null and app.has_perm_globally('asset.read'))
  );

drop policy if exists assets_write on public.assets;
create policy assets_write on public.assets for all to authenticated
  using (
    app.has_perm('asset.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or (entity_id is null and app.has_perm_globally('asset.manage'))
  )
  with check (
    app.has_perm('asset.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or (entity_id is null and app.has_perm_globally('asset.manage'))
  );

-- asset_assignments --------------------------------------------------------------------------------
drop policy if exists asset_assignments_select on public.asset_assignments;
create policy asset_assignments_select on public.asset_assignments for select to authenticated
  using (
    app.has_perm('asset.read', entity_id, zone_id, branch_id, department_id, employee_id)
    or exists (
      select 1 from public.assets a
       where a.id = asset_assignments.asset_id
         and (app.has_perm('asset.read', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
              or (a.entity_id is null and app.has_perm_globally('asset.read')))
    )
  );

drop policy if exists asset_assignments_write on public.asset_assignments;
create policy asset_assignments_write on public.asset_assignments for all to authenticated
  using (
    exists (
      select 1 from public.assets a
       where a.id = asset_assignments.asset_id
         and (app.has_perm('asset.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
              or (a.entity_id is null and app.has_perm_globally('asset.manage')))
    )
  )
  with check (
    exists (
      select 1 from public.assets a
       where a.id = asset_assignments.asset_id
         and (app.has_perm('asset.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
              or (a.entity_id is null and app.has_perm_globally('asset.manage')))
    )
  );

-- payroll_runs ------------------------------------------------------------------------------------
drop policy if exists payroll_runs_select on public.payroll_runs;
create policy payroll_runs_select on public.payroll_runs for select to authenticated
  using (
    app.has_perm('payroll.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_globally('payroll.manage'))
  );

-- pay_components ----------------------------------------------------------------------------------
drop policy if exists pay_components_write on public.pay_components;
create policy pay_components_write on public.pay_components for all to authenticated
  using (
    app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, null)
    or (entity_id is null and app.has_perm_globally('payroll.manage'))
  )
  with check (
    app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, null)
    or (entity_id is null and app.has_perm_globally('payroll.manage'))
  );

-- shifts ------------------------------------------------------------------------------------------
drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts for all to authenticated
  using (
    app.has_perm('shift.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_globally('shift.manage'))
  )
  with check (
    app.has_perm('shift.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_globally('shift.manage'))
  );

-- holiday calendars -------------------------------------------------------------------------------
drop policy if exists holcal_write on public.holiday_calendars;
create policy holcal_write on public.holiday_calendars for all to authenticated
  using (
    app.has_perm('holiday.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_globally('holiday.manage'))
  )
  with check (
    app.has_perm('holiday.manage', entity_id, null, null, null, null)
    or (entity_id is null and app.has_perm_globally('holiday.manage'))
  );

drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays for all to authenticated
  using (
    exists (
      select 1 from public.holiday_calendars hc
       where hc.id = holidays.calendar_id
         and (app.has_perm('holiday.manage', hc.entity_id, null, null, null, null)
              or (hc.entity_id is null and app.has_perm_globally('holiday.manage')))
    )
  )
  with check (
    exists (
      select 1 from public.holiday_calendars hc
       where hc.id = holidays.calendar_id
         and (app.has_perm('holiday.manage', hc.entity_id, null, null, null, null)
              or (hc.entity_id is null and app.has_perm_globally('holiday.manage')))
    )
  );

-- devices -----------------------------------------------------------------------------------------
drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices for select to authenticated
  using (
    app.has_perm('attendance.read', entity_id,
      (select b.zone_id from public.branches b where b.id = devices.branch_id), branch_id, null, null)
    or (entity_id is null and branch_id is null and app.has_perm_globally('attendance.read'))
  );

drop policy if exists devices_write on public.devices;
create policy devices_write on public.devices for all to authenticated
  using (
    app.has_perm('device.manage', entity_id,
      (select b.zone_id from public.branches b where b.id = devices.branch_id), branch_id, null, null)
    or (entity_id is null and branch_id is null and app.has_perm_globally('device.manage'))
  )
  with check (
    app.has_perm('device.manage', entity_id,
      (select b.zone_id from public.branches b where b.id = devices.branch_id), branch_id, null, null)
    or (entity_id is null and branch_id is null and app.has_perm_globally('device.manage'))
  );

-- ---------------------------------------------------------------------------
-- An employee can see the equipment they are holding
-- ---------------------------------------------------------------------------
--
-- `asset.read` was never granted to the employee role, so the laptop signed out in somebody's name
-- was invisible to the one person responsible for it. assets_select already passes employee_id as
-- the row's owner, so a self-scoped grant resolves to exactly their own kit and nothing else — the
-- register, the other branches and the unassigned pool all stay hidden.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
 where r.key = 'employee' and p.key = 'asset.read'
on conflict do nothing;

-- 0080 made the ladder monotonic: every role holds what its juniors hold. Granting a new permission
-- to the most junior role breaks that unless the closure runs again, which would leave a dept_head
-- unable to see an asset their own team member can.
insert into public.role_permissions (role_id, permission_id)
select distinct senior.id, rp.permission_id
  from public.roles senior
  join public.roles junior
    on junior.rank < senior.rank
   and junior.key in ('entity_admin','hr_manager','zonal_manager','branch_manager','dept_head','employee')
  join public.role_permissions rp on rp.role_id = junior.id
 where senior.key in ('super_admin','entity_admin','hr_manager','zonal_manager','branch_manager','dept_head')
on conflict do nothing;

commit;
