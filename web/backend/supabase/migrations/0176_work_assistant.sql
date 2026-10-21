-- 0176 Hermes on the Work Ledger's real records.
--
-- The "Work Ledger" area of an assistant key (0172) worked on the old personal ledger. Its tools now
-- work on the same task records as every screen (0173) and the creative team's shared campaigns and
-- ideas (0174), under the key owner's own identity, so Task Management's visibility, the review-step
-- rules, history and notifications apply exactly as on screen. Tool names stay the same, so keys keep
-- working; one is added (ledger_add_deliverable). The Tasks area's own tools gain the review step,
-- waiting on, depends on and outcome. Nothing deletes.
begin;

-- Tasks area -------------------------------------------------------------------------------------------
create or replace function hr_agent.task_summary(_task public.tasks)
returns jsonb language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object('id', _task.id, 'title', _task.title, 'status', _task.status,
    'review_stage', _task.review_stage, 'step', app.work_step(_task.status, _task.review_stage), 'priority', _task.priority,
    'due_date', _task.due_date, 'created_at', _task.created_at, 'completed_at', _task.completed_at,
    'assignee', hr_agent.person(_task.employee_id), 'assigned_by', hr_agent.person(_task.assigned_by),
    'parent_task_id', _task.parent_task_id, 'waiting_on', _task.waiting_on, 'outcome', _task.outcome,
    'depends_on_task_id', _task.depends_on_task_id, 'revision', _task.revision, 'approved_version', _task.approved_version,
    'subtasks', (select jsonb_build_object('total', count(*), 'done', count(*) filter (where c.completed_at is not null))
      from public.task_checklist_items c where c.task_id = _task.id));
$$;

create or replace function hr_agent.get_task(_args jsonb)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _task public.tasks; _work jsonb;
begin
  perform hr_agent.only_keys(_args, array['task_id']);
  select * into _task from public.tasks where id = hr_agent.arg_uuid(_args, 'task_id', true) and deleted_at is null;
  if _task.id is null then
    raise exception using errcode = 'P0002', message = 'Task not found, or you cannot see it.';
  end if;
  _work := public.work_task(_task.id);
  return hr_agent.task_summary(_task) || jsonb_build_object(
    'description', _task.description,
    'people', coalesce((select jsonb_agg(hr_agent.person(a.employee_id) order by a.added_at, a.employee_id)
      from public.task_assignees a where a.task_id = _task.id), '[]'),
    'subtask_list', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title,
        'done', c.completed_at is not null, 'done_by', hr_agent.person(c.completed_by), 'owner', hr_agent.person(c.assigned_to))
      order by c.position, c.created_at, c.id) from public.task_checklist_items c where c.task_id = _task.id), '[]'),
    'comments', coalesce((select jsonb_agg(x.item order by x.created_at, x.id) from (
      select jsonb_build_object('id', m.id, 'reply_to', m.parent_id, 'author', m.author_name, 'body', m.body,
        'created_at', m.created_at) as item, m.created_at, m.id
      from public.task_comments m where m.task_id = _task.id order by m.created_at desc, m.id desc limit 30) x), '[]'),
    'progress', _work->'progress', 'deliverables', _work->'deliverables', 'history', _work->'history',
    'help_request_id', (select h.id from public.help_requests h where h.task_id = _task.id limit 1));
end $$;

