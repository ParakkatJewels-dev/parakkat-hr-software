-- The break allowance is 40 minutes, not 30.
--
-- Stated by the company: the break is 40 minutes; if the total break for the day exceeds 40, the
-- excess comes off the time between the first and last punch. Below 40 it costs nothing.
--
-- Only the allowance changes — 'excess' already implements the rule. With 40 instead of 30:
--
--   28 minutes of break  ->  nothing deducted   (was nothing)
--   48 minutes           ->   8 deducted        (was 18)
--   65 minutes           ->  25 deducted        (was 35)

update public.shifts
   set break_minutes = 40,
       updated_at = now();
