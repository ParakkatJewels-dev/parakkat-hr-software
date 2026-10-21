-- 0174 Creative extras in the Work Ledger: campaigns, ideas and a library shared by the creative team.
--
-- The personal ledger (0169-0171) kept these per person. Now that the Ledger is the one place for
-- work, they belong to the creative team as a whole. A super admin chooses which departments are the
-- creative team (org_settings 'creative_departments'); their members, and managers whose task.read
-- scope covers one of those departments, can read and change campaigns, ideas, vendors, templates,
-- key dates and brand notes, and see the creative fields on tasks. Deletes are soft. The rules the
-- personal ledger had (stage log, derived status, first wording of an idea, concept → Developing,
-- idea → campaign) are triggers and RPCs here, so every screen and Hermes behave the same.
begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Who is on the creative team
-- ---------------------------------------------------------------------------------------------
create or replace function app.creative_departments()
returns uuid[] language sql stable security definer set search_path = pg_catalog, public, app as $$
  select coalesce((select array_agg(d.value::uuid) from public.org_settings s, jsonb_array_elements_text(coalesce(s.value->'departments', '[]')) d
    where s.key = 'creative_departments'), '{}'::uuid[]);
$$;

create or replace function app.is_creative_member()
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.session_is_active() and (app.is_super_admin() or exists (
    select 1 from public.departments d left join public.branches b on b.id = d.branch_id
    where d.id = any(app.creative_departments()) and (
      d.id = (select e.department_id from public.employees e where e.id = app.current_employee_id())
      or app.has_perm('task.read', d.entity_id, b.zone_id, d.branch_id, d.id, null::uuid))));
$$;

create or replace function public.creative_settings()
returns jsonb language sql stable security definer set search_path = pg_catalog, public, app as $$
  select jsonb_build_object(
    'member', app.is_creative_member(),
    'can_configure', app.is_super_admin(),
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'branch', b.name) order by d.name)
      from public.departments d left join public.branches b on b.id = d.branch_id where d.id = any(app.creative_departments())), '[]'));
$$;

