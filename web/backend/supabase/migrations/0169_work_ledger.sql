-- Work Ledger, stage 1: a personal creative-operations ledger for any employee.
--
-- Every row belongs to one person (owner_user). The owner reads their ledger; so does a line manager
-- whose role covers the owner's department, branch, zone or company and ranks above the owner
-- (app.ledger_can_read). Super admins are deliberately NOT given access: this is personal work, and
-- the person shares reports with management themselves. Nothing here routes through app.has_perm,
-- which bypasses for super admins.
--
-- Clients may only SELECT. Every write goes through a SECURITY DEFINER RPC so the workflow rules
-- (status history, revision counts, append-only notes) cannot be skipped by a direct PATCH. Deletes
-- are always soft. This stage adds the tables, reading, reports, export and the importer for the
-- original Google Sheet; the everyday write RPCs arrive with the screens in the next stage.
-- Idempotent: safe to re-run.
begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------------------------------
insert into public.permissions (key, resource, action, description) values
  ('ledger.use', 'ledger', 'use', 'Keep a personal Work Ledger'),
  ('ledger.read_team', 'ledger', 'read_team', 'Read (never change) the Work Ledgers of people you manage')
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'ledger.use'
where r.key in ('super_admin', 'entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head', 'employee')
on conflict do nothing;
-- Line management only: not HR, and not the super admin role (see the header).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'ledger.read_team'
where r.key in ('entity_admin', 'zonal_manager', 'branch_manager', 'dept_head')
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------
-- 2. Small helpers
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_today()
returns date language sql stable set search_path = pg_catalog as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;
create or replace function app.ledger_ist_date(_at timestamptz)
returns date language sql immutable set search_path = pg_catalog as $$
  select (_at at time zone 'Asia/Kolkata')::date;
$$;
-- 'YYYY-MM-DDTHH:mm' (or a date) as wall-clock time in Asia/Kolkata.
create or replace function app.ledger_ist_timestamp(_value text)
returns timestamptz language sql immutable set search_path = pg_catalog as $$
  select case when nullif(btrim(_value), '') is null then null
    else (replace(btrim(_value), 'T', ' ')::timestamp at time zone 'Asia/Kolkata') end;
$$;
create or replace function app.ledger_status_event(_status text)
returns text language sql immutable set search_path = pg_catalog as $$
  select case _status
    when 'Internal Review' then 'Sent for internal review'
    when 'Awaiting Approval' then 'Sent for approval'
    when 'Revisions' then 'Back for revisions'
    when 'Approved' then 'Approved'
    when 'Blocked' then 'Blocked'
    when 'In Progress' then 'In progress'
    when 'Cancelled' then 'Cancelled'
  end;
$$;
-- Next occurrence for a repeating task. Monthly keeps the day, clamped to the month's last day.
create or replace function app.ledger_advance_date(_from date, _repeat text)
returns date language sql immutable set search_path = pg_catalog as $$
  select case _repeat
    when 'daily' then _from + 1
    when 'weekly' then _from + 7
    when 'weekdays' then _from + case extract(isodow from _from)::integer when 5 then 3 when 6 then 2 else 1 end
    when 'monthly' then (_from + interval '1 month')::date
  end;
$$;

