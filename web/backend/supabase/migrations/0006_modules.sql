-- 0006_modules.sql
-- Employee-scoped module tables. Each row carries the owning employee's ancestry
-- (entity/zone/branch/department), stamped automatically so RLS filters without joins.
-- Additional modules (payroll, documents, recruitment, onboarding, exits) are added in Phase 6
-- following this same pattern.

create table if not exists public.leaves (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  entity_id     uuid, zone_id uuid, branch_id uuid, department_id uuid,   -- stamped by trigger
  type          text not null,
  start_date    date not null,
  end_date      date not null,
  days          numeric,
  reason        text,
  status        text not null default 'Pending',   -- Pending/Approved/Rejected/Cancelled
  approver_id   uuid references public.employees(id),
  created_at    timestamptz not null default now()
);

create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  entity_id     uuid, zone_id uuid, branch_id uuid, department_id uuid,
  category      text,
  amount        numeric not null,
  expense_date  date,
  description   text,
  receipt_url   text,
  status        text not null default 'Draft',     -- Draft/Pending/Approved/Rejected/Paid
  approver_id   uuid references public.employees(id),
  created_at    timestamptz not null default now()
);

create table if not exists public.attendance (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  entity_id     uuid, zone_id uuid, branch_id uuid, department_id uuid,
  work_date     date not null,
  check_in      timestamptz,
  check_out     timestamptz,
  hours         numeric,
  status        text,                              -- On Time/Late In/Early Out/Absent/Half Day/Regularized
  created_at    timestamptz not null default now(),
  unique (employee_id, work_date)
);

create table if not exists public.tickets (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  entity_id     uuid, zone_id uuid, branch_id uuid, department_id uuid,
  category      text,
  subject       text not null,
  description   text,
  priority      text default 'Medium',
  status        text not null default 'Open',      -- Open/In Progress/On Hold/Resolved
  assigned_to   uuid references public.employees(id),
  created_at    timestamptz not null default now()
);

create table if not exists public.assets (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid references public.employees(id) on delete set null,  -- allocated_to (nullable)
  entity_id     uuid, zone_id uuid, branch_id uuid, department_id uuid,
  asset_type    text,
  name          text not null,
  serial        text,
  status        text not null default 'Available', -- Available/Allocated/Under Repair/Damaged/Retired
  created_at    timestamptz not null default now()
);

create index if not exists idx_leaves_employee     on public.leaves(employee_id);
create index if not exists idx_leaves_branch        on public.leaves(branch_id);
create index if not exists idx_expenses_employee    on public.expenses(employee_id);
create index if not exists idx_expenses_branch      on public.expenses(branch_id);
create index if not exists idx_attendance_employee  on public.attendance(employee_id);
create index if not exists idx_attendance_branch    on public.attendance(branch_id);
create index if not exists idx_tickets_employee     on public.tickets(employee_id);
create index if not exists idx_assets_employee      on public.assets(employee_id);

-- Copy the owning employee's ancestry onto the row. Shared by every employee-scoped module table.
create or replace function app.tg_stamp_ancestry()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.employee_id is not null then
    select e.entity_id, e.zone_id, e.branch_id, e.department_id
      into new.entity_id, new.zone_id, new.branch_id, new.department_id
    from public.employees e where e.id = new.employee_id;
  end if;
  return new;
end $$;

create trigger trg_leaves_ancestry     before insert or update of employee_id on public.leaves     for each row execute function app.tg_stamp_ancestry();
create trigger trg_expenses_ancestry   before insert or update of employee_id on public.expenses   for each row execute function app.tg_stamp_ancestry();
create trigger trg_attendance_ancestry before insert or update of employee_id on public.attendance for each row execute function app.tg_stamp_ancestry();
create trigger trg_tickets_ancestry    before insert or update of employee_id on public.tickets    for each row execute function app.tg_stamp_ancestry();
create trigger trg_assets_ancestry     before insert or update of employee_id on public.assets     for each row execute function app.tg_stamp_ancestry();
