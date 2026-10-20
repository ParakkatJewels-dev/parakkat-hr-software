-- Work Ledger, stage 3: campaigns through their pipeline, ideas from capture to action, the library
-- (vendors, templates, key dates, brand foundations), insights and the data behind the generated
-- documents. Same rules as 0170: owner-only SECURITY DEFINER writes, managers read, deletes are soft.
-- Idempotent: safe to re-run.
begin;

-- History lines written within one transaction must keep their order.
alter table public.ledger_campaign_log alter column at set default clock_timestamp();
alter table public.ledger_task_log alter column at set default clock_timestamp();

-- ---------------------------------------------------------------------------------------------
-- 1. Festival calendar shared by every new ledger. Later years are projections from published
--    panchang tables; the note says so, and every row can be edited in the person's own ledger.
-- ---------------------------------------------------------------------------------------------
create table if not exists app.ledger_seed_key_dates (
  seed_key text primary key,
  name text not null,
  on_date date not null,
  brand text,
  lead_days integer,
  notes text
);
revoke all on app.ledger_seed_key_dates from public, anon, authenticated, service_role;
insert into app.ledger_seed_key_dates(seed_key, name, on_date, brand, lead_days, notes) values
  ('vishu-2026', 'Vishu', '2026-04-15', 'General', 30, null),
  ('akshaya-tritiya-2026', 'Akshaya Tritiya', '2026-04-19', 'Parakkat Jewels', 30, 'Gold buying day'),
  ('onam-2026', 'Onam (Thiruvonam)', '2026-08-26', 'General', 45, 'Kerala holidays 25–28 Aug'),
  ('independence-day-2026', 'Independence Day long weekend', '2026-08-15', 'Parakkat Munnar Resort', 21, 'Saturday'),
  ('gandhi-jayanti-2026', 'Gandhi Jayanti long weekend', '2026-10-02', 'Parakkat Munnar Resort', 21, 'Friday'),
  ('diwali-2026', 'Diwali', '2026-11-08', 'Parakkat Jewels', 45, null),
  ('wedding-season-2026', 'Wedding season peak', '2026-11-15', 'Parakkat Jewels', 45, 'Approximate; adjust to the season you plan for'),
  ('christmas-2026', 'Christmas and New Year peak', '2026-12-24', 'Parakkat Riverscape', 30, 'Resort peak'),
  ('republic-day-2027', 'Republic Day long weekend', '2027-01-26', 'Parakkat Munnar Resort', 21, 'Tuesday'),
  ('summer-peak-2027', 'Summer holiday peak', '2027-04-10', 'Parakkat Adimali Retreat', 30, 'Resort peak; approximate'),
  ('vishu-2027', 'Vishu', '2027-04-15', 'General', 30, 'Projected; confirm with the local calendar'),
  ('akshaya-tritiya-2027', 'Akshaya Tritiya', '2027-05-08', 'Parakkat Jewels', 30, 'Projected (some calendars say 9 May)'),
  ('onam-2027', 'Onam (Thiruvonam)', '2027-09-12', 'General', 45, 'Projected; confirm with the local calendar'),
  ('diwali-2027', 'Diwali', '2027-10-29', 'Parakkat Jewels', 45, 'Projected; confirm with the local calendar'),
  ('vishu-2028', 'Vishu', '2028-04-13', 'General', 30, 'Projected; confirm with the local calendar'),
  ('akshaya-tritiya-2028', 'Akshaya Tritiya', '2028-04-27', 'Parakkat Jewels', 30, 'Projected'),
  ('onam-2028', 'Onam (Thiruvonam)', '2028-09-01', 'General', 45, 'Projected; confirm with the local calendar'),
  ('diwali-2028', 'Diwali', '2028-10-17', 'Parakkat Jewels', 45, 'Projected; confirm with the local calendar')
on conflict (seed_key) do update set name = excluded.name, on_date = excluded.on_date, brand = excluded.brand,
  lead_days = excluded.lead_days, notes = excluded.notes;

-- Adds festival dates the person does not have yet (today onwards). Never re-adds one they removed.
create or replace function app.ledger_add_seed_dates(_owner uuid)
returns integer language plpgsql security definer set search_path = pg_catalog as $$
declare _added integer;
begin
  insert into public.ledger_key_dates(owner_user, name, on_date, brand, lead_days, notes, seed_key)
    select _owner, s.name, s.on_date, s.brand, s.lead_days, s.notes, s.seed_key from app.ledger_seed_key_dates s
    where s.on_date >= app.ledger_today()
    on conflict (owner_user, seed_key) where seed_key is not null do nothing;
  get diagnostics _added = row_count;
  return _added;
end $$;
revoke all on function app.ledger_add_seed_dates(uuid) from public, anon, authenticated, service_role;

-- First open of a brand-new ledger also brings the festival calendar.
create or replace function public.ledger_open()
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _new boolean;
begin
  _new := not exists(select 1 from public.ledger_settings s where s.owner_user = _owner and s.seeded_at is not null);
  perform app.ledger_seed(_owner);
  if _new and not exists(select 1 from public.ledger_key_dates k where k.owner_user = _owner) then perform app.ledger_add_seed_dates(_owner); end if;
  return app.ledger_bootstrap_data(_owner);