-- Who may read a ledger: its owner, or a line manager above them (see the header).
create or replace function app.ledger_can_read(_owner uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select auth.uid() is not null and _owner is not null and app.session_is_active() and (
    _owner = auth.uid()
    or exists (
      select 1
      from public.profiles op
      join public.employees oe on oe.id = op.employee_id
      join public.role_assignments ra on ra.user_id = auth.uid()
      join public.roles r on r.id = ra.role_id and r.key <> 'super_admin'
      join public.role_permissions rp on rp.role_id = r.id
      join public.permissions p on p.id = rp.permission_id and p.key = 'ledger.read_team'
      where op.user_id = _owner
        and ((ra.scope_type = 'entity' and ra.scope_id = oe.entity_id)
          or (ra.scope_type = 'zone' and ra.scope_id = oe.zone_id)
          or (ra.scope_type = 'branch' and ra.scope_id = oe.branch_id)
          or (ra.scope_type = 'department' and ra.scope_id = oe.department_id))
        and r.rank > coalesce((select max(r2.rank) from public.role_assignments ra2
          join public.roles r2 on r2.id = ra2.role_id where ra2.user_id = _owner), 0)));
$$;
revoke all on function app.ledger_can_read(uuid) from public, anon, service_role;
grant execute on function app.ledger_can_read(uuid) to authenticated;

-- The signed-in owner, or an error. Writing needs ledger.use; a manager can never write.
create or replace function app.ledger_owner()
returns uuid language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null or not app.session_is_active() or not app.has_perm_any_scope('ledger.use') then
    raise exception using errcode = '42501', message = 'Your role does not include a Work Ledger.';
  end if;
  return auth.uid();
end $$;
revoke all on function app.ledger_owner() from public, anon, authenticated, service_role;

create or replace function app.ledger_reader(_owner uuid)
returns uuid language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := coalesce(_owner, auth.uid());
begin
  if not app.ledger_can_read(_target) then
    raise exception using errcode = '42501', message = 'You cannot see this Work Ledger.';
  end if;
  return _target;
end $$;
revoke all on function app.ledger_reader(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------------------------
create table if not exists public.ledger_settings (
  owner_user uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  seeded_at timestamptz,
  imported_at timestamptz,
  import_locked_at timestamptz,
  sound boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ledger_brands (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  short_label text check (short_label is null or length(short_label) <= 40),
  sort_order integer not null default 100,
  -- Brand foundation: positioning, audiences, tone, visual, offerings, claims.
  foundation jsonb not null default '{}'::jsonb check (jsonb_typeof(foundation) = 'object'),
  foundation_updated_at timestamptz,
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists ledger_brands_name_idx on public.ledger_brands(owner_user, lower(name)) where deleted_at is null;

create table if not exists public.ledger_vendors (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  role text, phone text, email text, rate text,
  rating integer check (rating is null or rating between 1 and 5),
  notes text,
  last_worked date,
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists ledger_vendors_name_idx on public.ledger_vendors(owner_user, lower(name)) where deleted_at is null;
create unique index if not exists ledger_vendors_legacy_idx on public.ledger_vendors(owner_user, legacy_row) where legacy_row is not null;

create table if not exists public.ledger_templates (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  type text,
  subtasks text[] not null default '{}',
  seed_key text,
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists ledger_templates_legacy_idx on public.ledger_templates(owner_user, legacy_row) where legacy_row is not null;
create unique index if not exists ledger_templates_seed_idx on public.ledger_templates(owner_user, seed_key) where seed_key is not null;

create table if not exists public.ledger_key_dates (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  on_date date not null,
  brand text,
  lead_days integer check (lead_days is null or lead_days between 0 and 365),
  notes text,
  seed_key text,
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists ledger_key_dates_legacy_idx on public.ledger_key_dates(owner_user, legacy_row) where legacy_row is not null;
create unique index if not exists ledger_key_dates_seed_idx on public.ledger_key_dates(owner_user, seed_key) where seed_key is not null;

create table if not exists public.ledger_campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  brand text,
  launch_date date,
  brief_link text,
  notes text,
  stage text not null default 'Captured' check (stage in
    ('Captured','Developing','Decision','Approved','Production','Live','Reviewed','Parked','Cancelled')),
  -- Derived from the stage, never set by hand.
  status text generated always as (case
    when stage in ('Captured','Parked') then 'Planning'
    when stage in ('Reviewed','Cancelled') then 'Done'
    else 'Active' end) stored,
  priority text not null default 'Medium' check (priority in ('High','Medium','Low')),
  objective text, next_action text, milestone text, milestone_date date, blocker text, decision text, budget text,
  brief jsonb not null default '{}'::jsonb check (jsonb_typeof(brief) = 'object'),
  measure jsonb not null default '{}'::jsonb check (jsonb_typeof(measure) = 'object'),
  results jsonb not null default '{}'::jsonb check (jsonb_typeof(results) = 'object'),
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists ledger_campaigns_name_idx on public.ledger_campaigns(owner_user, lower(name)) where deleted_at is null;
create unique index if not exists ledger_campaigns_legacy_idx on public.ledger_campaigns(owner_user, legacy_row) where legacy_row is not null;

-- Append-only: stage moves, decisions, edits.
create table if not exists public.ledger_campaign_log (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  campaign_id uuid not null references public.ledger_campaigns(id) on delete cascade,
  at timestamptz not null default now(),
  text text not null,
  legacy_index integer,
  created_at timestamptz not null default now()
);
create index if not exists ledger_campaign_log_campaign_idx on public.ledger_campaign_log(campaign_id, at);
create unique index if not exists ledger_campaign_log_legacy_idx on public.ledger_campaign_log(campaign_id, legacy_index) where legacy_index is not null;

create table if not exists public.ledger_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  logged_at timestamptz not null default now(),
  work_date date not null default app.ledger_today(),
  brand text not null default 'General' check (length(btrim(brand)) between 1 and 80),
  title text not null check (length(btrim(title)) between 1 and 500),
  status text not null default 'Brief' check (status in
    ('Brief','In Progress','Internal Review','Awaiting Approval','Revisions','Approved','Delivered','Blocked','Cancelled')),
  priority text not null default 'Medium' check (priority in ('High','Medium','Low')),
  deadline date, start_date date, end_date date,
  last_updated date,
  repeat text check (repeat is null or repeat in ('daily','weekly','weekdays','monthly')),
  pinned boolean not null default false,
  type text,
  campaign_id uuid references public.ledger_campaigns(id),
  tags text[] not null default '{}',
  revision integer not null default 0 check (revision >= 0),
  status_since date,
  waiting_on text,
  focus_date date,
  outcome text,
  est_cost numeric(14,2), actual_cost numeric(14,2),
  vendor_id uuid references public.ledger_vendors(id),
  brief jsonb check (brief is null or jsonb_typeof(brief) in ('object','string')),
  for_whom text,
  minutes integer check (minutes is null or minutes >= 0),
  -- Only ledger_log_support writes 'support'. A normal task whose type is Review / Feedback is NOT support.
  entry_kind text check (entry_kind is null or entry_kind = 'support'),
  depends_on uuid references public.ledger_tasks(id),
  approved_version text,
  recurrence_child_id uuid references public.ledger_tasks(id),
  source_idea_id uuid,
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists ledger_tasks_legacy_idx on public.ledger_tasks(owner_user, legacy_row) where legacy_row is not null;
create index if not exists ledger_tasks_open_idx on public.ledger_tasks(owner_user, status) where deleted_at is null;
create index if not exists ledger_tasks_touched_idx on public.ledger_tasks(owner_user, last_updated) where deleted_at is null;
create index if not exists ledger_tasks_logged_idx on public.ledger_tasks(owner_user, logged_at desc) where deleted_at is null;
create index if not exists ledger_tasks_campaign_idx on public.ledger_tasks(campaign_id) where campaign_id is not null;

-- "Notes / Links" as append-only history: one row per stamped line, plus the imported original.
create table if not exists public.ledger_task_log (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null references public.ledger_tasks(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in ('note','change','attachment','imported')),
  text text not null,
  changes jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ledger_task_log_task_idx on public.ledger_task_log(task_id, at, id);
create unique index if not exists ledger_task_log_imported_idx on public.ledger_task_log(task_id) where kind = 'imported';

create table if not exists public.ledger_subtasks (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null references public.ledger_tasks(id) on delete cascade,
  text text not null check (length(btrim(text)) between 1 and 500),
  done boolean not null default false,
  position integer not null default 0,
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists ledger_subtasks_task_idx on public.ledger_subtasks(task_id, position);
create unique index if not exists ledger_subtasks_legacy_idx on public.ledger_subtasks(owner_user, legacy_row) where legacy_row is not null;

create table if not exists public.ledger_deliverables (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null references public.ledger_tasks(id) on delete cascade,
  type text, version text, link text, used_where text,
  added_at timestamptz not null default now(),
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists ledger_deliverables_task_idx on public.ledger_deliverables(task_id, added_at);
create unique index if not exists ledger_deliverables_legacy_idx on public.ledger_deliverables(owner_user, legacy_row) where legacy_row is not null;

create table if not exists public.ledger_progress (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null references public.ledger_tasks(id) on delete cascade,
  on_date date not null default app.ledger_today(),
  note text not null check (length(btrim(note)) between 1 and 4000),
  minutes integer check (minutes is null or minutes >= 0),
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists ledger_progress_task_idx on public.ledger_progress(task_id, on_date);
create index if not exists ledger_progress_owner_idx on public.ledger_progress(owner_user, on_date) where deleted_at is null;
create unique index if not exists ledger_progress_legacy_idx on public.ledger_progress(owner_user, legacy_row) where legacy_row is not null;

create table if not exists public.ledger_attachments (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null references public.ledger_tasks(id) on delete cascade,
  kind text not null check (kind in ('file','link')),
  name text not null check (length(btrim(name)) between 1 and 300),
  url text,
  storage_path text,
  size_bytes bigint,
  content_type text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint ledger_attachments_shape check (
    (kind = 'link' and url is not null and storage_path is null)
    or (kind = 'file' and storage_path is not null and url is null))
);
create index if not exists ledger_attachments_task_idx on public.ledger_attachments(task_id, created_at);
create unique index if not exists ledger_attachments_link_idx on public.ledger_attachments(task_id, url) where kind = 'link' and deleted_at is null;

create table if not exists public.ledger_ideas (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text text not null check (length(btrim(text)) between 1 and 4000),
  -- The first wording, kept forever.
  original text not null,
  brand text,
  tags text[] not null default '{}',
  links text,
  status text not null default 'Open' check (status in ('Open','Developing','Parked','Promoted','Archived')),
  revisit_date date,
  revisit_when text,
  concept jsonb not null default '{}'::jsonb check (jsonb_typeof(concept) = 'object'),
  task_id uuid references public.ledger_tasks(id),
  campaign_id uuid references public.ledger_campaigns(id),
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists ledger_ideas_legacy_idx on public.ledger_ideas(owner_user, legacy_row) where legacy_row is not null;
create index if not exists ledger_ideas_owner_idx on public.ledger_ideas(owner_user, status, created_at desc) where deleted_at is null;

create table if not exists public.ledger_campaign_ideas (
  campaign_id uuid not null references public.ledger_campaigns(id) on delete cascade,
  idea_id uuid not null references public.ledger_ideas(id) on delete cascade,
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, idea_id)
);

create table if not exists public.ledger_reminders (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text text not null check (length(btrim(text)) between 1 and 500),
  due_at timestamptz not null,
  repeat text check (repeat is null or repeat in ('daily','weekly','weekdays','monthly')),
  done boolean not null default false,
  done_at timestamptz,
  source text not null default 'reminder' check (source in ('reminder','followup')),
  task_id uuid references public.ledger_tasks(id),
  calendar_event_id text,
  calendar_state text not null default 'none' check (calendar_state in ('none','pending','synced','failed')),
  calendar_error text,
  legacy_row integer,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists ledger_reminders_legacy_idx on public.ledger_reminders(owner_user, legacy_row) where legacy_row is not null;
create index if not exists ledger_reminders_due_idx on public.ledger_reminders(owner_user, due_at) where deleted_at is null and not done;

-- Legacy-row uniqueness for the brand foundation rows and campaign rows already exists above.
create unique index if not exists ledger_brands_legacy_idx on public.ledger_brands(owner_user, legacy_row) where legacy_row is not null;

-- ---------------------------------------------------------------------------------------------
-- 4. Row security: read-only to clients
-- ---------------------------------------------------------------------------------------------
do $$
declare _table text;
begin
  foreach _table in array array['ledger_settings','ledger_brands','ledger_vendors','ledger_templates','ledger_key_dates',
    'ledger_campaigns','ledger_campaign_log','ledger_tasks','ledger_task_log','ledger_subtasks','ledger_deliverables',
    'ledger_progress','ledger_attachments','ledger_ideas','ledger_campaign_ideas'] loop
    execute format('alter table public.%I enable row level security', _table);
    execute format('drop policy if exists ledger_read on public.%I', _table);
    execute format('create policy ledger_read on public.%I for select to authenticated using (app.ledger_can_read(owner_user))', _table);
    execute format('drop policy if exists active_account_required on public.%I', _table);
    execute format('create policy active_account_required on public.%I as restrictive for all to authenticated using (app.session_is_active()) with check (app.session_is_active())', _table);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', _table);
    execute format('grant select on public.%I to authenticated', _table);
  end loop;
  -- Reminders belong to the owner alone; managers never see someone's reminders or calendar.
  alter table public.ledger_reminders enable row level security;
  drop policy if exists ledger_read on public.ledger_reminders;
  create policy ledger_read on public.ledger_reminders for select to authenticated using (owner_user = auth.uid());
  drop policy if exists active_account_required on public.ledger_reminders;
  create policy active_account_required on public.ledger_reminders as restrictive for all to authenticated
    using (app.session_is_active()) with check (app.session_is_active());
  revoke all on public.ledger_reminders from public, anon, authenticated, service_role;
  grant select on public.ledger_reminders to authenticated;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. First use: starter brands and templates
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_seed(_owner uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into public.ledger_settings(owner_user) values (_owner) on conflict (owner_user) do nothing;
  if (select seeded_at from public.ledger_settings where owner_user = _owner) is not null then return; end if;
  insert into public.ledger_brands(owner_user, name, short_label, sort_order)
  select _owner, b.name, b.short_label, b.sort_order
  from (values ('Parakkat Jewels','Jewels',1), ('Parakkat Munnar Resort','Munnar',2),
    ('Parakkat Riverscape','Riverscape',3), ('Parakkat Adimali Retreat','Adimali',4), ('General','General',5))
    as b(name, short_label, sort_order)
  where not exists(select 1 from public.ledger_brands x where x.owner_user = _owner and lower(x.name) = lower(b.name) and x.deleted_at is null);
  insert into public.ledger_templates(owner_user, name, type, subtasks, seed_key)
  select _owner, t.name, t.type, t.subtasks, t.seed_key
  from (values
    ('product-shoot', 'Product shoot', 'Photography', array['Brief and shot list','Book photographer and studio','Select and style products','Shoot day','Select and retouch','Deliver final images']),
    ('ad-campaign', 'Ad campaign', 'Ads', array['Objective and audience','Concept and copy','Design creatives','Internal review','Approval','Launch','Report results']),
    ('print-job', 'Print job', 'Print', array['Brief and sizes','Design','Internal review','Approval','Send to printer','Check proof','Delivery and installation']),
    ('reel', 'Reel', 'Video', array['Concept and script','Shoot','Edit','Music and captions','Review','Post'])
  ) as t(seed_key, name, type, subtasks)
  on conflict do nothing;
  update public.ledger_settings set seeded_at = now(), updated_at = now() where owner_user = _owner;
end $$;
revoke all on function app.ledger_seed(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Reading
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_brand_order(_owner uuid)
returns table(brand text, label text, sort_order integer) language sql stable security definer set search_path = pg_catalog as $$
  select b.name, coalesce(b.short_label, b.name), b.sort_order from public.ledger_brands b
  where b.owner_user = _owner and b.deleted_at is null;
$$;
revoke all on function app.ledger_brand_order(uuid) from public, anon, authenticated, service_role;

-- Everything the pickers need, in one call (webGetBootstrap).
create or replace function app.ledger_bootstrap_data(_owner uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object(
    'owner', jsonb_build_object('user_id', _owner,
      'name', (select e.full_name from public.profiles p join public.employees e on e.id = p.employee_id where p.user_id = _owner),
      'designation', (select g.title from public.profiles p join public.employees e on e.id = p.employee_id
        left join public.designations g on g.id = e.designation_id where p.user_id = _owner)),
    'settings', (select jsonb_build_object('seeded_at', s.seeded_at, 'imported_at', s.imported_at,
      'import_locked_at', s.import_locked_at, 'sound', s.sound) from public.ledger_settings s where s.owner_user = _owner),
    'brands', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'label', coalesce(b.short_label, b.name),
      'sort_order', b.sort_order, 'foundation', b.foundation) order by b.sort_order, lower(b.name))
      from public.ledger_brands b where b.owner_user = _owner and b.deleted_at is null), '[]'),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'type', t.type, 'subtasks', t.subtasks)
      order by lower(t.name)) from public.ledger_templates t where t.owner_user = _owner and t.deleted_at is null), '[]'),
    'vendors', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'role', v.role, 'last_worked', v.last_worked)
      order by lower(v.name)) from public.ledger_vendors v where v.owner_user = _owner and v.deleted_at is null), '[]'),
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'brand', c.brand, 'stage', c.stage,
      'status', c.status) order by lower(c.name)) from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null), '[]'),
    'people', coalesce((select jsonb_agg(p order by lower(p)) from (select distinct btrim(t.for_whom) p from public.ledger_tasks t
      where t.owner_user = _owner and t.deleted_at is null and nullif(btrim(t.for_whom), '') is not null) x), '[]'),
    'used_types', coalesce((select jsonb_agg(p order by lower(p)) from (select distinct btrim(t.type) p from public.ledger_tasks t
      where t.owner_user = _owner and t.deleted_at is null and nullif(btrim(t.type), '') is not null) x), '[]'),
    'used_brands', coalesce((select jsonb_agg(p order by lower(p)) from (select distinct btrim(t.brand) p from public.ledger_tasks t
      where t.owner_user = _owner and t.deleted_at is null) x), '[]'),
    'counts', jsonb_build_object(
      'tasks', (select count(*) from public.ledger_tasks t where t.owner_user = _owner and t.deleted_at is null and t.entry_kind is null),
      'support', (select count(*) from public.ledger_tasks t where t.owner_user = _owner and t.deleted_at is null and t.entry_kind = 'support'),
      'subtasks', (select count(*) from public.ledger_subtasks x where x.owner_user = _owner and x.deleted_at is null),
      'deliverables', (select count(*) from public.ledger_deliverables x where x.owner_user = _owner and x.deleted_at is null),
      'progress', (select count(*) from public.ledger_progress x where x.owner_user = _owner and x.deleted_at is null),
      'campaigns', (select count(*) from public.ledger_campaigns x where x.owner_user = _owner and x.deleted_at is null),
      'ideas', (select count(*) from public.ledger_ideas x where x.owner_user = _owner and x.deleted_at is null),
      'vendors', (select count(*) from public.ledger_vendors x where x.owner_user = _owner and x.deleted_at is null),
      'templates', (select count(*) from public.ledger_templates x where x.owner_user = _owner and x.deleted_at is null),
      'key_dates', (select count(*) from public.ledger_key_dates x where x.owner_user = _owner and x.deleted_at is null),
      'reminders', case when _owner = auth.uid() then (select count(*) from public.ledger_reminders x where x.owner_user = _owner and x.deleted_at is null) end));