create or replace function public.set_creative_departments(_departments uuid[])
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if not app.is_super_admin() then
    raise exception using errcode = '42501', message = 'Only a super admin chooses the creative team.';
  end if;
  if exists (select 1 from unnest(coalesce(_departments, '{}')) x where not exists (select 1 from public.departments d where d.id = x)) then
    raise exception using errcode = '22023', message = 'One of those departments does not exist.';
  end if;
  insert into public.org_settings(key, value, updated_by)
    values ('creative_departments', jsonb_build_object('departments', to_jsonb(coalesce(_departments, '{}'))), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  return public.creative_settings();
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Shared tables
-- ---------------------------------------------------------------------------------------------
create table if not exists public.creative_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  short_label text check (short_label is null or length(short_label) <= 40),
  sort_order integer not null default 100,
  foundation jsonb not null default '{}'::jsonb check (jsonb_typeof(foundation) = 'object'),
  foundation_updated_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists creative_brands_name_idx on public.creative_brands(lower(name)) where deleted_at is null;

create table if not exists public.creative_vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  role text check (char_length(coalesce(role, '')) <= 120),
  phone text check (char_length(coalesce(phone, '')) <= 60),
  email text check (char_length(coalesce(email, '')) <= 200),
  rate text check (char_length(coalesce(rate, '')) <= 120),
  rating integer check (rating is null or rating between 1 and 5),
  notes text check (char_length(coalesce(notes, '')) <= 2000),
  last_worked date,
  legacy_row integer,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists creative_vendors_name_idx on public.creative_vendors(lower(name)) where deleted_at is null;

create table if not exists public.creative_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  work_type text check (char_length(coalesce(work_type, '')) <= 120),
  subtasks text[] not null default '{}' check (cardinality(subtasks) <= 50),
  seed_key text,
  legacy_row integer,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists creative_templates_seed_idx on public.creative_templates(seed_key) where seed_key is not null;

create table if not exists public.creative_key_dates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  on_date date not null,
  brand text check (char_length(coalesce(brand, '')) <= 80),
  lead_days integer check (lead_days is null or lead_days between 0 and 365),
  notes text check (char_length(coalesce(notes, '')) <= 2000),
  seed_key text,
  legacy_row integer,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists creative_key_dates_seed_idx on public.creative_key_dates(seed_key) where seed_key is not null;

create table if not exists public.creative_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  brand text check (char_length(coalesce(brand, '')) <= 80),
  launch_date date,
  brief_link text check (char_length(coalesce(brief_link, '')) <= 2000),
  notes text check (char_length(coalesce(notes, '')) <= 4000),
  stage text not null default 'Captured' check (stage in
    ('Captured','Developing','Decision','Approved','Production','Live','Reviewed','Parked','Cancelled')),
  -- Derived from the stage, never set by hand.
  status text generated always as (case
    when stage in ('Captured','Parked') then 'Planning'
    when stage in ('Reviewed','Cancelled') then 'Done'
    else 'Active' end) stored,
  priority text not null default 'Medium' check (priority in ('High','Medium','Low')),
  objective text check (char_length(coalesce(objective, '')) <= 2000),
  next_action text check (char_length(coalesce(next_action, '')) <= 1000),
  milestone text check (char_length(coalesce(milestone, '')) <= 500),
  milestone_date date,
  blocker text check (char_length(coalesce(blocker, '')) <= 1000),
  decision text check (char_length(coalesce(decision, '')) <= 2000),
  budget text check (char_length(coalesce(budget, '')) <= 200),
  brief jsonb not null default '{}'::jsonb check (jsonb_typeof(brief) = 'object'),
  measure jsonb not null default '{}'::jsonb check (jsonb_typeof(measure) = 'object'),
  results jsonb not null default '{}'::jsonb check (jsonb_typeof(results) = 'object'),
  legacy_row integer,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists creative_campaigns_name_idx on public.creative_campaigns(lower(name)) where deleted_at is null;

-- Append-only: stage moves, decisions and notes. Written by triggers and creative_campaign_note.
create table if not exists public.creative_campaign_log (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.creative_campaigns(id) on delete cascade,
  at timestamptz not null default clock_timestamp(),
  actor_user uuid default auth.uid(),
  actor_name text,
  text text not null check (length(btrim(text)) between 1 and 2000)
);
create index if not exists creative_campaign_log_campaign_idx on public.creative_campaign_log(campaign_id, at);

create table if not exists public.creative_ideas (
  id uuid primary key default gen_random_uuid(),
  text text not null check (length(btrim(text)) between 1 and 4000),
  -- The first wording, kept forever.
  original text not null default '',
  brand text check (char_length(coalesce(brand, '')) <= 80),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  links text check (char_length(coalesce(links, '')) <= 4000),
  status text not null default 'Open' check (status in ('Open','Developing','Parked','Promoted','Archived')),
  revisit_date date,
  revisit_when text check (char_length(coalesce(revisit_when, '')) <= 500),
  concept jsonb not null default '{}'::jsonb check (jsonb_typeof(concept) = 'object'),
  task_id uuid references public.tasks(id) on delete set null,
  campaign_id uuid references public.creative_campaigns(id) on delete set null,
  legacy_row integer,
  -- Who captured it, stamped once (names stay readable to the whole team).
  author_employee uuid references public.employees(id) on delete set null,
  author_name text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists creative_ideas_status_idx on public.creative_ideas(status, created_at desc) where deleted_at is null;

create table if not exists public.creative_campaign_ideas (
  campaign_id uuid not null references public.creative_campaigns(id) on delete cascade,
  idea_id uuid not null references public.creative_ideas(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, idea_id)
);

-- Tasks carry their campaign and vendor.
alter table public.tasks add column if not exists campaign_id uuid references public.creative_campaigns(id) on delete set null;
alter table public.tasks add column if not exists vendor_id uuid references public.creative_vendors(id) on delete set null;
create index if not exists idx_tasks_campaign on public.tasks(campaign_id) where campaign_id is not null;

-- ---------------------------------------------------------------------------------------------
-- 3. Starter data, once: the five brands, four templates and the festival calendar from today on
-- ---------------------------------------------------------------------------------------------
insert into public.creative_brands(name, short_label, sort_order, created_by)
select b.name, b.short_label, b.sort_order, null
from (values ('Parakkat Jewels','Jewels',1), ('Parakkat Munnar Resort','Munnar',2), ('Parakkat Riverscape','Riverscape',3),
  ('Parakkat Adimali Retreat','Adimali',4), ('General','General',5)) as b(name, short_label, sort_order)
where not exists (select 1 from public.creative_brands x where lower(x.name) = lower(b.name) and x.deleted_at is null);

insert into public.creative_templates(name, work_type, subtasks, seed_key, created_by)
select t.name, t.work_type, t.subtasks, t.seed_key, null
from (values
  ('product-shoot', 'Product shoot', 'Photography', array['Brief and shot list','Book photographer and studio','Select and style products','Shoot day','Select and retouch','Deliver final images']),
  ('ad-campaign', 'Ad campaign', 'Ads', array['Objective and audience','Concept and copy','Design creatives','Internal review','Approval','Launch','Report results']),
  ('print-job', 'Print job', 'Print', array['Brief and sizes','Design','Internal review','Approval','Send to printer','Check proof','Delivery and installation']),
  ('reel', 'Reel', 'Video', array['Concept and script','Shoot','Edit','Music and captions','Review','Post'])
) as t(seed_key, name, work_type, subtasks)
on conflict (seed_key) where seed_key is not null do nothing;

create or replace function app.creative_add_seed_dates()
returns integer language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _added integer;
begin
  insert into public.creative_key_dates(name, on_date, brand, lead_days, notes, seed_key, created_by)
    select s.name, s.on_date, s.brand, s.lead_days, s.notes, s.seed_key, null from app.ledger_seed_key_dates s
    where s.on_date >= app.ledger_today()
    on conflict (seed_key) where seed_key is not null do nothing;
  get diagnostics _added = row_count;
  return _added;
end $$;
select app.creative_add_seed_dates();

-- A date written by hand in a JSON field, or null when it is not one.
create or replace function app.creative_date(_value text)
returns date language plpgsql immutable set search_path = pg_catalog as $$
begin
  if _value is null or _value !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return _value::date;
exception when others then return null;
end $$;

create or replace function app.creative_actor_name()
returns text language sql stable security definer set search_path = pg_catalog, public, app as $$
  select e.full_name from public.employees e where e.id = app.current_employee_id();
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Rules
-- ---------------------------------------------------------------------------------------------
create or replace function app.tg_creative_row()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  -- Separate IFs: other tables have no foundation field.
  if tg_table_name = 'creative_brands' then
    if new.foundation <> '{}'::jsonb and (tg_op = 'INSERT' or new.foundation is distinct from old.foundation) then
      new.foundation_updated_at := now();
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function app.tg_creative_campaign()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  else
    new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function app.tg_creative_campaign_log()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if tg_op = 'INSERT' then
    insert into public.creative_campaign_log(campaign_id, actor_name, text) values (new.id, app.creative_actor_name(), 'Created at ' || new.stage);
    return new;
  end if;
  if new.stage is distinct from old.stage then
    insert into public.creative_campaign_log(campaign_id, actor_name, text) values (new.id, app.creative_actor_name(), 'Stage: ' || old.stage || ' → ' || new.stage);
  end if;
  if new.decision is distinct from old.decision and nullif(btrim(new.decision), '') is not null then
    insert into public.creative_campaign_log(campaign_id, actor_name, text) values (new.id, app.creative_actor_name(), 'Decision: ' || new.decision);
  end if;
  return new;
end $$;

-- An idea's first wording stays; writing any part of the concept moves an Open idea to Developing.
create or replace function app.tg_creative_idea()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  new.text := btrim(new.text);
  new.tags := coalesce((select array_agg(distinct lower(btrim(t))) from unnest(new.tags) t where btrim(t) <> ''), '{}');
  if tg_op = 'INSERT' then
    new.original := new.text;
    new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
    new.author_employee := coalesce(app.current_employee_id(), new.author_employee);
    new.author_name := coalesce(app.creative_actor_name(), new.author_name);
    if new.status = 'Open' and exists (select 1 from jsonb_each_text(new.concept) e where btrim(e.value) <> '') then new.status := 'Developing'; end if;
  else
    new.original := old.original; new.created_by := old.created_by; new.created_at := old.created_at;
    new.author_employee := old.author_employee; new.author_name := old.author_name;
    if old.status = 'Open' and new.status = 'Open' and new.concept is distinct from old.concept
       and exists (select 1 from jsonb_each_text(new.concept) e where btrim(e.value) <> '') then
      new.status := 'Developing';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- Naming a vendor on a task stamps when the team last worked with them.
create or replace function app.tg_task_vendor_worked()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if new.vendor_id is not null and (tg_op = 'INSERT' or new.vendor_id is distinct from old.vendor_id) then
    update public.creative_vendors set last_worked = greatest(coalesce(last_worked, app.ledger_today()), app.ledger_today()), updated_at = now()
      where id = new.vendor_id;
  end if;
  return new;
end $$;

do $$
declare _table text;
begin
  foreach _table in array array['creative_brands','creative_vendors','creative_templates','creative_key_dates'] loop
    execute format('drop trigger if exists trg_%1$s_row on public.%1$I', _table);
    execute format('create trigger trg_%1$s_row before insert or update on public.%1$I for each row execute function app.tg_creative_row()', _table);
  end loop;
end $$;
drop trigger if exists trg_creative_campaigns_row on public.creative_campaigns;
create trigger trg_creative_campaigns_row before insert or update on public.creative_campaigns
  for each row execute function app.tg_creative_campaign();
drop trigger if exists trg_creative_campaigns_log on public.creative_campaigns;
create trigger trg_creative_campaigns_log after insert or update of stage, decision on public.creative_campaigns
  for each row execute function app.tg_creative_campaign_log();
drop trigger if exists trg_creative_ideas_rules on public.creative_ideas;
create trigger trg_creative_ideas_rules before insert or update on public.creative_ideas
  for each row execute function app.tg_creative_idea();
drop trigger if exists trg_tasks_vendor_worked on public.tasks;
create trigger trg_tasks_vendor_worked after insert or update of vendor_id on public.tasks
  for each row execute function app.tg_task_vendor_worked();
revoke all on function app.creative_actor_name(), app.tg_creative_row(), app.tg_creative_campaign(), app.tg_creative_campaign_log(), app.tg_creative_idea(),
  app.tg_task_vendor_worked(), app.creative_add_seed_dates() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Access: the creative team reads and writes; nobody hard-deletes
-- ---------------------------------------------------------------------------------------------
do $$
declare _table text;
begin
  foreach _table in array array['creative_brands','creative_vendors','creative_templates','creative_key_dates',
    'creative_campaigns','creative_campaign_log','creative_ideas','creative_campaign_ideas'] loop
    execute format('alter table public.%I enable row level security', _table);
    execute format('revoke all on public.%I from public, anon, authenticated', _table);
    execute format('drop policy if exists active_account_required on public.%I', _table);
    execute format('create policy active_account_required on public.%I as restrictive for all to authenticated using (app.session_is_active()) with check (app.session_is_active())', _table);
    execute format('drop policy if exists creative_team_read on public.%I', _table);
    execute format('create policy creative_team_read on public.%I for select to authenticated using ((select app.is_creative_member()))', _table);
    execute format('grant select on public.%I to authenticated', _table);
  end loop;
  foreach _table in array array['creative_brands','creative_vendors','creative_templates','creative_key_dates','creative_campaigns','creative_ideas'] loop
    execute format('drop policy if exists creative_team_add on public.%I', _table);
    execute format('create policy creative_team_add on public.%I for insert to authenticated with check ((select app.is_creative_member()))', _table);
    execute format('drop policy if exists creative_team_change on public.%I', _table);
    execute format('create policy creative_team_change on public.%I for update to authenticated using ((select app.is_creative_member())) with check ((select app.is_creative_member()))', _table);
    execute format('grant insert, update on public.%I to authenticated', _table);
  end loop;
  -- Linking an idea to a campaign is the team's; the link row itself never changes.
  drop policy if exists creative_team_link on public.creative_campaign_ideas;
  create policy creative_team_link on public.creative_campaign_ideas for insert to authenticated with check ((select app.is_creative_member()));
  grant insert on public.creative_campaign_ideas to authenticated;
end $$;

do $$
declare _table text;
begin
  foreach _table in array array['creative_campaigns','creative_ideas'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = _table) then
      execute format('alter publication supabase_realtime add table public.%I', _table);
    end if;
    execute format('alter table public.%I replica identity full', _table);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Reads (invoker: the team policies above decide)
-- ---------------------------------------------------------------------------------------------
create or replace function app.creative_brand_label(_brand text)
returns text language sql stable set search_path = pg_catalog, public, app as $$
  select coalesce((select coalesce(b.short_label, b.name) from public.creative_brands b
    where lower(b.name) = lower(btrim(_brand)) and b.deleted_at is null limit 1), nullif(btrim(_brand), ''));
$$;

-- A campaign's progress counts every linked task, also ones the viewer cannot open.
create or replace function app.creative_campaign_counts(_campaign uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, public, app as $$
  select case when not app.is_creative_member() then '{}'::jsonb else jsonb_build_object(
    'total', count(*) filter (where t.status <> 'Cancelled'),
    'done', count(*) filter (where t.status = 'Done'),
    'in_review', count(*) filter (where t.status = 'In Progress' and t.review_stage in ('Internal Review','Awaiting Approval','Revisions')),
    'blocked', count(*) filter (where t.status = 'Blocked'),
    'spend', coalesce(sum(t.actual_cost), 0)) end
  from public.tasks t where t.campaign_id = _campaign and t.deleted_at is null;
$$;

create or replace function app.creative_campaign_json(_c public.creative_campaigns, _today date, _detail boolean default false)
returns jsonb language sql stable set search_path = pg_catalog, public, app as $$
  select jsonb_build_object('id', _c.id, 'name', _c.name, 'brand', _c.brand, 'brand_label', app.creative_brand_label(_c.brand),
    'launch_date', _c.launch_date, 'days_to_launch', _c.launch_date - _today, 'brief_link', _c.brief_link, 'notes', _c.notes,
    'stage', _c.stage, 'status', _c.status, 'priority', _c.priority, 'objective', _c.objective, 'next_action', _c.next_action,
    'milestone', _c.milestone, 'milestone_date', _c.milestone_date, 'blocker', _c.blocker, 'decision', _c.decision, 'budget', _c.budget,
    'brief', _c.brief, 'measure', _c.measure, 'results', _c.results, 'created_at', _c.created_at)
  || app.creative_campaign_counts(_c.id)
  || case when not _detail then '{}'::jsonb else jsonb_build_object(
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'text', l.text, 'by', l.actor_name) order by l.at desc, l.id desc)
      from public.creative_campaign_log l where l.campaign_id = _c.id), '[]'),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', app.work_step(t.status, t.review_stage),
        'deadline', t.due_date, 'priority', t.priority, 'vendor', (select v.name from public.creative_vendors v where v.id = t.vendor_id),
        'actual_cost', t.actual_cost, 'assignee', (select e.full_name from public.employees e where e.id = t.employee_id),
        'deliverables', coalesce((select jsonb_agg(jsonb_build_object('type', d.type, 'version', d.version, 'link', d.link, 'used_where', d.used_where)
          order by d.added_at) from public.task_deliverables d where d.task_id = t.id and d.deleted_at is null), '[]'))
      order by t.status = 'Done', t.due_date nulls last, t.created_at)
      from public.tasks t where t.campaign_id = _c.id and t.deleted_at is null), '[]'),
    'ideas', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'text', i.text, 'links', i.links, 'status', i.status) order by i.created_at)
      from public.creative_ideas i where i.deleted_at is null and (i.campaign_id = _c.id
        or i.id in (select ci.idea_id from public.creative_campaign_ideas ci where ci.campaign_id = _c.id))), '[]'))
  end;
