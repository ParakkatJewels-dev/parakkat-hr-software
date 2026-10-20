-- Work Ledger on task records (0173): review steps, history, notes, deliverables, marks, the help log,
-- and the Home / report / insights / search reads. Runs after the ledger tests in the same disposable
-- database and reuses their people:
--   1 owner (employee, dept A)  2 peer (employee, dept A)  3 head of dept A  4 head of dept B
--   5 branch manager  6 entity admin  7 HR manager  8 super admin  9 admin of another company
\set ON_ERROR_STOP on
create temp table work_ids(label text primary key, id uuid not null default gen_random_uuid());
grant all on work_ids to authenticated, anon;
insert into work_ids(label) select unnest(array['hoarding','rollup','focus1','focus2','focus3','focus4','own','reel']);
create function audit_ledger.wid(_label text) returns uuid language sql as $$ select id from work_ids where label = _label $$;
grant execute on function audit_ledger.wid(text) to authenticated, anon;

-- Notifications go to an employee's login, as in production.
update public.employees e set user_id = audit_ledger.id(6, n) from generate_series(1,10) n where e.id = audit_ledger.id(7, n) and e.user_id is null;

-- Grants --------------------------------------------------------------------------------------------
do $$
declare _table text;
begin
  foreach _table in array array['task_events','task_progress','task_deliverables','task_marks','task_help_log'] loop
    assert not has_table_privilege('anon', 'public.'||_table, 'select'), 'anon cannot read '||_table;
    assert (select relrowsecurity from pg_class where oid = ('public.'||_table)::regclass), 'RLS on '||_table;
    assert exists(select 1 from pg_policies where schemaname = 'public' and tablename = _table
      and policyname = 'active_account_required' and permissive = 'RESTRICTIVE'), 'active account guard on '||_table;
  end loop;
  assert not has_table_privilege('authenticated', 'public.task_events', 'insert,update,delete'), 'history is written by triggers only';
  assert not has_function_privilege('anon', 'public.work_home()', 'execute'), 'anon cannot read Home';
  assert not has_function_privilege('authenticated', 'app.tg_task_workflow()', 'execute'), 'trigger functions are internal';
end $$;
select 'PASS: work tables are RLS-protected, closed to anon, and history is trigger-written' as result;

-- A head assigns work; the owner does it ---------------------------------------------------------------
set role authenticated;
select audit_ledger.as_user(3);
insert into public.tasks(id, employee_id, assigned_by, title, priority, status, due_date)
values (audit_ledger.wid('hoarding'), audit_ledger.id(7,1), audit_ledger.id(7,3), 'Diwali hoarding', 'High', 'To Do', app.ledger_today() + 3),
       (audit_ledger.wid('rollup'), audit_ledger.id(7,1), audit_ledger.id(7,3), 'Menu card', 'Medium', 'In Progress', null),
       (audit_ledger.wid('reel'), audit_ledger.id(7,1), audit_ledger.id(7,3), 'Resort reel', 'Medium', 'To Do', app.ledger_today() - 2);
-- The app lists the main person on the task too (createTask, 0114).
insert into public.task_assignees(task_id, employee_id, added_by)
  select audit_ledger.wid(l), audit_ledger.id(7,1), audit_ledger.id(7,3) from unnest(array['hoarding','rollup','reel']) l;
do $$ begin
  assert (select status_since from public.tasks where id = audit_ledger.wid('hoarding')) = app.ledger_today(), 'new work starts its clock today';
  assert exists(select 1 from public.task_events where task_id = audit_ledger.wid('hoarding') and kind = 'created' and to_value = 'To do'), 'creation is history';
end $$;

select audit_ledger.as_user(1);
do $$ declare _t public.tasks;
begin
  insert into public.task_progress(task_id, note, minutes) values (audit_ledger.wid('hoarding'), 'First layouts', 45);
  select * into _t from public.tasks where id = audit_ledger.wid('hoarding');
  assert _t.status = 'In Progress', 'the first note starts the work';
  assert (select employee_id from public.task_progress where task_id = _t.id) = audit_ledger.id(7,1), 'the note is stamped with its author';
