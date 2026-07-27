-- 0040_payroll_core.sql
-- Payroll: configurable, scoped pay components + per-employee salary structures + monthly runs.
--
-- Design decisions:
--   * Nothing statutory is hardcoded. PF, ESI, PT and any future deduction are just rows in
--     pay_components, so an admin adds or re-rates one without a code change.
--   * Components are SCOPED like everything else (global / entity / zone / branch / department).
--     A component applies to an employee when its scope contains them; scopes STACK, so a
--     company-wide PF and a branch-specific deduction both apply.
--   * A salary structure fixes `basic` and `gross` per employee, effective-dated. Everything else
--     is derived by components, so a rate change re-computes rather than needing data migration.
--   * LOP: per-day rate = monthly gross / calendar days in that month (the company's chosen basis).
--   * Employer contributions are recorded for cost reporting but never reduce net pay.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- component catalog
-- ---------------------------------------------------------------------------
create table if not exists public.pay_components (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  name           text not null,
  kind           text not null check (kind in ('earning', 'deduction')),
  -- how the amount is derived
  calc_type      text not null check (calc_type in ('fixed', 'percent_of_basic', 'percent_of_gross')),
  rate           numeric(9,4),            -- percent when calc_type is a percentage
  amount         numeric(12,2),           -- rupees when calc_type = 'fixed'
  cap_base       numeric(12,2),           -- e.g. PF computed on at most 15000 of basic
  max_amount     numeric(12,2),           -- hard ceiling on the resulting amount
  -- eligibility by monthly gross, e.g. ESI only when gross <= 21000
  min_gross      numeric(12,2),
  max_gross      numeric(12,2),
  employer_share boolean not null default false,  -- cost to company, not deducted from the employee
  prorate_on_lop boolean not null default false,  -- scale with paid days (allowances often do)
  -- scope: all null = applies company-wide
  entity_id      uuid references public.entities(id) on delete cascade,
  zone_id        uuid references public.zones(id) on delete cascade,
  branch_id      uuid references public.branches(id) on delete cascade,
  department_id  uuid references public.departments(id) on delete cascade,
  display_order  int not null default 100,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_pay_components_active on public.pay_components(is_active);

drop trigger if exists trg_pay_components_updated on public.pay_components;
create trigger trg_pay_components_updated before update on public.pay_components
  for each row execute function app.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- per-employee salary, effective-dated
-- ---------------------------------------------------------------------------
create table if not exists public.salary_structures (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id) on delete cascade,
  effective_from date not null,
  basic          numeric(12,2) not null check (basic >= 0),
  gross          numeric(12,2) not null check (gross >= 0),
  notes          text,
  -- denormalised ancestry so RLS matches the rest of the schema
  entity_id      uuid references public.entities(id),
  zone_id        uuid references public.zones(id),
  branch_id      uuid references public.branches(id),
  department_id  uuid references public.departments(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (employee_id, effective_from),
  constraint salary_basic_le_gross check (basic <= gross)
);
create index if not exists idx_salary_emp_from on public.salary_structures(employee_id, effective_from desc);

drop trigger if exists trg_salary_ancestry on public.salary_structures;
create trigger trg_salary_ancestry before insert or update of employee_id on public.salary_structures
  for each row execute function app.tg_stamp_ancestry();
drop trigger if exists trg_salary_updated on public.salary_structures;
create trigger trg_salary_updated before update on public.salary_structures
  for each row execute function app.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- monthly runs
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_runs (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid references public.entities(id) on delete cascade,
  period       text not null,                       -- 'YYYY-MM'
  status       text not null default 'Draft' check (status in ('Draft', 'Published')),
  employees    int not null default 0,
  total_gross  numeric(14,2) not null default 0,
  total_net    numeric(14,2) not null default 0,
  run_by       uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  unique (entity_id, period)
);

-- Extend the existing payslips table with what a run needs.
alter table public.payslips add column if not exists run_id     uuid references public.payroll_runs(id) on delete cascade;
alter table public.payslips add column if not exists paid_days  numeric(6,2);
alter table public.payslips add column if not exists lop_days   numeric(6,2);
alter table public.payslips add column if not exists employer_cost numeric(12,2);

create table if not exists public.payslip_lines (
  id          uuid primary key default gen_random_uuid(),
  payslip_id  uuid not null references public.payslips(id) on delete cascade,
  code        text not null,
  name        text not null,
  kind        text not null check (kind in ('earning', 'deduction', 'employer')),
  amount      numeric(12,2) not null,
  sort_order  int not null default 100
);
create index if not exists idx_payslip_lines_payslip on public.payslip_lines(payslip_id);

-- ---------------------------------------------------------------------------
-- permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, resource, action, description) values
  ('payroll.manage', 'payroll', 'manage', 'Configure salary structures and run payroll')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'payroll.manage'
where r.key in ('super_admin', 'entity_admin', 'hr_manager')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.pay_components   enable row level security;
alter table public.salary_structures enable row level security;
alter table public.payroll_runs     enable row level security;
alter table public.payslip_lines    enable row level security;

-- The component catalog is configuration, readable by anyone who may run payroll.
drop policy if exists pay_components_select on public.pay_components;
create policy pay_components_select on public.pay_components for select to authenticated
  using (app.has_perm_any_scope('payroll.manage'));
drop policy if exists pay_components_write on public.pay_components;
create policy pay_components_write on public.pay_components for all to authenticated
  using (app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, null)
         or (entity_id is null and app.has_perm_org_wide('payroll.manage')))
  with check (app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, null)
              or (entity_id is null and app.has_perm_org_wide('payroll.manage')));

-- Salary is sensitive: an employee may read their OWN structure, managers need payroll.manage.
drop policy if exists salary_select on public.salary_structures;
create policy salary_select on public.salary_structures for select to authenticated
  using (app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, employee_id)
         or employee_id = app.current_employee_id());
drop policy if exists salary_write on public.salary_structures;
create policy salary_write on public.salary_structures for all to authenticated
  using (app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, null))
  with check (app.has_perm('payroll.manage', entity_id, zone_id, branch_id, department_id, null));

drop policy if exists payroll_runs_select on public.payroll_runs;
create policy payroll_runs_select on public.payroll_runs for select to authenticated
  using (app.has_perm('payroll.manage', entity_id, null, null, null, null)
         or app.has_perm_org_wide('payroll.manage'));
drop policy if exists payroll_runs_write on public.payroll_runs;
create policy payroll_runs_write on public.payroll_runs for all to authenticated
  using (app.has_perm('payroll.manage', entity_id, null, null, null, null))
  with check (app.has_perm('payroll.manage', entity_id, null, null, null, null));

-- Payslip lines inherit the visibility of their payslip (payslip.read covers own payslips).
drop policy if exists payslip_lines_select on public.payslip_lines;
create policy payslip_lines_select on public.payslip_lines for select to authenticated
  using (exists (
    select 1 from public.payslips ps
     where ps.id = payslip_id
       and app.has_perm('payslip.read', ps.entity_id, ps.zone_id, ps.branch_id, ps.department_id, ps.employee_id)
  ));

grant select, insert, update, delete on public.pay_components, public.salary_structures,
  public.payroll_runs, public.payslip_lines to authenticated;
