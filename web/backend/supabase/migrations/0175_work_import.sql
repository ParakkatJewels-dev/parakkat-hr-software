-- 0175 Bring the old Work Ledger Google Sheet into the Ledger's real records.
--
-- The browser reads the downloaded workbook (src/lib/ledger/importWorkbook.js) and sends its rows in
-- small batches, in dependency order. Each WorkLog row becomes a task assigned to the person
-- importing (support rows become help-log entries); subtasks, deliverables and progress notes attach
-- to those tasks; campaigns, ideas, vendors, templates, key dates and brand notes go to the creative
-- team's shared tables; reminders stay the importer's own. It is for members of the creative team.
--
-- Re-running is safe: every imported row is remembered against its Sheet row (app.work_import_map)
-- together with the values it was given. A row is updated again only while it still holds exactly
-- those values; anything changed or removed here since is left alone and reported. A campaign,
-- vendor or brand that already existed by name is linked, never overwritten.
begin;

create table if not exists app.work_import_map (
  owner_user uuid not null,
  kind text not null,
  legacy_row integer not null,
  target_id uuid not null,
  snapshot jsonb,
  adopted boolean not null default false,
  imported_at timestamptz not null default clock_timestamp(),
  primary key (owner_user, kind, legacy_row)
);
revoke all on app.work_import_map from public, anon, authenticated;

