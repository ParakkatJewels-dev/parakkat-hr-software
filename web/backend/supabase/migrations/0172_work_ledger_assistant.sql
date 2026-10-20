-- Work Ledger, stage 4: the assistant (Hermes) can read a person's own ledger and add to it.
--
-- A personal key with the new "Work Ledger" area runs the ledger_* RPCs as its owner through the
-- identity switch in public.developer_api_call (0168), so the ledger's owner-only rules, status rules
-- and recurrence apply exactly as on screen. Reading covers Home, tasks, reports, ideas, reminders and
-- campaigns; writing covers adding and updating tasks, finishing them, progress notes, help entries,
-- ideas and reminders. Nothing deletes. Three internal tools let the gateway mirror new reminders into
-- Google Calendar using the owner's sealed token, which it cannot read without the server key.
-- Idempotent: safe to re-run.
begin;

do $$ declare _constraint record; begin
  for _constraint in select conname from pg_constraint
    where conrelid = 'app.developer_api_keys'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%scopes%'
  loop
    execute format('alter table app.developer_api_keys drop constraint %I', _constraint.conname);
  end loop;
end $$;
alter table app.developer_api_keys add constraint developer_api_keys_scopes_by_kind check (
  (kind = 'read' and cardinality(scopes) between 1 and 3
    and scopes <@ array['employees:read','organization:read','attendance:read']::text[])
  or (kind = 'manage' and entity_id is null and cardinality(scopes) between 1 and 5
    and scopes <@ array['tasks:manage','leave:manage','assets:manage','goals:manage','ledger:manage']::text[])
);

create or replace function public.create_my_api_key(_name text, _scopes text[], _expires_in_days integer default 30)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _key app.developer_api_keys%rowtype; _secret text; _scoped text[]; _id uuid := gen_random_uuid();
begin
  if auth.uid() is null or not app.api_connect_allowed(auth.uid()) then
    raise exception using errcode = 'PT403', message = 'Your role does not allow connecting an AI assistant.';
  end if;
  if not coalesce((select agent_enabled from app.developer_settings where singleton), false) then
    raise exception using errcode = 'PT503', message = 'AI assistant access is turned off by the administrator.';
  end if;
  if length(btrim(coalesce(_name, ''))) not between 1 and 80 then
    raise exception using errcode = 'PT400', message = 'Key name must contain 1 to 80 characters.';
  end if;
  if _expires_in_days is null or _expires_in_days not between 1 and 90 then
    raise exception using errcode = 'PT400', message = 'Key expiry must be between 1 and 90 days.';
  end if;
  if _scopes is null or cardinality(_scopes) = 0 or exists (
    select 1 from unnest(_scopes) s where s is null or s not in ('tasks:manage','leave:manage','assets:manage','goals:manage','ledger:manage')
  ) then raise exception using errcode = 'PT400', message = 'Choose one or more areas: tasks, leave, assets, goals or Work Ledger.'; end if;
  select array_agg(distinct s order by s) into _scoped from unnest(_scopes) s;
  -- One person's concurrent requests queue here so the active-key cap cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('agent-key:' || auth.uid()::text, 0));
  if (select count(*) from app.developer_api_keys k where k.created_by = auth.uid() and k.kind = 'manage'
      and k.revoked_at is null and k.expires_at > clock_timestamp()) >= 5 then
    raise exception using errcode = 'PT400', message = 'You already have 5 active keys. Revoke one before creating another.';
  end if;
  _secret := 'phr_' || replace(_id::text, '-', '') || '_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into app.developer_api_keys(id, name, key_prefix, secret_hash, scopes, entity_id, created_by, expires_at, kind)
    values (_id, btrim(_name), 'phr_' || left(replace(_id::text, '-', ''), 8),
      encode(extensions.digest(_secret, 'sha256'), 'hex'), _scoped, null, auth.uid(),
      clock_timestamp() + make_interval(days => _expires_in_days), 'manage') returning * into _key;
  insert into public.audit_log(actor, actor_email, action, table_name, row_id)
    select auth.uid(), email, 'API_KEY_CREATE', 'developer_api_keys', _key.id from auth.users where id = auth.uid();
  return jsonb_build_object('api_key', _secret, 'key', app.agent_key_metadata(_key));
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
      'ledger_list_campaigns','ledger_add_task','ledger_update_task','ledger_mark_done','ledger_log_progress','ledger_log_help',
      'ledger_add_idea','ledger_add_reminder','ledger_calendar_outbox','ledger_calendar_ack','ledger_google_secret') then 'ledger:manage'
  end;
