-- Earlier deployed copies of 0164 did not contain break_windows. The current
-- attendance worker reads this column for every shift, including legacy policies.
-- Keep existing schedules and break policies unchanged; an empty list preserves
-- their behavior. Fresh installations already receive the column from 0164.
alter table public.shifts
  add column if not exists break_windows jsonb not null default '[]'::jsonb;
