-- One shift, one calendar, and the settings that were actually configured.
--
-- Creating a company fires trg_entity_defaults, which quietly inserts a default shift and a
-- default holiday calendar for it. The structure cleanup created a new company and therefore got
-- a brand-new GEN shift carrying the ORIGINAL seed values — 09:30-18:30, a 60-minute break, a
-- 420-minute full day — none of which anyone had chosen.
--
-- Worse, that shift is scoped to the company, and the engine prefers a company shift over a
-- global one:
--
--   defaultShifts.get(employee.entity_id) ?? defaultShifts.get('')
--
-- So it silently displaced the GN shift that was configured by hand, and every day since was
-- costed with a 60-minute break instead of 30. Kasinath A shows 152.1 hours on site and 134.0
-- paid: exactly 60 minutes removed on each of 18 days, when only 30 was intended.
--
-- The fix keeps the configured numbers and drops the auto-created row. The surviving shift is
-- scoped to the company rather than global, so the trigger's preference cannot displace it again.

do $$
declare
  _entity  uuid;
  _keep    uuid;   -- the hand-configured GN
  _auto    uuid;   -- the trigger's GEN
begin
  select id into _entity from public.entities order by created_at limit 1;

  select id into _keep from public.shifts where code = 'GN'  order by created_at limit 1;
  select id into _auto from public.shifts where code = 'GEN' and entity_id = _entity limit 1;

  if _keep is null or _auto is null then
    raise notice 'nothing to reconcile — shifts are already as intended';
    return;
  end if;

  -- Attendance rows point at whichever shift produced them; move them before the row disappears.
  update public.attendance set shift_id = _keep where shift_id = _auto;
  update public.employee_shift_assignments set shift_id = _keep where shift_id = _auto;

  delete from public.shifts where id = _auto;

  -- Scoped to the company, so a future auto-created shift cannot outrank it the same way.
  update public.shifts
     set entity_id = _entity, is_default = true, is_active = true, updated_at = now()
   where id = _keep;
end $$;

-- Three "Company Holidays" calendars now exist: one from the original seed, one from the trigger,
-- one created explicitly by the cleanup. Keep the one the employees resolve to and drop the empty
-- duplicates — none of them holds a single holiday yet, so nothing is lost.
delete from public.holiday_calendars hc
 where not exists (select 1 from public.holidays h where h.calendar_id = hc.id)
   and hc.id <> (
     select id from public.holiday_calendars
      where entity_id = (select id from public.entities order by created_at limit 1)
      order by created_at limit 1
   );
