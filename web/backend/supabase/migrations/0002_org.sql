-- 0002_org.sql
-- Admin-editable org hierarchy: Entity -> Zone -> Branch -> Department -> Designation.
-- Re-parenting an item = updating its FK from the admin UI (no data moves).

create table if not exists public.entities (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,               -- 'PPI', 'PPJ', 'PJT'
  name        text not null,
  legal_name  text,
  gstin       text,
  address     text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.zones (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references public.entities(id) on delete cascade,
  code        text,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (entity_id, code)
);

create table if not exists public.branches (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references public.entities(id) on delete cascade,
  zone_id     uuid references public.zones(id) on delete set null,   -- nullable: Head Office / unmapped
  code        text not null,
  name        text,
  city        text,
  address     text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (entity_id, code)
);

create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references public.entities(id) on delete cascade,
  branch_id   uuid references public.branches(id) on delete set null, -- optional branch-local dept
  code        text,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.designations (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid references public.entities(id) on delete cascade,
  department_id  uuid references public.departments(id) on delete set null,
  title          text not null,
  code           text,
  grade          text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (entity_id, title)
);

create index if not exists idx_zones_entity        on public.zones(entity_id);
create index if not exists idx_branches_entity      on public.branches(entity_id);
create index if not exists idx_branches_zone        on public.branches(zone_id);
create index if not exists idx_departments_entity   on public.departments(entity_id);
create index if not exists idx_departments_branch   on public.departments(branch_id);
create index if not exists idx_designations_entity  on public.designations(entity_id);

-- updated_at triggers
create trigger trg_entities_updated    before update on public.entities    for each row execute function app.tg_set_updated_at();
create trigger trg_zones_updated       before update on public.zones       for each row execute function app.tg_set_updated_at();
create trigger trg_branches_updated    before update on public.branches    for each row execute function app.tg_set_updated_at();
create trigger trg_departments_updated before update on public.departments for each row execute function app.tg_set_updated_at();
create trigger trg_designations_updated before update on public.designations for each row execute function app.tg_set_updated_at();
