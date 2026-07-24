-- 0012_biotime.sql
-- Phase 1: the BioTime ingest layer — devices, the device-side personnel roster, raw punch
-- transactions, and the resumable sync cursor + run log.
--
-- Two rules shape this whole file:
--
--   1. BioTime is the DEVICE layer, not the HR master. Nothing here ever writes to
--      public.employees. `biotime_employees` is a separate roster that *links* to an employee;
--      the Excel-imported org data (entity/zone/branch/department/designation) stays authoritative.
--   2. Ingest must never fail. A punch from an unknown terminal, or for an emp_code we cannot map
--      to a person, still lands in raw_punches — it parks with a null employee_id until HR maps it.
--      Losing a punch is unrecoverable; an unmapped punch is a UI exception.

-- ---------------------------------------------------------------------------
-- devices — the ZKTeco terminals, as BioTime reports them
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
  id             uuid primary key default gen_random_uuid(),
  serial_number  text not null unique,          -- terminal_sn on a punch; the join key
  alias          text,                          -- terminal_alias ("CDA Showroom Entry")
  ip_address     text,
  area_name      text,                          -- BioTime "area"; usually names the branch
  -- Where this terminal physically lives. HR maps it once from the admin screen. This is what
  -- disambiguates an emp_code if the same code turns out to exist in two entities.
  entity_id      uuid references public.entities(id) on delete set null,
  branch_id      uuid references public.branches(id) on delete set null,
  last_punch_at  timestamptz,                   -- newest punch we have ingested from this terminal
  last_seen_at   timestamptz,                   -- BioTime's own last_activity for the terminal
  is_active      boolean not null default true,
  raw            jsonb,                         -- full BioTime terminal record, for audit
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_devices_branch on public.devices(branch_id);

-- ---------------------------------------------------------------------------
-- biotime_employees — the device-side roster, and its link to a real employee
-- ---------------------------------------------------------------------------
-- emp_code is unique *within BioTime* (BioTime enforces it), so it is the PK-by-nature here.
-- Whether it also matches public.employees.employee_code is exactly what link_status records.
create table if not exists public.biotime_employees (
  id              uuid primary key default gen_random_uuid(),
  emp_code        text not null unique,
  biotime_id      bigint unique,                -- BioTime's internal personnel id
  first_name      text,
  last_name       text,
  full_name       text,                         -- composed by the sync worker (not generated:
                                                -- Prisma cannot write generated columns)
  department_name text,                         -- BioTime's own strings — NOT our org FKs.
  area_name       text,                         -- Kept for matching hints and HR context only.
  position_name   text,
  hire_date       date,
  is_active       boolean not null default true,

  -- The link. Null employee_id means punches for this code park unassigned.
  employee_id     uuid references public.employees(id) on delete set null,
  link_status     text not null default 'unmatched',
    -- unmatched : no employee has this employee_code
    -- auto      : exactly one employee matched on employee_code — linked by the sync worker
    -- ambiguous : more than one employee carries this code (codes repeat across entities) — HR picks
    -- manual    : an HR user set the link explicitly; the worker must never overwrite it
    -- ignored   : a device-only enrolment (guard, demo finger, ex-staff) — deliberately unlinked
  linked_at       timestamptz,
  linked_by       uuid references auth.users(id) on delete set null,

  -- Ranked candidate employees for an unmatched code, computed by the sync worker from name
  -- similarity. Feeds the HR mapping screen so 240-odd codes can be resolved by confirming a
  -- suggestion rather than searching for each person by hand.
  -- [{ "employee_id": "...", "full_name": "...", "employee_code": "...", "score": 0.93, "reason": "name" }]
  match_suggestions jsonb,

  raw             jsonb,
  first_seen_at   timestamptz not null default now(),
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint biotime_employees_link_status_check
    check (link_status in ('unmatched','auto','ambiguous','manual','ignored'))
);

create index if not exists idx_biotime_employees_employee on public.biotime_employees(employee_id);
create index if not exists idx_biotime_employees_status   on public.biotime_employees(link_status);

