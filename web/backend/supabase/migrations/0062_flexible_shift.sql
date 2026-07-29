-- The shift is flexible, and its numbers come from Easy Time Pro.
--
-- TWO SEPARATE THINGS, both stated by the company.
--
-- 1. THE CONFIGURATION IS EASY TIME PRO'S.
--    Its General Time Table runs 09:00-17:30, not the 09:30-18:00 we had been carrying. That was
--    not a guess: the Late and Early columns of its own Monthly Status Report pin the boundaries
--    exactly (late = clock in - start, early = end - clock out), and 1780 late marks agree on
--    09:00 while 247 early marks agree on 17:30. Clipping the punch window to that window
--    reproduces its Total WK on 2703 of 2703 employee-days.
--
--    09:00-17:30 is 510 minutes, and a full day is 510 minutes of worked time. That is reachable
--    while still taking the whole 40-minute break, because the break policy is 'excess' — the
--    allowance costs nothing and only an overrun is charged. Easy Time Pro deducts no break at all
--    and calls the same day 8:30.
--
-- 2. THE SHIFT IS FLEXIBLE.
--    There is no fixed start here. People arrive when they arrive; what is owed is the daily
--    hours. Easy Time Pro cannot express that — every employee sits on its General Time Table, so
--    it grades all 163 of them against a 09:00 start and produced 1780 late marks in July, 1113
--    hours of "lateness" that is not lateness under the company's actual policy.
--
--    So the clock boundaries stop being a judgement and become only a frame of reference: they
--    still decide which work date a punch belongs to, which end of the day a lone punch is, and
--    what to assume for a forgotten punch. They no longer decide whether somebody was late.
--
-- WHY A COLUMN RATHER THAN JUST WIDENING THE GRACE PERIODS
-- A grace period of 600 minutes would silence the late marks and leave the intent unreadable, and
-- would still leave the late/early absence escalation armed. This states the rule instead.

-- FIRST, A CONSTRAINT THAT PREDATES THE BREAK POLICIES.
-- 0013 requires full_day_minutes <= window - break_minutes, to stop somebody defining a full day
-- nobody on that shift could ever reach. Sound reasoning, but it was written when every break was
-- deducted unconditionally, and it is now wrong for two of the four policies:
--
--   fixed                 always deducts the allowance      -> window - break_minutes
--   actual_over_allowance deducts at least the allowance    -> window - break_minutes
--   actual                deducts what was measured, maybe 0 -> the whole window is reachable
--   excess                the allowance is free             -> the whole window is reachable
--
-- Under 'excess' a person on site 09:00-17:30 who takes the entire 40-minute break still records
-- 510 worked minutes, because only an overrun is charged. The old constraint would reject that as
-- unreachable while the engine reaches it every day. Rewritten to ask the policy rather than
-- assume it, keeping the original protection intact for the two policies that do always deduct.
alter table public.shifts drop constraint if exists shifts_full_day_reachable_check;

alter table public.shifts add constraint shifts_full_day_reachable_check check (
  full_day_minutes <= (
    case when end_time <= start_time
         then extract(epoch from (end_time - start_time)) / 60 + 1440
         else extract(epoch from (end_time - start_time)) / 60
    end
  ) - case when break_policy in ('actual', 'excess') then 0 else break_minutes end
);

alter table public.shifts
  add column if not exists is_flexible boolean not null default false;

comment on column public.shifts.is_flexible is
  'Flexible shift: the employee owes the daily hours, not a fixed start and end. Lateness and '
  'early exit are not recorded, and the late/early absence escalation does not apply. The '
  'scheduled window still frames the day — punch-to-date assignment, lone-punch direction, and '
  'the assumption used for a forgotten punch.';

update public.shifts
   set start_time  = '09:00:00',
       end_time    = '17:30:00',
       -- 09:00-17:30 with the 40-minute allowance free under the 'excess' policy.
       full_day_minutes = 510,
       half_day_minutes = 255,
       is_flexible = true,
       -- Overtime has to be measured against hours worked, not against a shift end nobody is held
       -- to. On a flexible shift 'schedule' would pay someone who drifts late and stays late, and
       -- pay nothing to someone who starts at 07:00 and leaves at 17:00 having worked longer.
       ot_basis = 'worked'
 where code = 'GN';

-- The update above is the whole point of this migration, so verify it landed rather than assume a
-- silent no-match. A typo'd code would otherwise leave the old 09:30 window in place and this
-- would report success.
do $$
declare
  n int;
  s record;
begin
  select count(*) into n from public.shifts where is_flexible;
  if n = 0 then
    raise exception 'no shift was made flexible — did the GN code change?';
  end if;

  for s in select code, start_time, end_time, full_day_minutes, ot_basis from public.shifts where is_flexible
  loop
    if s.start_time <> time '09:00' or s.end_time <> time '17:30' then
      raise exception 'shift % is %-%, not Easy Time Pro''s 09:00-17:30', s.code, s.start_time, s.end_time;
    end if;
    if s.ot_basis <> 'worked' then
      raise exception 'flexible shift % must measure overtime from hours worked, not %', s.code, s.ot_basis;
    end if;
  end loop;
end $$;