-- A ledger step name, an old ledger status or a task status → the task's status and review step.
create or replace function hr_agent.work_target(_value text, out status text, out review text)
language plpgsql immutable set search_path = pg_catalog as $$
declare _k text := regexp_replace(lower(coalesce(_value, '')), '[^a-z]', '', 'g');
begin
  case
    when _k in ('brief','todo') then status := 'To Do';
    when _k in ('inprogress','started') then status := 'In Progress';
    when _k in ('internalreview','inreview','review') then status := 'In Progress'; review := 'Internal Review';
    when _k in ('awaitingapproval','waitingforapproval') then status := 'In Progress'; review := 'Awaiting Approval';
    when _k in ('revisions','changesneeded','changesrequested') then status := 'In Progress'; review := 'Revisions';
    when _k = 'approved' then status := 'In Progress'; review := 'Approved';
    when _k in ('delivered','done','completed') then status := 'Done';
    when _k = 'blocked' then status := 'Blocked';
    when _k in ('cancelled','canceled') then status := 'Cancelled';
    else raise exception using errcode = '22023', message =
      '"status" must be one of: To do, In progress, In review, Waiting for approval, Changes needed, Approved, Done, Blocked, Cancelled.';
  end case;
end $$;

create or replace function hr_agent.update_task(_args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _id uuid; _status text; _priority text; _due date; _clear boolean; _title text; _description text; _review text;
  _target record; _depends uuid; _work boolean;
begin
  perform hr_agent.only_keys(_args, array['task_id','status','priority','due_date','clear_due_date','title','description',
    'review_stage','waiting_on','depends_on_task_id','clear_depends_on','outcome']);
  _id := hr_agent.arg_uuid(_args, 'task_id', true);
  _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 40), hr_agent.task_statuses(), 'status');
  _priority := hr_agent.pick(hr_agent.arg_text(_args, 'priority', 20), hr_agent.task_priorities(), 'priority');
  _due := hr_agent.arg_date(_args, 'due_date');
  _clear := hr_agent.arg_bool(_args, 'clear_due_date', false);
  _title := hr_agent.arg_text(_args, 'title', 200);
  _description := hr_agent.arg_text(_args, 'description', 4000);
  _depends := hr_agent.arg_uuid(_args, 'depends_on_task_id');
  if hr_agent.arg_text(_args, 'review_stage', 40) is not null then
    if regexp_replace(lower(_args->>'review_stage'), '[^a-z]', '', 'g') = 'none' then
      _review := 'none';
    else
      select * into _target from hr_agent.work_target(_args->>'review_stage');
      if _target.review is null then
        raise exception using errcode = '22023', message = '"review_stage" must be one of: none, In review, Waiting for approval, Changes needed, Approved.';
      end if;
      _review := _target.review;
      if _status is not null and _status <> 'In Progress' then
        raise exception using errcode = '22023', message = 'A review step means the task is In Progress.';
      end if;
      _status := 'In Progress';
    end if;
  end if;
  _work := _review is not null or _args ? 'waiting_on' or _depends is not null or hr_agent.arg_bool(_args, 'clear_depends_on', false) or _args ? 'outcome';
  if _status is null and _priority is null and _due is null and not _clear and _title is null and not (_args ? 'description') and not _work then
    raise exception using errcode = '22023', message =
      'Give at least one change: status, review_stage, priority, due_date, clear_due_date, title, description, waiting_on, depends_on_task_id or outcome.';
  end if;
  if _due is not null and _clear then
    raise exception using errcode = '22023', message = 'Use either due_date or clear_due_date, not both.';
  end if;
  if _depends = _id then raise exception using errcode = '22023', message = 'A task cannot depend on itself.'; end if;
  update public.tasks t set
      status = coalesce(_status, t.status),
      review_stage = case when _review = 'none' then null when _review is not null then _review
        when _status is not null and _status <> 'In Progress' then null else t.review_stage end,
      completed_at = case when _status is null then t.completed_at
        when _status = 'Done' then coalesce(t.completed_at, clock_timestamp()) else null end,
      priority = coalesce(_priority, t.priority),
      due_date = case when _clear then null else coalesce(_due, t.due_date) end,
      title = coalesce(_title, t.title),
      description = case when _args ? 'description' then _description else t.description end,
      waiting_on = case when _args ? 'waiting_on' then hr_agent.arg_text(_args, 'waiting_on', 200) else t.waiting_on end,
      outcome = case when _args ? 'outcome' then hr_agent.arg_text(_args, 'outcome', 1000) else t.outcome end,
      depends_on_task_id = case when hr_agent.arg_bool(_args, 'clear_depends_on', false) then null else coalesce(_depends, t.depends_on_task_id) end
    where t.id = _id and t.deleted_at is null;
  if not found then
    -- The requesting side of a department request edits through its own checked RPC.
    if _status is null and not _work and exists(select 1 from public.help_requests h where h.task_id = _id) then
      perform public.update_requested_task(_id, _title, _description, _priority, _due, _clear);
    else
      raise exception using errcode = 'P0002', message = 'Task not found, or you cannot change it.';
    end if;
  end if;
  return jsonb_build_object('task_id', _id, 'updated', true);