end $$;

create or replace function public.ledger_refresh_key_dates()
returns integer language plpgsql security definer set search_path = pg_catalog as $$
begin return app.ledger_add_seed_dates(app.ledger_owner()); end $$;

-- Importing the person's own key dates replaces starter festival rows they have not touched.
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
  perform pg_advisory_xact_lock(hashtextextended('ledger-import:' || _owner::text, 0));
  if _kind = 'key_dates' and jsonb_array_length(_rows) > 0 then
    update public.ledger_key_dates set deleted_at = now(), updated_at = now()
      where owner_user = _owner and seed_key is not null and deleted_at is null and updated_at <= created_at + interval '1 second';
  end if;
  _result := app.ledger_import_rows(_owner, _kind, _rows, clock_timestamp());
  update public.ledger_settings set imported_at = now(), updated_at = now() where owner_user = _owner;
  return _result;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Campaigns
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_campaign_stages() returns text[] language sql immutable as $$
  select array['Captured','Developing','Decision','Approved','Production','Live','Reviewed'];
$$;

create or replace function app.ledger_campaign_json(_c public.ledger_campaigns, _today date, _detail boolean default false)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object('id', _c.id, 'name', _c.name, 'brand', _c.brand,
    'brand_label', coalesce((select coalesce(b.short_label, b.name) from public.ledger_brands b where b.owner_user = _c.owner_user
      and lower(b.name) = lower(_c.brand) and b.deleted_at is null), _c.brand),
    'launch_date', _c.launch_date, 'days_to_launch', _c.launch_date - _today, 'brief_link', _c.brief_link, 'notes', _c.notes,
    'stage', _c.stage, 'status', _c.status, 'priority', _c.priority, 'objective', _c.objective, 'next_action', _c.next_action,
    'milestone', _c.milestone, 'milestone_date', _c.milestone_date, 'blocker', _c.blocker, 'decision', _c.decision, 'budget', _c.budget,
    'brief', _c.brief, 'measure', _c.measure, 'results', _c.results, 'created_at', _c.created_at,
    'total', (select count(*) from public.ledger_tasks t where t.campaign_id = _c.id and t.deleted_at is null and t.entry_kind is null and t.status <> 'Cancelled'),
    'done', (select count(*) from public.ledger_tasks t where t.campaign_id = _c.id and t.deleted_at is null and t.status = 'Delivered'),
    'in_review', (select count(*) from public.ledger_tasks t where t.campaign_id = _c.id and t.deleted_at is null
      and t.status in ('Internal Review','Awaiting Approval','Revisions')),
    'blocked', (select count(*) from public.ledger_tasks t where t.campaign_id = _c.id and t.deleted_at is null and t.status = 'Blocked'),
    'spend', (select coalesce(sum(t.actual_cost), 0) from public.ledger_tasks t where t.campaign_id = _c.id and t.deleted_at is null))
  || case when not _detail then '{}'::jsonb else jsonb_build_object(
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'text', l.text) order by l.at desc, l.id desc)
      from public.ledger_campaign_log l where l.campaign_id = _c.id), '[]'),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'deadline', t.deadline,
        'priority', t.priority, 'vendor', (select v.name from public.ledger_vendors v where v.id = t.vendor_id), 'actual_cost', t.actual_cost,
        'deliverables', coalesce((select jsonb_agg(jsonb_build_object('type', d.type, 'version', d.version, 'link', d.link, 'used_where', d.used_where)
          order by d.added_at) from public.ledger_deliverables d where d.task_id = t.id and d.deleted_at is null), '[]'))
      order by t.status = 'Delivered', t.deadline nulls last, t.logged_at)
      from public.ledger_tasks t where t.campaign_id = _c.id and t.deleted_at is null and t.entry_kind is null), '[]'),
    'ideas', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'text', i.text, 'links', i.links, 'status', i.status) order by i.created_at)
      from public.ledger_ideas i where i.deleted_at is null and (i.campaign_id = _c.id
        or i.id in (select ci.idea_id from public.ledger_campaign_ideas ci where ci.campaign_id = _c.id))), '[]'))
  end;
$$;
revoke all on function app.ledger_campaign_json(public.ledger_campaigns,date,boolean) from public, anon, authenticated, service_role;

create or replace function public.ledger_campaigns(_owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner); _today date := app.ledger_today();
begin
  return coalesce((select jsonb_agg(app.ledger_campaign_json(c, _today) order by
      coalesce(array_position(app.ledger_campaign_stages(), c.stage), 8 + array_position(array['Parked','Cancelled'], c.stage)), c.launch_date nulls last, lower(c.name))
    from public.ledger_campaigns c where c.owner_user = _target and c.deleted_at is null), '[]');
end $$;