end $$;
select audit_ledger.expect_error($q$insert into public.task_progress(task_id, note, on_date) values (audit_ledger.wid('hoarding'), 'Tomorrow', app.ledger_today() + 1)$q$, '22023');

-- Review steps -----------------------------------------------------------------------------------------
do $$ declare _t public.tasks;
begin
  update public.tasks set review_stage = 'Internal Review' where id = audit_ledger.wid('hoarding');
  insert into public.task_deliverables(task_id, type, version, link) values (audit_ledger.wid('hoarding'), 'Hoarding 20x10', 'v2', 'https://canva.example/h');
  update public.tasks set review_stage = 'Awaiting Approval', waiting_on = 'MD sign-off' where id = audit_ledger.wid('hoarding');
  select * into _t from public.tasks where id = audit_ledger.wid('hoarding');
  assert app.work_lane(_t.status, _t.review_stage) = 'review' and app.work_step(_t.status, _t.review_stage) = 'Waiting for approval', 'step named';
  assert _t.waiting_on = 'MD sign-off', 'waiting on kept while waiting for approval';
  update public.tasks set revision = 9, approved_version = 'forged', status_since = '2020-01-01' where id = _t.id;
  select * into _t from public.tasks where id = audit_ledger.wid('hoarding');
  assert _t.revision = 0 and _t.approved_version is null and _t.status_since = app.ledger_today(), 'derived fields cannot be written directly';
end $$;
reset role;
do $$ begin
  assert exists(select 1 from public.notifications where user_id = audit_ledger.id(6,3) and title = 'Waiting for your approval'
    and ref_id = audit_ledger.wid('hoarding')), 'the assigner is told it is waiting for them';
end $$;
set role authenticated;

select audit_ledger.as_user(3);
do $$ declare _t public.tasks;
begin
  update public.tasks set review_stage = 'Revisions' where id = audit_ledger.wid('hoarding');
  select * into _t from public.tasks where id = audit_ledger.wid('hoarding');
  assert _t.revision = 1 and _t.waiting_on is null, 'changes needed counts a round and clears waiting on';
  update public.tasks set review_stage = 'Approved' where id = audit_ledger.wid('hoarding');
  select * into _t from public.tasks where id = audit_ledger.wid('hoarding');
  assert _t.approved_version = 'v2', 'approval remembers the latest deliverable';
  update public.tasks set status = 'Done', completed_at = now(), outcome = 'Up on MG Road' where id = audit_ledger.wid('hoarding');
  select * into _t from public.tasks where id = audit_ledger.wid('hoarding');
  assert _t.review_stage is null and _t.approved_version = 'v2', 'done clears the step and keeps the approved version';
  assert (select count(*) from public.task_events where task_id = _t.id and kind = 'step') = 6, 'every step change is history';
end $$;
reset role;
do $$ begin
  assert exists(select 1 from public.notifications where user_id = audit_ledger.id(6,1) and title = 'Changes requested'), 'the owner is told changes are needed';
  assert exists(select 1 from public.notifications where user_id = audit_ledger.id(6,1) and title = 'Approved'), 'the owner is told it was approved';
end $$;
select 'PASS: review steps count rounds, keep the approved version, clear waiting-on, write history and notify both sides' as result;

-- Ticking the last subtask does not skip review ------------------------------------------------------
set role authenticated;
select audit_ledger.as_user(3);
insert into public.task_checklist_items(task_id, title, position, created_by) values (audit_ledger.wid('rollup'), 'Proof', 1, audit_ledger.id(7,3));
update public.tasks set review_stage = 'Internal Review' where id = audit_ledger.wid('rollup');
select audit_ledger.as_user(1);
update public.task_checklist_items set completed_at = now(), completed_by = audit_ledger.id(7,1) where task_id = audit_ledger.wid('rollup');
do $$ begin
  assert (select status from public.tasks where id = audit_ledger.wid('rollup')) = 'In Progress', 'work in review is not finished by its checklist';
