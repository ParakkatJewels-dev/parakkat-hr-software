-- 0013_attendance_engine.sql
-- Phase 2: shifts, shift assignments, the holiday calendar, and the daily attendance record the
-- engine produces.
--
-- public.attendance already exists (0006_modules.sql) with one row per (employee_id, work_date) —
-- that IS the daily_attendance table, so it is extended in place rather than duplicated. Its
-- original columns (check_in, check_out, hours, status) are kept and still populated, so the
-- existing UI and any report built against them keeps working.
--
-- The engine is idempotent by contract: recomputing a date range overwrites those rows cleanly.
-- Business rules change, and this gets re-run often.

-- Needed for the no-overlapping-assignments exclusion constraint below.
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- shifts
-- ---------------------------------------------------------------------------
create table if not exists public.shifts (
  id                uuid primary key default gen_random_uuid(),
  -- null = available to every entity. Most groups want one or two shared shifts.
  entity_id         uuid references public.entities(id) on delete cascade,
  code              text not null,
  name              text not null,

  start_time        time not null,
  end_time          time not null,
  -- A shift whose end is at or before its start runs past midnight (e.g. 22:00 -> 06:00).
  -- Stored rather than derived so it can be read without re-deriving it in five places.
  crosses_midnight  boolean not null generated always as (end_time <= start_time) stored,

  grace_in_minutes  integer not null default 10,   -- arrive within this and it is not "late"
  grace_out_minutes integer not null default 10,   -- leave within this and it is not "early exit"
  break_minutes     integer not null default 0,    -- unpaid break deducted from worked time

  -- 0 = Sunday … 6 = Saturday, matching the engine's weekdayOf().
  weekly_offs       integer[] not null default '{0}',

  full_day_minutes  integer not null default 480,  -- worked minutes for a full day's credit
  half_day_minutes  integer not null default 240,  -- below full, at or above this = half day
  ot_after_minutes  integer not null default 30,   -- OT starts this long after scheduled end
  min_ot_minutes    integer not null default 30,   -- ignore OT shorter than this

  is_default        boolean not null default false,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint shifts_grace_check check (grace_in_minutes >= 0 and grace_out_minutes >= 0),
  constraint shifts_minutes_check check (half_day_minutes <= full_day_minutes),
  constraint shifts_weekly_offs_check check (
    weekly_offs <@ array[0,1,2,3,4,5,6]
  ),

  -- full_day_minutes must be ACHIEVABLE within the shift once the unpaid break is taken out.
  -- Without this it is very easy to define, say, a 22:00–06:00 shift with a 30-minute break and
  -- full_day_minutes = 480: nobody can ever reach 480 worked minutes in a 450-minute window, so
  -- every single person on that shift is silently marked Half Day. The failure looks like an
  -- engine bug and is actually a data entry mistake, so it is rejected at the source.
  constraint shifts_full_day_reachable_check check (
    full_day_minutes <= (
      case when end_time <= start_time
           then extract(epoch from (end_time - start_time)) / 60 + 1440
           else extract(epoch from (end_time - start_time)) / 60
      end
    ) - break_minutes
  )
);

-- Unique per entity, and separately unique among the shared (entity-less) shifts, because a null
-- entity_id would otherwise never collide.
create unique index if not exists idx_shifts_entity_code on public.shifts(entity_id, code)
  where entity_id is not null;
create unique index if not exists idx_shifts_global_code on public.shifts(code)
  where entity_id is null;
