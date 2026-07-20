-- 0003_identity.sql
-- Employees (the workforce, ~242 real people) are decoupled from logins:
-- most employees never log in. A `profile` links an auth.users login to (optionally) an employee.

create table if not exists public.employees (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references public.entities(id),
  zone_id        uuid references public.zones(id),          -- denormalized ancestry (kept in sync by trigger)
  branch_id      uuid references public.branches(id),
  department_id  uuid references public.departments(id),
  designation_id uuid references public.designations(id),
  employee_code  text,                                       -- generated e.g. 'PPI-0001'
  full_name      text not null,
  email          text,
  phone          text,
  join_date      date,
  status         text not null default 'Active',
  manager_id     uuid references public.employees(id),       -- self-ref, nullable
  salary         jsonb,
  meta           jsonb,
  user_id        uuid references auth.users(id) on delete set null,  -- set when the person is invited to log in
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (entity_id, employee_code)
);

create index if not exists idx_employees_entity     on public.employees(entity_id);
create index if not exists idx_employees_zone        on public.employees(zone_id);
create index if not exists idx_employees_branch      on public.employees(branch_id);
create index if not exists idx_employees_department  on public.employees(department_id);
create index if not exists idx_employees_user        on public.employees(user_id);

create table if not exists public.profiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  employee_id    uuid references public.employees(id) on delete set null,
  is_super_admin boolean not null default false,
  created_at     timestamptz not null default now()
);

-- Keep an employee's ancestry (entity_id, zone_id) consistent with its branch/department.
create or replace function app.tg_employee_ancestry()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.branch_id is not null then
    select b.entity_id, b.zone_id into new.entity_id, new.zone_id
    from public.branches b where b.id = new.branch_id;
  end if;
  if new.department_id is not null and new.entity_id is null then
    select d.entity_id into new.entity_id
    from public.departments d where d.id = new.department_id;
  end if;
  return new;
end $$;

create trigger trg_employees_ancestry
  before insert or update of branch_id, department_id, entity_id on public.employees
  for each row execute function app.tg_employee_ancestry();

create trigger trg_employees_updated
  before update on public.employees for each row execute function app.tg_set_updated_at();

-- Every new auth login automatically gets a profile row.
create or replace function app.handle_new_user()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function app.handle_new_user();