$$;
revoke all on function app.agent_tool_scope(text) from public, anon, authenticated, service_role;

-- The owner's tasks, newest first: open ones unless a status is named or closed ones are asked for.
create or replace function public.ledger_list_tasks(_status text default null, _query text default null,
  _include_closed boolean default false, _limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _today date := app.ledger_today();
  _pick text := app.ledger_pick(_status, app.ledger_statuses(), 'Status'); _q text := lower(nullif(btrim(_query), ''));
begin
  if coalesce(_limit, 20) not between 1 and 200 then raise exception using errcode = '22023', message = 'Limit is 1 to 200.'; end if;
  return coalesce((select jsonb_agg(app.ledger_task_json(t, _today) order by t.logged_at desc) from (
    select * from public.ledger_tasks t where t.owner_user = _owner and t.deleted_at is null and t.entry_kind is null
      and (_pick is null or t.status = _pick) and (_pick is not null or coalesce(_include_closed, false) or t.status not in ('Delivered','Cancelled'))
      and (_q is null or strpos(lower(t.title), _q) > 0)
    order by t.logged_at desc limit coalesce(_limit, 20)) t), '[]');
end $$;
revoke all on function public.ledger_list_tasks(text,text,boolean,integer) from public, anon, service_role;
grant execute on function public.ledger_list_tasks(text,text,boolean,integer) to authenticated;

-- Work Ledger tools. They call the same ledger_* RPCs the screens use, under the key owner's
-- identity, so every rule and the owner-only scope apply unchanged. No tool deletes anything.
create or replace function hr_agent.ledger_task_brief(_t jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_strip_nulls(jsonb_build_object('id', _t->'id', 'title', _t->'title', 'brand', _t->'brand_label', 'status', _t->'status',
    'priority', _t->'priority', 'deadline', _t->'deadline', 'campaign', _t->'campaign', 'waiting_on', _t->'waiting_on',
    'focused', _t->'focused', 'pinned', _t->'pinned', 'stale', _t->'stale', 'subtasks', jsonb_build_object('done', _t->'subtasks_done', 'total', _t->'subtasks_total'),
    'last_progress', _t->'last_progress', 'outcome', _t->'outcome'));
$$;

create or replace function hr_agent.ledger_dispatch(_tool text, _args jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog, public as $$
declare _home jsonb; _entry jsonb;
begin
  case _tool
    when 'ledger_home' then
      perform hr_agent.only_keys(_args, '{}');
      _home := public.ledger_home();
      return jsonb_build_object('today', _home->'today', 'overdue', _home->'overdue', 'done_this_week', _home->'done_this_week',
        'worked_on_today', _home->'worked_on_today', 'help_today', _home->'support_today', 'ideas_open', _home->'ideas_open',
        'alerts', _home->'alerts', 'schedule', _home->'schedule',
        'board', (select coalesce(jsonb_agg(hr_agent.ledger_task_brief(t)), '[]') from jsonb_array_elements(_home->'pending') t),
        'delivered_today', (select coalesce(jsonb_agg(hr_agent.ledger_task_brief(t)), '[]') from jsonb_array_elements(_home->'completed_today') t));
    when 'ledger_list_tasks' then
      perform hr_agent.only_keys(_args, array['status','query','include_closed','limit']);
      return jsonb_build_object('tasks', (select coalesce(jsonb_agg(hr_agent.ledger_task_brief(t)), '[]') from jsonb_array_elements(
        public.ledger_list_tasks(hr_agent.arg_text(_args, 'status', 40), hr_agent.arg_text(_args, 'query', 100),
          hr_agent.arg_bool(_args, 'include_closed', false), coalesce(hr_agent.arg_int(_args, 'limit', 1, 50), 20))) t));
    when 'ledger_get_task' then
      perform hr_agent.only_keys(_args, array['task_id']);
      return public.ledger_task(hr_agent.arg_uuid(_args, 'task_id', true));
    when 'ledger_report' then
      perform hr_agent.only_keys(_args, array['period','date']);
      return public.ledger_report(coalesce(hr_agent.pick(hr_agent.arg_text(_args, 'period', 10), array['day','week','month','all','range'], 'period'), 'day'),
        hr_agent.arg_text(_args, 'date', 21));
    when 'ledger_list_ideas' then
      perform hr_agent.only_keys(_args, array['status']);
      return jsonb_build_object('ideas', public.ledger_ideas(hr_agent.arg_text(_args, 'status', 20)));
    when 'ledger_list_reminders' then
      perform hr_agent.only_keys(_args, array['include_done']);
      return jsonb_build_object('reminders', public.ledger_reminders(hr_agent.arg_bool(_args, 'include_done', false)));
    when 'ledger_list_campaigns' then
      perform hr_agent.only_keys(_args, '{}');
      return jsonb_build_object('campaigns', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', c->'id', 'name', c->'name',
        'brand', c->'brand_label', 'stage', c->'stage', 'priority', c->'priority', 'launch_date', c->'launch_date', 'next_action', c->'next_action',
        'blocker', c->'blocker', 'done', c->'done', 'total', c->'total'))), '[]') from jsonb_array_elements(public.ledger_campaigns()) c));
    when 'ledger_add_task' then
      perform hr_agent.only_keys(_args, array['title','brand','priority','deadline','start_date','end_date','status','campaign','type','vendor',
        'waiting_on','tags','repeat','notes','subtasks','est_cost']);
      _entry := _args;
      return hr_agent.ledger_task_brief(public.ledger_add_task(gen_random_uuid(), _entry));
    when 'ledger_update_task' then
      perform hr_agent.only_keys(_args, array['task_id','title','brand','priority','deadline','start_date','end_date','status','campaign','type',
        'vendor','waiting_on','tags','repeat','outcome','note','est_cost','actual_cost']);
      return hr_agent.ledger_task_brief(public.ledger_update_task(hr_agent.arg_uuid(_args, 'task_id', true), _args - 'task_id'));
    when 'ledger_mark_done' then
      perform hr_agent.only_keys(_args, array['task_id','outcome']);
      return hr_agent.ledger_task_brief(public.ledger_mark_done(hr_agent.arg_uuid(_args, 'task_id', true), hr_agent.arg_text(_args, 'outcome', 1000)));
    when 'ledger_log_progress' then
      perform hr_agent.only_keys(_args, array['task_id','note','minutes','date']);
      return hr_agent.ledger_task_brief(public.ledger_log_progress(gen_random_uuid(), hr_agent.arg_uuid(_args, 'task_id', true),
        hr_agent.arg_text(_args, 'note', 4000, true), hr_agent.arg_int(_args, 'minutes', 0, 1440), hr_agent.arg_date(_args, 'date')));
    when 'ledger_log_help' then
      perform hr_agent.only_keys(_args, array['what','for_whom','minutes','brand','type','note','date']);
      if hr_agent.arg_text(_args, 'what', 500) is null then raise exception using errcode = '22023', message = '"what" is required.'; end if;
      return hr_agent.ledger_task_brief(public.ledger_log_support(gen_random_uuid(), _args));
    when 'ledger_add_idea' then
      perform hr_agent.only_keys(_args, array['text','brand','tags']);
      return public.ledger_add_idea(gen_random_uuid(), hr_agent.arg_text(_args, 'text', 4000, true), hr_agent.arg_text(_args, 'brand', 80),
        hr_agent.arg_texts(_args, 'tags', 20, 40));
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
revoke all on function hr_agent.ledger_task_brief(jsonb), hr_agent.ledger_dispatch(text,jsonb) from public, anon, service_role;
grant execute on function hr_agent.ledger_task_brief(jsonb), hr_agent.ledger_dispatch(text,jsonb) to authenticated;