end $$;
select audit_ledger.as_user(3);
update public.tasks set review_stage = 'Approved' where id = audit_ledger.wid('rollup');
select audit_ledger.as_user(1);
update public.task_checklist_items set completed_at = null, completed_by = null where task_id = audit_ledger.wid('rollup');
update public.task_checklist_items set completed_at = now(), completed_by = audit_ledger.id(7,1) where task_id = audit_ledger.wid('rollup');
do $$ begin
  assert (select status from public.tasks where id = audit_ledger.wid('rollup')) = 'Done', 'approved work finishes with its last subtask';
end $$;
select 'PASS: the checklist rollup respects review' as result;

-- Focus and pin are personal; at most three in focus ---------------------------------------------------
select audit_ledger.as_user(1);
insert into public.tasks(id, employee_id, assigned_by, title, priority, status)
  select audit_ledger.wid(l), audit_ledger.id(7,1), audit_ledger.id(7,1), 'Focus '||l, 'Low', 'To Do' from unnest(array['focus1','focus2','focus3','focus4']) l;
insert into public.task_assignees(task_id, employee_id, added_by)
  select audit_ledger.wid(l), audit_ledger.id(7,1), audit_ledger.id(7,1) from unnest(array['focus1','focus2','focus3','focus4']) l;
insert into public.task_marks(task_id, focus_date) select audit_ledger.wid(l), app.ledger_today() from unnest(array['focus1','focus2','focus3']) l;
select audit_ledger.expect_error($q$insert into public.task_marks(task_id, focus_date) values (audit_ledger.wid('focus4'), app.ledger_today())$q$, '22023');
insert into public.task_marks(task_id, pinned) values (audit_ledger.wid('reel'), true);
do $$ begin
  assert (select count(*) from public.task_marks where focus_date = app.ledger_today()) = 3, 'three in focus';
end $$;
select audit_ledger.as_user(3);
do $$ begin
  assert (select count(*) from public.task_marks) = 0, 'a manager does not see someone else''s marks';
end $$;
select 'PASS: focus holds at most three, and marks are private to each person' as result;

-- Who may write the ledger parts of a task ---------------------------------------------------------------
select audit_ledger.as_user(2);
select audit_ledger.expect_error($q$insert into public.task_progress(task_id, note) values (audit_ledger.wid('reel'), 'Not mine')$q$, '42501');
select audit_ledger.expect_error($q$insert into public.task_deliverables(task_id, type) values (audit_ledger.wid('reel'), 'Not mine')$q$, '42501');
do $$ begin
  assert (select count(*) from public.task_progress where task_id = audit_ledger.wid('hoarding')) = 0, 'a peer cannot read notes on work they cannot see';
end $$;
select 'PASS: only people who can work on a task add notes and deliverables' as result;

-- The help log: mine, and visible to my managers -------------------------------------------------------
select audit_ledger.as_user(1);
insert into public.task_help_log(what, for_whom, minutes, kind) values ('Reviewed menu layout', 'Priya', 20, 'Review / Feedback');
select audit_ledger.expect_error($q$insert into public.task_help_log(what, on_date) values ('Later', app.ledger_today() + 1)$q$, '22023');
do $$ begin
  assert (select department_id from public.task_help_log where what = 'Reviewed menu layout') = audit_ledger.id(4,1), 'stamped with the department';
end $$;
select audit_ledger.as_user(3);
do $$ begin assert (select count(*) from public.task_help_log) = 1, 'the head of the department sees it'; end $$;
select audit_ledger.as_user(2);
do $$ begin assert (select count(*) from public.task_help_log) = 0, 'a peer does not'; end $$;
select audit_ledger.as_user(4);
do $$ begin assert (select count(*) from public.task_help_log) = 0, 'another department''s head does not'; end $$;
select 'PASS: help entries are the author''s, readable by their managers only' as result;