-- At most one default shift per entity — the engine falls back to it for unassigned employees.
create unique index if not exists idx_shifts_one_default
  on public.shifts ((coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  where is_default;

create trigger trg_shifts_updated
  before update on public.shifts for each row execute function app.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- employee shift assignments (effective-dated)
-- ---------------------------------------------------------------------------
create table if not exists public.employee_shift_assignments (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id) on delete cascade,
  shift_id       uuid not null references public.shifts(id) on delete restrict,
  entity_id      uuid, zone_id uuid, branch_id uuid, department_id uuid,  -- stamped by trigger
  effective_from date not null,
  effective_to   date,                      -- null = still in force
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint esa_range_check check (effective_to is null or effective_to >= effective_from),

  -- One employee cannot be on two shifts on the same day. Without this the engine would have to
  -- pick arbitrarily between overlapping rows, and the choice would drift between runs.
  constraint esa_no_overlap exclude using gist (
    employee_id with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  )
);

create index if not exists idx_esa_employee on public.employee_shift_assignments(employee_id, effective_from desc);
create index if not exists idx_esa_branch   on public.employee_shift_assignments(branch_id);

create trigger trg_esa_ancestry
  before insert or update of employee_id on public.employee_shift_assignments
  for each row execute function app.tg_stamp_ancestry();
create trigger trg_esa_updated
  before update on public.employee_shift_assignments for each row execute function app.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- holiday calendars
-- ---------------------------------------------------------------------------
-- Company-wide today, with the branch hook already in place so Kerala vs. Tamil Nadu branch
-- calendars are a data change later, not a migration.
create table if not exists public.holiday_calendars (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid references public.entities(id) on delete cascade,
  code       text not null,
  name       text not null,
  is_default boolean not null default false,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_holcal_entity_code on public.holiday_calendars(entity_id, code)
  where entity_id is not null;
create unique index if not exists idx_holcal_global_code on public.holiday_calendars(code)
  where entity_id is null;

create table if not exists public.holidays (
  id          uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.holiday_calendars(id) on delete cascade,
  holiday_date date not null,
  name        text not null,
  -- Optional/restricted holidays are only a holiday for someone who claims one; the engine treats
  -- them as a normal working day unless a leave record says otherwise.
  is_optional boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (calendar_id, holiday_date)
);

create index if not exists idx_holidays_date on public.holidays(holiday_date);

create trigger trg_holcal_updated
  before update on public.holiday_calendars for each row execute function app.tg_set_updated_at();

-- Branch-level override; falls back to the entity default, then the global default.
alter table public.branches
  add column if not exists holiday_calendar_id uuid references public.holiday_calendars(id) on delete set null;

-- ---------------------------------------------------------------------------
-- daily attendance — extend public.attendance into the engine's output table
-- ---------------------------------------------------------------------------
alter table public.attendance
  add column if not exists shift_id           uuid references public.shifts(id) on delete set null,
  add column if not exists scheduled_in       timestamptz,
  add column if not exists scheduled_out      timestamptz,
  add column if not exists first_punch_at     timestamptz,
  add column if not exists last_punch_at      timestamptz,
  add column if not exists punch_count        integer not null default 0,
  add column if not exists worked_minutes     integer,
  add column if not exists late_minutes       integer not null default 0,
  add column if not exists early_exit_minutes integer not null default 0,
  add column if not exists ot_minutes         integer not null default 0,
  -- working | weekly_off | holiday — what the calendar said, before looking at punches
  add column if not exists day_type           text not null default 'working',
  add column if not exists is_late            boolean not null default false,
  add column if not exists is_early_exit      boolean not null default false,
  add column if not exists is_missing_punch   boolean not null default false,
  add column if not exists leave_id           uuid references public.leaves(id) on delete set null,
  add column if not exists leave_type         text,
  add column if not exists is_lop             boolean not null default false,
  -- Payable day credit: 1 full, 0.5 half, 0 none. Payroll sums this; it is the single number that
  -- decides what a day is worth, rather than every report re-deriving it from `status`.
  add column if not exists day_fraction       numeric(3,2) not null default 0,
  add column if not exists regularization_id  uuid,   -- FK added in 0014, once the table exists
  add column if not exists source             text not null default 'device',
  add column if not exists remarks            text,
  -- Set when payroll for the month is finalized; the engine refuses to overwrite a locked row.
  add column if not exists is_locked          boolean not null default false,
  add column if not exists computed_at        timestamptz;

create index if not exists idx_attendance_work_date  on public.attendance(work_date);
create index if not exists idx_attendance_emp_date   on public.attendance(employee_id, work_date desc);
create index if not exists idx_attendance_branch_date on public.attendance(branch_id, work_date);
create index if not exists idx_attendance_status     on public.attendance(status) where status <> 'Present';

comment on column public.attendance.status is
  'Present | Absent | Half Day | Weekly Off | Holiday | On Leave | Missing Punch | No Shift';
comment on column public.attendance.day_fraction is
  'Payable day credit: 1 = full, 0.5 = half, 0 = none. Payroll sums this column.';

-- ---------------------------------------------------------------------------
-- recompute queue
-- ---------------------------------------------------------------------------
-- Anything that changes an attendance outcome (leave approved, regularization approved, shift
-- reassigned, a punch mapped to a person late) enqueues the affected employee-dates here. The
-- engine drains it, so a correction is reflected without anyone remembering to re-run a script.
create table if not exists public.attendance_recompute_queue (
  id           bigint generated always as identity primary key,
  employee_id  uuid references public.employees(id) on delete cascade,
  work_date    date not null,
  reason       text not null,
  requested_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_recompute_pending on public.attendance_recompute_queue(work_date)
  where processed_at is null;
create unique index if not exists idx_recompute_unique_pending
  on public.attendance_recompute_queue(employee_id, work_date)
  where processed_at is null;

-- Enqueue helper. Deliberately tolerant of duplicates: the partial unique index above collapses
-- repeat requests for the same employee-date into one pending row.
create or replace function public.enqueue_recompute(
  _employee_id uuid, _from date, _to date, _reason text
) returns integer language plpgsql security definer set search_path = app, public as $$
declare
  _count integer := 0;
begin
  insert into public.attendance_recompute_queue (employee_id, work_date, reason)
  select _employee_id, d::date, _reason
  from generate_series(_from, coalesce(_to, _from), interval '1 day') d
  on conflict do nothing;
  get diagnostics _count = row_count;
  return _count;
end $$;

-- ---------------------------------------------------------------------------
-- shift resolution
-- ---------------------------------------------------------------------------
-- The shift in force for an employee on a date: their assignment if any, otherwise their entity's
-- default, otherwise the global default. Returning null is meaningful — it becomes status
-- 'No Shift', which the exceptions screen surfaces rather than silently marking people absent.
create or replace function public.shift_for_employee(_employee_id uuid, _work_date date)
returns uuid language sql stable security definer set search_path = app, public as $$
  select coalesce(
    (select a.shift_id
       from public.employee_shift_assignments a
      where a.employee_id = _employee_id
        and a.effective_from <= _work_date
        and (a.effective_to is null or a.effective_to >= _work_date)
      order by a.effective_from desc
      limit 1),
    (select s.id
       from public.shifts s
       join public.employees e on e.id = _employee_id
      where s.is_default and s.is_active and s.entity_id = e.entity_id
      limit 1),
    (select s.id from public.shifts s
      where s.is_default and s.is_active and s.entity_id is null
      limit 1)
  )
$$;

-- The holiday calendar that applies to an employee: their branch's, else their entity's default,
-- else the global default.
create or replace function public.calendar_for_employee(_employee_id uuid)
returns uuid language sql stable security definer set search_path = app, public as $$
  select coalesce(
    (select b.holiday_calendar_id
       from public.employees e join public.branches b on b.id = e.branch_id
      where e.id = _employee_id),
    (select c.id from public.holiday_calendars c
       join public.employees e on e.id = _employee_id
      where c.is_default and c.is_active and c.entity_id = e.entity_id
      limit 1),
    (select c.id from public.holiday_calendars c
      where c.is_default and c.is_active and c.entity_id is null
      limit 1)
  )
$$;

-- ---------------------------------------------------------------------------
-- permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, resource, action, description) values
  ('shift.manage',   'shift',   'manage', 'Manage shifts and shift assignments'),
  ('holiday.manage', 'holiday', 'manage', 'Manage holiday calendars')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key in ('shift.manage','holiday.manage')
where r.key in ('super_admin','entity_admin','hr_manager')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.shifts                      enable row level security;
alter table public.employee_shift_assignments  enable row level security;
alter table public.holiday_calendars           enable row level security;
alter table public.holidays                    enable row level security;
alter table public.attendance_recompute_queue  enable row level security;

-- Shifts and holidays are reference data: any signed-in user may read them (the ESS calendar needs
-- them), but only shift.manage / holiday.manage holders may write.
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts for select to authenticated using (true);
drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts for all to authenticated
  using (app.has_perm('shift.manage', entity_id, null, null, null, null))
  with check (app.has_perm('shift.manage', entity_id, null, null, null, null));

drop policy if exists esa_select on public.employee_shift_assignments;
create policy esa_select on public.employee_shift_assignments for select to authenticated
  using (app.has_perm('attendance.read', entity_id, zone_id, branch_id, department_id, employee_id));
drop policy if exists esa_write on public.employee_shift_assignments;
create policy esa_write on public.employee_shift_assignments for all to authenticated
  using (app.has_perm('shift.manage', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('shift.manage', entity_id, zone_id, branch_id, department_id, employee_id));

drop policy if exists holcal_select on public.holiday_calendars;
create policy holcal_select on public.holiday_calendars for select to authenticated using (true);
drop policy if exists holcal_write on public.holiday_calendars;
create policy holcal_write on public.holiday_calendars for all to authenticated
  using (app.has_perm('holiday.manage', entity_id, null, null, null, null))
  with check (app.has_perm('holiday.manage', entity_id, null, null, null, null));

drop policy if exists holidays_select on public.holidays;
create policy holidays_select on public.holidays for select to authenticated using (true);
drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays for all to authenticated
  using (app.has_perm('holiday.manage', null, null, null, null, null))
  with check (app.has_perm('holiday.manage', null, null, null, null, null));

-- The queue is worker plumbing; only global-scope admins need to look at it.
drop policy if exists recompute_select on public.attendance_recompute_queue;
create policy recompute_select on public.attendance_recompute_queue for select to authenticated
  using (app.has_perm('attendance.manage', null, null, null, null, null));

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  public.shifts, public.employee_shift_assignments,
  public.holiday_calendars, public.holidays
  to authenticated;
grant select on public.attendance_recompute_queue to authenticated;
grant execute on function public.enqueue_recompute(uuid, date, date, text) to authenticated;
grant execute on function public.shift_for_employee(uuid, date) to authenticated;
grant execute on function public.calendar_for_employee(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- seed: one general shift + a holiday calendar, so the engine has something to work with
-- ---------------------------------------------------------------------------
insert into public.shifts (entity_id, code, name, start_time, end_time, grace_in_minutes,
                           grace_out_minutes, break_minutes, weekly_offs, full_day_minutes,
                           half_day_minutes, is_default)
values (null, 'GEN', 'General Shift', '09:30', '18:30', 15, 15, 60, '{0}', 480, 240, true)
on conflict do nothing;

insert into public.holiday_calendars (entity_id, code, name, is_default)
values (null, 'DEFAULT', 'Company Holidays', true)
on conflict do nothing;
