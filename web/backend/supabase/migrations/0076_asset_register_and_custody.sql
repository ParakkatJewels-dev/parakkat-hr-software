-- 0076 — The asset register, and who has had each thing.
--
-- WHAT WAS HERE
-- `assets` held a name, a type, a serial, a status and `employee_id` — the current holder. That
-- last column is the whole problem: reallocating a laptop overwrote it, and the previous holder
-- was gone. There was no way to answer "who had this before?", which is the question an asset
-- register exists to answer. audit_log records that the row changed, not who held what and when,
-- and it is scoped to audit.read rather than asset.read.
--
-- CUSTODY IS A TABLE, NOT A COLUMN
-- `asset_assignments` is one row per period of custody: who, from when, until when, in what
-- condition each way. The open row — returned_at is null — is the current holder, and a partial
-- unique index allows only one of those per asset, so two people cannot hold the same phone.
-- `assets.employee_id` stays, maintained by trigger from that table, because RLS scoping and every
-- existing query already read it. It is now a cache of the open assignment, not the truth.
--
-- WHY AN ASSET NEEDS ITS OWN SCOPE
-- app.has_perm called with all-NULL scope matches only a `global` grant. Ancestry on assets was
-- stamped exclusively from the holder, so an asset nobody holds had NULL everything and was
-- invisible to every entity admin and branch manager in the company — that is, unallocated stock,
-- the exact rows somebody goes looking for when they need to give a new joiner a laptop. An asset
-- now belongs to a company and a branch of its own, and the holder's ancestry is layered on top
-- while somebody has it, so both their manager and the owning branch can see it.

begin;

-- ---------------------------------------------------------------------------------- the record
alter table public.assets
  -- What kind of thing this is at the top level. `asset_type` stays as the finer label (Laptop,
  -- Monitor); this separates a licence from a physical object, because they are tracked
  -- differently — one has a key and a renewal date, the other has a serial and a warranty.
  add column if not exists category         text not null default 'Hardware',
  add column if not exists asset_code       text,
  add column if not exists make             text,
  add column if not exists model            text,
  add column if not exists condition        text,
  add column if not exists location         text,
  add column if not exists notes            text,

  -- ---- what it cost and who sold it ----
  add column if not exists purchase_date    date,
  add column if not exists purchase_cost    numeric(12,2),
  add column if not exists vendor           text,
  add column if not exists invoice_no       text,
  add column if not exists warranty_expires date,

  -- ---- software ----
  add column if not exists licence_key      text,
  add column if not exists licence_seats    integer,
  add column if not exists licence_expires  date,

  add column if not exists updated_at       timestamptz not null default now();

comment on column public.assets.employee_id is
  'Who holds it right now. A cache of the open row in asset_assignments, maintained by '
  'app.tg_asset_sync_holder — do not write it directly; open or close an assignment instead.';
comment on column public.assets.entity_id is
  'The company that owns the item, set when it is registered rather than inherited from a holder. '
  'Without it an unallocated asset has NULL scope, which app.has_perm grants only to global roles.';

-- Nobody can hold a negative number of seats, and a licence for zero people is a typo.
alter table public.assets drop constraint if exists assets_seats_positive;
alter table public.assets add constraint assets_seats_positive
  check (licence_seats is null or licence_seats > 0);

-- NOT VALID on purpose: it guards every future write without failing this migration on whatever
-- statuses the existing rows happen to carry.
alter table public.assets drop constraint if exists assets_status_values;
alter table public.assets add constraint assets_status_values
  check (status in ('Available', 'Allocated', 'Under Repair', 'Damaged', 'Lost', 'Retired'))
  not valid;

alter table public.assets drop constraint if exists assets_category_values;
alter table public.assets add constraint assets_category_values
  check (category in ('Hardware', 'Software', 'Furniture', 'Vehicle', 'Other'))
  not valid;

-- A tag written on the side of the thing. Unique per company where it is set, so two branches can
-- both run their own numbering without colliding company-wide.
create unique index if not exists idx_assets_code_per_entity
  on public.assets(entity_id, asset_code)
  where asset_code is not null and entity_id is not null;

create index if not exists idx_assets_status   on public.assets(status);
create index if not exists idx_assets_category on public.assets(category);

-- --------------------------------------------------------------------------------- the custody
create table if not exists public.asset_assignments (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.assets(id) on delete cascade,
  employee_id   uuid references public.employees(id) on delete set null,
  entity_id     uuid, zone_id uuid, branch_id uuid, department_id uuid,

  assigned_at   timestamptz not null default now(),
  assigned_by   uuid references auth.users(id) on delete set null,
  condition_out text,

  returned_at   timestamptz,
  returned_by   uuid references auth.users(id) on delete set null,
  condition_in  text,

  notes         text,
  created_at    timestamptz not null default now()
);

comment on table public.asset_assignments is
  'One row per period somebody held an asset. The row with returned_at null is the current '
  'holder; everything else is history and is never updated again.';

-- Two people cannot hold one thing. This is the constraint the old employee_id column could not
-- express, and it is why reassigning used to silently overwrite the previous holder.
create unique index if not exists idx_asset_one_open_assignment
  on public.asset_assignments(asset_id)
  where returned_at is null;