$$;

create or replace function app.creative_idea_json(_i public.creative_ideas)
returns jsonb language sql stable set search_path = pg_catalog, public, app as $$
  select jsonb_build_object('id', _i.id, 'text', _i.text, 'original', _i.original, 'edited', _i.text <> _i.original, 'brand', _i.brand,
    'tags', to_jsonb(_i.tags), 'links', _i.links, 'status', _i.status, 'created_at', _i.created_at, 'revisit_date', _i.revisit_date,
    'revisit_when', _i.revisit_when, 'concept', _i.concept, 'task_id', _i.task_id, 'campaign_id', _i.campaign_id,
    'task_title', (select t.title from public.tasks t where t.id = _i.task_id),
    'campaign_name', (select c.name from public.creative_campaigns c where c.id = _i.campaign_id),
    'by', _i.author_name, 'mine', _i.author_employee = app.current_employee_id());
$$;

create or replace function app.creative_alerts(_today date)
returns jsonb language sql stable set search_path = pg_catalog, public, app as $$
  select coalesce(jsonb_agg(a.item order by a.rank, a.at nulls last), '[]') from (
    select 1 as rank, null::date as at, jsonb_build_object('kind', 'decision', 'campaign_id', c.id, 'title', c.name,
      'text', coalesce(nullif(btrim(c.decision), ''), 'Decision needed is not written yet')) as item
      from public.creative_campaigns c where c.deleted_at is null and c.stage = 'Decision'
    union all select 2, null, jsonb_build_object('kind', 'blocked', 'campaign_id', c.id, 'title', c.name, 'text', c.blocker)
      from public.creative_campaigns c where c.deleted_at is null and c.stage not in ('Parked','Cancelled') and nullif(btrim(c.blocker), '') is not null
    union all select 3, c.launch_date, jsonb_build_object('kind', 'launch', 'campaign_id', c.id, 'title', c.name, 'date', c.launch_date,
        'text', case when c.launch_date < _today then 'Launch date has passed' else 'Launches in ' || (c.launch_date - _today) || ' days' end)
      from public.creative_campaigns c where c.deleted_at is null and c.stage not in ('Parked','Cancelled','Live','Reviewed') and c.launch_date <= _today + 14
    union all select 4, app.creative_date(c.measure->>'reviewDate'), jsonb_build_object('kind', 'review', 'campaign_id', c.id, 'title', c.name,
        'date', app.creative_date(c.measure->>'reviewDate'),
        'text', case when app.creative_date(c.measure->>'reviewDate') is null then 'Live without a review date' else 'Results review due' end)
      from public.creative_campaigns c where c.deleted_at is null and c.stage = 'Live'
        and coalesce(app.creative_date(c.measure->>'reviewDate') <= _today + 7, true)
    union all select 5, c.milestone_date, jsonb_build_object('kind', 'milestone', 'campaign_id', c.id, 'title', c.name, 'date', c.milestone_date,
        'text', coalesce(nullif(btrim(c.milestone), ''), 'Milestone') || case when c.milestone_date < _today then ' — overdue' else '' end)
      from public.creative_campaigns c where c.deleted_at is null and c.stage not in ('Parked','Cancelled','Live','Reviewed') and c.milestone_date <= _today + 14
    union all select 6, i.revisit_date, jsonb_build_object('kind', 'idea', 'idea_id', i.id, 'title', i.text, 'date', i.revisit_date,
        'text', coalesce('Revisit when ' || nullif(btrim(i.revisit_when), ''), 'Time to revisit'))
      from public.creative_ideas i where i.deleted_at is null and i.status = 'Parked' and i.revisit_date <= _today + 7
  ) a;
