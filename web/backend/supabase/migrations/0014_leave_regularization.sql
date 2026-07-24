-- 0014_leave_regularization.sql
-- Phase 3: leave types with balances, LOP when a balance runs out, and attendance regularization.
--
-- The rule that ties this migration to the engine: anything that changes an attendance outcome
-- must trigger a recompute of the affected employee-dates. That is enforced here with triggers
-- rather than left to application code, so a leave approved from the admin UI, from a script, or
-- straight from the SQL editor all queue the same recompute.

-- ---------------------------------------------------------------------------
-- leave types
-- ---------------------------------------------------------------------------
-- One catalog for the group. The engine joins leave_types.code = leaves.type, so `code` is the
-- stable identifier and is globally unique.
create table if not exists public.leave_types (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  name              text not null,
  description       text,
  annual_quota      numeric(5,1) not null default 0,
  is_paid           boolean not null default true,
  allow_half_day    boolean not null default true,
  carry_forward     boolean not null default false,
  max_carry_forward numeric(5,1) not null default 0,
  requires_approval boolean not null default true,
  -- Counts against a balance. LOP and similar do not.
  deducts_balance   boolean not null default true,
  colour            text,                       -- for the calendar UI
  sort_order        integer not null default 0,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint leave_types_quota_check check (annual_quota >= 0)
);

create trigger trg_leave_types_updated
  before update on public.leave_types for each row execute function app.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- leave balances (per employee, per type, per year)
-- ---------------------------------------------------------------------------
create table if not exists public.leave_balances (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees(id) on delete cascade,
  leave_type_id   uuid not null references public.leave_types(id) on delete cascade,
  entity_id       uuid, zone_id uuid, branch_id uuid, department_id uuid,   -- stamped by trigger
  year            integer not null,
  entitled        numeric(5,1) not null default 0,
  carried_forward numeric(5,1) not null default 0,
  used            numeric(5,1) not null default 0,
  -- Generated so "what is left" can never drift out of sync with the parts.
  available       numeric(5,1) generated always as (entitled + carried_forward - used) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (employee_id, leave_type_id, year)
);

create index if not exists idx_leave_balances_employee on public.leave_balances(employee_id, year);
create index if not exists idx_leave_balances_branch   on public.leave_balances(branch_id);

create trigger trg_leave_balances_ancestry
  before insert or update of employee_id on public.leave_balances
  for each row execute function app.tg_stamp_ancestry();
create trigger trg_leave_balances_updated
  before update on public.leave_balances for each row execute function app.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- extend leaves
-- ---------------------------------------------------------------------------
alter table public.leaves
  add column if not exists leave_type_id    uuid references public.leave_types(id) on delete set null,
  -- 1 = full day, 0.5 = half day. Applies to each day in the range.
  add column if not exists day_fraction     numeric(3,2) not null default 1,
  add column if not exists is_lop           boolean not null default false,
  add column if not exists lop_days         numeric(5,1) not null default 0,
  add column if not exists paid_days        numeric(5,1) not null default 0,
  add column if not exists decided_at       timestamptz,
  add column if not exists decided_by       uuid references auth.users(id) on delete set null,
  add column if not exists decision_note    text;

create index if not exists idx_leaves_dates  on public.leaves(employee_id, start_date, end_date);
create index if not exists idx_leaves_status on public.leaves(status) where status = 'Pending';

-- ---------------------------------------------------------------------------
-- attendance regularization
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_regularizations (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  entity_id     uuid, zone_id uuid, branch_id uuid, department_id uuid,   -- stamped by trigger
  work_date     date not null,
  -- Either or both may be supplied: a missed check-out only needs check_out.
  check_in      timestamptz,
  check_out     timestamptz,
  reason        text not null,
  status        text not null default 'Pending',    -- Pending/Approved/Rejected/Cancelled
  requested_by  uuid references auth.users(id) on delete set null,
  approver_id   uuid references public.employees(id) on delete set null,
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id) on delete set null,
  decision_note text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint reg_status_check check (status in ('Pending','Approved','Rejected','Cancelled')),
  constraint reg_has_time_check check (check_in is not null or check_out is not null),
  constraint reg_order_check check (check_in is null or check_out is null or check_out > check_in)
);

