-- A third break policy: charge the allowance, and only what ran over it.
--
--   fixed                 deduct shifts.break_minutes, whatever actually happened
--   actual                deduct the measured time away
--   actual_over_allowance deduct whichever is greater
--
-- The third is the one this company runs on. Staff keep their standard hour whether they use it or
-- not — a 45-minute lunch is not turned into 15 minutes of extra credit, which is what 'actual'
-- would do and what would make the change feel like a clawback in reverse. Only the days that ran
-- well past the hour are corrected:
--
--   took  45m  -> 60m deducted   unchanged, the hour is theirs
--   took 173m  -> 173m deducted  corrected
--
-- Nobody is worse off than under the rule that has been running until now, and the 29 long-break
-- days out of 99 stop being credited with time nobody worked.

alter table public.shifts drop constraint if exists shifts_break_policy_values;

alter table public.shifts
  add constraint shifts_break_policy_values
  check (break_policy in ('fixed', 'actual', 'actual_over_allowance'));

comment on column public.shifts.break_policy is
  'fixed = always the allowance; actual = always the measurement; actual_over_allowance = the greater of the two, so the standard break is protected and only overruns are charged.';

-- Adopt it. Every shift here is the same General 09:30-18:30 with a 60-minute allowance.
update public.shifts set break_policy = 'actual_over_allowance' where break_policy = 'fixed';