$$;

-- What Home adds for the creative team.
create or replace function public.creative_home()
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public, app as $$
declare _today date := app.ledger_today();
begin
  if not app.is_creative_member() then return null; end if;
  return jsonb_build_object(
    'alerts', app.creative_alerts(_today),
    'campaigns', coalesce((select jsonb_agg(app.creative_campaign_json(c, _today) order by c.launch_date nulls last, lower(c.name))
      from public.creative_campaigns c where c.deleted_at is null and c.stage not in ('Parked','Cancelled','Reviewed')), '[]'),
    'key_dates', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'date', k.on_date, 'brand', k.brand,
        'brand_label', app.creative_brand_label(k.brand), 'lead_days', k.lead_days, 'days_away', k.on_date - _today,
        'has_campaign', exists (select 1 from public.creative_campaigns c where c.deleted_at is null and c.stage not in ('Parked','Cancelled')
          and c.launch_date between k.on_date - greatest(coalesce(k.lead_days, 30), 30) and k.on_date)) order by k.on_date)
      from public.creative_key_dates k where k.deleted_at is null and k.on_date between _today and _today + 150), '[]'),
    'ideas', coalesce((select jsonb_agg(app.creative_idea_json(i) order by i.created_at desc) from (
      select * from public.creative_ideas i where i.deleted_at is null and i.status in ('Open','Developing') order by i.created_at desc limit 6) i), '[]'),
    'ideas_open', (select count(*) from public.creative_ideas i where i.deleted_at is null and i.status = 'Open'));
