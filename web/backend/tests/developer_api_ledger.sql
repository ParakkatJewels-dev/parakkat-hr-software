-- Work Ledger through the assistant (0172). Runs after developer_api_write.sql in the same database.
\set ON_ERROR_STOP on
-- The earlier file removed the permission from department heads; the administrator grants it again.
insert into public.role_permissions(role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p
  where r.key = 'dept_head' and p.key = 'api.connect' on conflict do nothing;
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
do $$ declare _task jsonb; _home jsonb; _report jsonb; _r jsonb;
begin
  assert audit_agent.ok('everything', 'whoami')->'areas' @> '["ledger:manage"]', 'five areas on one key';
  _task := audit_agent.ok('ledger', 'ledger_add_task', '{"title":"Onam reel","brand":"Parakkat Munnar Resort","priority":"high","deadline":"2026-12-01","subtasks":["Script","Shoot"]}');
  assert _task->>'title' = 'Onam reel' and _task->>'priority' = 'High' and _task->'subtasks'->>'total' = '2', 'task added as the owner';
  perform audit_agent.fails('ledger', 'ledger_add_task', '{"title":"x","owner_user":"someone"}', 'invalid');
  _task := audit_agent.ok('ledger', 'ledger_update_task', jsonb_build_object('task_id', _task->>'id', 'status', 'internal review', 'note', 'Sent to MD'));
  assert _task->>'status' = 'Internal Review', 'status rules apply';
  _task := audit_agent.ok('ledger', 'ledger_log_progress', jsonb_build_object('task_id', _task->>'id', 'note', 'Colour grade', 'minutes', 30));
  assert _task->'last_progress'->>'note' = 'Colour grade', 'progress logged';
  assert audit_agent.ok('ledger', 'ledger_list_tasks', '{"query":"onam"}')->'tasks' @> jsonb_build_array(jsonb_build_object('id', _task->>'id')), 'listed';
  _task := audit_agent.ok('ledger', 'ledger_mark_done', jsonb_build_object('task_id', _task->>'id', 'outcome', '40k views'));
  assert _task->>'status' = 'Delivered' and _task->>'outcome' = '40k views', 'finished with outcome';
  perform audit_agent.ok('ledger', 'ledger_log_help', '{"what":"Reviewed brochure","for_whom":"Anu","minutes":15}');
  perform audit_agent.fails('ledger', 'ledger_log_help', '{"for_whom":"Anu"}', 'invalid');
  perform audit_agent.ok('ledger', 'ledger_add_idea', '{"text":"Monsoon mornings series","tags":["reels"]}');
  _r := audit_agent.ok('ledger', 'ledger_add_reminder', '{"text":"Call printer","due_at":"2026-12-02T10:00"}');
  assert _r->'reminder'->>'due_at' = '2026-12-02T10:00' and not (_r->>'calendar')::boolean, 'reminder saved in the app';
  _report := audit_agent.ok('ledger', 'ledger_report', '{"period":"day"}');
  assert _report->'delivered' @> '[{"title":"Onam reel","outcome":"40k views"}]' and _report->'support' @> '[{"for_whom":"Anu"}]', 'today''s report';
  _home := audit_agent.ok('ledger', 'ledger_home');
  assert _home->'delivered_today' @> '[{"title":"Onam reel"}]' and (_home->>'help_today')::integer = 1, 'home summary';
  assert jsonb_array_length(audit_agent.ok('ledger', 'ledger_list_ideas')->'ideas') = 1, 'ideas';
  assert jsonb_array_length(audit_agent.ok('ledger', 'ledger_list_reminders')->'reminders') = 1, 'reminders';
  assert audit_agent.ok('ledger', 'ledger_list_campaigns')->'campaigns' = '[]'::jsonb, 'campaigns';
  assert audit_agent.ok('ledger', 'ledger_google_secret') = '{}'::jsonb, 'no calendar connected yet';
  assert (audit_agent.ok('ledger', 'ledger_calendar_outbox')->'items') = '[]'::jsonb, 'nothing to sync';
end $$;
reset role;
reset session authorization;
do $$ begin
  assert (select count(*) from public.ledger_tasks where owner_user = audit_developer.id(6,14)) = 2, 'everything landed in the key owner''s own ledger';
  assert exists(select 1 from public.ledger_task_log l join public.ledger_tasks t on t.id = l.task_id
    where t.title = 'Onam reel' and l.text like '%Sent to MD — Status: Brief → Internal Review%'), 'history line recorded';
  assert (select count(*) from public.audit_log where action = 'API_CALL' and table_name like 'api:ledger_%' and actor = audit_developer.id(6,14)) >= 10, 'assistant calls audited';
end $$;
select 'PASS: a Work Ledger key reads and adds to its owner''s own ledger with the same rules as the screens; other keys cannot' as result;
