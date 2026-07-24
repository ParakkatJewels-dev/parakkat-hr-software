-- 0004_rbac.sql
-- RBAC core. A permission = a ROLE granted within a SCOPE.
-- The same role (e.g. hr_manager) granted at different scopes covers "HR per branch / per department".

create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,      -- 'super_admin','entity_admin','hr_manager',...
  name        text not null,
  description text,
  is_system   boolean not null default false
);

create table if not exists public.permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,      -- 'employee.read','leave.approve','org.manage',...
  resource    text not null,             -- 'employee','leave','org',...
  action      text not null,             -- 'read','create','update','delete','approve','manage','punch'
  description text
);

create table if not exists public.role_permissions (
  role_id       uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- The heart of the model: WHO has WHICH role, WHERE (scope).
create table if not exists public.role_assignments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  role_id     uuid not null references public.roles(id) on delete cascade,
  scope_type  public.scope_type not null,
  scope_id    uuid,                       -- null for global/self; else entity/zone/branch/department id
  granted_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (user_id, role_id, scope_type, scope_id),
  -- scope_id must be null for global/self and present otherwise
  constraint role_assignments_scope_id_chk check (
    (scope_type in ('global','self') and scope_id is null)
    or (scope_type not in ('global','self') and scope_id is not null)
  )
);

create index if not exists idx_role_assignments_user on public.role_assignments(user_id);
create index if not exists idx_role_assignments_scope on public.role_assignments(scope_type, scope_id);