end $$;

create or replace function public.creative_campaigns()
returns jsonb language sql stable security invoker set search_path = pg_catalog, public, app as $$
  select coalesce(jsonb_agg(app.creative_campaign_json(c, app.ledger_today()) order by
    coalesce(array_position(array['Captured','Developing','Decision','Approved','Production','Live','Reviewed'], c.stage),
      8 + array_position(array['Parked','Cancelled'], c.stage)), c.launch_date nulls last, lower(c.name)), '[]')
  from public.creative_campaigns c where c.deleted_at is null;
$$;

create or replace function public.creative_campaign(_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public, app as $$
declare _c public.creative_campaigns;
begin
  select * into _c from public.creative_campaigns where id = _id and deleted_at is null;
  if _c.id is null then raise exception using errcode = 'P0002', message = 'Campaign not found.'; end if;
  return app.creative_campaign_json(_c, app.ledger_today(), true);
end $$;

create or replace function public.creative_campaign_details()
returns jsonb language sql stable security invoker set search_path = pg_catalog, public, app as $$
  select coalesce(jsonb_agg(app.creative_campaign_json(c, app.ledger_today(), true) order by c.launch_date nulls last, lower(c.name)), '[]')
  from public.creative_campaigns c where c.deleted_at is null;
$$;

create or replace function public.creative_ideas()
returns jsonb language sql stable security invoker set search_path = pg_catalog, public, app as $$
  select coalesce(jsonb_agg(app.creative_idea_json(i) order by i.created_at desc, i.id), '[]') from public.creative_ideas i where i.deleted_at is null;
$$;

create or replace function public.creative_library()
returns jsonb language sql stable security invoker set search_path = pg_catalog, public, app as $$
  select jsonb_build_object(
    'vendors', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'role', v.role, 'phone', v.phone, 'email', v.email,
      'rate', v.rate, 'rating', v.rating, 'notes', v.notes, 'last_worked', v.last_worked,
      'tasks', (select count(*) from public.tasks t where t.vendor_id = v.id and t.deleted_at is null)) order by lower(v.name))
      from public.creative_vendors v where v.deleted_at is null), '[]'),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'type', t.work_type, 'subtasks', t.subtasks) order by lower(t.name))
      from public.creative_templates t where t.deleted_at is null), '[]'),
    'key_dates', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'date', k.on_date, 'brand', k.brand,
      'lead_days', k.lead_days, 'notes', k.notes, 'starter', k.seed_key is not null) order by k.on_date, lower(k.name))
      from public.creative_key_dates k where k.deleted_at is null), '[]'),
    'brands', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'label', coalesce(b.short_label, b.name),
      'sort_order', b.sort_order, 'foundation', b.foundation, 'foundation_updated_at', b.foundation_updated_at) order by b.sort_order, lower(b.name))
      from public.creative_brands b where b.deleted_at is null), '[]'),
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'brand', c.brand, 'stage', c.stage) order by lower(c.name))
      from public.creative_campaigns c where c.deleted_at is null), '[]'));
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Writes that are more than one row
-- ---------------------------------------------------------------------------------------------
-- A note on a campaign's log.
create or replace function public.creative_campaign_note(_campaign uuid, _text text)
returns void language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if not app.is_creative_member() then raise exception using errcode = '42501', message = 'Campaigns are for the creative team.'; end if;
  if not exists (select 1 from public.creative_campaigns where id = _campaign and deleted_at is null) then
    raise exception using errcode = 'P0002', message = 'Campaign not found.';
  end if;
  if length(btrim(coalesce(_text, ''))) not between 1 and 2000 then raise exception using errcode = '22023', message = 'Write the note (up to 2000 characters).'; end if;
  insert into public.creative_campaign_log(campaign_id, actor_name, text) values (_campaign, app.creative_actor_name(), btrim(_text));
