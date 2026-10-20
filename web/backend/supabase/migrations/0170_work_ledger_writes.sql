-- Work Ledger, stage 2: everyday writing, the Home screen in one call, attachments, reminders and the
-- Google Calendar handshake.
--
-- Every write is a SECURITY DEFINER RPC that takes the owner from the session (app.ledger_owner)
-- and never an owner argument, so a manager who can read a ledger can never change it. The rules
-- of the original app live here, once, for the screens and for the assistant alike:
--   * status_since moves only on a real status change; Revisions counts a revision; leaving Blocked
--     or Awaiting Approval clears "waiting on"; Approved records the latest deliverable version;
--   * every save appends a dated history line ("[7 Oct] note — Status: Brief → In Progress");
--   * marking done delivers the task and, for a repeating task, creates the next one exactly once;
--   * the first progress note moves a Brief task to In Progress;
--   * at most three tasks are in today's focus.
-- Deletes are soft. Google refresh tokens arrive already encrypted by the server and are stored in
-- `app`, out of every client's reach.
-- Idempotent: safe to re-run.
begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_day_label(_day date)
returns text language sql immutable set search_path = pg_catalog as $$
  select to_char(_day, 'FMDD Mon');
$$;

-- A date argument from a JSON object, with a sentence instead of a cast error.
create or replace function app.ledger_json_date(_u jsonb, _key text)
returns date language plpgsql immutable set search_path = pg_catalog as $$
begin
  if not (_u ? _key) or jsonb_typeof(_u->_key) = 'null' or btrim(_u->>_key) = '' then return null; end if;
  if (_u->>_key) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = '22023', message = format('%s must be a date like 2026-10-31.', initcap(replace(_key, '_', ' ')));
  end if;
  return (_u->>_key)::date;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode = '22023', message = format('%s is not a real date.', initcap(replace(_key, '_', ' ')));
end $$;

create or replace function app.ledger_json_text(_u jsonb, _key text, _max integer default 500)
returns text language plpgsql immutable set search_path = pg_catalog as $$
declare _value text;
begin
  if not (_u ? _key) or jsonb_typeof(_u->_key) = 'null' then return null; end if;
  _value := nullif(btrim(_u->>_key), '');
  if length(_value) > _max then
    raise exception using errcode = '22023', message = format('%s can be at most %s characters.', initcap(replace(_key, '_', ' ')), _max);
  end if;
  return _value;
end $$;

create or replace function app.ledger_json_number(_u jsonb, _key text)
returns numeric language plpgsql immutable set search_path = pg_catalog as $$
begin
  if not (_u ? _key) or jsonb_typeof(_u->_key) = 'null' or btrim(_u->>_key) = '' then return null; end if;
  return replace(replace(_u->>_key, ',', ''), '₹', '')::numeric;
exception when invalid_text_representation then
  raise exception using errcode = '22023', message = format('%s must be a number.', initcap(replace(_key, '_', ' ')));
end $$;

create or replace function app.ledger_json_tags(_u jsonb, _key text default 'tags')
returns text[] language sql immutable set search_path = pg_catalog as $$
  select case
    when not (_u ? _key) or jsonb_typeof(_u->_key) = 'null' then '{}'::text[]
    when jsonb_typeof(_u->_key) = 'array' then coalesce((select array_agg(distinct btrim(v)) from jsonb_array_elements_text(_u->_key) v where btrim(v) <> ''), '{}')
    else coalesce((select array_agg(distinct btrim(v)) from unnest(string_to_array(_u->>_key, ',')) v where btrim(v) <> ''), '{}')
  end;
$$;

create or replace function app.ledger_pick(_value text, _options text[], _label text)
returns text language plpgsql immutable set search_path = pg_catalog as $$
declare _match text;
begin
  if _value is null or btrim(_value) = '' then return null; end if;
  select o into _match from unnest(_options) o where lower(regexp_replace(o, '[^a-zA-Z]', '', 'g')) = lower(regexp_replace(_value, '[^a-zA-Z]', '', 'g'));
  if _match is null then
    raise exception using errcode = '22023', message = format('%s must be one of: %s.', _label, array_to_string(_options, ', '));
  end if;
  return _match;
end $$;

create or replace function app.ledger_statuses() returns text[] language sql immutable as $$
  select array['Brief','In Progress','Internal Review','Awaiting Approval','Revisions','Approved','Delivered','Blocked','Cancelled'];
$$;

create or replace function app.ledger_ensure_brand(_owner uuid, _brand text)
returns text language plpgsql security definer set search_path = pg_catalog as $$
declare _name text := coalesce(nullif(btrim(_brand), ''), 'General');
begin
  insert into public.ledger_brands(owner_user, name, sort_order) values (_owner, _name, 100)
  on conflict (owner_user, lower(name)) where deleted_at is null do nothing;
  return (select b.name from public.ledger_brands b where b.owner_user = _owner and lower(b.name) = lower(_name) and b.deleted_at is null);
end $$;

-- Typing a campaign name that does not exist yet creates it at Captured (ensureCampaign).
create or replace function app.ledger_ensure_campaign(_owner uuid, _name text, _brand text default null)
returns uuid language plpgsql security definer set search_path = pg_catalog as $$
declare _id uuid; _clean text := nullif(btrim(_name), '');
begin
  if _clean is null then return null; end if;
  select c.id into _id from public.ledger_campaigns c where c.owner_user = _owner and lower(c.name) = lower(_clean) and c.deleted_at is null;
  if _id is null then
    insert into public.ledger_campaigns(owner_user, name, brand, stage) values (_owner, _clean, _brand, 'Captured')
    on conflict (owner_user, lower(name)) where deleted_at is null do nothing returning id into _id;
    if _id is null then
      select c.id into _id from public.ledger_campaigns c where c.owner_user = _owner and lower(c.name) = lower(_clean) and c.deleted_at is null;
    else
      insert into public.ledger_campaign_log(owner_user, campaign_id, text) values (_owner, _id, 'Captured from a task');
    end if;
  end if;
  return _id;
end $$;

-- Naming a vendor on a task creates the vendor and stamps when they last worked with us.
create or replace function app.ledger_ensure_vendor(_owner uuid, _name text, _on date)
returns uuid language plpgsql security definer set search_path = pg_catalog as $$
declare _id uuid; _clean text := nullif(btrim(_name), '');
begin
  if _clean is null then return null; end if;
  insert into public.ledger_vendors(owner_user, name, last_worked) values (_owner, _clean, _on)
  on conflict (owner_user, lower(name)) where deleted_at is null do update
    set last_worked = greatest(ledger_vendors.last_worked, excluded.last_worked), updated_at = now()
  returning id into _id;
  return _id;
end $$;

create or replace function app.ledger_own_task(_owner uuid, _id uuid)
returns public.ledger_tasks language plpgsql security definer set search_path = pg_catalog as $$
declare _task public.ledger_tasks;
begin
  select * into _task from public.ledger_tasks where id = _id and owner_user = _owner and deleted_at is null for update;
  if _task.id is null then raise exception using errcode = 'P0002', message = 'Task not found.'; end if;
  return _task;
end $$;

-- clock_timestamp, not now(): lines written in one transaction keep the order they were written in.
create or replace function app.ledger_log(_owner uuid, _task uuid, _kind text, _text text, _changes jsonb default null)
returns void language sql security definer set search_path = pg_catalog as $$
  insert into public.ledger_task_log(owner_user, task_id, at, kind, text, changes) values (_owner, _task, clock_timestamp(), _kind, _text, _changes);
$$;