end $$;

-- Work Ledger area -------------------------------------------------------------------------------------
create or replace function hr_agent.work_brief(_c jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_strip_nulls(jsonb_build_object('id', _c->'id', 'title', _c->'title', 'step', _c->'step', 'status', _c->'status',
    'review_stage', _c->'review_stage', 'priority', _c->'priority', 'due_date', _c->'due_date', 'assignee', _c->'assignee_name',
    'assigned_by', _c->'assigner_name', 'brand', _c->'brand_label', 'campaign', _c->'campaign', 'vendor', _c->'vendor',
    'waiting_on', _c->'waiting_on', 'revision', case when (_c->>'revision')::integer > 0 then _c->'revision' end,
    'approved_version', _c->'approved_version', 'focused', case when (_c->>'focused')::boolean then true end,
    'pinned', case when (_c->>'pinned')::boolean then true end, 'stale', case when (_c->>'stale')::boolean then true end,
    'overdue', case when (_c->>'overdue')::boolean then true end,
    'subtasks', jsonb_build_object('done', _c->'subtasks_done', 'total', _c->'subtasks_total'),
    'last_progress', _c->'last_progress', 'outcome', _c->'outcome'));
$$;

-- A campaign or vendor by name for the creative team: the existing one, or a new one.
create or replace function hr_agent.creative_named(_kind text, _name text)
returns uuid language plpgsql volatile set search_path = pg_catalog, public as $$
declare _clean text := btrim(coalesce(_name, '')); _id uuid;
begin
  if _clean = '' then return null; end if;
  if not app.is_creative_member() then
    raise exception using errcode = '42501', message = 'Campaigns and vendors are for the creative team.';
  end if;
  if _kind = 'campaign' then
    select id into _id from public.creative_campaigns where deleted_at is null and lower(name) = lower(_clean);
    if _id is null then insert into public.creative_campaigns(name) values (left(_clean, 160)) returning id into _id; end if;
  else
    select id into _id from public.creative_vendors where deleted_at is null and lower(name) = lower(_clean);
    if _id is null then insert into public.creative_vendors(name) values (left(_clean, 160)) returning id into _id; end if;
  end if;
  return _id;
end $$;

create or replace function hr_agent.work_card_of(_id uuid)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare _t public.tasks;
begin
  select * into _t from public.tasks where id = _id and deleted_at is null;
  if _t.id is null then raise exception using errcode = 'P0002', message = 'Task not found, or you cannot see it.'; end if;
  return hr_agent.work_brief(app.work_card(_t, app.ledger_today()));
end $$;

create or replace function hr_agent.cost(_args jsonb, _name text)
returns numeric language plpgsql immutable set search_path = pg_catalog as $$
begin
  if not (_args ? _name) or jsonb_typeof(_args->_name) = 'null' then return null; end if;
  if jsonb_typeof(_args->_name) <> 'number' or (_args->>_name)::numeric < 0 or (_args->>_name)::numeric > 9999999999 then
    raise exception using errcode = '22023', message = format('"%s" must be an amount in rupees, 0 or more.', _name);
  end if;
  return round((_args->>_name)::numeric, 2);
end $$;

create or replace function hr_agent.ledger_dispatch(_tool text, _args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _home jsonb; _me uuid := app.current_employee_id(); _today date := app.ledger_today(); _id uuid; _target record;
  _status text; _q text; _creative boolean := app.is_creative_member();
begin
  select null::text as status, null::text as review into _target;
  case _tool
    when 'ledger_home' then
      perform hr_agent.only_keys(_args, '{}');
      _home := public.work_home();
      return jsonb_build_object('today', _home->'today', 'overdue', _home->'overdue', 'done_this_week', _home->'done_this_week',
        'worked_on_today', _home->'worked_on_today', 'help_today', _home->'support_today', 'schedule', _home->'schedule',
        'board', (select coalesce(jsonb_agg(hr_agent.work_brief(t)), '[]') from jsonb_array_elements(_home->'pending') t),
        'delivered_today', (select coalesce(jsonb_agg(hr_agent.work_brief(t)), '[]') from jsonb_array_elements(_home->'completed_today') t))
        || case when _creative then jsonb_build_object('creative_alerts', public.creative_home()->'alerts') else '{}'::jsonb end;

    when 'ledger_list_tasks' then
      perform hr_agent.only_keys(_args, array['status','query','include_closed','limit']);
      if hr_agent.arg_text(_args, 'status', 40) is not null then select * into _target from hr_agent.work_target(_args->>'status'); end if;
      _q := hr_agent.arg_text(_args, 'query', 100);
      return jsonb_build_object('tasks', coalesce((select jsonb_agg(hr_agent.work_brief(app.work_card(t, _today)) order by t.created_at desc) from (
        select t.* from public.tasks t
        where t.deleted_at is null
          and (t.employee_id = _me or exists (select 1 from public.task_assignees a where a.task_id = t.id and a.employee_id = _me))
          and (_target.status is null or (t.status = _target.status and (_target.review is null or t.review_stage = _target.review)
            and (_target.status <> 'In Progress' or _target.review is not null or t.review_stage is null)))
          and (_target.status is not null or hr_agent.arg_bool(_args, 'include_closed', false) or t.status not in ('Done','Cancelled'))
          and (_q is null or t.title ilike hr_agent.like_pattern(_q))
        order by t.created_at desc limit coalesce(hr_agent.arg_int(_args, 'limit', 1, 50), 20)) t), '[]'));

    when 'ledger_get_task' then
      perform hr_agent.only_keys(_args, array['task_id']);
      return public.work_task(hr_agent.arg_uuid(_args, 'task_id', true));

    when 'ledger_report' then
      perform hr_agent.only_keys(_args, array['period','date','employee_id']);
      return public.work_report(coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'period', 10), array['day','week','month','all','range'], 'period'), 'day'),
        hr_agent.arg_text(_args, 'date', 21), hr_agent.arg_uuid(_args, 'employee_id'));

    when 'ledger_list_ideas' then
      perform hr_agent.only_keys(_args, array['status']);
      if not _creative then raise exception using errcode = '42501', message = 'Ideas are for the creative team.'; end if;
      _status := hr_agent.pick(hr_agent.arg_text(_args, 'status', 20), array['Open','Developing','Parked','Promoted','Archived'], 'status');
      return jsonb_build_object('ideas', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', i->'id', 'text', i->'text', 'brand', i->'brand',
          'tags', i->'tags', 'status', i->'status', 'by', i->'by', 'created_at', i->'created_at', 'revisit_date', i->'revisit_date',
          'campaign', i->'campaign_name', 'task', i->'task_title')))
        from jsonb_array_elements(public.creative_ideas()) i where _status is null or i->>'status' = _status), '[]'));

    when 'ledger_list_reminders' then
      perform hr_agent.only_keys(_args, array['include_done']);
      return jsonb_build_object('reminders', public.ledger_reminders(hr_agent.arg_bool(_args, 'include_done', false)));

    when 'ledger_list_campaigns' then
      perform hr_agent.only_keys(_args, '{}');
      if not _creative then raise exception using errcode = '42501', message = 'Campaigns are for the creative team.'; end if;
      return jsonb_build_object('campaigns', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', c->'id', 'name', c->'name',
        'brand', c->'brand_label', 'stage', c->'stage', 'status', c->'status', 'priority', c->'priority', 'launch_date', c->'launch_date',
        'next_action', c->'next_action', 'decision', c->'decision', 'blocker', c->'blocker', 'done', c->'done', 'total', c->'total'))), '[]')
        from jsonb_array_elements(public.creative_campaigns()) c));

    when 'ledger_add_task' then
      -- A task for yourself. To give work to someone else, use create_task (Tasks area).
      perform hr_agent.only_keys(_args, array['title','notes','brand','priority','deadline','status','campaign','type','vendor',
        'waiting_on','tags','subtasks','est_cost']);
      if _me is null then raise exception using errcode = '42501', message = 'Tasks are for staff with an employee record.'; end if;
      select * into _target from hr_agent.work_target(coalesce(hr_agent.arg_text(_args, 'status', 40), 'To do'));
      insert into public.tasks(employee_id, assigned_by, title, description, priority, status, review_stage, due_date, completed_at,
          waiting_on, tags, brand, work_type, est_cost, campaign_id, vendor_id)
        values (_me, _me, hr_agent.arg_text(_args, 'title', 200, true), hr_agent.arg_text(_args, 'notes', 4000),
          coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'priority', 20), hr_agent.task_priorities(), 'priority'), 'Medium'),
          _target.status, _target.review, hr_agent.arg_date(_args, 'deadline'), case when _target.status = 'Done' then clock_timestamp() end,
          hr_agent.arg_text(_args, 'waiting_on', 200),
          coalesce((select array_agg(distinct lower(x)) from unnest(hr_agent.arg_texts(_args, 'tags', 20, 40)) x), '{}'),
          hr_agent.arg_text(_args, 'brand', 80), hr_agent.arg_text(_args, 'type', 120), hr_agent.cost(_args, 'est_cost'),
          hr_agent.creative_named('campaign', hr_agent.arg_text(_args, 'campaign', 160)), hr_agent.creative_named('vendor', hr_agent.arg_text(_args, 'vendor', 160)))
        returning id into _id;
      insert into public.task_assignees(task_id, employee_id, added_by) values (_id, _me, _me);
      insert into public.task_checklist_items(task_id, title, position, created_by)
        select _id, s, (n - 1)::integer, _me from unnest(hr_agent.arg_texts(_args, 'subtasks', 50, 200)) with ordinality x(s, n);
      return hr_agent.work_card_of(_id);

    when 'ledger_update_task' then
      perform hr_agent.only_keys(_args, array['task_id','title','brand','priority','deadline','status','campaign','type',
        'vendor','waiting_on','tags','outcome','note','est_cost','actual_cost']);
      _id := hr_agent.arg_uuid(_args, 'task_id', true);
      if hr_agent.arg_text(_args, 'status', 40) is not null then select * into _target from hr_agent.work_target(_args->>'status'); end if;
      update public.tasks t set
          title = coalesce(hr_agent.arg_text(_args, 'title', 200), t.title),
          status = coalesce(_target.status, t.status),
          review_stage = case when _target.status is null then t.review_stage else _target.review end,
          completed_at = case when _target.status is null then t.completed_at
            when _target.status = 'Done' then coalesce(t.completed_at, clock_timestamp()) else null end,
          priority = coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'priority', 20), hr_agent.task_priorities(), 'priority'), t.priority),
          due_date = case when _args ? 'deadline' then hr_agent.arg_date(_args, 'deadline') else t.due_date end,
          waiting_on = case when _args ? 'waiting_on' then hr_agent.arg_text(_args, 'waiting_on', 200) else t.waiting_on end,
          outcome = case when _args ? 'outcome' then hr_agent.arg_text(_args, 'outcome', 1000) else t.outcome end,
          tags = case when _args ? 'tags' then coalesce((select array_agg(distinct lower(x)) from unnest(hr_agent.arg_texts(_args, 'tags', 20, 40)) x), '{}') else t.tags end,
          brand = case when _args ? 'brand' then hr_agent.arg_text(_args, 'brand', 80) else t.brand end,
          work_type = case when _args ? 'type' then hr_agent.arg_text(_args, 'type', 120) else t.work_type end,
          est_cost = case when _args ? 'est_cost' then hr_agent.cost(_args, 'est_cost') else t.est_cost end,
          actual_cost = case when _args ? 'actual_cost' then hr_agent.cost(_args, 'actual_cost') else t.actual_cost end,
          campaign_id = case when _args ? 'campaign' then hr_agent.creative_named('campaign', hr_agent.arg_text(_args, 'campaign', 160)) else t.campaign_id end,
          vendor_id = case when _args ? 'vendor' then hr_agent.creative_named('vendor', hr_agent.arg_text(_args, 'vendor', 160)) else t.vendor_id end
        where t.id = _id and t.deleted_at is null and app.can_write_task(t.id);
      if not found then raise exception using errcode = 'P0002', message = 'Task not found, or you cannot change it.'; end if;
      if hr_agent.arg_text(_args, 'note', 4000) is not null then
        insert into public.task_progress(task_id, note) values (_id, hr_agent.arg_text(_args, 'note', 4000));
      end if;
      return hr_agent.work_card_of(_id);

    when 'ledger_mark_done' then
      perform hr_agent.only_keys(_args, array['task_id','outcome']);
      _id := hr_agent.arg_uuid(_args, 'task_id', true);
      update public.tasks t set status = 'Done', review_stage = null, completed_at = coalesce(t.completed_at, clock_timestamp()),
          outcome = coalesce(hr_agent.arg_text(_args, 'outcome', 1000), t.outcome)
        where t.id = _id and t.deleted_at is null and app.can_write_task(t.id);
      if not found then raise exception using errcode = 'P0002', message = 'Task not found, or you cannot change it.'; end if;
      return hr_agent.work_card_of(_id);

    when 'ledger_log_progress' then
      perform hr_agent.only_keys(_args, array['task_id','note','minutes','date']);
      _id := hr_agent.arg_uuid(_args, 'task_id', true);
      insert into public.task_progress(task_id, note, minutes, on_date)
        values (_id, hr_agent.arg_text(_args, 'note', 4000, true), nullif(hr_agent.arg_int(_args, 'minutes', 0, 1440), 0),
          coalesce(hr_agent.arg_date(_args, 'date'), _today));
      return hr_agent.work_card_of(_id);

    when 'ledger_add_deliverable' then
      perform hr_agent.only_keys(_args, array['task_id','type','version','link','used_where']);
      _id := hr_agent.arg_uuid(_args, 'task_id', true);
      if hr_agent.arg_text(_args, 'type', 120) is null and hr_agent.arg_text(_args, 'link', 2000) is null then
        raise exception using errcode = '22023', message = 'Give a type or a link.';
      end if;
      insert into public.task_deliverables(task_id, type, version, link, used_where)
        values (_id, hr_agent.arg_text(_args, 'type', 120), hr_agent.arg_text(_args, 'version', 80), hr_agent.arg_text(_args, 'link', 2000),
          hr_agent.arg_text(_args, 'used_where', 200));
      return hr_agent.work_card_of(_id);

    when 'ledger_log_help' then
      perform hr_agent.only_keys(_args, array['what','for_whom','minutes','brand','type','note','date']);
      insert into public.task_help_log(what, for_whom, minutes, brand, kind, note, on_date)
        values (hr_agent.arg_text(_args, 'what', 500, true), hr_agent.arg_text(_args, 'for_whom', 120),
          nullif(hr_agent.arg_int(_args, 'minutes', 0, 1440), 0), hr_agent.arg_text(_args, 'brand', 80),
          coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'type', 40), array['Review / Feedback','Team support'], 'type'), 'Review / Feedback'),
          hr_agent.arg_text(_args, 'note', 4000), coalesce(hr_agent.arg_date(_args, 'date'), _today))
        returning id into _id;
      return (select jsonb_build_object('id', h.id, 'what', h.what, 'for_whom', h.for_whom, 'minutes', h.minutes, 'type', h.kind, 'date', h.on_date)
        from public.task_help_log h where h.id = _id);

    when 'ledger_add_idea' then
      perform hr_agent.only_keys(_args, array['text','brand','tags']);
      if not _creative then raise exception using errcode = '42501', message = 'Ideas are for the creative team.'; end if;
      insert into public.creative_ideas(text, brand, tags)
        values (hr_agent.arg_text(_args, 'text', 4000, true), hr_agent.arg_text(_args, 'brand', 80), hr_agent.arg_texts(_args, 'tags', 20, 40))
        returning id into _id;
      return (select jsonb_build_object('id', i.id, 'text', i.text, 'brand', i.brand, 'tags', to_jsonb(i.tags), 'status', i.status)
        from public.creative_ideas i where i.id = _id);

    when 'ledger_add_reminder' then
      perform hr_agent.only_keys(_args, array['text','due_at','repeat','task_id']);
      return public.ledger_add_reminder(gen_random_uuid(), _args);

    -- Used by the assistant gateway itself to mirror reminders into Google Calendar; not offered as tools.
    when 'ledger_calendar_outbox' then return jsonb_build_object('items', public.ledger_calendar_outbox());
    when 'ledger_calendar_ack' then return jsonb_build_object('acknowledged', public.ledger_calendar_ack(_args->'results'));
    when 'ledger_google_secret' then return coalesce(public.ledger_google_secret(), '{}'::jsonb);
    else raise exception using errcode = 'PT400', message = 'Unknown tool.';
  end case;