end $$;

-- An idea becomes a Developing campaign pre-filled from its concept card; once.
create or replace function public.creative_idea_to_campaign(_idea uuid, _campaign uuid default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _i public.creative_ideas; _name text; _suffix integer := 1;
begin
  _campaign := coalesce(_campaign, gen_random_uuid());
  if not app.is_creative_member() then raise exception using errcode = '42501', message = 'Ideas are for the creative team.'; end if;
  select * into _i from public.creative_ideas where id = _idea and deleted_at is null for update;
  if _i.id is null then raise exception using errcode = 'P0002', message = 'Idea not found.'; end if;
  if _i.campaign_id is not null then return public.creative_campaign(_i.campaign_id); end if;
  _name := left(coalesce(nullif(btrim(_i.concept->>'oneLine'), ''), _i.text), 150);
  while exists (select 1 from public.creative_campaigns c where c.deleted_at is null and lower(c.name) = lower(_name)) loop
    _suffix := _suffix + 1; _name := left(coalesce(nullif(btrim(_i.concept->>'oneLine'), ''), _i.text), 145) || ' (' || _suffix || ')';
  end loop;
  insert into public.creative_campaigns(id, name, brand, stage, objective, next_action, brief)
    values (_campaign, _name, _i.brand, 'Developing', nullif(btrim(_i.concept->>'objective'), ''), nullif(btrim(_i.concept->>'nextAction'), ''),
      jsonb_strip_nulls(jsonb_build_object('insight', nullif(btrim(_i.concept->>'insight'), ''),
        'idea', coalesce(nullif(btrim(_i.concept->>'approach'), ''), nullif(btrim(_i.concept->>'oneLine'), '')),
        'example', nullif(btrim(_i.concept->>'outputs'), ''), 'resources', nullif(btrim(_i.concept->>'needs'), ''))));
  insert into public.creative_campaign_log(campaign_id, actor_name, text) values (_campaign, app.creative_actor_name(), 'From idea: ' || left(_i.text, 200));
  insert into public.creative_campaign_ideas(campaign_id, idea_id) values (_campaign, _idea) on conflict do nothing;
  update public.creative_ideas set status = 'Promoted', campaign_id = _campaign where id = _idea;
  return public.creative_campaign(_campaign);
end $$;

create or replace function public.creative_refresh_key_dates()
returns integer language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if not app.is_creative_member() then raise exception using errcode = '42501', message = 'Key dates are for the creative team.'; end if;
  return app.creative_add_seed_dates();
end $$;

-- ---------------------------------------------------------------------------------------------
-- 8. The creative parts in task cards, reports and insights
-- ---------------------------------------------------------------------------------------------
create or replace function app.work_card(_t public.tasks, _today date)
returns jsonb language sql stable set search_path = pg_catalog, public, app as $$
  select jsonb_build_object(
    'id', _t.id, 'title', _t.title, 'description', left(_t.description, 280),
    'status', _t.status, 'review_stage', _t.review_stage, 'step', app.work_step(_t.status, _t.review_stage),
    'lane', app.work_lane(_t.status, _t.review_stage), 'priority', _t.priority, 'due_date', _t.due_date,
    'status_since', _t.status_since, 'created_at', _t.created_at, 'completed_at', _t.completed_at,
    'stale', _t.status not in ('Done','Cancelled') and coalesce(_t.status_since, app.ledger_ist_date(_t.created_at)) < _today - 7,
    'overdue', _t.status not in ('Done','Cancelled') and _t.due_date < _today,
    'waiting_on', _t.waiting_on, 'revision', _t.revision, 'approved_version', _t.approved_version, 'outcome', _t.outcome,
    'tags', to_jsonb(_t.tags), 'brand', _t.brand, 'brand_label', app.creative_brand_label(_t.brand), 'work_type', _t.work_type,
    'est_cost', _t.est_cost, 'actual_cost', _t.actual_cost,
    'campaign_id', _t.campaign_id, 'campaign', (select c.name from public.creative_campaigns c where c.id = _t.campaign_id and c.deleted_at is null),
    'vendor_id', _t.vendor_id, 'vendor', (select v.name from public.creative_vendors v where v.id = _t.vendor_id),
    'employee_id', _t.employee_id, 'assignee_name', (select e.full_name from public.employees e where e.id = _t.employee_id),
    'assigned_by', _t.assigned_by, 'assigner_name', (select e.full_name from public.employees e where e.id = _t.assigned_by),
    'helpers', (select count(*) from public.task_assignees a where a.task_id = _t.id and a.employee_id <> _t.employee_id),
    'department_id', _t.department_id,
    'depends_on_task_id', _t.depends_on_task_id,
    'depends_on_title', (select d.title from public.tasks d where d.id = _t.depends_on_task_id),
    'depends_on_done', (select d.status = 'Done' from public.tasks d where d.id = _t.depends_on_task_id),
    'subtasks_total', (select count(*) from public.task_checklist_items c where c.task_id = _t.id),
    'subtasks_done', (select count(c.completed_at) from public.task_checklist_items c where c.task_id = _t.id),
    'deliverables_count', (select count(*) from public.task_deliverables d where d.task_id = _t.id and d.deleted_at is null),
    'attachments_count', (select count(*) from public.task_attachments a where a.task_id = _t.id),
    'comments_count', (select count(*) from public.task_comments c where c.task_id = _t.id),
    'last_progress', (select jsonb_build_object('date', p.on_date, 'note', p.note, 'minutes', p.minutes) from public.task_progress p
      where p.task_id = _t.id and p.deleted_at is null order by p.on_date desc, p.created_at desc limit 1),
    'pinned', coalesce((select m.pinned from public.task_marks m where m.task_id = _t.id and m.user_id = auth.uid()), false),
    'focused', coalesce((select m.focus_date = _today from public.task_marks m where m.task_id = _t.id and m.user_id = auth.uid()), false),
    'can_edit', app.can_write_task(_t.id));
$$;

-- The report gains brand labels, campaigns and the ideas a person captured.
do $$
declare _body text;
begin
  select pg_get_functiondef('app.work_report_data(uuid,text,date,date,date,boolean)'::regprocedure) into _body;
  _body := replace(_body, $r$coalesce(nullif(btrim(t.brand), ''), '') as brand_label$r$,
    $r$coalesce(app.creative_brand_label(t.brand), '') as brand_label, (select c.name from public.creative_campaigns c where c.id = t.campaign_id and c.deleted_at is null) as campaign_name$r$);
  _body := replace(_body, $r$select t.id, t.title, t.status, t.review_stage, t.brand,$r$, $r$select t.id, t.title, t.status, t.review_stage, t.brand, t.campaign_id,$r$);
  _body := replace(_body, $r$'by_campaign', '[]'::jsonb,$r$,
    $r$'by_campaign', coalesce((select jsonb_agg(jsonb_build_object('campaign', x.name, 'done', x.done, 'total', x.total, 'spend', x.spend)
    order by lower(x.name)) from (
      select a.campaign_name as name, count(*) as total, count(*) filter (where a.id in (select d.id from delivered d)) as done,
        coalesce(sum(a.actual_cost), 0) as spend
      from active a where a.campaign_name is not null group by a.campaign_name) x), '[]'),$r$);
  _body := replace(_body, $r$'ideas_captured', '[]'::jsonb$r$,
    $r$'ideas_captured', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'text', i.text, 'brand', i.brand) order by i.created_at, i.id)
    from public.creative_ideas i
    where i.author_employee = _emp and i.deleted_at is null and app.ledger_ist_date(i.created_at) between _from and _to), '[]')$r$);
  if _body not like '%creative_brand_label%' or _body not like '%creative_ideas%' or _body not like '%campaign_name as name%' then
    raise exception 'work_report_data did not take the creative parts';
  end if;
  execute _body;
