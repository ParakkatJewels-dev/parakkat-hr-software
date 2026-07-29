-- Adopt Easy Time Pro's own calculation rules.
--
-- Read from Attendance > Global Rule > Calculation Settings on the HR laptop:
--
--   When work duration is less than   270 minutes, count as half day
--   Calculate Missed Check-In as      Present
--   Calculate Missed Check-Out as     Present
--   When late exceeds                 540 min  -> Absent
--   When early-leave exceeds          540 min  -> Absent
--   Leave calculation                 26th to 25th
--
-- Until now every one of these was a number we chose. Two of them change what people are paid.
--
-- HALF DAY: 240 -> 270 minutes. Ours was half of an assumed full day; theirs is a stated policy.
--
-- MISSED PUNCH: this is the big one. Our engine treats a day with one punch as an exception worth
-- half a day, pending a regularization somebody has to file. Easy Time Pro credits it as Present.
-- That is a deliberate choice on their side — the person demonstrably came to work, and a forgotten
-- punch is an administrative slip, not a half-day absence. 184 days are affected, and under our
-- rule each of those people lost half a day's credit for pressing a button once instead of twice.
--
-- The behaviour stays configurable rather than hard-coded, because it is a policy and policies
-- change; 'exception' preserves what the engine did before.

alter table public.shifts
  add column if not exists missed_punch_policy text not null default 'exception';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shifts_missed_punch_policy_values') then
    alter table public.shifts
      add constraint shifts_missed_punch_policy_values
      check (missed_punch_policy in ('exception', 'present'));
  end if;
end $$;

comment on column public.shifts.missed_punch_policy is
  'How a day with only one punch is credited. exception = Missing Punch at half a day, awaiting regularization. present = credited as a full day, matching Easy Time Pro''s "Calculate Missed Check-In/Out as Present". The day is still flagged is_missing_punch either way so HR can see it.';

-- Beyond these, being late or leaving early stops being a flag and becomes an absence.
alter table public.shifts
  add column if not exists late_absent_minutes  integer not null default 540,
  add column if not exists early_absent_minutes integer not null default 540;

comment on column public.shifts.late_absent_minutes is
  'Lateness beyond this many minutes is scored Absent rather than late. Easy Time Pro: 540.';
comment on column public.shifts.early_absent_minutes is
  'Leaving this many minutes early is scored Absent rather than an early exit. Easy Time Pro: 540.';

-- Adopt the values as configured on the terminal.
update public.shifts
   set half_day_minutes     = 270,
       missed_punch_policy  = 'present',
       late_absent_minutes  = 540,
       early_absent_minutes = 540,
       updated_at           = now();

-- The payroll month runs 26th to 25th, not the calendar month. Nothing reads this yet — payroll
-- has not been built — but it belongs recorded next to the rules it goes with rather than in
-- somebody's memory when it does.
comment on table public.shifts is
  'Working-time rules. Note: Easy Time Pro runs its leave/payroll period from the 26th to the 25th, which payroll must use rather than the calendar month.';
