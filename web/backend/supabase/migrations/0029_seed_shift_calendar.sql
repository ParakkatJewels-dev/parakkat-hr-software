-- 0029_seed_shift_calendar.sql
-- The live database has ZERO shifts and ZERO holiday calendars — the 0013 seed never landed
-- (found during the pre-rollout bug hunt). Without a default shift every synced day computes
-- as 'No Shift'. Re-seed idempotently, with the corrected full_day_minutes (see 0028: 480 was
-- unreachable-in-practice for a 09:30-18:30 shift with a 60-minute break; 420 = 7h is the
-- forgiving default, tunable per shift in Attendance Setup).

insert into public.shifts (entity_id, code, name, start_time, end_time, grace_in_minutes,
                           grace_out_minutes, break_minutes, weekly_offs, full_day_minutes,
                           half_day_minutes, is_default)
select null, 'GEN', 'General Shift', '09:30', '18:30', 15, 15, 60, '{0}', 420, 240, true
where not exists (select 1 from public.shifts where code = 'GEN');

insert into public.holiday_calendars (entity_id, code, name, is_default)
select null, 'DEFAULT', 'Company Holidays', true
where not exists (select 1 from public.holiday_calendars where code = 'DEFAULT');