-- The imported fields of a row as they are now; null when the row is gone or removed.
create or replace function app.work_import_current(_kind text, _id uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, public, app as $$
  select case _kind
    when 'tasks' then (select to_jsonb(x) from (select t.title, t.description, t.priority, t.status, t.review_stage, t.due_date, t.waiting_on,
        t.outcome, t.tags, t.brand, t.work_type, t.est_cost, t.actual_cost, t.campaign_id, t.vendor_id
      from public.tasks t where t.id = _id and t.deleted_at is null) x)
    when 'help' then (select to_jsonb(x) from (select h.what, h.for_whom, h.minutes, h.kind, h.on_date, h.brand, h.note
      from public.task_help_log h where h.id = _id and h.deleted_at is null) x)
    when 'subtasks' then (select to_jsonb(x) from (select c.title, c.completed_at is not null as done
      from public.task_checklist_items c where c.id = _id) x)
    when 'deliverables' then (select to_jsonb(x) from (select d.type, d.version, d.link, d.used_where
      from public.task_deliverables d where d.id = _id and d.deleted_at is null) x)
    when 'progress' then (select to_jsonb(x) from (select p.on_date, p.note, p.minutes
      from public.task_progress p where p.id = _id and p.deleted_at is null) x)
    when 'campaigns' then (select to_jsonb(x) from (select c.name, c.brand, c.launch_date, c.brief_link, c.notes, c.stage, c.priority,
        c.objective, c.next_action, c.milestone, c.milestone_date, c.blocker, c.decision, c.budget, c.brief, c.measure, c.results
      from public.creative_campaigns c where c.id = _id and c.deleted_at is null) x)
    when 'ideas' then (select to_jsonb(x) from (select i.text, i.brand, i.tags, i.links, i.status, i.revisit_date, i.revisit_when, i.concept
      from public.creative_ideas i where i.id = _id and i.deleted_at is null) x)
    when 'templates' then (select to_jsonb(x) from (select t.name, t.work_type, t.subtasks
      from public.creative_templates t where t.id = _id and t.deleted_at is null) x)
    when 'key_dates' then (select to_jsonb(x) from (select k.name, k.on_date, k.brand, k.lead_days, k.notes
      from public.creative_key_dates k where k.id = _id and k.deleted_at is null) x)
    when 'vendors' then (select to_jsonb(x) from (select v.name from public.creative_vendors v where v.id = _id and v.deleted_at is null) x)
    when 'brands' then (select to_jsonb(x) from (select b.name, b.foundation from public.creative_brands b where b.id = _id and b.deleted_at is null) x)
    when 'reminders' then (select to_jsonb(x) from (select r.text, r.due_at, r.repeat, r.done, r.work_task_id
      from public.ledger_reminders r where r.id = _id and r.deleted_at is null) x)
  end;
$$;

-- What to do with one Sheet row: 'new' (never imported, or imported and since erased), 'update'
-- (imported and untouched here), or 'keep' (changed or removed here, or linked to an existing row).
create or replace function app.work_import_state(_owner uuid, _kind text, _row integer, out state text, out target uuid)
language plpgsql stable security definer set search_path = pg_catalog, public, app as $$
declare _m app.work_import_map; _now jsonb;
begin
  select * into _m from app.work_import_map where owner_user = _owner and kind = _kind and legacy_row = _row;
  if _m.target_id is null then state := 'new'; return; end if;
  target := _m.target_id;
  _now := app.work_import_current(_kind, _m.target_id);
  if _now is null then
    -- Removed here (soft delete) stays removed; a row that no longer exists at all comes back.
    state := case when app.work_import_exists(_kind, _m.target_id) then 'keep' else 'new' end;
    if state = 'new' then target := null; end if;
  elsif _m.adopted or _now is distinct from _m.snapshot then state := 'keep';
  else state := 'update';
  end if;
end $$;

create or replace function app.work_import_exists(_kind text, _id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select case _kind
    when 'tasks' then exists (select 1 from public.tasks where id = _id)
    when 'help' then exists (select 1 from public.task_help_log where id = _id)
    when 'deliverables' then exists (select 1 from public.task_deliverables where id = _id)
    when 'progress' then exists (select 1 from public.task_progress where id = _id)
    when 'campaigns' then exists (select 1 from public.creative_campaigns where id = _id)
    when 'ideas' then exists (select 1 from public.creative_ideas where id = _id)
    when 'templates' then exists (select 1 from public.creative_templates where id = _id)
    when 'key_dates' then exists (select 1 from public.creative_key_dates where id = _id)
    when 'vendors' then exists (select 1 from public.creative_vendors where id = _id)
    when 'brands' then exists (select 1 from public.creative_brands where id = _id)
    when 'reminders' then exists (select 1 from public.ledger_reminders where id = _id)
    else false end;
$$;

create or replace function app.work_import_remember(_owner uuid, _kind text, _row integer, _target uuid, _adopted boolean default false)
returns void language sql security definer set search_path = pg_catalog, public, app as $$
  insert into app.work_import_map(owner_user, kind, legacy_row, target_id, snapshot, adopted, imported_at)
    values (_owner, _kind, _row, _target, app.work_import_current(_kind, _target), _adopted, clock_timestamp())
    on conflict (owner_user, kind, legacy_row) do update set target_id = excluded.target_id, snapshot = excluded.snapshot,
      adopted = excluded.adopted, imported_at = excluded.imported_at;
$$;

create or replace function app.work_import_target(_owner uuid, _kind text, _row integer)
returns uuid language sql stable security definer set search_path = pg_catalog, public, app as $$
  select target_id from app.work_import_map where owner_user = _owner and kind = _kind and legacy_row = _row;
$$;

-- A Sheet day as an India-time moment late in that day (when a task was delivered).
create or replace function app.work_import_evening(_day date)
returns timestamptz language sql immutable set search_path = pg_catalog as $$
  select case when _day is null then null else (_day::timestamp + interval '18 hours') at time zone 'Asia/Kolkata' end;
$$;

-- A shared campaign, vendor or brand by name: the existing one, or a new one.
create or replace function app.work_import_named(_kind text, _name text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _clean text := btrim(coalesce(_name, '')); _id uuid;
begin
  if _clean = '' then return null; end if;
  if _kind = 'campaign' then
    select id into _id from public.creative_campaigns where deleted_at is null and lower(name) = lower(_clean);
    if _id is null then insert into public.creative_campaigns(name, stage) values (left(_clean, 160), 'Captured') returning id into _id; end if;
  elsif _kind = 'vendor' then
    select id into _id from public.creative_vendors where deleted_at is null and lower(name) = lower(_clean);
    if _id is null then insert into public.creative_vendors(name) values (left(_clean, 160)) returning id into _id; end if;
  end if;
  return _id;
end $$;

create or replace function app.work_import_rows(_owner uuid, _emp uuid, _kind text, _rows jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare
  _r jsonb; _row integer; _s record; _id uuid; _task uuid; _today date := app.ledger_today();
  _inserted integer := 0; _updated integer := 0; _saved jsonb := '[]'; _kept jsonb := '[]'; _unresolved jsonb := '[]';
  _status text; _review text; _logged timestamptz; _day date; _done_day date; _minutes integer; _link text; _type text;
  _est numeric; _actual numeric; _completed timestamptz;
begin
  for _r in select value from jsonb_array_elements(coalesce(_rows, '[]')) loop
    _row := (_r->>'legacy_row')::integer;
    continue when _row is null;

    if _kind = 'brands' then
      continue when nullif(btrim(_r->>'brand'), '') is null;
      select id into _id from public.creative_brands where deleted_at is null and lower(name) = lower(btrim(_r->>'brand'));
      if _id is null then
        insert into public.creative_brands(name, sort_order, foundation)
          values (left(btrim(_r->>'brand'), 80), 100, jsonb_strip_nulls(jsonb_build_object('positioning', _r->>'positioning', 'audiences', _r->>'audiences',
            'tone', _r->>'tone', 'visual', _r->>'visual', 'offerings', _r->>'offerings', 'claims', _r->>'claims'))) returning id into _id;
        _inserted := _inserted + 1;
      elsif (select foundation = '{}'::jsonb from public.creative_brands where id = _id) then
        -- A brand with no notes yet takes the Sheet's; notes written here are never replaced.
        update public.creative_brands set foundation = jsonb_strip_nulls(jsonb_build_object('positioning', _r->>'positioning', 'audiences', _r->>'audiences',
          'tone', _r->>'tone', 'visual', _r->>'visual', 'offerings', _r->>'offerings', 'claims', _r->>'claims')) where id = _id;
        _updated := _updated + 1;
      else
        _kept := _kept || to_jsonb(_row); continue;
      end if;
      perform app.work_import_remember(_owner, 'brands', _row, _id, true);
      _saved := _saved || to_jsonb(_row);

    elsif _kind = 'vendors' then
      continue when nullif(btrim(_r->>'name'), '') is null;
      select id into _id from public.creative_vendors where deleted_at is null and lower(name) = lower(btrim(_r->>'name'));
      if _id is null then
        insert into public.creative_vendors(name, role, phone, email, rate, rating, notes, last_worked, legacy_row)
          values (left(btrim(_r->>'name'), 160), _r->>'role', _r->>'phone', _r->>'email', _r->>'rate',
            case when (_r->>'rating')::integer between 1 and 5 then (_r->>'rating')::integer end, _r->>'notes', (_r->>'last_worked')::date, _row)
          returning id into _id;
        _inserted := _inserted + 1;
        perform app.work_import_remember(_owner, 'vendors', _row, _id, false);
      else
        update public.creative_vendors set last_worked = greatest(last_worked, (_r->>'last_worked')::date) where id = _id;
        perform app.work_import_remember(_owner, 'vendors', _row, _id, true);
        _kept := _kept || to_jsonb(_row);
      end if;
      _saved := _saved || to_jsonb(_row);

    elsif _kind = 'templates' then
      continue when nullif(btrim(_r->>'name'), '') is null;
      select * into _s from app.work_import_state(_owner, 'templates', _row);
      if _s.state = 'keep' then _kept := _kept || to_jsonb(_row); continue; end if;
      if _s.state = 'new' then
        insert into public.creative_templates(name, work_type, subtasks, legacy_row)
          values (left(btrim(_r->>'name'), 160), _r->>'type', coalesce((select array_agg(left(x, 200)) from jsonb_array_elements_text(coalesce(_r->'subtasks', '[]')) x), '{}'), _row)
          returning id into _id;
        _inserted := _inserted + 1;
      else
        _id := _s.target;
        update public.creative_templates set name = left(btrim(_r->>'name'), 160), work_type = _r->>'type',
          subtasks = coalesce((select array_agg(left(x, 200)) from jsonb_array_elements_text(coalesce(_r->'subtasks', '[]')) x), '{}') where id = _id;
        _updated := _updated + 1;
      end if;
      perform app.work_import_remember(_owner, 'templates', _row, _id);
      _saved := _saved || to_jsonb(_row);

    elsif _kind = 'key_dates' then
      continue when nullif(btrim(_r->>'name'), '') is null or (_r->>'date') is null;
      select * into _s from app.work_import_state(_owner, 'key_dates', _row);
      if _s.state = 'keep' then _kept := _kept || to_jsonb(_row); continue; end if;
      if _s.state = 'new' then
        select id into _id from public.creative_key_dates where deleted_at is null and lower(name) = lower(btrim(_r->>'name')) and on_date = (_r->>'date')::date;
        if _id is not null then
          -- The festival calendar already has it.
          perform app.work_import_remember(_owner, 'key_dates', _row, _id, true);
          _kept := _kept || to_jsonb(_row); _saved := _saved || to_jsonb(_row); continue;
        end if;
        insert into public.creative_key_dates(name, on_date, brand, lead_days, notes, legacy_row)
          values (left(btrim(_r->>'name'), 160), (_r->>'date')::date, _r->>'brand',
            case when (_r->>'lead_days')::integer between 0 and 365 then (_r->>'lead_days')::integer end, _r->>'notes', _row)
          returning id into _id;
        _inserted := _inserted + 1;
      else
        _id := _s.target;
        update public.creative_key_dates set name = left(btrim(_r->>'name'), 160), on_date = (_r->>'date')::date, brand = _r->>'brand',
          lead_days = case when (_r->>'lead_days')::integer between 0 and 365 then (_r->>'lead_days')::integer end, notes = _r->>'notes' where id = _id;
        _updated := _updated + 1;
      end if;
      perform app.work_import_remember(_owner, 'key_dates', _row, _id);
      _saved := _saved || to_jsonb(_row);

    elsif _kind = 'campaigns' then
      continue when nullif(btrim(_r->>'name'), '') is null;
      select * into _s from app.work_import_state(_owner, 'campaigns', _row);
      if _s.state = 'keep' then _kept := _kept || to_jsonb(_row); continue; end if;
      if _s.state = 'new' then
        select id into _id from public.creative_campaigns where deleted_at is null and lower(name) = lower(btrim(_r->>'name'));
        if _id is not null then
          perform app.work_import_remember(_owner, 'campaigns', _row, _id, true);
          _kept := _kept || to_jsonb(_row); _saved := _saved || to_jsonb(_row); continue;
        end if;
        insert into public.creative_campaigns(name, brand, launch_date, brief_link, notes, created_at, stage, priority, objective, next_action,
            milestone, milestone_date, blocker, decision, budget, brief, measure, results, legacy_row)
          values (left(btrim(_r->>'name'), 160), _r->>'brand', (_r->>'launch_date')::date, _r->>'brief_link', _r->>'notes',
            coalesce(app.ledger_ist_timestamp(_r->>'created_at'), now()), coalesce(_r->>'stage', 'Captured'), coalesce(_r->>'priority', 'Medium'),
            _r->>'objective', _r->>'next_action', _r->>'milestone', (_r->>'milestone_date')::date, _r->>'blocker', _r->>'decision', _r->>'budget',
            coalesce(_r->'brief', '{}'), coalesce(_r->'measure', '{}'), coalesce(_r->'results', '{}'), _row)
          returning id into _id;
        insert into public.creative_campaign_log(campaign_id, at, actor_user, actor_name, text)
          select _id, coalesce(app.ledger_ist_timestamp(l->>'at'), now()), null, null, left(l->>'text', 2000)
          from jsonb_array_elements(coalesce(_r->'log', '[]')) l where nullif(btrim(l->>'text'), '') is not null;
        _inserted := _inserted + 1;
      else
        _id := _s.target;
        update public.creative_campaigns set name = left(btrim(_r->>'name'), 160), brand = _r->>'brand', launch_date = (_r->>'launch_date')::date,
          brief_link = _r->>'brief_link', notes = _r->>'notes', stage = coalesce(_r->>'stage', 'Captured'), priority = coalesce(_r->>'priority', 'Medium'),
          objective = _r->>'objective', next_action = _r->>'next_action', milestone = _r->>'milestone', milestone_date = (_r->>'milestone_date')::date,
          blocker = _r->>'blocker', decision = _r->>'decision', budget = _r->>'budget', brief = coalesce(_r->'brief', '{}'),
          measure = coalesce(_r->'measure', '{}'), results = coalesce(_r->'results', '{}') where id = _id;
        _updated := _updated + 1;
      end if;
      perform app.work_import_remember(_owner, 'campaigns', _row, _id);
      _saved := _saved || to_jsonb(_row);

    elsif _kind = 'tasks' then
      continue when nullif(btrim(_r->>'title'), '') is null;
      _logged := coalesce(app.ledger_ist_timestamp(_r->>'logged_at'), ((_r->>'work_date')::date)::timestamp at time zone 'Asia/Kolkata', now());
      _logged := least(_logged, now());
      _day := least(coalesce((_r->>'work_date')::date, app.ledger_ist_date(_logged)), _today);

      if _r->>'entry_kind' = 'support' then
        -- Help given to someone: the help log, never a task on a board.
        _minutes := case when (_r->>'minutes')::integer between 1 and 1440 then (_r->>'minutes')::integer end;
        select * into _s from app.work_import_state(_owner, 'help', _row);
        if _s.state = 'keep' then _kept := _kept || to_jsonb(_row); continue; end if;
        if _s.state = 'new' then
          insert into public.task_help_log(on_date, what, for_whom, minutes, kind, brand, note, created_at)
            values (_day, left(btrim(_r->>'title'), 500), left(_r->>'for_whom', 120), _minutes,
              case when lower(coalesce(_r->>'type', '')) like '%support%' then 'Team support' else 'Review / Feedback' end,
              _r->>'brand', _r->>'notes', _logged)
            returning id into _id;
          _inserted := _inserted + 1;
        else
          _id := _s.target;
          update public.task_help_log set on_date = _day, what = left(btrim(_r->>'title'), 500), for_whom = left(_r->>'for_whom', 120), minutes = _minutes,
            brand = _r->>'brand', note = _r->>'notes' where id = _id;
          _updated := _updated + 1;
        end if;
        perform app.work_import_remember(_owner, 'help', _row, _id);
        _saved := _saved || to_jsonb(_row);
        continue;
      end if;

      -- The Sheet's nine statuses → the task's status and review step.
      _status := case _r->>'status' when 'Brief' then 'To Do' when 'Delivered' then 'Done' when 'Blocked' then 'Blocked'
        when 'Cancelled' then 'Cancelled' else 'In Progress' end;
      _review := case when _r->>'status' in ('Internal Review','Awaiting Approval','Revisions','Approved') then _r->>'status' end;
      _done_day := case when _status = 'Done' then least(coalesce((_r->>'end_date')::date, (_r->>'last_updated')::date, _day), _today) end;
      -- (least/greatest skip nulls, so a blank stays blank only when checked first.)
      _completed := case when _done_day is not null then least(app.work_import_evening(_done_day), now()) end;
      _est := case when (_r->>'est_cost')::numeric >= 0 then (_r->>'est_cost')::numeric end;
      _actual := case when (_r->>'actual_cost')::numeric >= 0 then (_r->>'actual_cost')::numeric end;
      select * into _s from app.work_import_state(_owner, 'tasks', _row);
      if _s.state = 'keep' then _kept := _kept || to_jsonb(_row); continue; end if;
      if _s.state = 'new' then
        insert into public.tasks(employee_id, assigned_by, title, description, priority, status, review_stage, due_date, completed_at, created_at,
            revision, approved_version, status_since, waiting_on, outcome, tags, brand, work_type, est_cost, actual_cost, campaign_id, vendor_id)
          values (_emp, _emp, left(btrim(_r->>'title'), 500), _r->>'notes', coalesce(_r->>'priority', 'Medium'), _status, _review, (_r->>'deadline')::date,
            _completed, _logged, greatest(coalesce((_r->>'revision')::integer, 0), 0), left(_r->>'approved_version', 200),
            least(coalesce((_r->>'status_since')::date, (_r->>'last_updated')::date, _day), _today), left(_r->>'waiting_on', 200), left(_r->>'outcome', 1000),
            coalesce((select array_agg(distinct lower(btrim(x))) from jsonb_array_elements_text(coalesce(_r->'tags', '[]')) x where btrim(x) <> ''), '{}'),
            left(_r->>'brand', 80), left(_r->>'type', 120), _est, _actual,
            app.work_import_named('campaign', _r->>'campaign'), app.work_import_named('vendor', _r->>'vendor'))
          returning id into _id;
        insert into public.task_assignees(task_id, employee_id, added_by) values (_id, _emp, _emp) on conflict do nothing;
        insert into public.task_attachments(task_id, kind, label, url, added_by, added_user)
          select _id, 'link', left(coalesce(nullif(btrim(a->>'name'), ''), a->>'url'), 300), a->>'url', _emp, _owner
          from jsonb_array_elements(coalesce(_r->'attachments', '[]')) a where (a->>'url') ~* '^https?://';
        if coalesce((_r->>'pinned')::boolean, false) then
          insert into public.task_marks(task_id, pinned) values (_id, true) on conflict do nothing;
        end if;
        _inserted := _inserted + 1;
      else
        _id := _s.target;
        update public.tasks set title = left(btrim(_r->>'title'), 500), description = _r->>'notes', priority = coalesce(_r->>'priority', 'Medium'),
          status = _status, review_stage = _review, due_date = (_r->>'deadline')::date, completed_at = _completed,
          revision = greatest(coalesce((_r->>'revision')::integer, 0), 0), approved_version = left(_r->>'approved_version', 200),
          status_since = least(coalesce((_r->>'status_since')::date, (_r->>'last_updated')::date, _day), _today),
          waiting_on = left(_r->>'waiting_on', 200), outcome = left(_r->>'outcome', 1000),
          tags = coalesce((select array_agg(distinct lower(btrim(x))) from jsonb_array_elements_text(coalesce(_r->'tags', '[]')) x where btrim(x) <> ''), '{}'),
          brand = left(_r->>'brand', 80), work_type = left(_r->>'type', 120), est_cost = _est,
          actual_cost = _actual, campaign_id = app.work_import_named('campaign', _r->>'campaign'),
          vendor_id = app.work_import_named('vendor', _r->>'vendor')
          where id = _id;
        _updated := _updated + 1;
      end if;
      perform app.work_import_remember(_owner, 'tasks', _row, _id);
      _saved := _saved || to_jsonb(_row);

    elsif _kind in ('subtasks','deliverables','progress') then
      _task := app.work_import_target(_owner, 'tasks', coalesce(_r->>'parent_row', _r->>'task_row')::integer);
      if _task is null or not exists (select 1 from public.tasks where id = _task and deleted_at is null) then
        _unresolved := _unresolved || to_jsonb(_row); continue;
      end if;
      select * into _s from app.work_import_state(_owner, _kind, _row);
      if _s.state = 'keep' then _kept := _kept || to_jsonb(_row); continue; end if;
      if _kind = 'subtasks' then
        continue when nullif(btrim(_r->>'text'), '') is null;
        if _s.state = 'new' then
          insert into public.task_checklist_items(task_id, title, position, completed_by, completed_at, created_by, created_at)
            values (_task, left(btrim(_r->>'text'), 200), _row,
              case when coalesce((_r->>'done')::boolean, false) then _emp end,
              case when coalesce((_r->>'done')::boolean, false) then coalesce(app.ledger_ist_timestamp(_r->>'created_at'), now()) end,
              _emp, coalesce(app.ledger_ist_timestamp(_r->>'created_at'), now()))
            returning id into _id;
          _inserted := _inserted + 1;
        else
          _id := _s.target;
          update public.task_checklist_items set title = left(btrim(_r->>'text'), 200),
            completed_by = case when coalesce((_r->>'done')::boolean, false) then coalesce(completed_by, _emp) end,
            completed_at = case when coalesce((_r->>'done')::boolean, false) then coalesce(completed_at, now()) end where id = _id;
          _updated := _updated + 1;
        end if;
      elsif _kind = 'deliverables' then
        -- Only web links are links; anything else is kept as the deliverable's name.
        _link := case when (_r->>'link') ~* '^https?://' then left(btrim(_r->>'link'), 2000) end;
        _type := left(coalesce(nullif(btrim(_r->>'type'), ''), case when _link is null then nullif(btrim(_r->>'link'), '') end), 120);
        continue when _link is null and _type is null;
        if _s.state = 'new' then
          insert into public.task_deliverables(task_id, type, version, link, used_where, added_at)
            values (_task, _type, left(_r->>'version', 80), _link, left(_r->>'used_where', 200), coalesce(app.ledger_ist_timestamp(_r->>'added_at'), now()))
            returning id into _id;
          _inserted := _inserted + 1;
        else
          _id := _s.target;
          update public.task_deliverables set type = _type, version = left(_r->>'version', 80), link = _link, used_where = left(_r->>'used_where', 200) where id = _id;
          _updated := _updated + 1;
        end if;
      else
        continue when nullif(btrim(_r->>'note'), '') is null;
        _minutes := case when (_r->>'minutes')::integer between 1 and 1440 then (_r->>'minutes')::integer end;
        _day := least(coalesce((_r->>'date')::date, _today), _today);
        if _s.state = 'new' then
          insert into public.task_progress(task_id, on_date, note, minutes, created_at)
            values (_task, _day, left(btrim(_r->>'note'), 4000), _minutes, (_day::timestamp + interval '18 hours') at time zone 'Asia/Kolkata')
            returning id into _id;
          _inserted := _inserted + 1;
        else
          _id := _s.target;
          update public.task_progress set on_date = _day, note = left(btrim(_r->>'note'), 4000), minutes = _minutes where id = _id;
          _updated := _updated + 1;
        end if;
      end if;
      perform app.work_import_remember(_owner, _kind, _row, _id);
      _saved := _saved || to_jsonb(_row);

    elsif _kind = 'ideas' then
      continue when nullif(btrim(_r->>'text'), '') is null;
      select * into _s from app.work_import_state(_owner, 'ideas', _row);
      if _s.state = 'keep' then _kept := _kept || to_jsonb(_row); continue; end if;
      if _s.state = 'new' then
        insert into public.creative_ideas(text, original, brand, tags, links, status, created_at, revisit_date, revisit_when, concept, legacy_row)
          values (left(btrim(_r->>'text'), 4000), _r->>'original', left(_r->>'brand', 80),
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(_r->'tags', '[]')) x), '{}'), _r->>'links',
            coalesce(_r->>'status', 'Open'), coalesce(app.ledger_ist_timestamp(_r->>'created_at'), now()), (_r->>'revisit_date')::date,
            _r->>'revisit_when', coalesce(_r->'concept', '{}'), _row)
          returning id into _id;
        _inserted := _inserted + 1;
      else
        _id := _s.target;
        update public.creative_ideas set text = left(btrim(_r->>'text'), 4000), brand = left(_r->>'brand', 80),
          tags = coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(_r->'tags', '[]')) x), '{}'), links = _r->>'links',
          status = coalesce(_r->>'status', 'Open'), revisit_date = (_r->>'revisit_date')::date, revisit_when = _r->>'revisit_when',
          concept = coalesce(_r->'concept', '{}') where id = _id;
        _updated := _updated + 1;
      end if;
      perform app.work_import_remember(_owner, 'ideas', _row, _id);
      _saved := _saved || to_jsonb(_row);

    elsif _kind = 'reminders' then
      continue when nullif(btrim(_r->>'text'), '') is null or app.ledger_ist_timestamp(_r->>'due_at') is null;
      select * into _s from app.work_import_state(_owner, 'reminders', _row);
      if _s.state = 'keep' then _kept := _kept || to_jsonb(_row); continue; end if;
      if _s.state = 'new' then
        insert into public.ledger_reminders(owner_user, text, due_at, repeat, done, done_at, source, work_task_id, calendar_event_id,
            calendar_state, created_at, imported_at)
          values (_owner, left(btrim(_r->>'text'), 500), app.ledger_ist_timestamp(_r->>'due_at'), _r->>'repeat', coalesce((_r->>'done')::boolean, false),
            case when coalesce((_r->>'done')::boolean, false) then now() end, coalesce(_r->>'source', 'reminder'),
            app.work_import_target(_owner, 'tasks', (_r->>'task_row')::integer), nullif(btrim(_r->>'calendar_event_id'), ''),
            case when nullif(btrim(_r->>'calendar_event_id'), '') is not null then 'synced' else 'none' end,
            coalesce(app.ledger_ist_timestamp(_r->>'created_at'), now()), now())
          returning id into _id;
        _inserted := _inserted + 1;
      else
        _id := _s.target;
        update public.ledger_reminders set text = left(btrim(_r->>'text'), 500), due_at = app.ledger_ist_timestamp(_r->>'due_at'), repeat = _r->>'repeat',
          done = coalesce((_r->>'done')::boolean, false), work_task_id = app.work_import_target(_owner, 'tasks', (_r->>'task_row')::integer)
          where id = _id;
        _updated := _updated + 1;
      end if;
      perform app.work_import_remember(_owner, 'reminders', _row, _id);
      _saved := _saved || to_jsonb(_row);

    elsif _kind = 'links' then
      -- Second pass, once everything exists: what a task waits for, what ideas became, where campaigns came from.
      if _r->>'kind' = 'task_depends' then
        _id := app.work_import_target(_owner, 'tasks', _row);
        _task := app.work_import_target(_owner, 'tasks', (_r->>'depends_on_row')::integer);
        if _id is not null and _task is not null and _id <> _task then
          update public.tasks set depends_on_task_id = _task where id = _id and depends_on_task_id is null;
        end if;
      elsif _r->>'kind' = 'idea_refs' then
        _id := app.work_import_target(_owner, 'ideas', _row);
        if _id is not null then
          update public.creative_ideas set
            task_id = coalesce(task_id, app.work_import_target(_owner, 'tasks', (_r->>'task_row')::integer)),
            campaign_id = coalesce(campaign_id, app.work_import_target(_owner, 'campaigns', (_r->>'campaign_row')::integer))
          where id = _id;
        end if;
      elsif _r->>'kind' = 'campaign_ideas' then
        _id := app.work_import_target(_owner, 'campaigns', _row);
        if _id is not null then
          insert into public.creative_campaign_ideas(campaign_id, idea_id)
            select _id, app.work_import_target(_owner, 'ideas', x::integer) from jsonb_array_elements_text(coalesce(_r->'idea_rows', '[]')) x
            where app.work_import_target(_owner, 'ideas', x::integer) is not null
            on conflict do nothing;
        end if;
      end if;
      _saved := _saved || to_jsonb(_row);
    else
      raise exception using errcode = '22023', message = 'Unknown import kind.';
    end if;
  end loop;

  return jsonb_build_object('kind', _kind, 'received', jsonb_array_length(coalesce(_rows, '[]')), 'inserted', _inserted, 'updated', _updated,
    'saved_rows', _saved, 'kept_rows', _kept, 'unresolved_rows', _unresolved);