create or replace function public.ledger_campaign(_id uuid, _owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner); _c public.ledger_campaigns;
begin
  select * into _c from public.ledger_campaigns where id = _id and owner_user = _target and deleted_at is null;
  if _c.id is null then raise exception using errcode = 'P0002', message = 'Campaign not found.'; end if;
  return app.ledger_campaign_json(_c, app.ledger_today(), true);
end $$;

-- Everything the group review and the monthly document need: every campaign with its detail.
create or replace function public.ledger_campaign_details(_owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner); _today date := app.ledger_today();
begin
  return coalesce((select jsonb_agg(app.ledger_campaign_json(c, _today, true) order by c.launch_date nulls last, lower(c.name))
    from public.ledger_campaigns c where c.owner_user = _target and c.deleted_at is null), '[]');
end $$;

-- Create (new id) or change (partial: only keys present). Stage moves are logged.
create or replace function public.ledger_save_campaign(_id uuid, _c jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _old public.ledger_campaigns; _new public.ledger_campaigns;
  _stage text; _key text; _text text;
begin
  if _id is null or _c is null or jsonb_typeof(_c) <> 'object' then raise exception using errcode = '22023', message = 'Send a campaign id and details.'; end if;
  if exists(select 1 from jsonb_object_keys(_c) k where k not in ('name','brand','launch_date','brief_link','notes','stage','priority','objective',
      'next_action','milestone','milestone_date','blocker','decision','budget','brief','measure','results','log_text')) then
    raise exception using errcode = '22023', message = 'One of the campaign fields is not recognised.';
  end if;
  foreach _key in array array['brief','measure','results'] loop
    if _c ? _key and jsonb_typeof(_c->_key) not in ('object','null') then
      raise exception using errcode = '22023', message = format('%s must be a set of named fields.', initcap(_key));
    end if;
  end loop;
  _stage := app.ledger_pick(_c->>'stage', app.ledger_campaign_stages() || array['Parked','Cancelled'], 'Stage');
  select * into _old from public.ledger_campaigns where id = _id;
  begin
    if _old.id is null then
      if app.ledger_json_text(_c, 'name', 160) is null then raise exception using errcode = '22023', message = 'A campaign needs a name.'; end if;
      perform app.ledger_seed(_owner);
      insert into public.ledger_campaigns(id, owner_user, name, brand, launch_date, brief_link, notes, stage, priority, objective, next_action,
          milestone, milestone_date, blocker, decision, budget, brief, measure, results)
        values (_id, _owner, app.ledger_json_text(_c, 'name', 160),
          case when _c ? 'brand' then app.ledger_ensure_brand(_owner, _c->>'brand') end,
          app.ledger_json_date(_c, 'launch_date'), app.ledger_json_text(_c, 'brief_link', 2000), app.ledger_json_text(_c, 'notes', 4000),
          coalesce(_stage, 'Captured'), coalesce(app.ledger_pick(_c->>'priority', array['High','Medium','Low'], 'Priority'), 'Medium'),
          app.ledger_json_text(_c, 'objective', 2000), app.ledger_json_text(_c, 'next_action', 1000), app.ledger_json_text(_c, 'milestone', 500),
          app.ledger_json_date(_c, 'milestone_date'), app.ledger_json_text(_c, 'blocker', 1000), app.ledger_json_text(_c, 'decision', 2000),
          app.ledger_json_text(_c, 'budget', 200), coalesce(nullif(_c->'brief', 'null'), '{}'), coalesce(nullif(_c->'measure', 'null'), '{}'),
          coalesce(nullif(_c->'results', 'null'), '{}'))
        returning * into _new;
      insert into public.ledger_campaign_log(owner_user, campaign_id, text) values (_owner, _id, 'Created at ' || _new.stage);
    else
      if _old.owner_user <> _owner or _old.deleted_at is not null then raise exception using errcode = 'P0002', message = 'Campaign not found.'; end if;
      if (_c ? 'name') and app.ledger_json_text(_c, 'name', 160) is null then raise exception using errcode = '22023', message = 'A campaign needs a name.'; end if;
      update public.ledger_campaigns c set
          name = case when _c ? 'name' then app.ledger_json_text(_c, 'name', 160) else c.name end,
          brand = case when _c ? 'brand' then app.ledger_ensure_brand(_owner, _c->>'brand') else c.brand end,
          launch_date = case when _c ? 'launch_date' then app.ledger_json_date(_c, 'launch_date') else c.launch_date end,
          brief_link = case when _c ? 'brief_link' then app.ledger_json_text(_c, 'brief_link', 2000) else c.brief_link end,
          notes = case when _c ? 'notes' then app.ledger_json_text(_c, 'notes', 4000) else c.notes end,
          stage = coalesce(_stage, c.stage),
          priority = coalesce(app.ledger_pick(_c->>'priority', array['High','Medium','Low'], 'Priority'), c.priority),
          objective = case when _c ? 'objective' then app.ledger_json_text(_c, 'objective', 2000) else c.objective end,
          next_action = case when _c ? 'next_action' then app.ledger_json_text(_c, 'next_action', 1000) else c.next_action end,
          milestone = case when _c ? 'milestone' then app.ledger_json_text(_c, 'milestone', 500) else c.milestone end,
          milestone_date = case when _c ? 'milestone_date' then app.ledger_json_date(_c, 'milestone_date') else c.milestone_date end,
          blocker = case when _c ? 'blocker' then app.ledger_json_text(_c, 'blocker', 1000) else c.blocker end,
          decision = case when _c ? 'decision' then app.ledger_json_text(_c, 'decision', 2000) else c.decision end,
          budget = case when _c ? 'budget' then app.ledger_json_text(_c, 'budget', 200) else c.budget end,
          brief = case when _c ? 'brief' then coalesce(nullif(_c->'brief', 'null'), '{}') else c.brief end,
          measure = case when _c ? 'measure' then coalesce(nullif(_c->'measure', 'null'), '{}') else c.measure end,
          results = case when _c ? 'results' then coalesce(nullif(_c->'results', 'null'), '{}') else c.results end,
          updated_at = now()
        where c.id = _id returning * into _new;
      if _new.stage <> _old.stage then
        insert into public.ledger_campaign_log(owner_user, campaign_id, text) values (_owner, _id, 'Stage: ' || _old.stage || ' → ' || _new.stage);
      end if;
      if (_c ? 'decision') and _new.decision is distinct from _old.decision and _new.decision is not null then
        insert into public.ledger_campaign_log(owner_user, campaign_id, text) values (_owner, _id, 'Decision: ' || _new.decision);
      end if;
    end if;
  exception when unique_violation then
    raise exception using errcode = '22023', message = 'You already have a campaign with that name.';
  end;
  _text := app.ledger_json_text(_c, 'log_text', 2000);
  if _text is not null then insert into public.ledger_campaign_log(owner_user, campaign_id, text) values (_owner, _id, _text); end if;
  return app.ledger_campaign_json(_new, _today, true);
end $$;

-- webAdvanceCampaign: the next stage in the pipeline; fails at Reviewed.
create or replace function public.ledger_advance_campaign(_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _c public.ledger_campaigns; _position integer;
begin
  select * into _c from public.ledger_campaigns where id = _id and owner_user = _owner and deleted_at is null for update;
  if _c.id is null then raise exception using errcode = 'P0002', message = 'Campaign not found.'; end if;
  if _c.stage in ('Parked','Cancelled') then raise exception using errcode = '22023', message = 'Reactivate the campaign before advancing it.'; end if;
  _position := array_position(app.ledger_campaign_stages(), _c.stage);
  if _position >= 7 then raise exception using errcode = '22023', message = 'This campaign has been reviewed; there is no next stage.'; end if;
  return public.ledger_save_campaign(_id, jsonb_build_object('stage', (app.ledger_campaign_stages())[_position + 1]));
end $$;

create or replace function public.ledger_delete_campaign(_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  update public.ledger_campaigns set deleted_at = now(), updated_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Campaign not found.'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Ideas
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_idea_json(_i public.ledger_ideas)
returns jsonb language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object('id', _i.id, 'text', _i.text, 'original', _i.original, 'edited', _i.text <> _i.original, 'brand', _i.brand,
    'tags', to_jsonb(_i.tags), 'links', _i.links, 'status', _i.status, 'created_at', _i.created_at, 'revisit_date', _i.revisit_date,
    'revisit_when', _i.revisit_when, 'concept', _i.concept, 'task_id', _i.task_id, 'campaign_id', _i.campaign_id,
    'task_title', (select t.title from public.ledger_tasks t where t.id = _i.task_id),
    'campaign_name', (select c.name from public.ledger_campaigns c where c.id = _i.campaign_id));
$$;
revoke all on function app.ledger_idea_json(public.ledger_ideas) from public, anon, authenticated, service_role;

create or replace function public.ledger_ideas(_status text default null, _owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner); _pick text := app.ledger_pick(_status, array['Open','Developing','Parked','Promoted','Archived'], 'Status');
begin
  return coalesce((select jsonb_agg(app.ledger_idea_json(i) order by i.created_at desc, i.id)
    from public.ledger_ideas i where i.owner_user = _target and i.deleted_at is null and (_pick is null or i.status = _pick)), '[]');
end $$;

create or replace function public.ledger_add_idea(_id uuid, _text text, _brand text default null, _tags text[] default '{}')
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _row public.ledger_ideas;
begin
  select * into _row from public.ledger_ideas where id = _id;
  if _row.id is not null then
    if _row.owner_user <> _owner then raise exception using errcode = '42501', message = 'That id is taken.'; end if;
    return app.ledger_idea_json(_row);
  end if;
  if length(btrim(coalesce(_text, ''))) not between 1 and 4000 then raise exception using errcode = '22023', message = 'Write the idea (up to 4000 characters).'; end if;
  perform app.ledger_seed(_owner);
  insert into public.ledger_ideas(id, owner_user, text, original, brand, tags)
    values (_id, _owner, btrim(_text), btrim(_text), case when nullif(btrim(_brand), '') is not null then app.ledger_ensure_brand(_owner, _brand) end,
      coalesce((select array_agg(distinct lower(btrim(t))) from unnest(_tags) t where btrim(t) <> ''), '{}'))
    returning * into _row;
  return app.ledger_idea_json(_row);
end $$;

-- Edits change the working text only; the first wording stays. Writing any concept field moves an
-- Open idea to Developing.
create or replace function public.ledger_update_idea(_id uuid, _u jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _row public.ledger_ideas; _status text; _concept jsonb;
begin
  if _u is null or jsonb_typeof(_u) <> 'object' or exists(select 1 from jsonb_object_keys(_u) k
      where k not in ('text','brand','tags','links','status','revisit_date','revisit_when','concept')) then
    raise exception using errcode = '22023', message = 'Send the idea fields to change.';
  end if;
  if (_u ? 'concept') and jsonb_typeof(_u->'concept') <> 'object' then raise exception using errcode = '22023', message = 'The concept must be a set of named fields.'; end if;
  select * into _row from public.ledger_ideas where id = _id and owner_user = _owner and deleted_at is null for update;
  if _row.id is null then raise exception using errcode = 'P0002', message = 'Idea not found.'; end if;
  if (_u ? 'text') and app.ledger_json_text(_u, 'text', 4000) is null then raise exception using errcode = '22023', message = 'An idea needs some words.'; end if;
  _status := app.ledger_pick(_u->>'status', array['Open','Developing','Parked','Promoted','Archived'], 'Status');
  _concept := case when _u ? 'concept' then _row.concept || jsonb_strip_nulls(_u->'concept') else _row.concept end;
  if _status is null and _row.status = 'Open' and (_u ? 'concept') and exists(select 1 from jsonb_each_text(jsonb_strip_nulls(_u->'concept')) e where btrim(e.value) <> '') then
    _status := 'Developing';
  end if;
  update public.ledger_ideas i set
      text = case when _u ? 'text' then app.ledger_json_text(_u, 'text', 4000) else i.text end,
      brand = case when _u ? 'brand' then case when nullif(btrim(_u->>'brand'), '') is not null then app.ledger_ensure_brand(_owner, _u->>'brand') end else i.brand end,
      tags = case when _u ? 'tags' then app.ledger_json_tags(_u) else i.tags end,
      links = case when _u ? 'links' then app.ledger_json_text(_u, 'links', 4000) else i.links end,
      status = coalesce(_status, i.status),
      revisit_date = case when _u ? 'revisit_date' then app.ledger_json_date(_u, 'revisit_date') else i.revisit_date end,
      revisit_when = case when _u ? 'revisit_when' then app.ledger_json_text(_u, 'revisit_when', 500) else i.revisit_when end,
      concept = _concept, updated_at = now()
    where i.id = _id returning * into _row;
  return app.ledger_idea_json(_row);
end $$;

-- webIdeaToCampaign: a Developing campaign pre-filled from the concept card.
create or replace function public.ledger_idea_to_campaign(_idea uuid, _campaign uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _i public.ledger_ideas; _name text; _result jsonb; _suffix integer := 1;
begin
  select * into _i from public.ledger_ideas where id = _idea and owner_user = _owner and deleted_at is null for update;
  if _i.id is null then raise exception using errcode = 'P0002', message = 'Idea not found.'; end if;
  if _i.campaign_id is not null then return public.ledger_campaign(_i.campaign_id); end if;
  _name := left(coalesce(nullif(btrim(_i.concept->>'oneLine'), ''), _i.text), 150);
  while exists(select 1 from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null and lower(c.name) = lower(_name)) loop
    _suffix := _suffix + 1; _name := left(coalesce(nullif(btrim(_i.concept->>'oneLine'), ''), _i.text), 145) || ' (' || _suffix || ')';
  end loop;
  _result := public.ledger_save_campaign(_campaign, jsonb_strip_nulls(jsonb_build_object('name', _name, 'brand', _i.brand, 'stage', 'Developing',
    'objective', _i.concept->>'objective', 'next_action', _i.concept->>'nextAction',
    'brief', jsonb_strip_nulls(jsonb_build_object('insight', _i.concept->>'insight', 'idea', coalesce(_i.concept->>'approach', _i.concept->>'oneLine'),
      'example', _i.concept->>'outputs', 'resources', _i.concept->>'needs')),
    'log_text', 'From idea: ' || left(_i.text, 200))));
  insert into public.ledger_campaign_ideas(campaign_id, idea_id, owner_user) values (_campaign, _idea, _owner) on conflict do nothing;
  update public.ledger_ideas set status = 'Promoted', campaign_id = _campaign, updated_at = now() where id = _idea;
  return _result;
end $$;

create or replace function public.ledger_delete_idea(_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  update public.ledger_ideas set deleted_at = now(), updated_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Idea not found.'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Library
-- ---------------------------------------------------------------------------------------------
create or replace function public.ledger_library(_owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner);
begin
  return jsonb_build_object(
    'vendors', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'role', v.role, 'phone', v.phone, 'email', v.email,
      'rate', v.rate, 'rating', v.rating, 'notes', v.notes, 'last_worked', v.last_worked,
      'tasks', (select count(*) from public.ledger_tasks t where t.vendor_id = v.id and t.deleted_at is null)) order by lower(v.name))
      from public.ledger_vendors v where v.owner_user = _target and v.deleted_at is null), '[]'),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'type', t.type, 'subtasks', t.subtasks) order by lower(t.name))
      from public.ledger_templates t where t.owner_user = _target and t.deleted_at is null), '[]'),
    'key_dates', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'date', k.on_date, 'brand', k.brand,
      'lead_days', k.lead_days, 'notes', k.notes, 'starter', k.seed_key is not null) order by k.on_date, lower(k.name))
      from public.ledger_key_dates k where k.owner_user = _target and k.deleted_at is null), '[]'),
    'brands', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'label', coalesce(b.short_label, b.name),
      'sort_order', b.sort_order, 'foundation', b.foundation, 'foundation_updated_at', b.foundation_updated_at) order by b.sort_order, lower(b.name))
      from public.ledger_brands b where b.owner_user = _target and b.deleted_at is null), '[]'));
