-- Work Ledger through the assistant (0172, on task records since 0176). Runs after developer_api_write.sql
-- in the same database. The key owner (user 14) heads department 2; that department is the creative team.
\set ON_ERROR_STOP on
-- The earlier file removed the permission from department heads; the administrator grants it again.
insert into public.role_permissions(role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p
  where r.key = 'dept_head' and p.key = 'api.connect' on conflict do nothing;
insert into public.org_settings(key, value) values ('creative_departments', jsonb_build_object('departments', jsonb_build_array(audit_developer.id(4,2))))
  on conflict (key) do update set value = excluded.value;
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000014';
insert into audit_developer.keys values
  ('ledger', public.create_my_api_key('Hermes ledger', array['ledger:manage'])),
  ('everything', public.create_my_api_key('Everything', array['tasks:manage','leave:manage','assets:manage','goals:manage','ledger:manage'])),
  ('no-ledger', public.create_my_api_key('Tasks only', array['tasks:manage']));
reset role;
set request.jwt.claim.sub = '';
set session authorization api_gateway_sim;
set role anon;
select audit_developer.expect_error($q$select audit_agent.call('no-ledger','ledger_home')$q$, 'PT403');
do $$ declare _task jsonb; _home jsonb; _report jsonb; _r jsonb; _full jsonb;
begin
  assert audit_agent.ok('everything', 'whoami')->'areas' @> '["ledger:manage"]', 'five areas on one key';
  _task := audit_agent.ok('ledger', 'ledger_add_task', '{"title":"Onam reel","brand":"Parakkat Munnar Resort","priority":"high","deadline":"2026-12-01",
    "subtasks":["Script","Shoot"],"campaign":"Onam","vendor":"Studio Lumen","est_cost":12000}');
  assert _task->>'title' = 'Onam reel' and _task->>'priority' = 'High' and _task->'subtasks'->>'total' = '2' and _task->>'step' = 'To do', 'a task of my own';
  assert _task->>'campaign' = 'Onam' and _task->>'vendor' = 'Studio Lumen', 'campaign and vendor by name, for the creative team';
  perform audit_agent.fails('ledger', 'ledger_add_task', '{"title":"x","owner_user":"someone"}', 'invalid');
  perform audit_agent.fails('ledger', 'ledger_add_task', '{"title":"x","status":"someday"}', 'invalid');
  _task := audit_agent.ok('ledger', 'ledger_update_task', jsonb_build_object('task_id', _task->>'id', 'status', 'internal review', 'note', 'Sent to MD'));
  assert _task->>'step' = 'In review' and _task->>'status' = 'In Progress' and _task->>'review_stage' = 'Internal Review', 'old step names still work';
  assert _task->'last_progress'->>'note' = 'Sent to MD', 'a note goes on the task as progress';
  _task := audit_agent.ok('ledger', 'ledger_update_task', jsonb_build_object('task_id', _task->>'id', 'status', 'Changes needed'));
  assert (_task->>'revision')::int = 1, 'rounds of changes are counted';
  _task := audit_agent.ok('ledger', 'ledger_log_progress', jsonb_build_object('task_id', _task->>'id', 'note', 'Colour grade', 'minutes', 30));
  assert _task->'last_progress'->>'note' = 'Colour grade', 'progress logged';
  _task := audit_agent.ok('ledger', 'ledger_add_deliverable', jsonb_build_object('task_id', _task->>'id', 'type', 'Reel', 'version', 'v2', 'link', 'https://example.test/v2'));
  perform audit_agent.fails('ledger', 'ledger_add_deliverable', jsonb_build_object('task_id', _task->>'id'), 'invalid');
  assert audit_agent.ok('ledger', 'ledger_list_tasks', '{"query":"onam"}')->'tasks' @> jsonb_build_array(jsonb_build_object('id', _task->>'id')), 'listed';
  assert audit_agent.ok('ledger', 'ledger_list_tasks', '{"status":"changes needed"}')->'tasks' @> jsonb_build_array(jsonb_build_object('id', _task->>'id')), 'by step';
  assert jsonb_array_length(audit_agent.ok('ledger', 'ledger_list_tasks', '{"status":"in review"}')->'tasks') = 0, 'only that step';
  _full := audit_agent.ok('ledger', 'ledger_get_task', jsonb_build_object('task_id', _task->>'id'));
  assert jsonb_array_length(_full->'deliverables') = 1 and jsonb_array_length(_full->'progress') = 2, 'the full task';
  _task := audit_agent.ok('ledger', 'ledger_mark_done', jsonb_build_object('task_id', _task->>'id', 'outcome', '40k views'));
  assert _task->>'status' = 'Done' and _task->>'outcome' = '40k views', 'finished with outcome';
  perform audit_agent.ok('ledger', 'ledger_log_help', '{"what":"Reviewed brochure","for_whom":"Anu","minutes":15}');
  perform audit_agent.fails('ledger', 'ledger_log_help', '{"for_whom":"Anu"}', 'invalid');
  _r := audit_agent.ok('ledger', 'ledger_add_idea', '{"text":"Monsoon mornings series","tags":["Reels"]}');
  assert _r->'tags' = '["reels"]' and _r->>'status' = 'Open', 'idea in the creative team''s inbox';
  _r := audit_agent.ok('ledger', 'ledger_add_reminder', jsonb_build_object('text', 'Call printer', 'due_at', '2026-12-02T10:00', 'task_id', _task->>'id'));
  assert _r->'reminder'->>'due_at' = '2026-12-02T10:00' and _r->'reminder'->>'task_title' = 'Onam reel' and not (_r->>'calendar')::boolean, 'reminder on the task';
  _report := audit_agent.ok('ledger', 'ledger_report', '{"period":"day"}');
  assert _report->'delivered' @> '[{"title":"Onam reel","outcome":"40k views"}]' and _report->'support' @> '[{"for_whom":"Anu"}]', 'today''s report';
  assert _report->'ideas_captured' @> '[{"text":"Monsoon mornings series"}]', 'with the ideas captured';
  _home := audit_agent.ok('ledger', 'ledger_home');
  assert _home->'delivered_today' @> '[{"title":"Onam reel"}]' and (_home->>'help_today')::integer = 1, 'home summary';
  assert _home ? 'creative_alerts', 'the creative team''s alerts';
  assert jsonb_array_length(audit_agent.ok('ledger', 'ledger_list_ideas', '{"status":"open"}')->'ideas') = 1, 'ideas';
  assert jsonb_array_length(audit_agent.ok('ledger', 'ledger_list_reminders')->'reminders') = 1, 'reminders';
  assert audit_agent.ok('ledger', 'ledger_list_campaigns')->'campaigns' @> '[{"name":"Onam","total":1,"done":1}]', 'campaigns';
  assert audit_agent.ok('ledger', 'ledger_google_secret') = '{}'::jsonb, 'no calendar connected yet';
  assert (audit_agent.ok('ledger', 'ledger_calendar_outbox')->'items') = '[]'::jsonb, 'nothing to sync';
  -- The Tasks area's own tools know the review step, waiting on and depends on too.
  _r := audit_agent.ok('ledger', 'ledger_add_task', '{"title":"Hoarding"}');
  perform audit_agent.ok('everything', 'update_task', jsonb_build_object('task_id', _r->>'id', 'review_stage', 'waiting for approval',
    'waiting_on', 'MD sign-off', 'depends_on_task_id', _task->>'id'));
  _full := audit_agent.ok('everything', 'get_task', jsonb_build_object('task_id', _r->>'id'));
  assert _full->>'step' = 'Waiting for approval' and _full->>'waiting_on' = 'MD sign-off' and _full->>'depends_on_task_id' = _task->>'id', 'review step through update_task';
  assert jsonb_array_length(_full->'history') >= 1, 'get_task shows the history';
  perform audit_agent.fails('everything', 'update_task', jsonb_build_object('task_id', _r->>'id', 'review_stage', 'approved', 'status', 'Blocked'), 'invalid');
  perform audit_agent.fails('everything', 'update_task', jsonb_build_object('task_id', _r->>'id', 'depends_on_task_id', _r->>'id'), 'invalid');
  -- Someone else's task follows Task Management's rules: a department head of another department cannot see it.
  perform audit_agent.fails('ledger', 'ledger_get_task', jsonb_build_object('task_id', (select id from agent_ids where label = 'task')), 'not_found');
  perform audit_agent.fails('ledger', 'ledger_mark_done', jsonb_build_object('task_id', (select id from agent_ids where label = 'task')), 'not_found');
end $$;
reset role;
reset session authorization;
-- Outside the creative team, ideas, campaigns and vendors are refused.
update public.org_settings set value = '{"departments":[]}' where key = 'creative_departments';
set session authorization api_gateway_sim;
set role anon;
do $$ begin
  perform audit_agent.fails('ledger', 'ledger_list_ideas', '{}', 'forbidden');
  perform audit_agent.fails('ledger', 'ledger_add_idea', '{"text":"x"}', 'forbidden');
  perform audit_agent.fails('ledger', 'ledger_add_task', '{"title":"Banner","campaign":"Onam"}', 'forbidden');
  assert not (audit_agent.ok('ledger', 'ledger_home') ? 'creative_alerts'), 'no creative alerts';
end $$;
reset role;
reset session authorization;
do $$ declare _id uuid;
begin
  select id into _id from public.tasks where title = 'Onam reel' and deleted_at is null;
  assert (select employee_id = audit_developer.id(7,14) and assigned_by = audit_developer.id(7,14) from public.tasks where id = _id), 'the key owner''s own task';
  assert exists (select 1 from public.task_events where task_id = _id and kind = 'step' and to_value = 'In review'
    and actor_employee = audit_developer.id(7,14)), 'history recorded under the owner';
  assert not exists (select 1 from public.ledger_tasks where owner_user = audit_developer.id(6,14) and title = 'Onam reel'), 'nothing in the old personal ledger';
  assert (select count(*) from public.audit_log where action = 'API_CALL' and table_name like 'api:ledger_%' and actor = audit_developer.id(6,14)) >= 10, 'assistant calls audited';
end $$;
select 'PASS: a Work Ledger key works on the owner''s real tasks and the creative team''s shared ideas with the same rules as the screens; other keys cannot' as result;