-- ---------------------------------------------------------------------------
-- raw_punches — immutable transaction log from the terminals
-- ---------------------------------------------------------------------------
-- Deliberately `bigint identity` rather than the uuid PK used elsewhere: this is the only
-- high-volume append-only table in the schema (~250 staff x ~4 punches/day ≈ 365k rows/year),
-- and it is scanned by date range constantly. Narrow keys matter here; nothing references it by id.
--
-- punch_time is UTC. BioTime returns a *naive local* string ("2026-07-23 09:15:32") in the
-- BioTime server's timezone — the worker parses it as Asia/Kolkata and converts at the edge.
create table if not exists public.raw_punches (
  id             bigint generated always as identity primary key,
  biotime_id     bigint unique,                 -- BioTime transaction id; null for manual inserts
  emp_code       text not null,                 -- canonical device key, always recorded
  employee_id    uuid references public.employees(id) on delete set null,  -- resolved link; nullable

  -- ancestry, stamped from employee_id by trigger so RLS filters without joins (0006 pattern).
  -- Stays null while the punch is unmapped, which correctly restricts it to global-scope readers.
  entity_id      uuid,
  zone_id        uuid,
  branch_id      uuid,
  department_id  uuid,

  punch_time     timestamptz not null,
  punch_state    text,                          -- BioTime code: '0' in, '1' out, '4'/'5' overtime...
  punch_state_label text,                       -- BioTime's own label, kept verbatim
  verify_type    text,                          -- 15 = face, 1 = fingerprint, ...
  terminal_sn    text,                          -- soft reference to devices.serial_number:
                                                -- intentionally NOT a FK, so a punch from a
                                                -- newly-added terminal can never fail to insert
  terminal_alias text,
  area_alias     text,
  upload_time    timestamptz,
  source         text not null default 'biotime',   -- biotime | backfill | manual
  raw            jsonb not null default '{}'::jsonb, -- the full record as received
  created_at     timestamptz not null default now(),

  -- The dedupe key from the brief. Makes re-syncing an overlapping window a no-op.
  unique (emp_code, punch_time)
);

-- Query shapes: the engine reads one employee's day; HR reads a branch's day; the worker
-- checks the high-water mark.
create index if not exists idx_raw_punches_employee_time on public.raw_punches(employee_id, punch_time);
create index if not exists idx_raw_punches_time          on public.raw_punches(punch_time);
create index if not exists idx_raw_punches_emp_code_time on public.raw_punches(emp_code, punch_time);
create index if not exists idx_raw_punches_branch_time   on public.raw_punches(branch_id, punch_time);
create index if not exists idx_raw_punches_unlinked      on public.raw_punches(emp_code)
  where employee_id is null;

create trigger trg_raw_punches_ancestry
  before insert or update of employee_id on public.raw_punches
  for each row execute function app.tg_stamp_ancestry();

-- ---------------------------------------------------------------------------
-- sync_state — the resumable cursor (one row per sync kind)
-- ---------------------------------------------------------------------------
-- Both a transaction id and a punch time are kept. The worker queries BioTime by start_time with a
-- small overlap window and relies on the unique constraint to absorb the repeats, so a punch that
-- shares a boundary second with the last batch can never be skipped.
create table if not exists public.sync_state (
  key                  text primary key,        -- 'transactions' | 'employees' | 'devices'
  last_transaction_id  bigint,
  last_punch_time      timestamptz,
  last_success_at      timestamptz,
  last_error           text,
  consecutive_failures integer not null default 0,
  updated_at           timestamptz not null default now()
);

insert into public.sync_state (key) values ('transactions'), ('employees'), ('devices')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- sync_runs — one row per sync attempt; powers the Phase 5 status page
-- ---------------------------------------------------------------------------
create table if not exists public.sync_runs (
  id               bigint generated always as identity primary key,
  kind             text not null,               -- transactions | employees | devices | backfill
  status           text not null default 'running',  -- running | success | partial | failed
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  duration_ms      integer,
  pages_fetched    integer not null default 0,
  records_fetched  integer not null default 0,
  records_inserted integer not null default 0,
  records_skipped  integer not null default 0,  -- duplicates the unique constraint absorbed
  unmatched_codes  integer not null default 0,  -- punches that landed with no employee link
  cursor_before    jsonb,
  cursor_after     jsonb,
  error_message    text,
  detail           jsonb,
  constraint sync_runs_status_check check (status in ('running','success','partial','failed'))
);

create index if not exists idx_sync_runs_kind_started on public.sync_runs(kind, started_at desc);

