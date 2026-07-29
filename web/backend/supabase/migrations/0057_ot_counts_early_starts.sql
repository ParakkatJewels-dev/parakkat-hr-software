-- Overtime counts time worked outside the shift at EITHER end.
--
-- Stated by the company as: general shift 09:00 to 17:30; somebody who punches in at 08:00 and out
-- at 17:30 has done an hour of overtime.
--
-- 'schedule' cannot express that. It measures only the time visible after the scheduled end, so an
-- early start is worth nothing:
--
--   in 08:00, out 17:30     schedule 0h     worked 1h   <- the case above
--   in 09:00, out 18:30     schedule 1h     worked 1h
--   in 08:00, out 18:30     schedule 1h     worked 2h
--
-- 'worked' measures the day against a full day's work rather than against the clock, so an hour is
-- an hour whichever end of the day it was done at.
--
-- This is only correct because the shift now adds up: 09:30-18:00 is a 510-minute span, less the
-- 30-minute break, is the 480-minute full day. An earlier attempt at this basis ran against a
-- 420-minute "full day" on a 540-minute shift and awarded overtime on 63% of days — the basis was
-- right and the full-day figure it measured against was not.

update public.shifts
   set ot_basis = 'worked',
       updated_at = now()
 where ot_basis <> 'worked';