-- Home, report, insights, search ---------------------------------------------------------------------
select audit_ledger.as_user(1);
do $$ declare _home jsonb; _report jsonb; _insights jsonb; _search jsonb; _worked jsonb;
begin
  _home := public.work_home();
  assert jsonb_array_length(_home->'pending') = 5, 'open work on Home: '||jsonb_array_length(_home->'pending');
  assert (_home->'pending'->0->>'pinned')::boolean, 'pinned work sorts first';
  assert (_home->>'overdue')::int = 1 and (_home->>'worked_on_today')::int = 1 and (_home->>'support_today')::int = 1, 'today''s numbers';
  assert jsonb_array_length(_home->'completed_today') = 2, 'finished today';
  assert _home->'google'->>'status' = 'disconnected', 'calendar state is mine';

  _report := public.work_report('day', null, null);
  select w into _worked from jsonb_array_elements(_report->'worked_on') w where w->>'title' = 'Focus focus1';
  assert _worked->>'is_new' = 'true', 'new work today is listed';
  assert jsonb_array_length(_report->'delivered') = 2, 'delivered today';
  assert exists(select 1 from jsonb_array_elements(_report->'delivered') d where d->>'title' = 'Diwali hoarding' and d->>'outcome' = 'Up on MG Road'
    and jsonb_array_length(d->'notes') = 1), 'delivered with its outcome and notes';
  assert jsonb_array_length(_report->'support') = 1 and (_report->>'support_minutes')::int = 20, 'help counted';
  assert jsonb_array_length(_report->'overdue') = 1, 'overdue listed';
  assert jsonb_array_length(_report->'pending_now') = 5, 'still open on a single day';
  assert jsonb_array_length((public.work_report('week', null, null))->'pending_now') = 0, 'no backlog section for a week';

  _insights := public.work_insights(null);
  assert jsonb_array_length(_insights->'months') = 6, 'six months';
  assert (select sum((m->>'delivered')::int) from jsonb_array_elements(_insights->'months') m) = 2, 'delivered counted';

  _search := public.work_search('hoard');
  assert jsonb_array_length(_search->'tasks') = 1 and jsonb_array_length(_search->'deliverables') = 1, 'search finds the task and its deliverable';
end $$;

select audit_ledger.as_user(3);
do $$ begin
  assert jsonb_array_length((public.work_report('day', null, audit_ledger.id(7,1)))->'delivered') = 2, 'the head reads the owner''s report';
end $$;
select audit_ledger.as_user(7);
do $$ begin
  assert jsonb_array_length((public.work_report('day', null, audit_ledger.id(7,1)))->'support') = 1, 'HR manager in scope reads it too';
end $$;
select audit_ledger.as_user(2);
select audit_ledger.expect_error($q$select public.work_report('day', null, audit_ledger.id(7,1))$q$, '42501');
select audit_ledger.expect_error($q$select public.work_insights(audit_ledger.id(7,1))$q$, '42501');
do $$ begin assert jsonb_array_length((public.work_search('hoard'))->'tasks') = 0, 'a peer finds nothing they cannot see'; end $$;
select audit_ledger.as_user(4);
select audit_ledger.expect_error($q$select public.work_report('day', null, audit_ledger.id(7,1))$q$, '42501');
select audit_ledger.as_user(9);
select audit_ledger.expect_error($q$select public.work_report('day', null, audit_ledger.id(7,1))$q$, '42501');
select 'PASS: Home, reports, insights and search follow Task Management''s visibility' as result;

-- Reminders link to real tasks --------------------------------------------------------------------
select audit_ledger.as_user(1);
do $$ declare _r jsonb;
begin
  _r := public.ledger_add_reminder(gen_random_uuid(), jsonb_build_object('text', 'Chase the printer', 'due_at', to_char(now() + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI'),
    'task_id', audit_ledger.wid('reel')));
  assert _r->'reminder'->>'task_title' = 'Resort reel', 'a reminder names its task';
  _r := public.ledger_add_reminder(gen_random_uuid(), jsonb_build_object('text', 'Not mine', 'due_at', to_char(now() + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI'),
    'task_id', gen_random_uuid()));
  assert _r->'reminder'->>'task_id' is null, 'an unknown task is not linked';
  assert jsonb_array_length((public.work_home())->'schedule') >= 1, 'my schedule shows on Home';
end $$;
select audit_ledger.as_user(3);
do $$ begin assert jsonb_array_length((public.work_home())->'schedule') = 0, 'nobody else''s reminders'; end $$;
reset role;
select 'PASS: reminders link to tasks the owner can see and stay private' as result;