-- ---------------------------------------------------------------------------
-- linking helpers
-- ---------------------------------------------------------------------------
-- Resolve one device code to an employee. Only an unambiguous single match auto-links; a code held
-- by two people across entities is left for HR rather than guessed at. A 'manual' or 'ignored'
-- link set by a human is never overwritten.
create or replace function app.link_biotime_employee(_emp_code text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare
  _match_count integer;
  _employee_id uuid;
  _current     text;
begin
  select link_status into _current from public.biotime_employees where emp_code = _emp_code;
  if _current in ('manual','ignored') then
    return (select employee_id from public.biotime_employees where emp_code = _emp_code);
  end if;

  select count(*), min(id) into _match_count, _employee_id
  from public.employees
  where employee_code = _emp_code and status = 'Active';

  if _match_count = 1 then
    update public.biotime_employees
       set employee_id = _employee_id, link_status = 'auto', linked_at = now(), updated_at = now()
     where emp_code = _emp_code;
    return _employee_id;
  elsif _match_count > 1 then
    update public.biotime_employees
       set employee_id = null, link_status = 'ambiguous', updated_at = now()
     where emp_code = _emp_code;
    return null;
  else
    update public.biotime_employees
       set employee_id = null, link_status = 'unmatched', updated_at = now()
     where emp_code = _emp_code;
    return null;
  end if;
end $$;

-- Backfill the link onto punches already sitting unassigned for this code. Called after the worker
-- auto-links, and after HR maps a code by hand. The ancestry trigger re-stamps on update.
-- Returns the number of punches adopted, and the affected date range so the Phase 2 engine knows
-- exactly which employee-dates to recompute.
create or replace function public.resolve_punch_links(_emp_code text)
returns table (punches_linked integer, employee_id uuid, first_date date, last_date date)
language plpgsql security definer set search_path = app, public as $$
declare
  _employee_id uuid;
  _count       integer;
begin
  select be.employee_id into _employee_id
  from public.biotime_employees be where be.emp_code = _emp_code;

  if _employee_id is null then
    return query select 0, null::uuid, null::date, null::date;
    return;
  end if;

  with updated as (
    update public.raw_punches rp
       set employee_id = _employee_id
     where rp.emp_code = _emp_code and rp.employee_id is null
    returning rp.punch_time
  )
  select count(*)::integer,
         min(punch_time at time zone 'Asia/Kolkata')::date,
         max(punch_time at time zone 'Asia/Kolkata')::date
    into _count, first_date, last_date
  from updated;

  punches_linked := coalesce(_count, 0);
  employee_id    := _employee_id;
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, resource, action, description) values
  ('device.manage', 'device', 'manage', 'Manage biometric terminals, code mapping and sync')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'device.manage'
where r.key in ('super_admin','entity_admin','hr_manager')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Writes are service_role only (the sync worker connects directly and bypasses RLS by design —
-- it is a trusted background process with no user context). The one exception is HR resolving a
-- code mapping by hand, which needs an update path from the app.
alter table public.devices           enable row level security;
alter table public.biotime_employees enable row level security;
alter table public.raw_punches       enable row level security;
alter table public.sync_state        enable row level security;
alter table public.sync_runs         enable row level security;

drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices for select to authenticated
  using (app.has_perm('attendance.read', entity_id, null, branch_id, null, null));
drop policy if exists devices_write on public.devices;
create policy devices_write on public.devices for all to authenticated
  using (app.has_perm('device.manage', entity_id, null, branch_id, null, null))
  with check (app.has_perm('device.manage', entity_id, null, branch_id, null, null));

-- The device roster has no ancestry of its own (it is pre-org data), so it is gated globally:
-- only holders of device.manage at a global/entity grant, or a super admin, see it.
drop policy if exists biotime_employees_select on public.biotime_employees;
create policy biotime_employees_select on public.biotime_employees for select to authenticated
  using (app.has_perm('device.manage', null, null, null, null, null));
drop policy if exists biotime_employees_update on public.biotime_employees;
create policy biotime_employees_update on public.biotime_employees for update to authenticated
  using (app.has_perm('device.manage', null, null, null, null, null))
  with check (app.has_perm('device.manage', null, null, null, null, null));

-- Punches are readable by whoever may read that person's attendance. An unmapped punch carries
-- null ancestry and a null employee_id, so has_perm only passes for a global grant / super admin —
-- which is the intent: unidentified punches are an admin exception, not branch-visible data.
drop policy if exists raw_punches_select on public.raw_punches;
create policy raw_punches_select on public.raw_punches for select to authenticated
  using (app.has_perm('attendance.read', entity_id, zone_id, branch_id, department_id, employee_id));

drop policy if exists sync_state_select on public.sync_state;
create policy sync_state_select on public.sync_state for select to authenticated
  using (app.has_perm('device.manage', null, null, null, null, null));
drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs for select to authenticated
  using (app.has_perm('device.manage', null, null, null, null, null));

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
grant select on public.raw_punches, public.sync_state, public.sync_runs to authenticated;
grant select, insert, update, delete on public.devices to authenticated;
grant select, update on public.biotime_employees to authenticated;
grant execute on function public.resolve_punch_links(text) to authenticated;