$$;
revoke all on function app.ledger_bootstrap_data(uuid) from public, anon, authenticated, service_role;

-- First call of a session: makes sure the starter data exists, then returns the bootstrap.
create or replace function public.ledger_open()
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  perform app.ledger_seed(_owner);
  return app.ledger_bootstrap_data(_owner);
end $$;

create or replace function public.ledger_bootstrap(_owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  return app.ledger_bootstrap_data(app.ledger_reader(_owner));
end $$;

-- People whose ledger the caller may read, for the managers' Team view.
create or replace function public.ledger_team_members()
returns table(user_id uuid, employee_id uuid, name text, code text, department text, designation text)
language sql stable security definer set search_path = pg_catalog as $$
  select p.user_id, e.id, e.full_name, e.employee_code, d.name, g.title
  from public.profiles p join public.employees e on e.id = p.employee_id
  left join public.departments d on d.id = e.department_id
  left join public.designations g on g.id = e.designation_id
  where p.user_id <> auth.uid() and e.status = 'Active' and app.ledger_can_read(p.user_id)
  order by e.full_name, e.id;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Reports (webGetReport). The share text is formatted by the client from this data.
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_period(_period text, _date text, _today date)
returns table(period text, from_date date, to_date date, single_day boolean)
language plpgsql immutable set search_path = pg_catalog as $$
declare _value text := nullif(btrim(coalesce(_date, '')), ''); _from date; _to date;
begin
  case coalesce(_period, 'day')
    when 'day' then _from := coalesce(_value::date, _today); _to := _from;
    when 'week' then
      _from := coalesce(_value::date, _today);
      _from := _from - (extract(isodow from _from)::integer - 1);
      _to := _from + 6;
    when 'month' then
      if _value is not null and _value !~ '^\d{4}-\d{2}$' then
        raise exception using errcode = '22023', message = 'A month looks like 2026-10.';
      end if;
      _from := coalesce((_value || '-01')::date, date_trunc('month', _today)::date);
      _to := (_from + interval '1 month')::date - 1;
    when 'all' then _from := date '2000-01-01'; _to := _today;
    when 'range' then
      if _value is null or _value !~ '^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$' then
        raise exception using errcode = '22023', message = 'A custom period looks like 2026-10-01|2026-10-31.';
      end if;
      _from := split_part(_value, '|', 1)::date; _to := split_part(_value, '|', 2)::date;
      if _to < _from then raise exception using errcode = '22023', message = 'The period ends before it starts.'; end if;
    else raise exception using errcode = '22023', message = 'Choose day, week, month, all or range.';
  end case;
  return query select coalesce(_period, 'day'), _from, _to, _from = _to;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode = '22023', message = 'That is not a real date.';
end $$;

create or replace function app.ledger_report_data(_owner uuid, _period text, _from date, _to date, _today date, _single boolean)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
with brands as (select * from app.ledger_brand_order(_owner)),
t as (
  select t.*, coalesce(t.last_updated, app.ledger_ist_date(t.logged_at)) as touched, app.ledger_ist_date(t.logged_at) as logged_on,
    coalesce(b.label, t.brand) as brand_label, coalesce(b.sort_order, 1000) as brand_rank,
    c.name as campaign_name, coalesce(t.status_since, t.last_updated, app.ledger_ist_date(t.logged_at)) as since
  from public.ledger_tasks t
  left join brands b on lower(b.brand) = lower(t.brand)
  left join public.ledger_campaigns c on c.id = t.campaign_id
  where t.owner_user = _owner and t.deleted_at is null
),
notes as (
  select p.task_id, p.on_date, p.note, p.minutes, p.created_at, p.id from public.ledger_progress p
  where p.owner_user = _owner and p.deleted_at is null
),
work as (
  select t.*,
    (t.status_since between _from and _to and t.status <> 'Brief') as moved,
    (t.logged_on between _from and _to) as is_new,
    exists(select 1 from notes n where n.task_id = t.id and n.on_date between _from and _to) as noted
  from t where t.entry_kind is null and t.status not in ('Delivered','Cancelled')
),
worked as (
  select w.*, case when w.moved and w.status in ('Internal Review','Awaiting Approval','Revisions','Approved') then 0
    when w.moved then 1 else 2 end as grp
  from work w where w.moved or w.is_new or w.noted
),
delivered as (
  select t.* from t where t.entry_kind is null and t.status = 'Delivered' and t.since between _from and _to
),
support as (
  select t.* from t where t.entry_kind = 'support' and coalesce(t.work_date, t.logged_on) between _from and _to
),
active as (select t.* from t where t.entry_kind is null and t.touched between _from and _to),
open_tasks as (select t.* from t where t.entry_kind is null and t.status not in ('Delivered','Cancelled'))
select jsonb_build_object(
  'period', _period, 'from', _from, 'to', _to, 'today', _today, 'single_day', _single,
  'worked_on', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'title', w.title, 'brand', w.brand, 'brand_label', w.brand_label,
      'status', w.status, 'event', case when w.moved then app.ledger_status_event(w.status) end, 'is_new', w.is_new, 'group', w.grp,
      'notes', coalesce((select jsonb_agg(jsonb_build_object('date', n.on_date, 'note', n.note, 'minutes', n.minutes) order by n.on_date, n.created_at, n.id)
        from notes n where n.task_id = w.id and n.on_date between _from and _to), '[]'))
    order by w.grp, w.brand_rank, lower(w.brand), w.logged_at, w.id) from worked w), '[]'),
  'delivered', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'brand', d.brand, 'brand_label', d.brand_label,
      'outcome', d.outcome, 'delivered_on', d.since,
      'notes', coalesce((select jsonb_agg(jsonb_build_object('date', n.on_date, 'note', n.note, 'minutes', n.minutes) order by n.on_date, n.created_at, n.id)
        from notes n where n.task_id = d.id), '[]'))
    order by d.brand_rank, lower(d.brand), d.since, d.logged_at, d.id) from delivered d), '[]'),
  'support', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'for_whom', s.for_whom, 'minutes', s.minutes,
      'brand', s.brand, 'brand_label', s.brand_label, 'type', s.type, 'date', coalesce(s.work_date, s.logged_on))
    order by coalesce(s.work_date, s.logged_on), s.logged_at, s.id) from support s), '[]'),
  'support_by_person', coalesce((select jsonb_agg(jsonb_build_object('person', x.person, 'count', x.n, 'minutes', x.minutes) order by x.n desc, lower(x.person))
    from (select coalesce(nullif(btrim(s.for_whom), ''), 'Unnamed') as person, count(*) as n, coalesce(sum(s.minutes), 0) as minutes
      from support s group by 1) x), '[]'),
  'support_minutes', (select coalesce(sum(s.minutes), 0) from support s),
  'pending_now', case when _single then coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'brand', o.brand,
      'brand_label', o.brand_label, 'status', o.status, 'deadline', o.deadline, 'untouched', not exists(select 1 from worked w where w.id = o.id))
    order by o.brand_rank, lower(o.brand), o.logged_at, o.id) from open_tasks o), '[]') else '[]'::jsonb end,
  'overdue', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'brand', o.brand, 'brand_label', o.brand_label,
      'deadline', o.deadline) order by o.deadline, o.logged_at, o.id) from open_tasks o where o.deadline < _today), '[]'),
  'blocked', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'brand', o.brand, 'brand_label', o.brand_label,
      'status', o.status, 'waiting_on', o.waiting_on, 'since', o.since) order by o.since, o.logged_at, o.id)
    from open_tasks o where o.status in ('Blocked','Awaiting Approval','Internal Review')), '[]'),
  'wins', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'brand_label', d.brand_label, 'outcome', d.outcome)
    order by d.since, d.logged_at, d.id) from delivered d where nullif(btrim(d.outcome), '') is not null), '[]'),
  'by_brand', coalesce((select jsonb_agg(jsonb_build_object('brand', x.brand, 'label', x.label, 'items', x.items, 'done', x.done)
    order by x.rank, lower(x.brand)) from (
      select a.brand, min(a.brand_label) as label, min(a.brand_rank) as rank, count(*) as items,
        count(*) filter (where a.id in (select d.id from delivered d)) as done
      from active a group by a.brand) x), '[]'),
  'by_campaign', coalesce((select jsonb_agg(jsonb_build_object('campaign', x.name, 'done', x.done, 'total', x.total, 'spend', x.spend)
    order by lower(x.name)) from (
      select a.campaign_name as name, count(*) as total, count(*) filter (where a.id in (select d.id from delivered d)) as done,
        coalesce(sum(a.actual_cost), 0) as spend
      from active a where a.campaign_name is not null group by a.campaign_name) x), '[]'),
  'by_type', coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'items', x.items, 'done', x.done) order by x.items desc, lower(x.type))
    from (select coalesce(nullif(btrim(a.type), ''), 'Other') as type, count(*) as items,
      count(*) filter (where a.id in (select d.id from delivered d)) as done from active a group by 1) x), '[]'),
  'cost', jsonb_build_object('est', (select coalesce(sum(a.est_cost), 0) from active a), 'actual', (select coalesce(sum(a.actual_cost), 0) from active a)),
  'ideas_captured', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'text', i.text, 'brand', i.brand) order by i.created_at, i.id)
    from public.ledger_ideas i where i.owner_user = _owner and i.deleted_at is null
      and app.ledger_ist_date(i.created_at) between _from and _to), '[]')
);
$$;
revoke all on function app.ledger_report_data(uuid,text,date,date,date,boolean) from public, anon, authenticated, service_role;