-- The task as the screens and the assistant see it. _detail adds the child lists and the notes text.
create or replace function app.ledger_task_json(_t public.ledger_tasks, _today date, _detail boolean default false)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object(
    'id', _t.id, 'title', _t.title, 'brand', _t.brand,
    'brand_label', coalesce((select coalesce(b.short_label, b.name) from public.ledger_brands b
      where b.owner_user = _t.owner_user and lower(b.name) = lower(_t.brand) and b.deleted_at is null), _t.brand),
    'status', _t.status, 'priority', _t.priority, 'deadline', _t.deadline, 'start_date', _t.start_date, 'end_date', _t.end_date,
    'last_updated', _t.last_updated, 'repeat', _t.repeat, 'pinned', _t.pinned, 'type', _t.type,
    'campaign_id', _t.campaign_id, 'campaign', (select c.name from public.ledger_campaigns c where c.id = _t.campaign_id),
    'tags', to_jsonb(_t.tags), 'revision', _t.revision, 'status_since', _t.status_since, 'waiting_on', _t.waiting_on,
    'focus_date', _t.focus_date, 'focused', _t.focus_date = _today, 'outcome', _t.outcome,
    'est_cost', _t.est_cost, 'actual_cost', _t.actual_cost,
    'vendor_id', _t.vendor_id, 'vendor', (select v.name from public.ledger_vendors v where v.id = _t.vendor_id),
    'brief', _t.brief, 'for_whom', _t.for_whom, 'minutes', _t.minutes, 'entry_kind', _t.entry_kind,
    'depends_on', _t.depends_on,
    'depends_on_title', (select d.title from public.ledger_tasks d where d.id = _t.depends_on),
    'depends_on_done', (select d.status = 'Delivered' from public.ledger_tasks d where d.id = _t.depends_on),
    'approved_version', _t.approved_version, 'logged_at', _t.logged_at, 'work_date', _t.work_date,
    'stale', _t.status not in ('Delivered','Cancelled') and coalesce(_t.status_since, _t.work_date) < _today - 7,
    'subtasks_total', (select count(*) from public.ledger_subtasks s where s.task_id = _t.id and s.deleted_at is null),
    'subtasks_done', (select count(*) from public.ledger_subtasks s where s.task_id = _t.id and s.deleted_at is null and s.done),
    'deliverables_count', (select count(*) from public.ledger_deliverables d where d.task_id = _t.id and d.deleted_at is null),
    'attachments_count', (select count(*) from public.ledger_attachments a where a.task_id = _t.id and a.deleted_at is null),
    'last_progress', (select jsonb_build_object('date', p.on_date, 'note', p.note) from public.ledger_progress p
      where p.task_id = _t.id and p.deleted_at is null order by p.on_date desc, p.created_at desc limit 1))
  || case when not _detail then '{}'::jsonb else jsonb_build_object(
    'subtasks', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'text', s.text, 'done', s.done) order by s.position, s.created_at, s.id)
      from public.ledger_subtasks s where s.task_id = _t.id and s.deleted_at is null), '[]'),
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'type', d.type, 'version', d.version, 'link', d.link,
      'used_where', d.used_where, 'added_at', d.added_at) order by d.added_at, d.id)
      from public.ledger_deliverables d where d.task_id = _t.id and d.deleted_at is null), '[]'),
    'progress', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'date', p.on_date, 'note', p.note, 'minutes', p.minutes)
      order by p.on_date desc, p.created_at desc) from public.ledger_progress p where p.task_id = _t.id and p.deleted_at is null), '[]'),
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'name', a.name, 'url', a.url,
      'storage_path', a.storage_path, 'size_bytes', a.size_bytes, 'content_type', a.content_type) order by a.created_at, a.id)
      from public.ledger_attachments a where a.task_id = _t.id and a.deleted_at is null), '[]'),
    'notes', (select string_agg(l.text, E'\n' order by l.kind <> 'imported', l.at, l.id) from public.ledger_task_log l where l.task_id = _t.id))
  end;
$$;

