-- Overtime measured from hours worked, not from the clock.
--
-- Until now overtime meant "minutes past the shift's scheduled end time". That only rewards
-- staying late, and here almost nobody does — the median day runs 09:13 to 17:33 against a shift
-- configured to end at 18:30, so of 594 completed days only 15 earned any overtime while 419 of
-- them were over seven hours of actual work.
--
-- It also ignores the front of the day entirely. Murukan K B clocked in at 07:56 and out at 17:29
-- on 07-22: eight hours thirty-six of work, and nothing, because the schedule says he left an hour
-- early. Someone who starts ninety minutes before everyone else is working those ninety minutes.
--
--   schedule  overtime = minutes past the scheduled end       [the behaviour up to now]
--   worked    overtime = worked minutes beyond a full day
--
-- Both still pass through ot_after_minutes (a grace before the clock starts) and min_ot_minutes
-- (a floor below which it is not worth recording), so neither turns a stray four minutes into a
-- payable claim.

alter table public.shifts
  add column if not exists ot_basis text not null default 'schedule';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shifts_ot_basis_values') then
    alter table public.shifts
      add constraint shifts_ot_basis_values check (ot_basis in ('schedule', 'worked'));
  end if;
end $$;

comment on column public.shifts.ot_basis is
  'schedule = overtime is time past the shift end; worked = overtime is work beyond full_day_minutes, so an early start counts. Both respect ot_after_minutes and min_ot_minutes.';

-- Adopt it: this company pays for time worked, not for time visible after 18:30.
update public.shifts set ot_basis = 'worked' where ot_basis = 'schedule';
