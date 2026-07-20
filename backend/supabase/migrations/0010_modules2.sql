-- 0010_modules2.sql
-- Remaining module tables: payroll, documents, recruitment (jobs/candidates), onboarding, exits.
-- Same scoped pattern: rows carry ancestry (entity/zone/branch/department) stamped by triggers,
-- and RLS uses app.has_perm(...). Adds a few permissions the earlier seed didn't include.

-- ---------- new permissions ----------
insert into public.permissions (key, resource, action, description) values
  ('payroll.manage',  'payroll',  'manage', 'Process/manage payroll & payslips'),
  ('document.manage', 'document', 'manage', 'Upload/manage documents'),
  ('exit.create',     'exit',     'create', 'Submit own resignation')
on conflict (key) do nothing;

-- grant the two manage perms to entity_admin + hr_manager; exit.create to employees
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key = any (array['payroll.manage','document.manage'])
where r.key in ('entity_admin','hr_manager')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'exit.create'
where r.key = 'employee'
on conflict do nothing;

-- give super_admin the new perms too (it holds everything)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key = any (array['payroll.manage','document.manage','exit.create'])
where r.key = 'super_admin'
on conflict do nothing;

-- ---------- ancestry stamping helpers for non-employee rows ----------
create or replace function app.tg_stamp_from_branch()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.branch_id is not null then
    select b.entity_id, b.zone_id into new.entity_id, new.zone_id
    from public.branches b where b.id = new.branch_id;
  end if;
  return new;
end $$;

create or replace function app.tg_stamp_from_job()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  select entity_id, zone_id, branch_id, department_id
    into new.entity_id, new.zone_id, new.branch_id, new.department_id
  from public.jobs where id = new.job_id;
  return new;
end $$;

-- ---------- payslips (employee-scoped) ----------
create table if not exists public.payslips (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.employees(id) on delete cascade,
  entity_id uuid, zone_id uuid, branch_id uuid, department_id uuid,
  period       text not null,               -- 'YYYY-MM'
  gross        numeric, deductions numeric, net numeric,
  status       text not null default 'Processed',  -- Draft/Processed/Paid
  created_at   timestamptz not null default now(),
  unique (employee_id, period)
);
create trigger trg_payslips_ancestry before insert or update of employee_id on public.payslips for each row execute function app.tg_stamp_ancestry();

-- ---------- documents (employee-scoped, or company-wide when employee_id is null) ----------
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid references public.employees(id) on delete cascade,
  entity_id uuid, zone_id uuid, branch_id uuid, department_id uuid,
  title        text not null,
  category     text,
  url          text,
  signed       boolean default false,
  created_at   timestamptz not null default now()
);
create trigger trg_documents_ancestry before insert or update of employee_id on public.documents for each row execute function app.tg_stamp_ancestry();

-- ---------- recruitment: jobs + candidates ----------
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid references public.entities(id) on delete cascade,
  zone_id uuid, branch_id uuid references public.branches(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  title         text not null,
  type          text default 'Full-time',
  location      text,
  status        text not null default 'Open',   -- Open/Closed
  openings      int default 1,
  created_at    timestamptz not null default now()
);
create trigger trg_jobs_ancestry before insert or update of branch_id on public.jobs for each row execute function app.tg_stamp_from_branch();

create table if not exists public.candidates (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs(id) on delete cascade,
  entity_id uuid, zone_id uuid, branch_id uuid, department_id uuid,
  name          text not null,
  email         text,
  stage         text not null default 'Applied',  -- Applied/Shortlisted/Interview/Offered/Hired/Rejected
  match_score   int,
  created_at    timestamptz not null default now()
);
create trigger trg_candidates_ancestry before insert or update of job_id on public.candidates for each row execute function app.tg_stamp_from_job();

-- ---------- onboarding ----------
create table if not exists public.onboarding (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid references public.entities(id) on delete cascade,
  zone_id uuid, branch_id uuid references public.branches(id) on delete set null, department_id uuid,
  name          text not null,
  job_title     text,
  join_date     date,
  progress      int default 0,
  tasks         jsonb default '[]'::jsonb,
  created_at    timestamptz not null default now()
);
create trigger trg_onboarding_ancestry before insert or update of branch_id on public.onboarding for each row execute function app.tg_stamp_from_branch();