revoke all on function app.ledger_day_label(date), app.ledger_json_date(jsonb,text), app.ledger_json_text(jsonb,text,integer),
  app.ledger_json_number(jsonb,text), app.ledger_json_tags(jsonb,text), app.ledger_pick(text,text[],text), app.ledger_statuses(),
  app.ledger_ensure_brand(uuid,text), app.ledger_ensure_campaign(uuid,text,text), app.ledger_ensure_vendor(uuid,text,date),
  app.ledger_own_task(uuid,uuid), app.ledger_log(uuid,uuid,text,text,jsonb), app.ledger_task_json(public.ledger_tasks,date,boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Tasks
-- ---------------------------------------------------------------------------------------------
-- Delivers a task; for a repeating task creates the next occurrence exactly once.
create or replace function app.ledger_finish(_owner uuid, _task public.ledger_tasks, _outcome text, _today date)
returns public.ledger_tasks language plpgsql security definer set search_path = pg_catalog as $$
declare _done public.ledger_tasks; _child uuid;
begin
  update public.ledger_tasks set status = 'Delivered',
      status_since = case when status <> 'Delivered' then _today else status_since end,
      last_updated = _today, outcome = coalesce(nullif(btrim(_outcome), ''), outcome),
      focus_date = null, updated_at = now()
    where id = _task.id returning * into _done;
  if _task.status <> 'Delivered' then
    perform app.ledger_log(_owner, _task.id, 'change', '[' || app.ledger_day_label(_today) || '] Delivered'
      || coalesce(' — ' || nullif(btrim(_outcome), ''), '') || ' — Status: ' || _task.status || ' → Delivered',
      jsonb_build_object('status', jsonb_build_array(_task.status, 'Delivered')));
  end if;
  if _done.repeat is not null and _done.recurrence_child_id is null and _done.entry_kind is null then
    insert into public.ledger_tasks(owner_user, logged_at, work_date, brand, title, status, priority, deadline, repeat, pinned, type,
        campaign_id, tags, status_since, last_updated, est_cost, vendor_id, brief)
      values (_owner, now(), _today, _done.brand, _done.title, 'Brief', _done.priority,
        app.ledger_advance_date(coalesce(_done.deadline, _today), _done.repeat), _done.repeat, _done.pinned, _done.type,
        _done.campaign_id, _done.tags, _today, _today, _done.est_cost, _done.vendor_id, _done.brief)
      returning id into _child;
    insert into public.ledger_subtasks(owner_user, task_id, text, position)
      select _owner, _child, s.text, s.position from public.ledger_subtasks s where s.task_id = _done.id and s.deleted_at is null;
    update public.ledger_tasks set recurrence_child_id = _child where id = _done.id returning * into _done;
  end if;
  return _done;
end $$;
revoke all on function app.ledger_finish(uuid,public.ledger_tasks,text,date) from public, anon, authenticated, service_role;

-- webAddEntry. A client-made id makes a retried save harmless.
create or replace function public.ledger_add_task(_id uuid, _entry jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _task public.ledger_tasks; _brand text;
  _status text; _note text; _item jsonb; _position integer := 0;
begin
  if _id is null or _entry is null or jsonb_typeof(_entry) <> 'object' then
    raise exception using errcode = '22023', message = 'Send a task id and the task details.';
  end if;
  select * into _task from public.ledger_tasks where id = _id;
  if _task.id is not null then
    if _task.owner_user <> _owner then raise exception using errcode = '42501', message = 'That id is taken.'; end if;
    return app.ledger_task_json(_task, _today, true);
  end if;
  if coalesce(app.ledger_json_text(_entry, 'task', 500), app.ledger_json_text(_entry, 'title', 500)) is null then
    raise exception using errcode = '22023', message = 'A task needs a title.';
  end if;
  perform app.ledger_seed(_owner);
  _brand := app.ledger_ensure_brand(_owner, _entry->>'brand');
  _status := coalesce(app.ledger_pick(_entry->>'status', app.ledger_statuses(), 'Status'), 'Brief');
  if _status = 'Delivered' then _status := 'Brief'; end if;
  insert into public.ledger_tasks(id, owner_user, logged_at, work_date, brand, title, status, priority, deadline, start_date, end_date,
      repeat, pinned, type, campaign_id, tags, waiting_on, est_cost, actual_cost, vendor_id, brief, depends_on, source_idea_id,
      status_since, last_updated)
    values (_id, _owner, now(), coalesce(app.ledger_json_date(_entry, 'date'), _today), _brand,
      coalesce(app.ledger_json_text(_entry, 'task', 500), app.ledger_json_text(_entry, 'title', 500)),
      _status, coalesce(app.ledger_pick(_entry->>'priority', array['High','Medium','Low'], 'Priority'), 'Medium'),
      app.ledger_json_date(_entry, 'deadline'), app.ledger_json_date(_entry, 'start_date'), app.ledger_json_date(_entry, 'end_date'),
      app.ledger_pick(_entry->>'repeat', array['daily','weekly','weekdays','monthly'], 'Repeat'),
      coalesce((_entry->>'pinned')::boolean, false), app.ledger_json_text(_entry, 'type', 120),
      app.ledger_ensure_campaign(_owner, _entry->>'campaign', _brand), app.ledger_json_tags(_entry),
      app.ledger_json_text(_entry, 'waiting_on', 200), app.ledger_json_number(_entry, 'est_cost'), app.ledger_json_number(_entry, 'actual_cost'),
      app.ledger_ensure_vendor(_owner, _entry->>'vendor', _today),
      case when jsonb_typeof(_entry->'brief') = 'object' and _entry->'brief' <> '{}'::jsonb then _entry->'brief' end,
      (select d.id from public.ledger_tasks d where d.id = nullif(_entry->>'depends_on', '')::uuid and d.owner_user = _owner),
      nullif(_entry->>'idea_id', '')::uuid, _today, _today)
    returning * into _task;
  _note := app.ledger_json_text(_entry, 'notes', 4000);
  if _note is not null then perform app.ledger_log(_owner, _id, 'note', '[' || app.ledger_day_label(_today) || '] ' || _note); end if;
  for _item in select value from jsonb_array_elements(coalesce(_entry->'subtasks', '[]')) loop
    if nullif(btrim(_item #>> '{}'), '') is not null then
      insert into public.ledger_subtasks(owner_user, task_id, text, position) values (_owner, _id, left(btrim(_item #>> '{}'), 500), _position);
      _position := _position + 1;
    end if;
  end loop;
  for _item in select value from jsonb_array_elements(coalesce(_entry->'deliverables', '[]')) loop
    insert into public.ledger_deliverables(owner_user, task_id, type, version, link, used_where)
      values (_owner, _id, app.ledger_json_text(_item, 'type', 200), app.ledger_json_text(_item, 'version', 80),
        app.ledger_json_text(_item, 'link', 2000), app.ledger_json_text(_item, 'used_where', 200));
  end loop;
  for _item in select value from jsonb_array_elements(coalesce(_entry->'links', '[]')) loop
    if nullif(btrim(_item->>'url'), '') is not null then
      insert into public.ledger_attachments(owner_user, task_id, kind, name, url)
        values (_owner, _id, 'link', left(coalesce(nullif(btrim(_item->>'name'), ''), _item->>'url'), 300), left(_item->>'url', 2000))
        on conflict (task_id, url) where kind = 'link' and deleted_at is null do nothing;
      perform app.ledger_log(_owner, _id, 'attachment', '📎 ' || coalesce(nullif(btrim(_item->>'name'), ''), _item->>'url') || ' — ' || (_item->>'url'));
    end if;
  end loop;
  -- Turning an idea into a task marks the idea Promoted (webPromoteIdea).
  if _task.source_idea_id is not null then
    update public.ledger_ideas set status = 'Promoted', task_id = _id, updated_at = now()
      where id = _task.source_idea_id and owner_user = _owner and deleted_at is null;
  end if;
  return app.ledger_task_json(_task, _today, true);
end $$;

-- webLogSupport: the only way a support entry is written.
create or replace function public.ledger_log_support(_id uuid, _entry jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _task public.ledger_tasks; _day date; _note text;
begin
  if _id is null or _entry is null or jsonb_typeof(_entry) <> 'object' then
    raise exception using errcode = '22023', message = 'Send an id and what you did.';
  end if;
  select * into _task from public.ledger_tasks where id = _id;
  if _task.id is not null then
    if _task.owner_user <> _owner then raise exception using errcode = '42501', message = 'That id is taken.'; end if;
    return app.ledger_task_json(_task, _today);
  end if;
  if coalesce(app.ledger_json_text(_entry, 'what', 500), app.ledger_json_text(_entry, 'title', 500)) is null then
    raise exception using errcode = '22023', message = 'Say what you did.';
  end if;
  perform app.ledger_seed(_owner);
  _day := coalesce(app.ledger_json_date(_entry, 'date'), _today);
  insert into public.ledger_tasks(id, owner_user, logged_at, work_date, brand, title, status, priority, type, for_whom, minutes,
      entry_kind, status_since, last_updated)
    values (_id, _owner, now(), _day, app.ledger_ensure_brand(_owner, _entry->>'brand'),
      coalesce(app.ledger_json_text(_entry, 'what', 500), app.ledger_json_text(_entry, 'title', 500)), 'Delivered', 'Medium',
      coalesce(app.ledger_pick(_entry->>'type', array['Review / Feedback','Team support'], 'Type'), 'Review / Feedback'),
      app.ledger_json_text(_entry, 'for_whom', 120), (app.ledger_json_number(_entry, 'minutes'))::integer, 'support', _day, _day)
    returning * into _task;
  _note := app.ledger_json_text(_entry, 'note', 4000);
  if _note is not null then perform app.ledger_log(_owner, _id, 'note', '[' || app.ledger_day_label(_day) || '] ' || _note); end if;
  return app.ledger_task_json(_task, _today);
end $$;

-- webUpdateTask: a partial update — only keys present are written — with the status rules.
create or replace function app.ledger_apply_update(_owner uuid, _id uuid, _u jsonb, _today date)
returns public.ledger_tasks language plpgsql security definer set search_path = pg_catalog as $$
declare _old public.ledger_tasks; _new public.ledger_tasks; _status text; _changes jsonb := '{}'; _parts text[] := '{}';
  _note text; _label text; _key text; _approved text; _link jsonb;
  _tracked text[][] := array[['title','Task'],['brand','Brand'],['status','Status'],['priority','Priority'],['deadline','Deadline'],
    ['campaign','Campaign'],['waiting_on','Waiting on'],['outcome','Outcome'],['repeat','Repeat'],['type','Type'],['vendor','Vendor']];
  _before jsonb; _after jsonb;
begin
  if _u is null or jsonb_typeof(_u) <> 'object' then raise exception using errcode = '22023', message = 'Send the fields to change.'; end if;
  if exists(select 1 from jsonb_object_keys(_u) k where k not in ('title','task','brand','status','priority','deadline','start_date','end_date',
      'repeat','pinned','type','campaign','tags','waiting_on','outcome','est_cost','actual_cost','vendor','brief','depends_on','note','links')) then
    raise exception using errcode = '22023', message = 'One of the fields cannot be changed here.';
  end if;
  _old := app.ledger_own_task(_owner, _id);
  if _old.entry_kind = 'support' and (_u ? 'status') then
    raise exception using errcode = '22023', message = 'A help entry has no workflow status.';
  end if;
  _status := coalesce(app.ledger_pick(_u->>'status', app.ledger_statuses(), 'Status'), _old.status);
  if _u ? 'task' and not (_u ? 'title') then _u := _u || jsonb_build_object('title', _u->'task'); end if;
  if (_u ? 'title') and app.ledger_json_text(_u, 'title', 500) is null then
    raise exception using errcode = '22023', message = 'A task needs a title.';
  end if;
  if _status = 'Approved' and _old.status <> 'Approved' then
    select coalesce(nullif(btrim(d.version), ''), nullif(btrim(d.type), '')) into _approved from public.ledger_deliverables d
      where d.task_id = _id and d.deleted_at is null order by d.added_at desc, d.id desc limit 1;
  end if;
  update public.ledger_tasks t set
      title = case when _u ? 'title' then app.ledger_json_text(_u, 'title', 500) else t.title end,
      brand = case when _u ? 'brand' then app.ledger_ensure_brand(_owner, _u->>'brand') else t.brand end,
      -- Delivered goes through ledger_finish below so the repeat rule applies.
      status = case when _status = 'Delivered' then t.status else _status end,
      status_since = case when _status <> t.status and _status <> 'Delivered' then _today else t.status_since end,
      revision = t.revision + case when _status = 'Revisions' and t.status <> 'Revisions' then 1 else 0 end,
      waiting_on = case when _u ? 'waiting_on' then app.ledger_json_text(_u, 'waiting_on', 200)
        when _status <> t.status and _status not in ('Blocked','Awaiting Approval') then null else t.waiting_on end,
      approved_version = case when _status = 'Approved' and t.status <> 'Approved' then coalesce(_approved, 'Work as reviewed') else t.approved_version end,
      priority = coalesce(app.ledger_pick(_u->>'priority', array['High','Medium','Low'], 'Priority'), t.priority),
      deadline = case when _u ? 'deadline' then app.ledger_json_date(_u, 'deadline') else t.deadline end,
      start_date = case when _u ? 'start_date' then app.ledger_json_date(_u, 'start_date') else t.start_date end,
      end_date = case when _u ? 'end_date' then app.ledger_json_date(_u, 'end_date') else t.end_date end,
      repeat = case when _u ? 'repeat' then app.ledger_pick(_u->>'repeat', array['daily','weekly','weekdays','monthly'], 'Repeat') else t.repeat end,
      pinned = case when _u ? 'pinned' then coalesce((_u->>'pinned')::boolean, false) else t.pinned end,
      type = case when _u ? 'type' then app.ledger_json_text(_u, 'type', 120) else t.type end,
      campaign_id = case when _u ? 'campaign' then app.ledger_ensure_campaign(_owner, _u->>'campaign', t.brand) else t.campaign_id end,
      tags = case when _u ? 'tags' then app.ledger_json_tags(_u) else t.tags end,
      outcome = case when _u ? 'outcome' then app.ledger_json_text(_u, 'outcome', 1000) else t.outcome end,
      est_cost = case when _u ? 'est_cost' then app.ledger_json_number(_u, 'est_cost') else t.est_cost end,
      actual_cost = case when _u ? 'actual_cost' then app.ledger_json_number(_u, 'actual_cost') else t.actual_cost end,
      vendor_id = case when _u ? 'vendor' then app.ledger_ensure_vendor(_owner, _u->>'vendor', _today) else t.vendor_id end,
      brief = case when _u ? 'brief' then case when jsonb_typeof(_u->'brief') = 'object' and _u->'brief' <> '{}'::jsonb then _u->'brief' end else t.brief end,
      depends_on = case when _u ? 'depends_on' then (select d.id from public.ledger_tasks d
        where d.id = nullif(_u->>'depends_on', '')::uuid and d.owner_user = _owner and d.id <> t.id) else t.depends_on end,
      last_updated = _today, updated_at = now()
    where t.id = _id returning * into _new;
  -- The history line: "[7 Oct] note — Priority: Medium → High — Status: Brief → In Progress".
  _before := app.ledger_task_json(_old, _today); _after := app.ledger_task_json(_new, _today);
  if _status = 'Delivered' and _old.status <> 'Delivered' then _after := jsonb_set(_after, '{status}', '"Delivered"'); end if;
  for i in 1 .. array_length(_tracked, 1) loop
    _key := _tracked[i][1]; _label := _tracked[i][2];
    if (_before->>_key) is distinct from (_after->>_key) and not (_key = 'status' and _status = 'Delivered') then
      _parts := _parts || (_label || ': ' || coalesce(_before->>_key, '—') || ' → ' || coalesce(_after->>_key, '—'));
      _changes := _changes || jsonb_build_object(_key, jsonb_build_array(_before->_key, _after->_key));
    end if;
  end loop;
  _note := app.ledger_json_text(_u, 'note', 4000);
  if _note is not null or cardinality(_parts) > 0 then
    perform app.ledger_log(_owner, _id, case when _note is not null then 'note' else 'change' end,
      '[' || app.ledger_day_label(_today) || '] ' || concat_ws(' — ', _note, nullif(array_to_string(_parts, ' — '), '')), _changes);
  end if;
  for _link in select value from jsonb_array_elements(coalesce(_u->'links', '[]')) loop
    if nullif(btrim(_link->>'url'), '') is not null then
      insert into public.ledger_attachments(owner_user, task_id, kind, name, url)
        values (_owner, _id, 'link', left(coalesce(nullif(btrim(_link->>'name'), ''), _link->>'url'), 300), left(_link->>'url', 2000))
        on conflict (task_id, url) where kind = 'link' and deleted_at is null do nothing;
      perform app.ledger_log(_owner, _id, 'attachment', '📎 ' || coalesce(nullif(btrim(_link->>'name'), ''), _link->>'url') || ' — ' || (_link->>'url'));
    end if;
  end loop;
  if _status = 'Delivered' and _old.status <> 'Delivered' then
    _new := app.ledger_finish(_owner, _new, app.ledger_json_text(_u, 'outcome', 1000), _today);
  end if;
  return _new;
end $$;
revoke all on function app.ledger_apply_update(uuid,uuid,jsonb,date) from public, anon, authenticated, service_role;

-- The reads below run as their own statements: a stable function inside the same statement as the
-- write would read the snapshot from before it and miss the new history line.
create or replace function public.ledger_update_task(_id uuid, _updates jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _task public.ledger_tasks;
begin
  _task := app.ledger_apply_update(_owner, _id, _updates, _today);
  return app.ledger_task_json(_task, _today, true);
end $$;

create or replace function public.ledger_mark_done(_id uuid, _outcome text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _task public.ledger_tasks;
begin
  _task := app.ledger_own_task(_owner, _id);
  if _task.entry_kind = 'support' then raise exception using errcode = '22023', message = 'A help entry is already done.'; end if;
  if length(_outcome) > 1000 then raise exception using errcode = '22023', message = 'Outcome can be at most 1000 characters.'; end if;
  _task := app.ledger_finish(_owner, _task, _outcome, _today);
  return app.ledger_task_json(_task, _today, true);
end $$;

create or replace function public.ledger_cancel_task(_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _task public.ledger_tasks;
begin
  _task := app.ledger_apply_update(_owner, _id, '{"status":"Cancelled"}', _today);
  return app.ledger_task_json(_task, _today, true);
end $$;

-- Soft delete: the record stays so nothing that refers to it breaks.
create or replace function public.ledger_delete_task(_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  perform app.ledger_own_task(_owner, _id);
  update public.ledger_tasks set deleted_at = now(), focus_date = null, updated_at = now() where id = _id;
end $$;

create or replace function public.ledger_bulk_mark_done(_ids uuid[])
returns integer language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _id uuid; _count integer := 0;
begin
  if cardinality(_ids) > 200 then raise exception using errcode = '22023', message = 'Choose at most 200 tasks at a time.'; end if;
  foreach _id in array coalesce(_ids, '{}') loop
    perform app.ledger_finish(_owner, app.ledger_own_task(_owner, _id), null, _today);
    _count := _count + 1;
  end loop;
  return _count;
end $$;

create or replace function public.ledger_bulk_update(_ids uuid[], _updates jsonb)
returns integer language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _id uuid; _count integer := 0;
begin
  if cardinality(_ids) > 200 then raise exception using errcode = '22023', message = 'Choose at most 200 tasks at a time.'; end if;
  if _updates is null or exists(select 1 from jsonb_object_keys(_updates) k where k not in ('status','priority','deadline')) then
    raise exception using errcode = '22023', message = 'Bulk changes cover status, priority and deadline.';
  end if;
  foreach _id in array coalesce(_ids, '{}') loop
    perform app.ledger_apply_update(_owner, _id, _updates, _today);
    _count := _count + 1;
  end loop;
  return _count;
end $$;

create or replace function public.ledger_set_focus(_id uuid, _on boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _task public.ledger_tasks;
begin
  _task := app.ledger_own_task(_owner, _id);
  if coalesce(_on, false) and _task.focus_date is distinct from _today and (select count(*) from public.ledger_tasks t
      where t.owner_user = _owner and t.deleted_at is null and t.focus_date = _today and t.id <> _id) >= 3 then
    raise exception using errcode = '22023', message = 'Today''s focus already has 3 tasks. Remove one first.';
  end if;
  update public.ledger_tasks set focus_date = case when coalesce(_on, false) then _today end, updated_at = now()
    where id = _id returning * into _task;
  return app.ledger_task_json(_task, _today);
end $$;

create or replace function public.ledger_set_pin(_id uuid, _pinned boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _task public.ledger_tasks;
begin
  perform app.ledger_own_task(_owner, _id);
  update public.ledger_tasks set pinned = coalesce(_pinned, false), updated_at = now() where id = _id returning * into _task;
  return app.ledger_task_json(_task, _today);
end $$;

-- Subtasks, deliverables, progress -----------------------------------------------------------
create or replace function public.ledger_add_subtask(_id uuid, _task uuid, _text text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  perform app.ledger_own_task(_owner, _task);
  if length(btrim(coalesce(_text, ''))) not between 1 and 500 then raise exception using errcode = '22023', message = 'A subtask needs 1 to 500 characters.'; end if;
  insert into public.ledger_subtasks(id, owner_user, task_id, text, position)
    values (_id, _owner, _task, btrim(_text), coalesce((select max(position) + 1 from public.ledger_subtasks where task_id = _task), 0))
    on conflict (id) do nothing;
  update public.ledger_tasks set last_updated = app.ledger_today(), updated_at = now() where id = _task;
  return jsonb_build_object('id', _id, 'text', btrim(_text), 'done', false);
end $$;

create or replace function public.ledger_set_subtask(_id uuid, _done boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _row public.ledger_subtasks;
begin
  update public.ledger_subtasks set done = coalesce(_done, false), updated_at = now()
    where id = _id and owner_user = _owner and deleted_at is null returning * into _row;
  if _row.id is null then raise exception using errcode = 'P0002', message = 'Subtask not found.'; end if;
  update public.ledger_tasks set last_updated = app.ledger_today(), updated_at = now() where id = _row.task_id;
  return jsonb_build_object('id', _row.id, 'text', _row.text, 'done', _row.done);
end $$;

create or replace function public.ledger_delete_subtask(_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  update public.ledger_subtasks set deleted_at = now(), updated_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Subtask not found.'; end if;
end $$;

create or replace function public.ledger_add_deliverable(_id uuid, _task uuid, _d jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  perform app.ledger_own_task(_owner, _task);
  if coalesce(app.ledger_json_text(_d, 'type', 200), app.ledger_json_text(_d, 'link', 2000)) is null then
    raise exception using errcode = '22023', message = 'A deliverable needs a type or a link.';
  end if;
  insert into public.ledger_deliverables(id, owner_user, task_id, type, version, link, used_where)
    values (_id, _owner, _task, app.ledger_json_text(_d, 'type', 200), app.ledger_json_text(_d, 'version', 80),
      app.ledger_json_text(_d, 'link', 2000), app.ledger_json_text(_d, 'used_where', 200))
    on conflict (id) do nothing;
  update public.ledger_tasks set last_updated = app.ledger_today(), updated_at = now() where id = _task;
  return (select jsonb_build_object('id', d.id, 'type', d.type, 'version', d.version, 'link', d.link, 'used_where', d.used_where, 'added_at', d.added_at)
    from public.ledger_deliverables d where d.id = _id);
end $$;

create or replace function public.ledger_delete_deliverable(_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  update public.ledger_deliverables set deleted_at = now(), updated_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Deliverable not found.'; end if;
end $$;

-- webLogProgress: touches the task on that day; the first note moves a Brief task to In Progress.
create or replace function public.ledger_log_progress(_id uuid, _task uuid, _note text, _minutes integer default null, _date date default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today(); _row public.ledger_tasks; _day date := coalesce(_date, _today);
begin
  _row := app.ledger_own_task(_owner, _task);
  if length(btrim(coalesce(_note, ''))) not between 1 and 4000 then raise exception using errcode = '22023', message = 'Write what you did (up to 4000 characters).'; end if;
  if _minutes is not null and _minutes not between 0 and 1440 then raise exception using errcode = '22023', message = 'Minutes must be between 0 and 1440.'; end if;
  if _day > _today then raise exception using errcode = '22023', message = 'Progress cannot be logged for a future day.'; end if;
  insert into public.ledger_progress(id, owner_user, task_id, on_date, note, minutes) values (_id, _owner, _task, _day, btrim(_note), _minutes)
    on conflict (id) do nothing;
  update public.ledger_tasks t set last_updated = greatest(coalesce(t.last_updated, _day), _day),
      status = case when t.status = 'Brief' then 'In Progress' else t.status end,
      status_since = case when t.status = 'Brief' then _day else t.status_since end,
      updated_at = now()
    where t.id = _task returning * into _row;
  return app.ledger_task_json(_row, _today, true);
end $$;

create or replace function public.ledger_delete_progress(_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  update public.ledger_progress set deleted_at = now(), updated_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Progress note not found.'; end if;
end $$;

-- Attachments ----------------------------------------------------------------------------------
create or replace function public.ledger_add_link(_id uuid, _task uuid, _name text, _url text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _label text := coalesce(nullif(btrim(_name), ''), btrim(_url));
begin
  perform app.ledger_own_task(_owner, _task);
  if coalesce(btrim(_url), '') !~* '^https?://\S+$' or length(_url) > 2000 then
    raise exception using errcode = '22023', message = 'A link must start with http:// or https://.';
  end if;
  insert into public.ledger_attachments(id, owner_user, task_id, kind, name, url) values (_id, _owner, _task, 'link', left(_label, 300), btrim(_url))
    on conflict do nothing;
  perform app.ledger_log(_owner, _task, 'attachment', '📎 ' || _label || ' — ' || btrim(_url));
  update public.ledger_tasks set last_updated = app.ledger_today(), updated_at = now() where id = _task;
  return jsonb_build_object('id', _id, 'kind', 'link', 'name', left(_label, 300), 'url', btrim(_url));
end $$;

-- Called after the browser has uploaded the file to <owner>/<task>/<id>-<name> in ledger-files.
create or replace function public.ledger_add_file(_id uuid, _task uuid, _name text, _path text, _size bigint, _type text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  perform app.ledger_own_task(_owner, _task);
  if _path is null or _path not like (_owner::text || '/' || _task::text || '/' || _id::text || '-%') then
    raise exception using errcode = '22023', message = 'The file is not in this task''s folder.';
  end if;
  if _size is not null and _size > 52428800 then raise exception using errcode = '22023', message = 'Files can be at most 50 MB.'; end if;
  insert into public.ledger_attachments(id, owner_user, task_id, kind, name, storage_path, size_bytes, content_type)
    values (_id, _owner, _task, 'file', left(coalesce(nullif(btrim(_name), ''), 'file'), 300), _path, _size, left(_type, 200))
    on conflict (id) do nothing;
  perform app.ledger_log(_owner, _task, 'attachment', '📎 ' || coalesce(nullif(btrim(_name), ''), 'file') || ' — file');
  update public.ledger_tasks set last_updated = app.ledger_today(), updated_at = now() where id = _task;
  return jsonb_build_object('id', _id, 'kind', 'file', 'name', _name, 'storage_path', _path, 'size_bytes', _size, 'content_type', _type);
end $$;

create or replace function public.ledger_remove_attachment(_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  update public.ledger_attachments set deleted_at = now() where id = _id and owner_user = _owner and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Attachment not found.'; end if;
end $$;

-- 50 MB files in a private bucket under <owner>/<task>/. Readable wherever the attachment row is.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ledger-files', 'ledger-files', false, 52428800, array['image/*','video/*','audio/*','application/pdf','text/plain','text/csv',
  'application/zip','application/postscript','application/illustrator','image/vnd.adobe.photoshop','application/octet-stream',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types, public = false;

create or replace function public.ledger_file_visible(_path text)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select exists(select 1 from public.ledger_attachments a where a.storage_path = _path and a.deleted_at is null and app.ledger_can_read(a.owner_user));
$$;
create or replace function public.ledger_file_uploadable(_path text)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select auth.uid() is not null and (storage.foldername(_path))[1] = auth.uid()::text
    and exists(select 1 from public.ledger_tasks t where t.id::text = (storage.foldername(_path))[2] and t.owner_user = auth.uid() and t.deleted_at is null);
$$;
revoke all on function public.ledger_file_visible(text), public.ledger_file_uploadable(text) from public, anon, service_role;
grant execute on function public.ledger_file_visible(text), public.ledger_file_uploadable(text) to authenticated;

drop policy if exists ledger_files_read on storage.objects;
drop policy if exists ledger_files_insert on storage.objects;
drop policy if exists ledger_files_delete on storage.objects;
create policy ledger_files_read on storage.objects for select to authenticated
  using (bucket_id = 'ledger-files' and public.ledger_file_visible(name));
create policy ledger_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'ledger-files' and public.ledger_file_uploadable(name));
-- Only an upload that never got its attachment row (a failed save) may be cleaned up.
create policy ledger_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'ledger-files' and (storage.foldername(name))[1] = auth.uid()::text
    and not exists(select 1 from public.ledger_attachments a where a.storage_path = name));

-- ---------------------------------------------------------------------------------------------
-- 3. Reminders and the Google Calendar connection
-- ---------------------------------------------------------------------------------------------
create table if not exists app.ledger_google (
  owner_user uuid primary key references auth.users(id) on delete cascade,
  google_email text,
  client_kind text not null default 'workspace' check (client_kind in ('workspace','external')),
  refresh_ct text,
  status text not null default 'connected' check (status in ('connected','needs_reconnect','disconnected')),
  connected_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists app.ledger_google_pending (
  nonce_hash text primary key,
  owner_user uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table app.ledger_google enable row level security;
alter table app.ledger_google_pending enable row level security;
revoke all on app.ledger_google, app.ledger_google_pending from public, anon, authenticated, service_role;

create or replace function app.ledger_calendar_connected(_owner uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select exists(select 1 from app.ledger_google g where g.owner_user = _owner and g.status = 'connected' and g.refresh_ct is not null);
$$;
revoke all on function app.ledger_calendar_connected(uuid) from public, anon, authenticated, service_role;

create or replace function app.ledger_reminder_json(_r public.ledger_reminders)
returns jsonb language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object('id', _r.id, 'text', _r.text, 'due_at', to_char(_r.due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI'),
    'repeat', _r.repeat, 'done', _r.done, 'source', _r.source, 'task_id', _r.task_id,
    'task_title', (select t.title from public.ledger_tasks t where t.id = _r.task_id),
    'overdue', not _r.done and _r.due_at < now(), 'calendar_state', _r.calendar_state);
$$;
revoke all on function app.ledger_reminder_json(public.ledger_reminders) from public, anon, authenticated, service_role;

-- A weekday reminder that falls on a weekend moves to Monday.
create or replace function app.ledger_reminder_due(_due timestamptz, _repeat text)
returns timestamptz language sql immutable set search_path = pg_catalog as $$
  select case when _repeat = 'weekdays' and extract(isodow from _due at time zone 'Asia/Kolkata') in (6, 7)
    then _due + make_interval(days => 8 - extract(isodow from _due at time zone 'Asia/Kolkata')::integer) else _due end;
$$;

create or replace function public.ledger_add_reminder(_id uuid, _r jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _row public.ledger_reminders; _repeat text; _due timestamptz; _connected boolean;
begin
  if _id is null or _r is null or jsonb_typeof(_r) <> 'object' then raise exception using errcode = '22023', message = 'Send an id and the reminder.'; end if;
  select * into _row from public.ledger_reminders where id = _id;
  if _row.id is not null then
    if _row.owner_user <> _owner then raise exception using errcode = '42501', message = 'That id is taken.'; end if;
    return jsonb_build_object('reminder', app.ledger_reminder_json(_row), 'calendar', app.ledger_calendar_connected(_owner));
  end if;
  if (_r->>'due_at') is null or (_r->>'due_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then
    raise exception using errcode = '22023', message = 'A reminder needs a time like 2026-10-08T10:00.';
  end if;
  _repeat := app.ledger_pick(_r->>'repeat', array['daily','weekly','weekdays','monthly'], 'Repeat');
  _due := app.ledger_reminder_due(app.ledger_ist_timestamp(_r->>'due_at'), _repeat);
  _connected := app.ledger_calendar_connected(_owner);
  insert into public.ledger_reminders(id, owner_user, text, due_at, repeat, source, task_id, calendar_state)
    values (_id, _owner, coalesce(app.ledger_json_text(_r, 'text', 500), 'Reminder'), _due, _repeat,
      coalesce(app.ledger_pick(_r->>'source', array['reminder','followup'], 'Source'), 'reminder'),
      (select t.id from public.ledger_tasks t where t.id = nullif(_r->>'task_id', '')::uuid and t.owner_user = _owner),
      case when _connected then 'pending' else 'none' end)
    returning * into _row;
  return jsonb_build_object('reminder', app.ledger_reminder_json(_row), 'calendar', _connected);
end $$;

create or replace function public.ledger_add_follow_up(_id uuid, _task uuid, _text text, _due_at text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
begin
  return public.ledger_add_reminder(_id, jsonb_build_object('text', _text, 'due_at', _due_at, 'source', 'followup', 'task_id', _task));
end $$;

-- Completing a one-off reminder finishes it (and its calendar event); a repeating one moves to its
-- next occurrence and the calendar series carries on.
create or replace function public.ledger_complete_reminder(_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _row public.ledger_reminders; _local timestamp;
begin
  select * into _row from public.ledger_reminders where id = _id and owner_user = _owner and deleted_at is null for update;
  if _row.id is null then raise exception using errcode = 'P0002', message = 'Reminder not found.'; end if;
  if _row.repeat is null then
    update public.ledger_reminders set done = true, done_at = now(), updated_at = now(),
        calendar_state = case when calendar_event_id is not null and app.ledger_calendar_connected(_owner) then 'pending' else calendar_state end
      where id = _id returning * into _row;
  else
    _local := _row.due_at at time zone 'Asia/Kolkata';
    update public.ledger_reminders set due_at = app.ledger_reminder_due(
        (app.ledger_advance_date(_local::date, _row.repeat) + _local::time) at time zone 'Asia/Kolkata', _row.repeat), updated_at = now()
      where id = _id returning * into _row;
  end if;
  return app.ledger_reminder_json(_row);
end $$;

create or replace function public.ledger_snooze_reminder(_id uuid, _due_at text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _row public.ledger_reminders;
begin
  select * into _row from public.ledger_reminders where id = _id and owner_user = _owner and deleted_at is null and not done for update;
  if _row.id is null then raise exception using errcode = 'P0002', message = 'Reminder not found.'; end if;
  if _row.repeat is not null then raise exception using errcode = '22023', message = 'Snooze works on one-off reminders. Mark this one done for today instead.'; end if;
  if coalesce(_due_at, '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then
    raise exception using errcode = '22023', message = 'Snooze needs a time like 2026-10-08T10:00.';
  end if;
  update public.ledger_reminders set due_at = app.ledger_ist_timestamp(_due_at), updated_at = now(),
      calendar_state = case when app.ledger_calendar_connected(_owner) then 'pending' else calendar_state end
    where id = _id returning * into _row;
  return app.ledger_reminder_json(_row);
end $$;

create or replace function public.ledger_delete_reminder(_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  update public.ledger_reminders set deleted_at = now(), updated_at = now(),
      calendar_state = case when calendar_event_id is not null and app.ledger_calendar_connected(_owner) then 'pending' else calendar_state end
    where id = _id and owner_user = _owner and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Reminder not found.'; end if;
end $$;

create or replace function public.ledger_reminders(_include_done boolean default false)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(app.ledger_reminder_json(r) order by r.done, r.due_at, r.id), '[]')
  from public.ledger_reminders r
  where r.owner_user = app.ledger_owner() and r.deleted_at is null and (coalesce(_include_done, false) or not r.done);
$$;

-- What the server must still do in Google Calendar for this person.
create or replace function app.ledger_outbox(_owner uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'text', r.text,
      'due_at', to_char(r.due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI'), 'repeat', r.repeat, 'event_id', r.calendar_event_id,
      'op', case when r.deleted_at is not null or (r.done and r.repeat is null) then 'delete'
        when r.calendar_event_id is null then 'insert' else 'patch' end) order by r.updated_at, r.id), '[]')
  from (select * from public.ledger_reminders r where r.owner_user = _owner and r.calendar_state = 'pending'
    and not ((r.deleted_at is not null or r.done) and r.calendar_event_id is null) order by r.updated_at limit 50) r;
$$;
create or replace function app.ledger_ack(_owner uuid, _results jsonb)
returns integer language plpgsql security definer set search_path = pg_catalog as $$
declare _item jsonb; _count integer := 0;
begin
  if _results is null or jsonb_typeof(_results) <> 'array' then raise exception using errcode = '22023', message = 'Send the sync results.'; end if;
  for _item in select value from jsonb_array_elements(_results) loop
    update public.ledger_reminders set
        calendar_event_id = case when (_item->>'ok')::boolean and _item->>'op' = 'delete' then null
          when (_item->>'ok')::boolean then coalesce(nullif(_item->>'event_id', ''), calendar_event_id) else calendar_event_id end,
        calendar_state = case when (_item->>'ok')::boolean then case when _item->>'op' = 'delete' then 'none' else 'synced' end else 'failed' end,
        calendar_error = case when (_item->>'ok')::boolean then null else left(_item->>'error', 300) end
      where id = (_item->>'id')::uuid and owner_user = _owner;
    _count := _count + 1;
  end loop;
  -- Reminders already done or deleted without an event need nothing more.
  update public.ledger_reminders set calendar_state = 'none'
    where owner_user = _owner and calendar_state = 'pending' and calendar_event_id is null and (deleted_at is not null or done);
  return _count;
end $$;
revoke all on function app.ledger_reminder_due(timestamptz,text), app.ledger_outbox(uuid), app.ledger_ack(uuid,jsonb) from public, anon, authenticated, service_role;

create or replace function public.ledger_calendar_outbox()
returns jsonb language sql stable security definer set search_path = pg_catalog as $$ select app.ledger_outbox(app.ledger_owner()); $$;
create or replace function public.ledger_calendar_ack(_results jsonb)
returns integer language plpgsql security definer set search_path = pg_catalog as $$
begin return app.ledger_ack(app.ledger_owner(), _results); end $$;

create or replace function public.ledger_google_status()
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select coalesce((select jsonb_build_object('connected', g.status = 'connected' and g.refresh_ct is not null, 'status', g.status,
      'email', g.google_email, 'client_kind', g.client_kind, 'connected_at', g.connected_at)
    from app.ledger_google g where g.owner_user = app.ledger_owner()),
    jsonb_build_object('connected', false, 'status', 'disconnected'));
$$;

-- Step one of connecting: a single-use nonce for the OAuth state, valid for ten minutes.
create or replace function public.ledger_google_begin()
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _nonce text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from app.ledger_google_pending where owner_user = _owner or expires_at < now();
  insert into app.ledger_google_pending(nonce_hash, owner_user, expires_at)
    values (encode(extensions.digest(_nonce, 'sha256'), 'hex'), _owner, now() + interval '10 minutes');
  return jsonb_build_object('nonce', _nonce, 'owner', _owner);
end $$;

-- Step two, called by the server's OAuth callback (no user session there): the nonce proves the
-- request started from this person's signed-in session. The token arrives encrypted with a key only
-- the server holds, bound to the owner.
create or replace function public.ledger_google_complete(_nonce text, _owner uuid, _email text, _ciphertext text, _client_kind text default 'workspace')
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare _pending app.ledger_google_pending;
begin
  delete from app.ledger_google_pending
    where nonce_hash = encode(extensions.digest(coalesce(_nonce, ''), 'sha256'), 'hex') and owner_user = _owner and expires_at > now()
    returning * into _pending;
  if _pending.owner_user is null then raise exception using errcode = '42501', message = 'This Google sign-in link has expired. Start again.'; end if;
  if coalesce(_ciphertext, '') !~ '^v1:[A-Za-z0-9_-]+$' or length(_ciphertext) > 4000 then
    raise exception using errcode = '22023', message = 'The Google connection could not be saved.';
  end if;
  insert into app.ledger_google(owner_user, google_email, client_kind, refresh_ct, status, connected_at, updated_at)
    values (_owner, left(_email, 320), case when _client_kind = 'external' then 'external' else 'workspace' end, _ciphertext, 'connected', now(), now())
  on conflict (owner_user) do update set google_email = excluded.google_email, client_kind = excluded.client_kind,
    refresh_ct = excluded.refresh_ct, status = 'connected', connected_at = now(), updated_at = now();
  -- Everything still to come goes to the calendar now.
  update public.ledger_reminders set calendar_state = 'pending', updated_at = now()
    where owner_user = _owner and deleted_at is null and not done and calendar_event_id is null;
  return true;
end $$;

create or replace function public.ledger_google_secret()
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select (select jsonb_build_object('owner', g.owner_user, 'ciphertext', g.refresh_ct, 'status', g.status, 'client_kind', g.client_kind)
    from app.ledger_google g where g.owner_user = app.ledger_owner() and g.refresh_ct is not null);
$$;

create or replace function public.ledger_google_mark(_status text)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if _status not in ('needs_reconnect','connected') then raise exception using errcode = '22023', message = 'Unknown connection status.'; end if;
  update app.ledger_google set status = _status, updated_at = now() where owner_user = app.ledger_owner() and refresh_ct is not null;
end $$;

create or replace function public.ledger_google_disconnect()
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  update app.ledger_google set status = 'disconnected', refresh_ct = null, updated_at = now() where owner_user = _owner;
  update public.ledger_reminders set calendar_state = 'none' where owner_user = _owner and calendar_state in ('pending','failed');
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Home in one call (webGetKanbanData), one task in full, search, settings
-- ---------------------------------------------------------------------------------------------
create or replace function app.ledger_alerts(_owner uuid, _today date)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(a.item order by a.rank, a.at nulls last), '[]') from (
    select 1 as rank, null::date as at, jsonb_build_object('kind', 'decision', 'campaign_id', c.id, 'title', c.name,
      'text', coalesce(nullif(btrim(c.decision), ''), 'Decision needed is not written yet')) as item
      from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null and c.stage = 'Decision'
    union all select 2, null, jsonb_build_object('kind', 'blocked', 'campaign_id', c.id, 'title', c.name, 'text', c.blocker)
      from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null and c.stage not in ('Parked','Cancelled')
        and nullif(btrim(c.blocker), '') is not null
    union all select 3, c.launch_date, jsonb_build_object('kind', 'launch', 'campaign_id', c.id, 'title', c.name, 'date', c.launch_date,
        'text', case when c.launch_date < _today then 'Launch date has passed' else 'Launches in ' || (c.launch_date - _today) || ' days' end)
      from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null and c.stage not in ('Parked','Cancelled','Live','Reviewed')
        and c.launch_date <= _today + 14
    union all select 4, nullif(c.measure->>'reviewDate', '')::date, jsonb_build_object('kind', 'review', 'campaign_id', c.id, 'title', c.name,
        'date', nullif(c.measure->>'reviewDate', ''),
        'text', case when nullif(c.measure->>'reviewDate', '') is null then 'Live without a review date' else 'Results review due' end)
      from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null and c.stage = 'Live'
        and (nullif(c.measure->>'reviewDate', '') is null or (c.measure->>'reviewDate') !~ '^\d{4}-\d{2}-\d{2}$'
          or (c.measure->>'reviewDate')::date <= _today + 7)
    union all select 5, c.milestone_date, jsonb_build_object('kind', 'milestone', 'campaign_id', c.id, 'title', c.name, 'date', c.milestone_date,
        'text', coalesce(nullif(btrim(c.milestone), ''), 'Milestone') || case when c.milestone_date < _today then ' — overdue' else '' end)
      from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null and c.stage not in ('Parked','Cancelled','Live','Reviewed')
        and c.milestone_date <= _today + 14
    union all select 6, i.revisit_date, jsonb_build_object('kind', 'idea', 'idea_id', i.id, 'title', i.text, 'date', i.revisit_date,
        'text', coalesce('Revisit when ' || nullif(btrim(i.revisit_when), ''), 'Time to revisit'))
      from public.ledger_ideas i where i.owner_user = _owner and i.deleted_at is null and i.status = 'Parked' and i.revisit_date <= _today + 7
  ) a;
$$;

create or replace function app.ledger_home_data(_owner uuid, _today date, _private boolean)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object(
    'today', _today,
    'pending', coalesce((select jsonb_agg(app.ledger_task_json(t, _today) order by t.pinned desc, (t.focus_date = _today) desc nulls last,
        coalesce(b.sort_order, 1000), lower(t.brand), t.deadline nulls last, t.logged_at, t.id)
      from public.ledger_tasks t left join public.ledger_brands b on b.owner_user = t.owner_user and lower(b.name) = lower(t.brand) and b.deleted_at is null
      where t.owner_user = _owner and t.deleted_at is null and t.entry_kind is null and t.status not in ('Delivered','Cancelled')), '[]'),
    'completed_today', coalesce((select jsonb_agg(app.ledger_task_json(t, _today) order by t.updated_at desc)
      from public.ledger_tasks t where t.owner_user = _owner and t.deleted_at is null and t.entry_kind is null
        and t.status = 'Delivered' and t.status_since = _today), '[]'),
    'done_this_week', (select count(*) from public.ledger_tasks t where t.owner_user = _owner and t.deleted_at is null and t.entry_kind is null
      and t.status = 'Delivered' and t.status_since between _today - (extract(isodow from _today)::integer - 1) and _today),
    'worked_on_today', (select count(distinct p.task_id) from public.ledger_progress p where p.owner_user = _owner and p.deleted_at is null and p.on_date = _today),
    'support_today', (select count(*) from public.ledger_tasks t where t.owner_user = _owner and t.deleted_at is null and t.entry_kind = 'support' and t.work_date = _today),
    'support_minutes_today', (select coalesce(sum(t.minutes), 0) from public.ledger_tasks t where t.owner_user = _owner and t.deleted_at is null
      and t.entry_kind = 'support' and t.work_date = _today),
    'overdue', (select count(*) from public.ledger_tasks t where t.owner_user = _owner and t.deleted_at is null and t.entry_kind is null
      and t.status not in ('Delivered','Cancelled') and t.deadline < _today),
    'ideas', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'text', i.text, 'brand', i.brand, 'status', i.status, 'created_at', i.created_at)
        order by i.created_at desc) from (select * from public.ledger_ideas i where i.owner_user = _owner and i.deleted_at is null
        and i.status in ('Open','Developing') order by i.created_at desc limit 6) i), '[]'),
    'ideas_open', (select count(*) from public.ledger_ideas i where i.owner_user = _owner and i.deleted_at is null and i.status = 'Open'),
    'alerts', app.ledger_alerts(_owner, _today),
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'brand', c.brand,
        'brand_label', coalesce((select coalesce(b.short_label, b.name) from public.ledger_brands b where b.owner_user = c.owner_user
          and lower(b.name) = lower(c.brand) and b.deleted_at is null), c.brand),
        'stage', c.stage, 'status', c.status, 'priority', c.priority, 'launch_date', c.launch_date,
        'days_to_launch', c.launch_date - _today,
        'total', (select count(*) from public.ledger_tasks t where t.campaign_id = c.id and t.deleted_at is null and t.entry_kind is null and t.status <> 'Cancelled'),
        'done', (select count(*) from public.ledger_tasks t where t.campaign_id = c.id and t.deleted_at is null and t.status = 'Delivered'),
        'in_review', (select count(*) from public.ledger_tasks t where t.campaign_id = c.id and t.deleted_at is null
          and t.status in ('Internal Review','Awaiting Approval','Revisions')),
        'blocked', (select count(*) from public.ledger_tasks t where t.campaign_id = c.id and t.deleted_at is null and t.status = 'Blocked'),
        'spend', (select coalesce(sum(t.actual_cost), 0) from public.ledger_tasks t where t.campaign_id = c.id and t.deleted_at is null))
        order by c.launch_date nulls last, lower(c.name))
      from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null and c.stage not in ('Parked','Cancelled','Reviewed')), '[]'),
    'key_dates', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'date', k.on_date, 'brand', k.brand,
        'lead_days', k.lead_days, 'days_away', k.on_date - _today,
        'has_campaign', exists(select 1 from public.ledger_campaigns c where c.owner_user = _owner and c.deleted_at is null
          and c.stage not in ('Parked','Cancelled') and c.launch_date between k.on_date - greatest(coalesce(k.lead_days, 30), 30) and k.on_date))
        order by k.on_date) from public.ledger_key_dates k where k.owner_user = _owner and k.deleted_at is null
        and k.on_date between _today and _today + 150), '[]'),
    'schedule', case when _private then coalesce((select jsonb_agg(app.ledger_reminder_json(r) order by r.due_at)
      from public.ledger_reminders r where r.owner_user = _owner and r.deleted_at is null and not r.done
        and r.due_at < ((_today + 2)::timestamp at time zone 'Asia/Kolkata')), '[]') end,
    'google', case when _private then coalesce((select jsonb_build_object('connected', g.status = 'connected' and g.refresh_ct is not null,
      'status', g.status, 'email', g.google_email) from app.ledger_google g where g.owner_user = _owner),
      jsonb_build_object('connected', false, 'status', 'disconnected')) end);
$$;
revoke all on function app.ledger_alerts(uuid,date), app.ledger_home_data(uuid,date,boolean) from public, anon, authenticated, service_role;

create or replace function public.ledger_home(_owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner);
begin
  return app.ledger_home_data(_target, app.ledger_today(), _target = auth.uid());
end $$;

create or replace function public.ledger_task(_id uuid, _owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner); _task public.ledger_tasks;
begin
  select * into _task from public.ledger_tasks where id = _id and owner_user = _target and deleted_at is null;
  if _task.id is null then raise exception using errcode = 'P0002', message = 'Task not found.'; end if;
  return app.ledger_task_json(_task, app.ledger_today(), true);
end $$;

-- webSearchHistory + webSearchDeliverables. Literal matching: % and _ are plain characters.
create or replace function public.ledger_search(_query text, _owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _target uuid := app.ledger_reader(_owner); _q text := lower(btrim(coalesce(_query, ''))); _today date := app.ledger_today();
begin
  if length(_q) < 2 then return jsonb_build_object('tasks', '[]'::jsonb, 'deliverables', '[]'::jsonb); end if;
  return jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(app.ledger_task_json(t, _today) order by t.logged_at desc) from (
      select * from public.ledger_tasks t where t.owner_user = _target and t.deleted_at is null
        and (strpos(lower(t.title), _q) > 0 or strpos(lower(array_to_string(t.tags, ' ')), _q) > 0)
      order by t.logged_at desc limit 20) t), '[]'),
    'deliverables', coalesce((select jsonb_agg(x.item order by x.added_at desc) from (
      select jsonb_build_object('id', d.id, 'task_id', t.id, 'task_title', t.title, 'type', d.type, 'version', d.version, 'link', d.link,
        'used_where', d.used_where, 'added_at', d.added_at) as item, d.added_at
      from public.ledger_deliverables d join public.ledger_tasks t on t.id = d.task_id
      where d.owner_user = _target and d.deleted_at is null and t.deleted_at is null
        and (strpos(lower(coalesce(d.type, '')), _q) > 0 or strpos(lower(coalesce(d.version, '')), _q) > 0
          or strpos(lower(coalesce(d.used_where, '')), _q) > 0 or strpos(lower(t.title), _q) > 0)
      order by d.added_at desc limit 20) x), '[]'));
end $$;

create or replace function public.ledger_set_sound(_on boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner();
begin
  perform app.ledger_seed(_owner);
  update public.ledger_settings set sound = coalesce(_on, false), updated_at = now() where owner_user = _owner;
  return app.ledger_bootstrap_data(_owner)->'settings';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------------------------
do $$
declare _signature text;
begin
  foreach _signature in array array[
    'ledger_add_task(uuid,jsonb)', 'ledger_log_support(uuid,jsonb)', 'ledger_update_task(uuid,jsonb)', 'ledger_mark_done(uuid,text)',
    'ledger_cancel_task(uuid)', 'ledger_delete_task(uuid)', 'ledger_bulk_mark_done(uuid[])', 'ledger_bulk_update(uuid[],jsonb)',
    'ledger_set_focus(uuid,boolean)', 'ledger_set_pin(uuid,boolean)', 'ledger_add_subtask(uuid,uuid,text)', 'ledger_set_subtask(uuid,boolean)',
    'ledger_delete_subtask(uuid)', 'ledger_add_deliverable(uuid,uuid,jsonb)', 'ledger_delete_deliverable(uuid)',
    'ledger_log_progress(uuid,uuid,text,integer,date)', 'ledger_delete_progress(uuid)', 'ledger_add_link(uuid,uuid,text,text)',
    'ledger_add_file(uuid,uuid,text,text,bigint,text)', 'ledger_remove_attachment(uuid)', 'ledger_add_reminder(uuid,jsonb)',
    'ledger_add_follow_up(uuid,uuid,text,text)', 'ledger_complete_reminder(uuid)', 'ledger_snooze_reminder(uuid,text)',
    'ledger_delete_reminder(uuid)', 'ledger_reminders(boolean)', 'ledger_calendar_outbox()', 'ledger_calendar_ack(jsonb)',
    'ledger_google_status()', 'ledger_google_begin()', 'ledger_google_secret()', 'ledger_google_mark(text)', 'ledger_google_disconnect()',
    'ledger_home(uuid)', 'ledger_task(uuid,uuid)', 'ledger_search(text,uuid)', 'ledger_set_sound(boolean)'] loop
    execute format('revoke all on function public.%s from public, anon, service_role', _signature);
    execute format('grant execute on function public.%s to authenticated', _signature);
  end loop;
end $$;
-- The OAuth callback runs without a user session; the single-use nonce is its proof.
revoke all on function public.ledger_google_complete(text,uuid,text,text,text) from public, service_role;
grant execute on function public.ledger_google_complete(text,uuid,text,text,text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