-- One live request per employee-date. A rejected or cancelled one may be superseded.
create unique index if not exists idx_reg_one_open
  on public.attendance_regularizations(employee_id, work_date)
  where status in ('Pending','Approved');

create index if not exists idx_reg_status   on public.attendance_regularizations(status) where status = 'Pending';
create index if not exists idx_reg_branch   on public.attendance_regularizations(branch_id, work_date);

create trigger trg_reg_ancestry
  before insert or update of employee_id on public.attendance_regularizations
  for each row execute function app.tg_stamp_ancestry();
create trigger trg_reg_updated
  before update on public.attendance_regularizations for each row execute function app.tg_set_updated_at();

-- Now that the table exists, wire up the column 0013 left dangling.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'attendance_regularization_id_fkey'
  ) then
    alter table public.attendance
      add constraint attendance_regularization_id_fkey
      foreign key (regularization_id) references public.attendance_regularizations(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- leave balance maths + LOP
-- ---------------------------------------------------------------------------
-- Working days in a leave request. Weekly offs and holidays inside a leave range are NOT deducted
-- from the balance — taking Friday to Monday off should cost two days, not four.
create or replace function public.leave_working_days(
  _employee_id uuid, _from date, _to date, _fraction numeric default 1
) returns numeric language plpgsql stable security definer set search_path = app, public as $$
declare
  _shift_id    uuid;
  _weekly_offs integer[];
  _calendar_id uuid;
  _days        numeric := 0;
  d            date;
begin
  _calendar_id := public.calendar_for_employee(_employee_id);

  for d in select generate_series(_from, _to, interval '1 day')::date loop
    _shift_id := public.shift_for_employee(_employee_id, d);
    select weekly_offs into _weekly_offs from public.shifts where id = _shift_id;

    -- extract(dow) is 0=Sunday, matching shifts.weekly_offs
    if _weekly_offs is not null and (extract(dow from d)::integer = any(_weekly_offs)) then
      continue;
    end if;

    if exists (
      select 1 from public.holidays h
       where h.calendar_id = _calendar_id and h.holiday_date = d and not h.is_optional
    ) then
      continue;
    end if;

    _days := _days + coalesce(_fraction, 1);
  end loop;

  return _days;
end $$;

-- Applied when a leave is approved: deduct what the balance covers, and spill the remainder to LOP.
-- Running out of balance does not block the leave — it changes how the days are paid, which is
-- what "include LOP as an outcome when balance is exhausted" means.
create or replace function app.apply_leave_balance(_leave_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  _leave        record;
  _type_id      uuid;
  _type_paid    boolean;
  _type_deducts boolean;
  _type_quota   numeric;
  _has_type     boolean;
  _year         integer;
  _requested    numeric;
  _available    numeric := 0;
  _paid         numeric := 0;
  _lop          numeric := 0;
  _balance_id   uuid;
begin
  select * into _leave from public.leaves where id = _leave_id;
  if not found then return; end if;

  -- Read into scalars rather than a record: a record variable read after a SELECT INTO that
  -- matched nothing is a well-known source of "record has no field" surprises.
  select id, is_paid, deducts_balance, annual_quota
    into _type_id, _type_paid, _type_deducts, _type_quota
    from public.leave_types
   where id = _leave.leave_type_id or code = _leave.type
   limit 1;
  _has_type := found;

  _year      := extract(year from _leave.start_date)::integer;
  _requested := public.leave_working_days(
                  _leave.employee_id, _leave.start_date, _leave.end_date,
                  coalesce(_leave.day_fraction, 1));

  -- No type configured, or a type that does not draw on a balance: treat as fully paid/unpaid
  -- per the type flag, with nothing to deduct.
  if not _has_type or not coalesce(_type_deducts, false) then
    update public.leaves
       set days      = _requested,
           paid_days = case when coalesce(_type_paid, true) then _requested else 0 end,
           lop_days  = case when coalesce(_type_paid, true) then 0 else _requested end,
           is_lop    = not coalesce(_type_paid, true)
     where id = _leave_id;
    return;
  end if;

  -- Make sure a balance row exists for the year, seeded from the type's annual quota.
  insert into public.leave_balances (employee_id, leave_type_id, year, entitled)
  values (_leave.employee_id, _type_id, _year, coalesce(_type_quota, 0))
  on conflict (employee_id, leave_type_id, year) do nothing;

  select id, available into _balance_id, _available
    from public.leave_balances
   where employee_id = _leave.employee_id and leave_type_id = _type_id and year = _year
   for update;

  -- What the balance covers is paid; the remainder becomes LOP. Running out of balance never
  -- blocks the leave — it changes how the days are paid.
  _available := greatest(coalesce(_available, 0), 0);
  _paid      := least(_requested, _available);
  _lop       := greatest(_requested - _available, 0);

  update public.leave_balances
     set used = used + _paid, updated_at = now()
   where id = _balance_id;

  update public.leaves
     set days      = _requested,
         paid_days = case when _type_paid then _paid else 0 end,
         lop_days  = case when _type_paid then _lop else _requested end,
         is_lop    = (_lop > 0) or not _type_paid
   where id = _leave_id;
end $$;

-- Give a balance back when an approved leave is cancelled or rejected after the fact.
create or replace function app.release_leave_balance(_leave_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  _leave        record;
  _type_id      uuid;
  _type_deducts boolean;
  _year         integer;
begin
  select * into _leave from public.leaves where id = _leave_id;
  if not found or coalesce(_leave.paid_days, 0) <= 0 then return; end if;

  select id, deducts_balance into _type_id, _type_deducts
    from public.leave_types
   where id = _leave.leave_type_id or code = _leave.type limit 1;
  if not found or not coalesce(_type_deducts, false) then return; end if;

  _year := extract(year from _leave.start_date)::integer;

  update public.leave_balances
     set used = greatest(used - _leave.paid_days, 0), updated_at = now()
   where employee_id = _leave.employee_id and leave_type_id = _type_id and year = _year;

  update public.leaves
     set paid_days = 0, lop_days = 0, is_lop = false
   where id = _leave_id;
end $$;

-- ---------------------------------------------------------------------------
-- recompute triggers — the "every change re-derives attendance" guarantee
-- ---------------------------------------------------------------------------
create or replace function app.tg_leave_recompute()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'Approved' then
      perform app.apply_leave_balance(new.id);
    elsif old.status = 'Approved' then
      perform app.release_leave_balance(new.id);
    end if;
  elsif tg_op = 'INSERT' and new.status = 'Approved' then
    perform app.apply_leave_balance(new.id);
  end if;

  -- Queue the affected days whenever anything that could change the outcome moved.
  if tg_op = 'DELETE' then
    perform public.enqueue_recompute(old.employee_id, old.start_date, old.end_date, 'leave deleted');
    return old;
  end if;

  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date
     or new.day_fraction is distinct from old.day_fraction
     or new.type is distinct from old.type then
    perform public.enqueue_recompute(new.employee_id, new.start_date, new.end_date, 'leave ' || new.status);
    -- If the dates moved, the days it used to cover need recomputing too.
    if tg_op = 'UPDATE' and (new.start_date is distinct from old.start_date
                             or new.end_date is distinct from old.end_date) then
      perform public.enqueue_recompute(old.employee_id, old.start_date, old.end_date, 'leave dates changed');
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_leave_recompute on public.leaves;
create trigger trg_leave_recompute
  after insert or update or delete on public.leaves
  for each row execute function app.tg_leave_recompute();

create or replace function app.tg_regularization_recompute()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'DELETE' then
    perform public.enqueue_recompute(old.employee_id, old.work_date, old.work_date, 'regularization deleted');
    return old;
  end if;

  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.check_in is distinct from old.check_in
     or new.check_out is distinct from old.check_out then
    perform public.enqueue_recompute(new.employee_id, new.work_date, new.work_date,
                                     'regularization ' || new.status);
  end if;

  return new;
end $$;

drop trigger if exists trg_regularization_recompute on public.attendance_regularizations;
create trigger trg_regularization_recompute
  after insert or update or delete on public.attendance_regularizations
  for each row execute function app.tg_regularization_recompute();

-- A shift reassignment changes every day it covers.
create or replace function app.tg_shift_assignment_recompute()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _from date;
  _to   date;
begin
  if tg_op = 'DELETE' then
    perform public.enqueue_recompute(old.employee_id, old.effective_from,
                                     coalesce(old.effective_to, current_date), 'shift assignment removed');
    return old;
  end if;

  _from := least(new.effective_from, coalesce(old.effective_from, new.effective_from));
  _to   := greatest(coalesce(new.effective_to, current_date), coalesce(old.effective_to, current_date));
  perform public.enqueue_recompute(new.employee_id, _from, _to, 'shift assignment changed');
  return new;
end $$;

drop trigger if exists trg_esa_recompute on public.employee_shift_assignments;
create trigger trg_esa_recompute
  after insert or update or delete on public.employee_shift_assignments
  for each row execute function app.tg_shift_assignment_recompute();

-- ---------------------------------------------------------------------------
-- permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, resource, action, description) values
  ('leave.manage',            'leave',          'manage',  'Manage leave types and balances'),
  ('regularization.create',   'regularization', 'create',  'Raise a missed-punch correction'),
  ('regularization.approve',  'regularization', 'approve', 'Approve/reject regularizations')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key in ('leave.manage','regularization.create','regularization.approve')
where r.key in ('super_admin','entity_admin','hr_manager')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key in ('regularization.create','regularization.approve')
where r.key in ('branch_manager','dept_head')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'regularization.approve'
where r.key = 'zonal_manager'
on conflict do nothing;

-- Employees raise their own corrections.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'regularization.create'
where r.key = 'employee'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.leave_types                enable row level security;
alter table public.leave_balances             enable row level security;
alter table public.attendance_regularizations enable row level security;

-- Leave types are reference data everyone reads and only HR edits.
drop policy if exists leave_types_select on public.leave_types;
create policy leave_types_select on public.leave_types for select to authenticated using (true);
drop policy if exists leave_types_write on public.leave_types;
create policy leave_types_write on public.leave_types for all to authenticated
  using (app.has_perm('leave.manage', null, null, null, null, null))
  with check (app.has_perm('leave.manage', null, null, null, null, null));

drop policy if exists leave_balances_select on public.leave_balances;
create policy leave_balances_select on public.leave_balances for select to authenticated
  using (app.has_perm('leave.read', entity_id, zone_id, branch_id, department_id, employee_id));
drop policy if exists leave_balances_write on public.leave_balances;
create policy leave_balances_write on public.leave_balances for all to authenticated
  using (app.has_perm('leave.manage', entity_id, zone_id, branch_id, department_id, null))
  with check (app.has_perm('leave.manage', entity_id, zone_id, branch_id, department_id, null));

-- Employees raise their own; approvers act within their scope. Managers therefore only ever see
-- and approve their own team's requests, because the scope grant is what defines "their team".
drop policy if exists reg_select on public.attendance_regularizations;
create policy reg_select on public.attendance_regularizations for select to authenticated
  using (app.has_perm('attendance.read', entity_id, zone_id, branch_id, department_id, employee_id));
drop policy if exists reg_insert on public.attendance_regularizations;
create policy reg_insert on public.attendance_regularizations for insert to authenticated
  with check (app.has_perm('regularization.create', entity_id, zone_id, branch_id, department_id, employee_id));
drop policy if exists reg_update on public.attendance_regularizations;
create policy reg_update on public.attendance_regularizations for update to authenticated
  using (app.has_perm('regularization.approve', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('regularization.approve', entity_id, zone_id, branch_id, department_id, employee_id));

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  public.leave_types, public.leave_balances, public.attendance_regularizations
  to authenticated;
grant execute on function public.leave_working_days(uuid, date, date, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- seed: a starting leave catalog. Quotas are a guess — tune them in HR > Leave Types.
-- ---------------------------------------------------------------------------
insert into public.leave_types (code, name, annual_quota, is_paid, allow_half_day, carry_forward,
                                max_carry_forward, deducts_balance, colour, sort_order)
values
  ('CL',  'Casual Leave',      12, true,  true,  false, 0,  true,  '#0ea971', 1),
  ('SL',  'Sick Leave',        12, true,  true,  false, 0,  true,  '#f59e0b', 2),
  ('EL',  'Earned Leave',      15, true,  true,  true,  30, true,  '#3b82f6', 3),
  ('CO',  'Compensatory Off',   0, true,  true,  false, 0,  true,  '#8b5cf6', 4),
  ('MAT', 'Maternity Leave',   182, true, false, false, 0,  false, '#ec4899', 5),
  ('LOP', 'Loss of Pay',         0, false, true, false, 0,  false, '#ef4444', 9)
on conflict (code) do nothing;