create or replace function public.developer_api_call(_api_key text, _tool text, _args jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = pg_catalog as $$
declare
  _auth record;
  _result jsonb;
  _error jsonb;
  _state text;
  _message text;
  _role text := current_setting('role');
  _claims text := coalesce(current_setting('request.jwt.claims', true), '');
  _sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  _claim_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  select * into _auth from agent_gateway.authorize(_api_key, _tool);
  _args := coalesce(_args, '{}'::jsonb);
  begin
    if jsonb_typeof(_args) <> 'object' then
      raise exception using errcode = '22023', message = 'Arguments must be a JSON object.';
    end if;
    perform set_config('request.jwt.claim.sub', _auth.actor::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', _auth.actor, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    if _tool like 'ledger\_%' then _result := hr_agent.ledger_dispatch(_tool, _args); else
    case _tool
      when 'whoami' then _result := hr_agent.whoami(_args) || jsonb_build_object('areas', to_jsonb(_auth.scopes));
      when 'find_employees' then _result := hr_agent.find_employees(_args);
      when 'list_departments' then _result := hr_agent.list_departments(_args);
      when 'list_tasks' then _result := hr_agent.list_tasks(_args);
      when 'get_task' then _result := hr_agent.get_task(_args);
      when 'create_task' then _result := hr_agent.create_task(_args);
      when 'update_task' then _result := hr_agent.update_task(_args);
      when 'add_task_helpers' then _result := hr_agent.add_task_helpers(_args);
      when 'comment_on_task' then _result := hr_agent.comment_on_task(_args);
      when 'add_subtask' then _result := hr_agent.add_subtask(_args);
      when 'tick_subtask' then _result := hr_agent.tick_subtask(_args);
      when 'list_routines' then _result := hr_agent.list_routines(_args);
      when 'create_routine' then _result := hr_agent.create_routine(_args);
      when 'update_routine' then _result := hr_agent.update_routine(_args);
      when 'stop_routine' then _result := hr_agent.stop_routine(_args);
      when 'list_help_requests' then _result := hr_agent.list_help_requests(_args);
      when 'request_help' then _result := hr_agent.request_help(_args);
      when 'answer_help_request' then _result := hr_agent.answer_help_request(_args);
      when 'cancel_help_request' then _result := hr_agent.cancel_help_request(_args);
      when 'list_ticket_categories' then _result := hr_agent.list_ticket_categories(_args);
      when 'list_tickets' then _result := hr_agent.list_tickets(_args);
      when 'create_ticket' then _result := hr_agent.create_ticket(_args);
      when 'set_ticket_status' then _result := hr_agent.set_ticket_status(_args);
      when 'list_leave_requests' then _result := hr_agent.list_leave_requests(_args);
      when 'decide_leave' then _result := hr_agent.decide_leave(_args);
      when 'list_assets' then _result := hr_agent.list_assets(_args);
      when 'add_asset' then _result := hr_agent.add_asset(_args);
      when 'update_asset' then _result := hr_agent.update_asset(_args);
      when 'assign_asset' then _result := hr_agent.assign_asset(_args);
      when 'return_asset' then _result := hr_agent.return_asset(_args);
      when 'list_goals' then _result := hr_agent.list_goals(_args);
      when 'create_goal' then _result := hr_agent.create_goal(_args);
      when 'update_goal' then _result := hr_agent.update_goal(_args);
      else raise exception using errcode = 'PT400', message = 'Unknown tool.';
    end case;
    end if;
    perform set_config('role', _role, true);
    perform set_config('request.jwt.claim.sub', _sub, true);
    perform set_config('request.jwt.claim.role', _claim_role, true);
    perform set_config('request.jwt.claims', _claims, true);
  exception when others then
    get stacked diagnostics _state = returned_sqlstate, _message = message_text;
    _error := agent_gateway.error(_state, _message);
  end;
  perform agent_gateway.audit(_api_key, _tool, _error is null);
  if _error is not null then
    return jsonb_build_object('ok', false, 'error', _error);
  end if;
  return jsonb_build_object('ok', true, 'data', coalesce(_result, 'null'::jsonb));
end $$;
revoke all on function public.developer_api_call(text,text,jsonb) from public, authenticated, service_role;
grant execute on function public.developer_api_call(text,text,jsonb) to anon;

notify pgrst, 'reload schema';
commit;