end $$;

-- Insights gain vendors.
do $$
declare _body text;
begin
  select pg_get_functiondef('public.work_insights(uuid)'::regprocedure) into _body;
  _body := replace(_body, $r$'vendors', '[]'::jsonb$r$,
    $r$'vendors', coalesce((select jsonb_agg(jsonb_build_object('vendor', x.vendor, 'tasks', x.n, 'spend', x.spend, 'last', x.last) order by x.n desc, x.vendor)
      from (select v.name as vendor, count(*) as n, coalesce(sum(t.actual_cost), 0) as spend, max(coalesce(t.done_on, t.logged_on)) as last
        from tasks t join public.creative_vendors v on v.id = t.vendor_id where t.logged_on >= _start group by v.name) x), '[]')$r$);
  if _body not like '%creative_vendors%' then raise exception 'work_insights did not take vendors'; end if;
  execute _body;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------------------------
revoke all on function app.creative_departments(), app.is_creative_member(), app.creative_brand_label(text), app.creative_date(text),
  app.creative_campaign_counts(uuid),
  app.creative_campaign_json(public.creative_campaigns,date,boolean), app.creative_idea_json(public.creative_ideas), app.creative_alerts(date)
  from public, anon;
grant execute on function app.creative_departments(), app.is_creative_member(), app.creative_brand_label(text), app.creative_date(text),
  app.creative_campaign_counts(uuid),
  app.creative_campaign_json(public.creative_campaigns,date,boolean), app.creative_idea_json(public.creative_ideas), app.creative_alerts(date)
  to authenticated;
revoke all on function public.creative_settings(), public.set_creative_departments(uuid[]), public.creative_home(), public.creative_campaigns(),
  public.creative_campaign(uuid), public.creative_campaign_details(), public.creative_ideas(), public.creative_library(),
  public.creative_campaign_note(uuid,text), public.creative_idea_to_campaign(uuid,uuid), public.creative_refresh_key_dates() from public, anon;
grant execute on function public.creative_settings(), public.set_creative_departments(uuid[]), public.creative_home(), public.creative_campaigns(),
  public.creative_campaign(uuid), public.creative_campaign_details(), public.creative_ideas(), public.creative_library(),
  public.creative_campaign_note(uuid,text), public.creative_idea_to_campaign(uuid,uuid), public.creative_refresh_key_dates() to authenticated;

comment on table public.creative_campaigns is 'Campaigns shared by the creative team (0174). Departments chosen in org_settings creative_departments.';
notify pgrst, 'reload schema';
commit;