end $$;

-- One batch of rows of one kind. At most 300 rows, so each call is quick.
create or replace function public.work_import_batch(_kind text, _rows jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _emp uuid := app.current_employee_id();
begin
  if not app.session_is_active() or auth.uid() is null then raise exception using errcode = '42501', message = 'Sign in again.'; end if;
  if _emp is null then raise exception using errcode = '42501', message = 'The import is for staff with an employee record.'; end if;
  if not app.is_creative_member() then raise exception using errcode = '42501', message = 'The Sheet import is for the creative team.'; end if;
  if jsonb_typeof(_rows) is distinct from 'array' or jsonb_array_length(_rows) > 300 then
    raise exception using errcode = '22023', message = 'Send at most 300 rows at a time.';
  end if;
  if _kind not in ('brands','vendors','templates','key_dates','campaigns','tasks','subtasks','deliverables','progress','ideas','reminders','links') then
    raise exception using errcode = '22023', message = 'Unknown import kind.';
  end if;
  perform set_config('app.work_import', 'on', true);
  return app.work_import_rows(auth.uid(), _emp, _kind, _rows);
end $$;

-- Before importing: how many of these Sheet rows are already here, and which were changed here since.
create or replace function public.work_import_preview(_kind text, _legacy_rows integer[])
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, app as $$
declare _kinds text[] := case when _kind = 'tasks' then array['tasks','help'] else array[_kind] end;
begin
  if not app.is_creative_member() then raise exception using errcode = '42501', message = 'The Sheet import is for the creative team.'; end if;
  return (select jsonb_build_object('kind', _kind,
    'existing', count(*),
    'edited_rows', coalesce(jsonb_agg(m.legacy_row order by m.legacy_row) filter (where not m.adopted
      and app.work_import_current(m.kind, m.target_id) is distinct from m.snapshot), '[]'))
    from app.work_import_map m where m.owner_user = auth.uid() and m.kind = any(_kinds) and m.legacy_row = any(coalesce(_legacy_rows, '{}')));
end $$;

revoke all on function app.work_import_current(text,uuid), app.work_import_state(uuid,text,integer), app.work_import_exists(text,uuid),
  app.work_import_remember(uuid,text,integer,uuid,boolean), app.work_import_target(uuid,text,integer), app.work_import_evening(date),
  app.work_import_named(text,text), app.work_import_rows(uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.work_import_batch(text,jsonb), public.work_import_preview(text,integer[]) from public, anon;
grant execute on function public.work_import_batch(text,jsonb), public.work_import_preview(text,integer[]) to authenticated;

notify pgrst, 'reload schema';
commit;