end $$;

-- Library saves: a new id adds the row; an existing id changes only the keys present.
create or replace function public.ledger_save_vendor(_id uuid, _v jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _rating integer; _exists boolean;
begin
  if _id is null or _v is null or jsonb_typeof(_v) <> 'object' then raise exception using errcode = '22023', message = 'Send the vendor details.'; end if;
  _rating := (app.ledger_json_number(_v, 'rating'))::integer;
  if _rating is not null and _rating not between 1 and 5 then raise exception using errcode = '22023', message = 'Rating is 1 to 5.'; end if;
  select true into _exists from public.ledger_vendors where id = _id;
  if _exists and not exists(select 1 from public.ledger_vendors where id = _id and owner_user = _owner and deleted_at is null) then
    raise exception using errcode = 'P0002', message = 'Vendor not found.';
  end if;
  if (not coalesce(_exists, false) or _v ? 'name') and app.ledger_json_text(_v, 'name', 160) is null then
    raise exception using errcode = '22023', message = 'A vendor needs a name.';
  end if;
  begin
    if coalesce(_exists, false) then
      update public.ledger_vendors v set
          name = case when _v ? 'name' then app.ledger_json_text(_v, 'name', 160) else v.name end,
          role = case when _v ? 'role' then app.ledger_json_text(_v, 'role', 120) else v.role end,
          phone = case when _v ? 'phone' then app.ledger_json_text(_v, 'phone', 60) else v.phone end,
          email = case when _v ? 'email' then app.ledger_json_text(_v, 'email', 200) else v.email end,
          rate = case when _v ? 'rate' then app.ledger_json_text(_v, 'rate', 120) else v.rate end,
          rating = case when _v ? 'rating' then _rating else v.rating end,
          notes = case when _v ? 'notes' then app.ledger_json_text(_v, 'notes', 2000) else v.notes end,
          last_worked = case when _v ? 'last_worked' then app.ledger_json_date(_v, 'last_worked') else v.last_worked end,
          updated_at = now()
        where v.id = _id;
    else
      insert into public.ledger_vendors(id, owner_user, name, role, phone, email, rate, rating, notes, last_worked)
        values (_id, _owner, app.ledger_json_text(_v, 'name', 160), app.ledger_json_text(_v, 'role', 120), app.ledger_json_text(_v, 'phone', 60),
          app.ledger_json_text(_v, 'email', 200), app.ledger_json_text(_v, 'rate', 120), _rating, app.ledger_json_text(_v, 'notes', 2000),
          app.ledger_json_date(_v, 'last_worked'));
    end if;
  exception when unique_violation then
    raise exception using errcode = '22023', message = 'You already have a vendor with that name.';
  end;
  return public.ledger_library()->'vendors';
end $$;

create or replace function public.ledger_save_template(_id uuid, _t jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _steps text[]; _exists boolean;
begin
  if _id is null or _t is null or jsonb_typeof(_t) <> 'object' then raise exception using errcode = '22023', message = 'Send the template.'; end if;
  select true into _exists from public.ledger_templates where id = _id;
  if _exists and not exists(select 1 from public.ledger_templates where id = _id and owner_user = _owner and deleted_at is null) then
    raise exception using errcode = 'P0002', message = 'Template not found.';
  end if;
  if (not coalesce(_exists, false) or _t ? 'name') and app.ledger_json_text(_t, 'name', 160) is null then
    raise exception using errcode = '22023', message = 'A template needs a name.';
  end if;
  _steps := case when jsonb_typeof(_t->'subtasks') = 'array' then (select coalesce(array_agg(btrim(v) order by n), '{}')
      from jsonb_array_elements_text(_t->'subtasks') with ordinality s(v, n) where btrim(v) <> '')
    else (select coalesce(array_agg(btrim(v) order by n), '{}') from unnest(string_to_array(coalesce(_t->>'subtasks', ''), E'\n')) with ordinality s(v, n) where btrim(v) <> '') end;
  if coalesce(_exists, false) then
    update public.ledger_templates t set
        name = case when _t ? 'name' then app.ledger_json_text(_t, 'name', 160) else t.name end,
        type = case when _t ? 'type' then app.ledger_json_text(_t, 'type', 120) else t.type end,
        subtasks = case when _t ? 'subtasks' then _steps else t.subtasks end, updated_at = now()
      where t.id = _id;
  else
    insert into public.ledger_templates(id, owner_user, name, type, subtasks)
      values (_id, _owner, app.ledger_json_text(_t, 'name', 160), app.ledger_json_text(_t, 'type', 120), _steps);
  end if;
  return public.ledger_library()->'templates';
end $$;

create or replace function public.ledger_save_key_date(_id uuid, _k jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _lead integer; _exists boolean;
begin
  if _id is null or _k is null or jsonb_typeof(_k) <> 'object' then raise exception using errcode = '22023', message = 'Send the key date.'; end if;
  select true into _exists from public.ledger_key_dates where id = _id;
  if _exists and not exists(select 1 from public.ledger_key_dates where id = _id and owner_user = _owner and deleted_at is null) then
    raise exception using errcode = 'P0002', message = 'Key date not found.';
  end if;
  if (not coalesce(_exists, false) or _k ? 'name') and app.ledger_json_text(_k, 'name', 160) is null then
    raise exception using errcode = '22023', message = 'A key date needs a name.';
  end if;
  if (not coalesce(_exists, false) or _k ? 'date') and app.ledger_json_date(_k, 'date') is null then
    raise exception using errcode = '22023', message = 'A key date needs a date.';
  end if;
  _lead := (app.ledger_json_number(_k, 'lead_days'))::integer;
  if _lead is not null and _lead not between 0 and 365 then raise exception using errcode = '22023', message = 'Lead days are 0 to 365.'; end if;
  if coalesce(_exists, false) then
    update public.ledger_key_dates k set
        name = case when _k ? 'name' then app.ledger_json_text(_k, 'name', 160) else k.name end,
        on_date = case when _k ? 'date' then app.ledger_json_date(_k, 'date') else k.on_date end,
        brand = case when _k ? 'brand' then case when nullif(btrim(_k->>'brand'), '') is not null then app.ledger_ensure_brand(_owner, _k->>'brand') end else k.brand end,
        lead_days = case when _k ? 'lead_days' then _lead else k.lead_days end,
        notes = case when _k ? 'notes' then app.ledger_json_text(_k, 'notes', 2000) else k.notes end, updated_at = now()
      where k.id = _id;
  else
    insert into public.ledger_key_dates(id, owner_user, name, on_date, brand, lead_days, notes)
      values (_id, _owner, app.ledger_json_text(_k, 'name', 160), app.ledger_json_date(_k, 'date'),
        case when nullif(btrim(_k->>'brand'), '') is not null then app.ledger_ensure_brand(_owner, _k->>'brand') end, _lead, app.ledger_json_text(_k, 'notes', 2000));
  end if;
  return public.ledger_library()->'key_dates';
end $$;

-- Brand foundations upsert by brand name (webUpdateBrandFoundation).
create or replace function public.ledger_save_brand(_name text, _f jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _brand text;
begin
  if nullif(btrim(_name), '') is null or _f is null or jsonb_typeof(_f) <> 'object' then raise exception using errcode = '22023', message = 'Send the brand and its notes.'; end if;
  if exists(select 1 from jsonb_object_keys(_f) k where k not in ('label','positioning','audiences','tone','visual','offerings','claims')) then
    raise exception using errcode = '22023', message = 'Brand notes cover positioning, audiences, tone, visual, offerings and claims.';
  end if;
  perform app.ledger_seed(_owner);
  _brand := app.ledger_ensure_brand(_owner, _name);
  update public.ledger_brands b set
      short_label = case when _f ? 'label' then left(app.ledger_json_text(_f, 'label', 40), 40) else b.short_label end,
      foundation = b.foundation || jsonb_strip_nulls(_f - 'label'), foundation_updated_at = now(), updated_at = now()
    where b.owner_user = _owner and b.name = _brand and b.deleted_at is null;
  return public.ledger_library()->'brands';
end $$;

create or replace function public.ledger_delete_library_item(_kind text, _id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  if _kind = 'vendor' then update public.ledger_vendors set deleted_at = now(), updated_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  elsif _kind = 'template' then update public.ledger_templates set deleted_at = now(), updated_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  elsif _kind = 'key_date' then update public.ledger_key_dates set deleted_at = now(), updated_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  else raise exception using errcode = '22023', message = 'Choose a vendor, template or key date.';
  end if;
  if not found then raise exception using errcode = 'P0002', message = 'Not found.'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Insights: six months, read-only (webGetInsights)
-- ---------------------------------------------------------------------------------------------
create or replace function public.ledger_insights(_owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner); _today date := app.ledger_today();
  _start date := (date_trunc('month', _today) - interval '5 months')::date;
begin
  return (with months as (select generate_series(_start, date_trunc('month', _today)::date, interval '1 month')::date as m),
  tasks as (select t.*, (select v.name from public.ledger_vendors v where v.id = t.vendor_id) as vendor_name,
      coalesce((select coalesce(b.short_label, b.name) from public.ledger_brands b where b.owner_user = t.owner_user and lower(b.name) = lower(t.brand) and b.deleted_at is null), t.brand) as brand_label
    from public.ledger_tasks t where t.owner_user = _target and t.deleted_at is null),
  delivered as (select * from tasks where entry_kind is null and status = 'Delivered' and status_since >= _start),
  open_tasks as (select * from tasks where entry_kind is null and status not in ('Delivered','Cancelled'))
  select jsonb_build_object('from', _start, 'to', _today,
    'months', (select jsonb_agg(jsonb_build_object('month', to_char(m.m, 'YYYY-MM'), 'label', to_char(m.m, 'Mon'),
        'delivered', (select count(*) from delivered d where date_trunc('month', d.status_since) = m.m),
        'with_deadline', (select count(*) from delivered d where date_trunc('month', d.status_since) = m.m and d.deadline is not null),
        'on_time', (select count(*) from delivered d where date_trunc('month', d.status_since) = m.m and d.deadline is not null and d.status_since <= d.deadline),
        'support', (select count(*) from tasks s where s.entry_kind = 'support' and date_trunc('month', coalesce(s.work_date, s.status_since)) = m.m),
        'support_minutes', (select coalesce(sum(s.minutes), 0) from tasks s where s.entry_kind = 'support' and date_trunc('month', coalesce(s.work_date, s.status_since)) = m.m),
        'est', (select coalesce(sum(d.est_cost), 0) from delivered d where date_trunc('month', d.status_since) = m.m),
        'actual', (select coalesce(sum(d.actual_cost), 0) from delivered d where date_trunc('month', d.status_since) = m.m))
      order by m.m) from months m),
    'by_brand', coalesce((select jsonb_agg(jsonb_build_object('brand', x.label, 'delivered', x.n) order by x.n desc, x.label)
      from (select brand_label as label, count(*) as n from delivered group by brand_label) x), '[]'),
    'turnaround_by_type', coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'days', x.days, 'count', x.n) order by x.days desc)
      from (select coalesce(nullif(btrim(type), ''), 'Other') as type, round(avg(status_since - work_date)::numeric, 1) as days, count(*) as n
        from delivered group by 1) x), '[]'),
    'average_revisions', (select round(avg(revision)::numeric, 2) from delivered),
    'open_by_status', coalesce((select jsonb_agg(jsonb_build_object('status', x.status, 'count', x.n) order by array_position(app.ledger_statuses(), x.status))
      from (select status, count(*) as n from open_tasks group by status) x), '[]'),
    'ageing', jsonb_build_object(
      'week', (select count(*) from open_tasks where _today - work_date <= 7),
      'month', (select count(*) from open_tasks where _today - work_date between 8 and 30),
      'quarter', (select count(*) from open_tasks where _today - work_date between 31 and 90),
      'older', (select count(*) from open_tasks where _today - work_date > 90)),
    'vendors', coalesce((select jsonb_agg(jsonb_build_object('vendor', x.vendor_name, 'tasks', x.n, 'spend', x.spend, 'last', x.last) order by x.n desc, x.vendor_name)
      from (select vendor_name, count(*) as n, coalesce(sum(actual_cost), 0) as spend, max(coalesce(status_since, work_date)) as last
        from tasks where vendor_name is not null and work_date >= _start group by vendor_name) x), '[]'))
  );
end $$;

do $$
declare _signature text;
begin
  foreach _signature in array array['ledger_refresh_key_dates()', 'ledger_campaigns(uuid)', 'ledger_campaign(uuid,uuid)',
    'ledger_campaign_details(uuid)', 'ledger_save_campaign(uuid,jsonb)', 'ledger_advance_campaign(uuid)', 'ledger_delete_campaign(uuid)',
    'ledger_ideas(text,uuid)', 'ledger_add_idea(uuid,text,text,text[])', 'ledger_update_idea(uuid,jsonb)', 'ledger_idea_to_campaign(uuid,uuid)',
    'ledger_delete_idea(uuid)', 'ledger_library(uuid)', 'ledger_save_vendor(uuid,jsonb)', 'ledger_save_template(uuid,jsonb)',
    'ledger_save_key_date(uuid,jsonb)', 'ledger_save_brand(text,jsonb)', 'ledger_delete_library_item(text,uuid)', 'ledger_insights(uuid)',
    'ledger_open()', 'ledger_import_batch(text,jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, service_role', _signature);
    execute format('grant execute on function public.%s to authenticated', _signature);
  end loop;
end $$;
revoke all on function app.ledger_campaign_stages() from public, anon;
grant execute on function app.ledger_campaign_stages() to authenticated;

notify pgrst, 'reload schema';
commit;