-- ---------- exits ----------
create table if not exists public.exits (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  entity_id uuid, zone_id uuid, branch_id uuid, department_id uuid,
  last_day      date,
  reason        text,
  status        text not null default 'Clearance in Progress',
  approvals     jsonb default '{"IT":"Pending","Admin":"Pending","Finance":"Pending","HR":"Pending"}'::jsonb,
  created_at    timestamptz not null default now()
);
create trigger trg_exits_ancestry before insert or update of employee_id on public.exits for each row execute function app.tg_stamp_ancestry();

create index if not exists idx_payslips_employee   on public.payslips(employee_id);
create index if not exists idx_documents_employee   on public.documents(employee_id);
create index if not exists idx_candidates_job        on public.candidates(job_id);
create index if not exists idx_jobs_entity           on public.jobs(entity_id);
create index if not exists idx_exits_employee        on public.exits(employee_id);

-- ---------- RLS ----------
alter table public.payslips   enable row level security;
alter table public.documents  enable row level security;
alter table public.jobs       enable row level security;
alter table public.candidates enable row level security;
alter table public.onboarding enable row level security;
alter table public.exits      enable row level security;

create policy payslips_select on public.payslips for select to authenticated
  using (app.has_perm('payslip.read', entity_id, zone_id, branch_id, department_id, employee_id));
create policy payslips_write on public.payslips for all to authenticated
  using (app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, employee_id));

create policy documents_select on public.documents for select to authenticated
  using (app.has_perm('document.read', entity_id, zone_id, branch_id, department_id, employee_id));
create policy documents_write on public.documents for all to authenticated
  using (app.has_perm('document.manage', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('document.manage', entity_id, zone_id, branch_id, department_id, employee_id));

create policy jobs_select on public.jobs for select to authenticated
  using (app.has_perm('recruitment.manage', entity_id, zone_id, branch_id, department_id, null));
create policy jobs_write on public.jobs for all to authenticated
  using (app.has_perm('recruitment.manage', entity_id, zone_id, branch_id, department_id, null))
  with check (app.has_perm('recruitment.manage', entity_id, zone_id, branch_id, department_id, null));

create policy candidates_select on public.candidates for select to authenticated
  using (app.has_perm('recruitment.manage', entity_id, zone_id, branch_id, department_id, null));
create policy candidates_write on public.candidates for all to authenticated
  using (app.has_perm('recruitment.manage', entity_id, zone_id, branch_id, department_id, null))
  with check (app.has_perm('recruitment.manage', entity_id, zone_id, branch_id, department_id, null));

create policy onboarding_select on public.onboarding for select to authenticated
  using (app.has_perm('onboarding.manage', entity_id, zone_id, branch_id, department_id, null));
create policy onboarding_write on public.onboarding for all to authenticated
  using (app.has_perm('onboarding.manage', entity_id, zone_id, branch_id, department_id, null))
  with check (app.has_perm('onboarding.manage', entity_id, zone_id, branch_id, department_id, null));

-- exits: HR manages within scope; an employee can see and file their own
create policy exits_select on public.exits for select to authenticated
  using (app.has_perm('exit.manage', entity_id, zone_id, branch_id, department_id, employee_id)
         or employee_id = app.current_employee_id());
create policy exits_insert on public.exits for insert to authenticated
  with check (app.has_perm('exit.create', entity_id, zone_id, branch_id, department_id, employee_id)
           or app.has_perm('exit.manage', entity_id, zone_id, branch_id, department_id, employee_id));
create policy exits_update on public.exits for update to authenticated
  using (app.has_perm('exit.manage', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('exit.manage', entity_id, zone_id, branch_id, department_id, employee_id));

grant select, insert, update, delete on
  public.payslips, public.documents, public.jobs, public.candidates, public.onboarding, public.exits
  to authenticated;