create or replace function public.ledger_report(_period text default 'day', _date text default null, _owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner); _today date := app.ledger_today(); _p record;
begin
  select * into _p from app.ledger_period(_period, _date, _today);
  return app.ledger_report_data(_target, _p.period, _p.from_date, _p.to_date, _today, _p.single_day);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 8. Export: every task with the 33 original columns (webExportAll). Owner only.
-- ---------------------------------------------------------------------------------------------
create or replace function public.ledger_export_tasks()
returns setof jsonb language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object(
    'id', t.id,
    'logged_at', to_char(t.logged_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI'),
    'work_date', t.work_date, 'brand', t.brand, 'task', t.title, 'status', t.status, 'priority', t.priority,
    'deadline', t.deadline, 'start_date', t.start_date, 'end_date', t.end_date,
    'notes', (select string_agg(l.text, E'\n' order by l.kind <> 'imported', l.at, l.id) from public.ledger_task_log l where l.task_id = t.id),
    'last_updated', t.last_updated, 'repeat', t.repeat, 'pinned', t.pinned, 'type', t.type,
    'campaign', (select c.name from public.ledger_campaigns c where c.id = t.campaign_id),
    'tags', array_to_string(t.tags, ', '), 'revision', t.revision, 'status_since', t.status_since, 'waiting_on', t.waiting_on,
    'focus_date', t.focus_date, 'outcome', t.outcome, 'est_cost', t.est_cost, 'actual_cost', t.actual_cost,
    'vendor', (select v.name from public.ledger_vendors v where v.id = t.vendor_id),
    'brief', t.brief, 'for_whom', t.for_whom, 'minutes', t.minutes, 'entry_kind', t.entry_kind,
    'depends_on', t.depends_on, 'approved_version', t.approved_version)
  from public.ledger_tasks t
  where t.owner_user = app.ledger_owner() and t.deleted_at is null
  order by t.logged_at, t.created_at, t.id;
$$;

-- ---------------------------------------------------------------------------------------------
-- 9. Import from the original Sheet (owner only). The browser parses and normalises the workbook
--    and sends batches; rows are matched on their original sheet row number (legacy_row). A row the
--    owner has edited since it was imported is reported as a conflict, never overwritten.
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_import_rows(_owner uuid, _kind text, _rows jsonb, _now timestamptz)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _done jsonb := '[]'; _unresolved jsonb := '[]';
begin
  if _kind = 'brands' then
    with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, brand text, positioning text, audiences text,
        tone text, visual text, offerings text, claims text, updated_at text)),
    up as (
      insert into public.ledger_brands as b (owner_user, name, sort_order, foundation, foundation_updated_at, legacy_row, imported_at, updated_at)
      select _owner, btrim(i.brand), 100, jsonb_strip_nulls(jsonb_build_object('positioning', i.positioning, 'audiences', i.audiences,
          'tone', i.tone, 'visual', i.visual, 'offerings', i.offerings, 'claims', i.claims)),
        app.ledger_ist_timestamp(i.updated_at), i.legacy_row, _now, _now
      from input i where nullif(btrim(i.brand), '') is not null
      on conflict (owner_user, lower(name)) where deleted_at is null do update set
        foundation = excluded.foundation, foundation_updated_at = excluded.foundation_updated_at,
        legacy_row = excluded.legacy_row, imported_at = excluded.imported_at, updated_at = excluded.updated_at
      where b.imported_at is null or b.updated_at <= b.imported_at
      returning b.legacy_row, (xmax = 0) as inserted)
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;

  elsif _kind = 'vendors' then
    with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, name text, role text, phone text, email text,
        rate text, rating integer, notes text, last_worked date)),
    up as (
      insert into public.ledger_vendors as v (owner_user, name, role, phone, email, rate, rating, notes, last_worked, legacy_row, imported_at, updated_at)
      select _owner, btrim(i.name), i.role, i.phone, i.email, i.rate, i.rating, i.notes, i.last_worked, i.legacy_row, _now, _now
      from input i where nullif(btrim(i.name), '') is not null
      on conflict (owner_user, lower(name)) where deleted_at is null do update set
        role = excluded.role, phone = excluded.phone, email = excluded.email, rate = excluded.rate, rating = excluded.rating,
        notes = excluded.notes, last_worked = greatest(v.last_worked, excluded.last_worked), legacy_row = excluded.legacy_row,
        imported_at = excluded.imported_at, updated_at = excluded.updated_at
      where v.imported_at is null or v.updated_at <= v.imported_at
      returning v.legacy_row, (xmax = 0) as inserted)
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;

  elsif _kind = 'templates' then
    with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, name text, type text, subtasks text[])),
    up as (
      insert into public.ledger_templates as t (owner_user, name, type, subtasks, legacy_row, imported_at, updated_at)
      select _owner, btrim(i.name), i.type, coalesce(i.subtasks, '{}'), i.legacy_row, _now, _now
      from input i where nullif(btrim(i.name), '') is not null
      on conflict (owner_user, legacy_row) where legacy_row is not null do update set
        name = excluded.name, type = excluded.type, subtasks = excluded.subtasks, imported_at = excluded.imported_at, updated_at = excluded.updated_at
      where t.updated_at <= t.imported_at
      returning t.legacy_row, (xmax = 0) as inserted)
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;

  elsif _kind = 'key_dates' then
    with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, name text, date date, brand text, lead_days integer, notes text)),
    up as (
      insert into public.ledger_key_dates as k (owner_user, name, on_date, brand, lead_days, notes, legacy_row, imported_at, updated_at)
      select _owner, btrim(i.name), i.date, i.brand, i.lead_days, i.notes, i.legacy_row, _now, _now
      from input i where nullif(btrim(i.name), '') is not null and i.date is not null
      on conflict (owner_user, legacy_row) where legacy_row is not null do update set
        name = excluded.name, on_date = excluded.on_date, brand = excluded.brand, lead_days = excluded.lead_days,
        notes = excluded.notes, imported_at = excluded.imported_at, updated_at = excluded.updated_at
      where k.updated_at <= k.imported_at
      returning k.legacy_row, (xmax = 0) as inserted)
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;

  elsif _kind = 'campaigns' then
    with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, name text, brand text, launch_date date,
        brief_link text, notes text, created_at text, stage text, priority text, objective text, next_action text, milestone text,
        milestone_date date, blocker text, decision text, budget text, brief jsonb, measure jsonb, results jsonb)),
    up as (
      insert into public.ledger_campaigns as c (owner_user, name, brand, launch_date, brief_link, notes, created_at, stage, priority,
          objective, next_action, milestone, milestone_date, blocker, decision, budget, brief, measure, results, legacy_row, imported_at, updated_at)
      select _owner, btrim(i.name), i.brand, i.launch_date, i.brief_link, i.notes, coalesce(app.ledger_ist_timestamp(i.created_at), _now),
        coalesce(i.stage, 'Captured'), coalesce(i.priority, 'Medium'), i.objective, i.next_action, i.milestone, i.milestone_date,
        i.blocker, i.decision, i.budget, coalesce(i.brief, '{}'), coalesce(i.measure, '{}'), coalesce(i.results, '{}'), i.legacy_row, _now, _now
      from input i where nullif(btrim(i.name), '') is not null
      on conflict (owner_user, lower(name)) where deleted_at is null do update set
        brand = excluded.brand, launch_date = excluded.launch_date, brief_link = excluded.brief_link, notes = excluded.notes,
        created_at = excluded.created_at, stage = excluded.stage, priority = excluded.priority, objective = excluded.objective,
        next_action = excluded.next_action, milestone = excluded.milestone, milestone_date = excluded.milestone_date,
        blocker = excluded.blocker, decision = excluded.decision, budget = excluded.budget, brief = excluded.brief,
        measure = excluded.measure, results = excluded.results, legacy_row = excluded.legacy_row,
        imported_at = excluded.imported_at, updated_at = excluded.updated_at
      where c.imported_at is null or c.updated_at <= c.imported_at
      returning c.id, c.legacy_row, (xmax = 0) as inserted),
    logs as (
      insert into public.ledger_campaign_log(owner_user, campaign_id, at, text, legacy_index)
      select _owner, u.id, coalesce(app.ledger_ist_timestamp(l.value->>'at'), _now), l.value->>'text', l.ordinality::integer
      from up u join input i on i.legacy_row = u.legacy_row
      cross join lateral jsonb_array_elements(coalesce((select x->'log' from jsonb_array_elements(_rows) x
        where (x->>'legacy_row')::integer = u.legacy_row limit 1), '[]')) with ordinality l
      where nullif(btrim(l.value->>'text'), '') is not null
      on conflict (campaign_id, legacy_index) where legacy_index is not null do update set at = excluded.at, text = excluded.text
      returning 1)
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done
      from up where (select count(*) from logs) >= 0;

  elsif _kind = 'tasks' then
    -- Brands, campaigns and vendors named on tasks are created on first sight (ensureCampaign).
    insert into public.ledger_brands(owner_user, name, sort_order)
    select distinct on (lower(btrim(x->>'brand'))) _owner, btrim(x->>'brand'), 100
    from jsonb_array_elements(_rows) x where nullif(btrim(x->>'brand'), '') is not null
    on conflict (owner_user, lower(name)) where deleted_at is null do nothing;
    insert into public.ledger_campaigns(owner_user, name, stage, imported_at, updated_at)
    select distinct on (lower(btrim(x->>'campaign'))) _owner, btrim(x->>'campaign'), 'Captured', _now, _now
    from jsonb_array_elements(_rows) x where nullif(btrim(x->>'campaign'), '') is not null
    on conflict (owner_user, lower(name)) where deleted_at is null do nothing;
    insert into public.ledger_vendors(owner_user, name, imported_at, updated_at)
    select distinct on (lower(btrim(x->>'vendor'))) _owner, btrim(x->>'vendor'), _now, _now
    from jsonb_array_elements(_rows) x where nullif(btrim(x->>'vendor'), '') is not null
    on conflict (owner_user, lower(name)) where deleted_at is null do nothing;
    with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, logged_at text, work_date date, brand text,
        title text, status text, priority text, deadline date, start_date date, end_date date, notes text, last_updated date,
        repeat text, pinned boolean, type text, campaign text, tags text[], revision integer, status_since date, waiting_on text,
        focus_date date, outcome text, est_cost numeric, actual_cost numeric, vendor text, brief jsonb, for_whom text,
        minutes integer, entry_kind text, approved_version text)),
    resolved as (
      select i.*, coalesce(app.ledger_ist_timestamp(i.logged_at), i.work_date::timestamp at time zone 'Asia/Kolkata', _now) as logged_ts,
        (select c.id from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null and lower(c.name) = lower(btrim(i.campaign))) as campaign_id,
        (select v.id from public.ledger_vendors v where v.owner_user = _owner and v.deleted_at is null and lower(v.name) = lower(btrim(i.vendor))) as vendor_id
      from input i where nullif(btrim(i.title), '') is not null),
    up as (
      insert into public.ledger_tasks as t (owner_user, logged_at, work_date, brand, title, status, priority, deadline, start_date, end_date,
          last_updated, repeat, pinned, type, campaign_id, tags, revision, status_since, waiting_on, focus_date, outcome, est_cost,
          actual_cost, vendor_id, brief, for_whom, minutes, entry_kind, approved_version, legacy_row, imported_at, updated_at)
      select _owner, r.logged_ts, coalesce(r.work_date, app.ledger_ist_date(r.logged_ts)), coalesce(nullif(btrim(r.brand), ''), 'General'),
        btrim(r.title), coalesce(r.status, 'Brief'), coalesce(r.priority, 'Medium'), r.deadline, r.start_date, r.end_date,
        r.last_updated, r.repeat, coalesce(r.pinned, false), r.type, r.campaign_id, coalesce(r.tags, '{}'), coalesce(r.revision, 0),
        coalesce(r.status_since, r.last_updated), r.waiting_on, r.focus_date, r.outcome, r.est_cost, r.actual_cost, r.vendor_id,
        r.brief, r.for_whom, r.minutes, r.entry_kind, r.approved_version, r.legacy_row, _now, _now
      from resolved r
      on conflict (owner_user, legacy_row) where legacy_row is not null do update set
        logged_at = excluded.logged_at, work_date = excluded.work_date, brand = excluded.brand, title = excluded.title,
        status = excluded.status, priority = excluded.priority, deadline = excluded.deadline, start_date = excluded.start_date,
        end_date = excluded.end_date, last_updated = excluded.last_updated, repeat = excluded.repeat, pinned = excluded.pinned,
        type = excluded.type, campaign_id = excluded.campaign_id, tags = excluded.tags, revision = excluded.revision,
        status_since = excluded.status_since, waiting_on = excluded.waiting_on, focus_date = excluded.focus_date,
        outcome = excluded.outcome, est_cost = excluded.est_cost, actual_cost = excluded.actual_cost, vendor_id = excluded.vendor_id,
        brief = excluded.brief, for_whom = excluded.for_whom, minutes = excluded.minutes, entry_kind = excluded.entry_kind,
        approved_version = excluded.approved_version, imported_at = excluded.imported_at, updated_at = excluded.updated_at
      where t.updated_at <= t.imported_at
      returning t.id, t.legacy_row, (xmax = 0) as inserted),
    notes as (
      insert into public.ledger_task_log(owner_user, task_id, at, kind, text)
      select _owner, u.id, r.logged_ts, 'imported', r.notes
      from up u join resolved r on r.legacy_row = u.legacy_row where nullif(btrim(r.notes), '') is not null
      on conflict (task_id) where kind = 'imported' do update set text = excluded.text
      returning 1),
    links as (
      insert into public.ledger_attachments(owner_user, task_id, kind, name, url)
      select _owner, u.id, 'link', left(coalesce(nullif(btrim(a.value->>'name'), ''), a.value->>'url'), 300), a.value->>'url'
      from up u cross join lateral jsonb_array_elements(coalesce((select x->'attachments' from jsonb_array_elements(_rows) x
        where (x->>'legacy_row')::integer = u.legacy_row limit 1), '[]')) a
      where nullif(btrim(a.value->>'url'), '') is not null
      on conflict (task_id, url) where kind = 'link' and deleted_at is null do nothing
      returning 1)
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done
      from up where (select count(*) from notes) + (select count(*) from links) >= 0;

  elsif _kind in ('subtasks','deliverables','progress') then
    select coalesce(jsonb_agg(x->'legacy_row'), '[]') into _unresolved from jsonb_array_elements(_rows) x
    where not exists(select 1 from public.ledger_tasks t where t.owner_user = _owner and t.legacy_row = (coalesce(x->>'parent_row', x->>'task_row'))::integer);
    if _kind = 'subtasks' then
      with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, parent_row integer, text text, done boolean, created_at text)),
      up as (
        insert into public.ledger_subtasks as s (owner_user, task_id, text, done, position, created_at, legacy_row, imported_at, updated_at)
        select _owner, t.id, btrim(i.text), coalesce(i.done, false), i.legacy_row, coalesce(app.ledger_ist_timestamp(i.created_at), _now), i.legacy_row, _now, _now
        from input i join public.ledger_tasks t on t.owner_user = _owner and t.legacy_row = i.parent_row
        where nullif(btrim(i.text), '') is not null
        on conflict (owner_user, legacy_row) where legacy_row is not null do update set
          task_id = excluded.task_id, text = excluded.text, done = excluded.done, imported_at = excluded.imported_at, updated_at = excluded.updated_at
        where s.updated_at <= s.imported_at
        returning s.legacy_row, (xmax = 0) as inserted)
      select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;
    elsif _kind = 'deliverables' then
      with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, parent_row integer, type text, version text,
          link text, used_where text, added_at text)),
      up as (
        insert into public.ledger_deliverables as d (owner_user, task_id, type, version, link, used_where, added_at, legacy_row, imported_at, updated_at)
        select _owner, t.id, i.type, i.version, i.link, i.used_where, coalesce(app.ledger_ist_timestamp(i.added_at), _now), i.legacy_row, _now, _now
        from input i join public.ledger_tasks t on t.owner_user = _owner and t.legacy_row = i.parent_row
        on conflict (owner_user, legacy_row) where legacy_row is not null do update set
          task_id = excluded.task_id, type = excluded.type, version = excluded.version, link = excluded.link,
          used_where = excluded.used_where, added_at = excluded.added_at, imported_at = excluded.imported_at, updated_at = excluded.updated_at
        where d.updated_at <= d.imported_at
        returning d.legacy_row, (xmax = 0) as inserted)
      select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;
    elsif _kind = 'progress' then
      with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, task_row integer, date date, note text, minutes integer)),
      up as (
        insert into public.ledger_progress as p (owner_user, task_id, on_date, note, minutes, created_at, legacy_row, imported_at, updated_at)
        select _owner, t.id, coalesce(i.date, app.ledger_ist_date(_now)), btrim(i.note), i.minutes,
          coalesce(i.date::timestamp at time zone 'Asia/Kolkata', _now), i.legacy_row, _now, _now
        from input i join public.ledger_tasks t on t.owner_user = _owner and t.legacy_row = i.task_row
        where nullif(btrim(i.note), '') is not null
        on conflict (owner_user, legacy_row) where legacy_row is not null do update set
          task_id = excluded.task_id, on_date = excluded.on_date, note = excluded.note, minutes = excluded.minutes,
          imported_at = excluded.imported_at, updated_at = excluded.updated_at
        where p.updated_at <= p.imported_at
        returning p.legacy_row, (xmax = 0) as inserted)
      select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;
    end if;

  elsif _kind = 'ideas' then
    with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, text text, original text, brand text, tags text[],
        links text, status text, created_at text, revisit_date date, revisit_when text, concept jsonb)),
    up as (
      insert into public.ledger_ideas as d (owner_user, text, original, brand, tags, links, status, created_at, revisit_date,
          revisit_when, concept, legacy_row, imported_at, updated_at)
      select _owner, btrim(i.text), coalesce(nullif(btrim(i.original), ''), btrim(i.text)), i.brand, coalesce(i.tags, '{}'), i.links,
        coalesce(i.status, 'Open'), coalesce(app.ledger_ist_timestamp(i.created_at), _now), i.revisit_date, i.revisit_when,
        coalesce(i.concept, '{}'), i.legacy_row, _now, _now
      from input i where nullif(btrim(i.text), '') is not null
      on conflict (owner_user, legacy_row) where legacy_row is not null do update set
        text = excluded.text, original = excluded.original, brand = excluded.brand, tags = excluded.tags, links = excluded.links,
        status = excluded.status, created_at = excluded.created_at, revisit_date = excluded.revisit_date,
        revisit_when = excluded.revisit_when, concept = excluded.concept, imported_at = excluded.imported_at, updated_at = excluded.updated_at
      where d.updated_at <= d.imported_at
      returning d.legacy_row, (xmax = 0) as inserted)
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;

  elsif _kind = 'reminders' then
    with input as (select * from jsonb_to_recordset(_rows) as x(legacy_row integer, text text, due_at text, repeat text, done boolean,
        calendar_event_id text, created_at text, source text, task_row integer)),
    up as (
      insert into public.ledger_reminders as m (owner_user, text, due_at, repeat, done, done_at, source, task_id, calendar_event_id,
          calendar_state, created_at, legacy_row, imported_at, updated_at)
      select _owner, btrim(i.text), app.ledger_ist_timestamp(i.due_at), i.repeat, coalesce(i.done, false),
        case when coalesce(i.done, false) then _now end, coalesce(i.source, 'reminder'),
        (select t.id from public.ledger_tasks t where t.owner_user = _owner and t.legacy_row = i.task_row),
        nullif(btrim(i.calendar_event_id), ''), case when nullif(btrim(i.calendar_event_id), '') is not null then 'synced' else 'none' end,
        coalesce(app.ledger_ist_timestamp(i.created_at), _now), i.legacy_row, _now, _now
      from input i where nullif(btrim(i.text), '') is not null and app.ledger_ist_timestamp(i.due_at) is not null
      on conflict (owner_user, legacy_row) where legacy_row is not null do update set
        text = excluded.text, due_at = excluded.due_at, repeat = excluded.repeat, done = excluded.done, source = excluded.source,
        task_id = excluded.task_id, calendar_event_id = excluded.calendar_event_id, calendar_state = excluded.calendar_state,
        imported_at = excluded.imported_at, updated_at = excluded.updated_at
      where m.updated_at <= m.imported_at
      returning m.legacy_row, (xmax = 0) as inserted)
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', legacy_row, 'inserted', inserted)), '[]') into _done from up;

  elsif _kind = 'links' then
    -- Second pass, once everything exists: task dependencies, what ideas became, where campaigns came from.
    update public.ledger_tasks t set depends_on = d.id
    from jsonb_array_elements(_rows) x
    join public.ledger_tasks d on d.owner_user = _owner and d.legacy_row = (x->>'depends_on_row')::integer
    where x->>'kind' = 'task_depends' and t.owner_user = _owner and t.legacy_row = (x->>'legacy_row')::integer
      and t.updated_at <= coalesce(t.imported_at, t.updated_at);
    update public.ledger_ideas i set
      task_id = coalesce((select t.id from public.ledger_tasks t where t.owner_user = _owner and t.legacy_row = (x->>'task_row')::integer), i.task_id),
      campaign_id = coalesce((select c.id from public.ledger_campaigns c where c.owner_user = _owner and c.legacy_row = (x->>'campaign_row')::integer), i.campaign_id)
    from jsonb_array_elements(_rows) x
    where x->>'kind' = 'idea_refs' and i.owner_user = _owner and i.legacy_row = (x->>'legacy_row')::integer;
    insert into public.ledger_campaign_ideas(campaign_id, idea_id, owner_user)
    select c.id, i.id, _owner
    from jsonb_array_elements(_rows) x
    join public.ledger_campaigns c on c.owner_user = _owner and c.legacy_row = (x->>'legacy_row')::integer
    cross join lateral jsonb_array_elements_text(coalesce(x->'idea_rows', '[]')) r(idea_row)
    join public.ledger_ideas i on i.owner_user = _owner and i.legacy_row = r.idea_row::integer
    where x->>'kind' = 'campaign_ideas'
    on conflict do nothing;
    select coalesce(jsonb_agg(jsonb_build_object('legacy_row', (x->>'legacy_row')::integer, 'inserted', false)), '[]') into _done
    from jsonb_array_elements(_rows) x;
  else
    raise exception using errcode = '22023', message = 'Unknown import kind.';
  end if;

  return jsonb_build_object('kind', _kind, 'received', jsonb_array_length(_rows),
    'inserted', (select count(*) from jsonb_array_elements(_done) d where (d->>'inserted')::boolean),
    'updated', (select count(*) from jsonb_array_elements(_done) d where not (d->>'inserted')::boolean),
    'saved_rows', (select coalesce(jsonb_agg((d->>'legacy_row')::integer), '[]') from jsonb_array_elements(_done) d),
    'unresolved_rows', _unresolved);
