-- Break tracking.
--
-- The terminals record every punch, but the engine only ever looked at the first and the last one
-- and subtracted a flat allowance from the shift. Staff here punch out for tea and lunch, so a
-- typical day carries six to eight punches and the middle ones were being discarded:
--
--   Dhanya AR, 07-23:  09:39 [10:38-10:53] [13:02-13:36] [15:36-16:05] 18:33
--                      in      15m tea       34m lunch      29m tea     out
--
-- Discarding them is not just a display gap, it is a costing error in both directions. A day with
-- 173 minutes of breaks was credited as though it had 60. This adds the measurement; whether the
-- measurement is allowed to change pay is a separate, explicit decision (see break_policy below).

-- The punch timeline as the engine saw it, oldest first, after de-duplication.
-- Stored on the row rather than re-derived from raw_punches so that a payslip can still be
-- justified in a year's time even if the punch table is re-synced or pruned.
alter table public.attendance
  add column if not exists punches jsonb not null default '[]'::jsonb;

-- Measured time between leaving and coming back, summed over the day. Not the shift's allowance.
alter table public.attendance
  add column if not exists break_minutes integer not null default 0;

-- An odd number of middle punches means somebody forgot one, so the breaks are only partly
-- measurable and break_minutes is a floor rather than the truth. HR should regularize these.
alter table public.attendance
  add column if not exists breaks_incomplete boolean not null default false;

comment on column public.attendance.punches is
  'Ordered punch instants for the day, post-dedupe. First is arrival, last is departure, the middle ones pair off as break out/in.';
comment on column public.attendance.break_minutes is
  'Measured minutes away during the day, from the paired middle punches. Compare with shifts.break_minutes, which is the allowance.';
comment on column public.attendance.breaks_incomplete is
  'True when the middle punches do not pair up, i.e. a break punch is missing and break_minutes understates the truth.';

-- How worked time is costed.
--   fixed  - worked = (last - first) - shifts.break_minutes        [the behaviour up to now]
--   actual - worked = (last - first) - the measured break_minutes
-- Left at 'fixed' so this migration changes no existing figure. Switching a shift to 'actual' is a
-- payroll policy change and will move some days from Present to Half Day; do it deliberately.
alter table public.shifts
  add column if not exists break_policy text not null default 'fixed';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shifts_break_policy_values') then
    alter table public.shifts
      add constraint shifts_break_policy_values check (break_policy in ('fixed', 'actual'));
  end if;
end $$;

comment on column public.shifts.break_policy is
  'fixed = deduct the standard allowance; actual = deduct measured break time. Changing this changes paid hours.';

-- Finding the days where the allowance and reality disagree is the whole point, so make it cheap.
create index if not exists attendance_break_gap_idx
  on public.attendance (work_date)
  where breaks_incomplete or break_minutes > 0;
