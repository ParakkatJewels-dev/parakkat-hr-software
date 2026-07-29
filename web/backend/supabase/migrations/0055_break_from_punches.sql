-- Deduct the break people actually took, including none.
--
-- 440 of 602 completed days carry exactly two punches: in and out, nothing between. Under
-- 'actual_over_allowance' each was charged the standard hour, removing 440 hours of worked time
-- for breaks nobody took. Staff here punch when they leave for a break and again when they return,
-- so two punches is not a missing measurement — it is a day worked straight through.
--
--   two punches, no break punched   ->  deduct nothing
--   a break punched                 ->  deduct exactly that
--   an odd number of middle punches ->  one of a pair was missed, so the measurement is
--                                       unreliable; the allowance is the safer number
--
-- This is 'actual', which now means what its name says. It previously fell back to the allowance
-- whenever the measurement was zero, which made "nobody took a break" indistinguishable from
-- "nobody recorded one".
--
-- Nobody loses time by this change; those who punch long breaks are already charged for them under
-- the measurement, and those who work through stop paying for an hour they were at their desk.

update public.shifts
   set break_policy = 'actual',
       updated_at = now()
 where break_policy = 'actual_over_allowance';

comment on column public.shifts.break_policy is
  'fixed = always the allowance; actual = what the punches show, including none; actual_over_allowance = the greater of the two. With actual, a day with no break punches is deducted nothing.';