end $$;

create or replace function app.agent_tool_scope(_tool text)
returns text language sql immutable set search_path = pg_catalog as $$
  select case
    when _tool in ('whoami','find_employees','list_departments') then 'any'
    when _tool in ('list_tasks','get_task','create_task','update_task','add_task_helpers','comment_on_task',
      'add_subtask','tick_subtask','list_routines','create_routine','update_routine','stop_routine',
      'list_help_requests','request_help','answer_help_request','cancel_help_request',
      'list_ticket_categories','list_tickets','create_ticket','set_ticket_status') then 'tasks:manage'
    when _tool in ('list_leave_requests','decide_leave') then 'leave:manage'
    when _tool in ('list_assets','add_asset','update_asset','assign_asset','return_asset') then 'assets:manage'
    when _tool in ('list_goals','create_goal','update_goal') then 'goals:manage'
    when _tool in ('ledger_home','ledger_list_tasks','ledger_get_task','ledger_report','ledger_list_ideas','ledger_list_reminders',
      'ledger_list_campaigns','ledger_add_task','ledger_update_task','ledger_mark_done','ledger_log_progress','ledger_add_deliverable',
      'ledger_log_help','ledger_add_idea','ledger_add_reminder','ledger_calendar_outbox','ledger_calendar_ack','ledger_google_secret') then 'ledger:manage'
  end;
$$;
revoke all on function app.agent_tool_scope(text) from public, anon, authenticated, service_role;

revoke all on function hr_agent.work_target(text), hr_agent.work_brief(jsonb), hr_agent.creative_named(text,text),
  hr_agent.work_card_of(uuid), hr_agent.cost(jsonb,text) from public, anon, service_role;
grant execute on function hr_agent.work_target(text), hr_agent.work_brief(jsonb), hr_agent.creative_named(text,text),
  hr_agent.work_card_of(uuid), hr_agent.cost(jsonb,text) to authenticated;

notify pgrst, 'reload schema';
commit;
