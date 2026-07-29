-- Charge only the part of a break that ran over its allowance.
--
-- Stated by the company: do not decrease working hours for the break itself. Only when a break
-- exceeds the configured allowance is the excess taken off.
--
-- With a 30-minute allowance:
--   no break punched   ->  nothing deducted
--   20 minutes         ->  nothing deducted   (inside the allowance)
--   62 minutes         ->  32 deducted        (the 32 that ran over)
--
-- None of the three existing policies express that:
--   fixed                  always the allowance, taken or not — cuts 18,595 hours across 15
--                          months, of which 15,154 were never punched by anyone
--   actual                 the whole measured break, so a 20-minute tea break costs 20 minutes
--   actual_over_allowance  the greater of the two, which is the harshest of all at 20,131 hours
--
-- 'excess' is the fourth: the allowance is genuinely free, and only an overrun is charged.
--
-- It also behaves sensibly on the data we actually have. Only 11% of days ever carried a punched
-- break — for thirteen months the practice barely existed, at 2.1 punches a day — so any policy
-- that deducts on the absence of a break punch is guessing. This one deducts nothing when nothing
-- was punched, which is the only defensible reading of a day with no evidence either way.

alter table public.shifts drop constraint if exists shifts_break_policy_values;

alter table public.shifts
  add constraint shifts_break_policy_values
  check (break_policy in ('fixed', 'actual', 'actual_over_allowance', 'excess'));

comment on column public.shifts.break_policy is
  'How the break is charged against worked time. fixed = always the allowance. actual = the measured break. actual_over_allowance = the greater of the two. excess = only the minutes beyond the allowance, so the standard break costs nothing.';

update public.shifts
   set break_policy = 'excess',
       updated_at = now();