create index if not exists idx_asset_assign_asset    on public.asset_assignments(asset_id, assigned_at desc);
create index if not exists idx_asset_assign_employee on public.asset_assignments(employee_id);

-- A return cannot precede the handover.
alter table public.asset_assignments drop constraint if exists asset_assignments_dates_sane;
alter table public.asset_assignments add constraint asset_assignments_dates_sane
  check (returned_at is null or returned_at >= assigned_at);

drop trigger if exists trg_asset_assignments_ancestry on public.asset_assignments;
create trigger trg_asset_assignments_ancestry
  before insert or update of employee_id on public.asset_assignments
  for each row execute function app.tg_stamp_ancestry();

-- ------------------------------------------------------------------- the asset follows its rows
-- Ancestry for the asset itself. The shared app.tg_stamp_ancestry() only ever widens FROM an
-- employee and leaves the columns untouched when there is none, which is what left unheld assets
-- unscoped. This keeps the owning company and branch as the floor and layers the holder's
-- department and zone on top only while somebody actually has it.
create or replace function app.tg_asset_scope()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _owner_entity uuid := new.entity_id;
  _owner_branch uuid := new.branch_id;
begin
  if new.employee_id is not null then
    select e.entity_id, e.zone_id, e.branch_id, e.department_id
      into new.entity_id, new.zone_id, new.branch_id, new.department_id
      from public.employees e where e.id = new.employee_id;
    -- Fall back to what was registered if the employee record is missing any of it.
    new.entity_id := coalesce(new.entity_id, _owner_entity);
    new.branch_id := coalesce(new.branch_id, _owner_branch);
  else
    -- Nobody holds it: it answers to wherever it is kept.
    new.zone_id := null;
    new.department_id := null;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_assets_ancestry on public.assets;
create trigger trg_assets_scope
  before insert or update on public.assets
  for each row execute function app.tg_asset_scope();

-- Keep assets.employee_id and status in step with the open assignment, so nothing has to remember
-- to write both. Status is only moved between Available and Allocated: an item returned broken was
-- marked Under Repair deliberately and that must not be undone by the return itself.
create or replace function app.tg_asset_sync_holder()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _asset  uuid := coalesce(new.asset_id, old.asset_id);
  _holder uuid;
begin
  select a.employee_id into _holder
    from public.asset_assignments a
   where a.asset_id = _asset and a.returned_at is null
   limit 1;

  update public.assets
     set employee_id = _holder,
         status = case
                    when _holder is not null then 'Allocated'
                    when status = 'Allocated' then 'Available'
                    else status
                  end
   where id = _asset;

  return null;
end $$;

drop trigger if exists trg_asset_assignments_sync on public.asset_assignments;
create trigger trg_asset_assignments_sync
  after insert or update or delete on public.asset_assignments
  for each row execute function app.tg_asset_sync_holder();

-- --------------------------------------------------------------------------------------- access
-- Mirrors public.assets exactly: seeing an assignment is seeing where the asset has been, so it
-- answers to the same permission the asset does.
alter table public.asset_assignments enable row level security;

drop policy if exists asset_assignments_select on public.asset_assignments;
create policy asset_assignments_select on public.asset_assignments for select to authenticated
  using (
    app.has_perm('asset.read', entity_id, zone_id, branch_id, department_id, employee_id)
    or exists (
      select 1 from public.assets a
       where a.id = asset_id
         and app.has_perm('asset.read', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
    )
  );

drop policy if exists asset_assignments_write on public.asset_assignments;
create policy asset_assignments_write on public.asset_assignments for all to authenticated
  using (
    exists (
      select 1 from public.assets a
       where a.id = asset_id
         and app.has_perm('asset.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
    )
  )
  with check (
    exists (
      select 1 from public.assets a
       where a.id = asset_id
         and app.has_perm('asset.manage', a.entity_id, a.zone_id, a.branch_id, a.department_id, a.employee_id)
    )
  );

-- Legacy rows registered before this migration have no owning company, and all-NULL scope is
-- readable only by a global grant. Same shape as the shifts / holiday_calendars policies in 0036.
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select to authenticated
  using (
    app.has_perm('asset.read', entity_id, zone_id, branch_id, department_id, employee_id)
    or (entity_id is null and app.has_perm_org_wide('asset.read'))
  );

drop policy if exists assets_write on public.assets;
create policy assets_write on public.assets for all to authenticated
  using (
    app.has_perm('asset.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or (entity_id is null and app.has_perm_org_wide('asset.manage'))
  )
  with check (
    app.has_perm('asset.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or (entity_id is null and app.has_perm_org_wide('asset.manage'))
  );

grant select, insert, update, delete on public.asset_assignments to authenticated;

-- ------------------------------------------------------------------------------------- backfill
-- Whoever is recorded as holding something today becomes their own open assignment, so the history
-- starts from what is true rather than from empty. assigned_at is the asset's creation date, which
-- is the earliest defensible claim — the real handover date was never recorded.
insert into public.asset_assignments (asset_id, employee_id, assigned_at, notes)
select a.id, a.employee_id, a.created_at,
       'Opened from the existing allocation when custody history was introduced.'
  from public.assets a
 where a.employee_id is not null
   and not exists (
     select 1 from public.asset_assignments x
      where x.asset_id = a.id and x.returned_at is null
   );

commit;