end $$;
revoke all on function app.ledger_import_rows(uuid,text,jsonb,timestamptz) from public, anon, authenticated, service_role;

create or replace function public.ledger_import_batch(_kind text, _rows jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _result jsonb;
begin
  if _rows is null or jsonb_typeof(_rows) <> 'array' or jsonb_array_length(_rows) > 500 then
    raise exception using errcode = '22023', message = 'Send import rows in batches of at most 500.';
  end if;
  perform app.ledger_seed(_owner);
  if (select import_locked_at from public.ledger_settings where owner_user = _owner) is not null then
    raise exception using errcode = '55000', message = 'Import is locked for this ledger.';
  end if;
  -- One import at a time per person.
  perform pg_advisory_xact_lock(hashtextextended('ledger-import:' || _owner::text, 0));
  _result := app.ledger_import_rows(_owner, _kind, _rows, clock_timestamp());
  update public.ledger_settings set imported_at = now(), updated_at = now() where owner_user = _owner;
  return _result;
end $$;

-- Which of these original rows already exist, and which were edited here since they were imported.
create or replace function public.ledger_import_preview(_kind text, _legacy_rows integer[])
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _table text;
  _existing integer[]; _edited integer[];
begin
  _table := case _kind when 'tasks' then 'ledger_tasks' when 'subtasks' then 'ledger_subtasks' when 'deliverables' then 'ledger_deliverables'
    when 'progress' then 'ledger_progress' when 'campaigns' then 'ledger_campaigns' when 'ideas' then 'ledger_ideas'
    when 'vendors' then 'ledger_vendors' when 'templates' then 'ledger_templates' when 'key_dates' then 'ledger_key_dates'
    when 'reminders' then 'ledger_reminders' when 'brands' then 'ledger_brands' end;
  if _table is null then raise exception using errcode = '22023', message = 'Unknown import kind.'; end if;
  execute format('select coalesce(array_agg(legacy_row), ''{}''), coalesce(array_agg(legacy_row) filter (where imported_at is not null and updated_at > imported_at), ''{}'')
    from public.%I where owner_user = $1 and legacy_row = any($2)', _table)
    into _existing, _edited using _owner, coalesce(_legacy_rows, '{}');
  return jsonb_build_object('kind', _kind, 'existing', cardinality(_existing), 'edited_rows', to_jsonb(_edited));
end $$;

create or replace function public.ledger_import_lock(_locked boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  perform app.ledger_seed(_owner);
  update public.ledger_settings set import_locked_at = case when _locked then now() end, updated_at = now() where owner_user = _owner;
  return app.ledger_bootstrap_data(_owner)->'settings';
end $$;

revoke all on function public.ledger_open(), public.ledger_bootstrap(uuid), public.ledger_team_members(),
  public.ledger_report(text,text,uuid), public.ledger_export_tasks(), public.ledger_import_batch(text,jsonb),
  public.ledger_import_preview(text,integer[]), public.ledger_import_lock(boolean) from public, anon, service_role;
grant execute on function public.ledger_open(), public.ledger_bootstrap(uuid), public.ledger_team_members(),
  public.ledger_report(text,text,uuid), public.ledger_export_tasks(), public.ledger_import_batch(text,jsonb),
  public.ledger_import_preview(text,integer[]), public.ledger_import_lock(boolean) to authenticated;
revoke all on function app.ledger_today(), app.ledger_ist_date(timestamptz), app.ledger_ist_timestamp(text),
  app.ledger_status_event(text), app.ledger_advance_date(date,text), app.ledger_period(text,text,date) from public, anon;
grant execute on function app.ledger_today(), app.ledger_ist_date(timestamptz), app.ledger_ist_timestamp(text),
  app.ledger_status_event(text), app.ledger_advance_date(date,text), app.ledger_period(text,text,date) to authenticated;

comment on table public.ledger_tasks is 'Work Ledger tasks. Private to the owner and their line managers (read-only); written only through ledger_* RPCs; never hard-deleted.';
notify pgrst, 'reload schema';
commit;
