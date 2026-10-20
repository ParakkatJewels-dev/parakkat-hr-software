-- Work Ledger writes (0170): task rules, recurrence, focus, reminders, the Google handshake, files and
-- Home. Runs after work_ledger.sql in the same disposable database and reuses its people.
\set ON_ERROR_STOP on
create temp table ids(label text primary key, id uuid not null default gen_random_uuid());
grant all on ids to authenticated, anon;
insert into ids(label) select unnest(array['hoarding','reel','support','focus1','focus2','focus3','focus4','monthly','approve',
  'progress','remind1','remind2','remind3','link1','file1','sub1','deliv1','gone']);
create function audit_ledger.idof(_label text) returns uuid language sql as $$ select id from ids where label = _label $$;
grant execute on function audit_ledger.idof(text) to authenticated, anon;

set role authenticated;
select audit_ledger.as_user(1);

-- Adding ----------------------------------------------------------------------------------------
do $$ declare _task jsonb; _again jsonb;
begin
  _task := public.ledger_add_task(audit_ledger.idof('hoarding'), jsonb_build_object('task', 'Navaratri window', 'brand', 'Parakkat Jewels',
    'priority', 'high', 'campaign', 'Navaratri 2026', 'vendor', 'Print House', 'tags', 'print, window', 'notes', 'Brief from MD',
    'subtasks', jsonb_build_array('Measure window', ' ', 'Mock-up'), 'links', jsonb_build_array(jsonb_build_object('name', 'Moodboard', 'url', 'https://canva.example/m')),
    'brief', jsonb_build_object('objective', 'Footfall'), 'est_cost', '18,000'));
  assert _task->>'status' = 'Brief' and _task->>'priority' = 'High' and _task->>'campaign' = 'Navaratri 2026' and _task->>'vendor' = 'Print House', 'task saved with names';
  assert (_task->>'est_cost')::numeric = 18000, 'rupees parsed';
  assert jsonb_array_length(_task->'subtasks') = 2 and jsonb_array_length(_task->'attachments') = 1, 'children saved';
  assert _task->>'notes' like '%] Brief from MD%📎 Moodboard — https://canva.example/m', 'note and attachment lines in history';
  assert exists(select 1 from public.ledger_campaigns where name = 'Navaratri 2026' and stage = 'Captured'), 'campaign created at Captured';
  assert (select last_worked from public.ledger_vendors where name = 'Print House') = app.ledger_today(), 'vendor stamped';
  _again := public.ledger_add_task(audit_ledger.idof('hoarding'), '{"task":"Duplicate"}');
  assert _again->>'title' = 'Navaratri window', 'retry returns the same task';
  assert (select count(*) from public.ledger_tasks where id = audit_ledger.idof('hoarding')) = 1, 'no duplicate';
end $$;
select audit_ledger.expect_error($q$select public.ledger_add_task(gen_random_uuid(), '{"task":""}')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_add_task(gen_random_uuid(), '{"task":"x","deadline":"31/10/2026"}')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_add_task(gen_random_uuid(), '{"task":"x","status":"Someday"}')$q$, '22023');

-- Status rules ----------------------------------------------------------------------------------
do $$ declare _t jsonb; _id uuid := audit_ledger.idof('hoarding');
begin
  _t := public.ledger_update_task(_id, '{"status":"In Progress","note":"Started layouts"}');
  assert _t->>'status' = 'In Progress' and (_t->>'status_since')::date = app.ledger_today(), 'status moved today';
  assert _t->>'notes' like '%] Started layouts — Status: Brief → In Progress%', 'history line names the change: ' || coalesce(_t->>'notes', '(none)');
  perform public.ledger_update_task(_id, '{"status":"Revisions"}');
  perform public.ledger_update_task(_id, '{"status":"Internal Review"}');
  _t := public.ledger_update_task(_id, '{"status":"Revisions"}');
  assert (_t->>'revision')::integer = 2, 'each entry into Revisions counts';
  _t := public.ledger_update_task(_id, '{"status":"Blocked","waiting_on":"Landlord"}');
  assert _t->>'waiting_on' = 'Landlord', 'waiting on set with Blocked';
  _t := public.ledger_update_task(_id, '{"priority":"Low"}');
  assert _t->>'waiting_on' = 'Landlord', 'unrelated save keeps waiting on';
  _t := public.ledger_update_task(_id, '{"status":"In Progress"}');
  assert _t->>'waiting_on' is null, 'leaving Blocked clears waiting on';
  _t := public.ledger_update_task(_id, '{"deadline":"2026-12-01","pinned":true}');
  assert _t->>'notes' like '%Deadline: — → 2026-12-01%' and (_t->>'pinned')::boolean, 'deadline change recorded';
end $$;
reset role;
update public.ledger_tasks set status_since = app.ledger_today() - 9 where id = audit_ledger.idof('hoarding');
set role authenticated;
do $$ declare _t jsonb;
begin
  _t := public.ledger_update_task(audit_ledger.idof('hoarding'), '{"status":"In Progress","note":"Same status"}');
  assert (_t->>'status_since')::date = app.ledger_today() - 9, 'saving the same status keeps status_since';
  assert (_t->>'stale')::boolean, 'over 7 days in one status is stale';
  perform public.ledger_add_task(audit_ledger.idof('approve'), '{"task":"Banner set"}');
  _t := public.ledger_update_task(audit_ledger.idof('approve'), '{"status":"Approved"}');
  assert _t->>'approved_version' = 'Work as reviewed', 'approval without deliverables';
  perform public.ledger_update_task(audit_ledger.idof('approve'), '{"status":"Revisions"}');
  perform public.ledger_add_deliverable(audit_ledger.idof('deliv1'), audit_ledger.idof('approve'), '{"type":"Hoarding 20x10","version":"v3","used_where":"MG Road"}');
  _t := public.ledger_update_task(audit_ledger.idof('approve'), '{"status":"Approved"}');
  assert _t->>'approved_version' = 'v3', 'approval records the latest deliverable version';
end $$;
select audit_ledger.expect_error(format('select public.ledger_update_task(%L, %L)', audit_ledger.idof('hoarding'), '{"owner_user":"x"}'), '22023');
select audit_ledger.expect_error(format('select public.ledger_update_task(%L, %L)', audit_ledger.idof('hoarding'), '{"title":"  "}'), '22023');
select 'PASS: adding names campaigns and vendors; status rules for status_since, revisions, waiting on, approval and history lines' as result;

-- Done and repeat -------------------------------------------------------------------------------
do $$ declare _t jsonb; _child public.ledger_tasks;
begin
  perform public.ledger_add_task(audit_ledger.idof('monthly'), '{"task":"Month-end creative report","repeat":"monthly","deadline":"2026-01-31","subtasks":["Collect numbers","Write summary"]}');
  perform public.ledger_set_subtask((select id from public.ledger_subtasks where task_id = audit_ledger.idof('monthly') order by position limit 1), true);
  _t := public.ledger_mark_done(audit_ledger.idof('monthly'), 'Sent to management');
  assert _t->>'status' = 'Delivered' and _t->>'outcome' = 'Sent to management', 'delivered with outcome';
  select * into _child from public.ledger_tasks where id = (select recurrence_child_id from public.ledger_tasks where id = audit_ledger.idof('monthly'));
  assert _child.deadline = '2026-02-28' and _child.status = 'Brief' and _child.repeat = 'monthly', 'next occurrence clamps to month end';
  assert (select count(*) from public.ledger_subtasks where task_id = _child.id and not done) = 2, 'subtasks copied unticked';
  perform public.ledger_mark_done(audit_ledger.idof('monthly'), null);
  assert (select count(*) from public.ledger_tasks where title = 'Month-end creative report') = 2, 'a second done never makes a second copy';
  perform public.ledger_update_task(_child.id, '{"status":"Delivered"}');
  assert (select count(*) from public.ledger_tasks where title = 'Month-end creative report') = 3, 'delivering through the form also repeats';
  assert (select deadline from public.ledger_tasks where title = 'Month-end creative report' and status = 'Brief') = '2026-03-28', 'counts from the previous deadline';
  _t := public.ledger_cancel_task(audit_ledger.idof('approve'));
  assert _t->>'status' = 'Cancelled', 'cancel is a status';
end $$;

-- Support, progress, focus, pin, delete, bulk -----------------------------------------------------
do $$ declare _t jsonb; _home jsonb;
begin
  _t := public.ledger_log_support(audit_ledger.idof('support'), '{"what":"Reviewed reel cut","for_whom":"Anu","minutes":25,"type":"team support"}');
  assert _t->>'entry_kind' = 'support' and _t->>'status' = 'Delivered' and _t->>'type' = 'Team support', 'help entry';
  perform audit_ledger.expect_error(format('select public.ledger_update_task(%L, %L)', audit_ledger.idof('support'), '{"status":"Brief"}'), '22023');
  perform public.ledger_add_task(audit_ledger.idof('progress'), '{"task":"Logo animation"}');
  _t := public.ledger_log_progress(gen_random_uuid(), audit_ledger.idof('progress'), 'First frames', 40, null);
  assert _t->>'status' = 'In Progress' and (_t->>'last_updated')::date = app.ledger_today(), 'first note starts the task';
  _t := public.ledger_log_progress(gen_random_uuid(), audit_ledger.idof('progress'), 'Earlier sketch', null, app.ledger_today() - 3);
  assert (_t->>'last_updated')::date = app.ledger_today(), 'an older note never moves last updated backwards';
  for i in 1..3 loop
    perform public.ledger_add_task(audit_ledger.idof('focus' || i), jsonb_build_object('task', 'Focus ' || i));
    perform public.ledger_set_focus(audit_ledger.idof('focus' || i), true);
  end loop;
  perform public.ledger_add_task(audit_ledger.idof('focus4'), '{"task":"Focus 4"}');
  perform public.ledger_set_focus(audit_ledger.idof('focus1'), true);
  perform public.ledger_set_focus(audit_ledger.idof('focus1'), false);
  _t := public.ledger_set_focus(audit_ledger.idof('focus4'), true);
  assert (_t->>'focused')::boolean, 'room after removing one';
  _t := public.ledger_set_pin(audit_ledger.idof('focus4'), true);
  assert (_t->>'pinned')::boolean, 'pinned';
  perform public.ledger_add_task(audit_ledger.idof('gone'), '{"task":"Mistake"}');
  perform public.ledger_delete_task(audit_ledger.idof('gone'));
  assert public.ledger_bulk_update(array[audit_ledger.idof('focus2'), audit_ledger.idof('focus3')], '{"priority":"High"}') = 2, 'bulk update';
  assert public.ledger_bulk_mark_done(array[audit_ledger.idof('progress')]) = 1, 'bulk done';
  _home := public.ledger_home();
  assert _home->'pending' @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('focus4'), 'focused', true, 'pinned', true)), 'focus and pin on Home';
  assert (_home->'pending'->0->>'pinned')::boolean, 'pinned first';
  assert not (_home->'pending' @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('gone')))), 'deleted tasks leave Home';
  assert not (_home->'pending' @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('support')))), 'help entries never on the board';
  assert _home->'completed_today' @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('progress'))), 'done today';
  assert (_home->>'support_today')::integer >= 1 and (_home->>'support_minutes_today')::integer >= 25, 'help today';
  assert (_home->>'worked_on_today')::integer >= 1, 'worked on today';
  assert exists(select 1 from public.ledger_tasks where id = audit_ledger.idof('gone') and deleted_at is not null), 'soft delete keeps the row';
end $$;
select audit_ledger.expect_error(format('select public.ledger_set_focus(%L, true)', audit_ledger.idof('focus1')), '22023');
select audit_ledger.expect_error(format('select public.ledger_log_progress(gen_random_uuid(), %L, %L, null, %L)', audit_ledger.idof('progress'), 'Tomorrow', app.ledger_today() + 1), '22023');
select 'PASS: done delivers and repeats exactly once; help entries stay off the board; progress starts work; focus holds three; soft deletes' as result;

-- Managers read, never write --------------------------------------------------------------------
select audit_ledger.as_user(3);
select audit_ledger.expect_error(format('select public.ledger_update_task(%L, %L)', audit_ledger.idof('hoarding'), '{"title":"Manager edit"}'), 'P0002');
select audit_ledger.expect_error(format('select public.ledger_mark_done(%L)', audit_ledger.idof('hoarding')), 'P0002');
select audit_ledger.expect_error(format('select public.ledger_delete_task(%L)', audit_ledger.idof('hoarding')), 'P0002');
do $$ declare _home jsonb;
begin
  _home := public.ledger_home(audit_ledger.id(6,1));
  assert jsonb_array_length(_home->'pending') > 0, 'manager sees the board';
  assert _home->'schedule' = 'null'::jsonb and _home->'google' = 'null'::jsonb, 'but not reminders or calendar';
  assert (public.ledger_task(audit_ledger.idof('hoarding'), audit_ledger.id(6,1))->>'title') = 'Navaratri window', 'and one task in full';
end $$;
select audit_ledger.as_user(2);
select audit_ledger.expect_error(format('select public.ledger_task(%L, %L)', audit_ledger.idof('hoarding'), audit_ledger.id(6,1)), '42501');
select 'PASS: managers read Home and tasks but cannot change, finish or delete anything; peers see nothing' as result;

-- Reminders and Google Calendar -----------------------------------------------------------------
select audit_ledger.as_user(1);
do $$ declare _r jsonb; _begin jsonb; _out jsonb;
begin
  _r := public.ledger_add_reminder(audit_ledger.idof('remind1'), '{"text":"Call printer","due_at":"2026-10-24T10:00","repeat":"weekdays"}');
  assert _r->'reminder'->>'due_at' = '2026-10-26T10:00', 'a weekday reminder on Saturday moves to Monday';
  assert not (_r->>'calendar')::boolean and _r->'reminder'->>'calendar_state' = 'none', 'saved in the app without a calendar';
  _r := public.ledger_complete_reminder(audit_ledger.idof('remind1'));
  assert _r->>'due_at' = '2026-10-27T10:00' and not (_r->>'done')::boolean, 'repeating reminder moves to its next day';
  perform public.ledger_add_reminder(audit_ledger.idof('remind2'), '{"text":"Send proofs","due_at":"2026-10-08T16:30"}');
  _r := public.ledger_snooze_reminder(audit_ledger.idof('remind2'), '2026-10-09T09:00');
  assert _r->>'due_at' = '2026-10-09T09:00', 'snoozed';
  _r := public.ledger_complete_reminder(audit_ledger.idof('remind2'));
  assert (_r->>'done')::boolean, 'one-off finished';
  _r := public.ledger_add_follow_up(audit_ledger.idof('remind3'), audit_ledger.idof('hoarding'), 'Chase landlord', '2026-10-30T11:00');
  assert _r->'reminder'->>'source' = 'followup' and _r->'reminder'->>'task_title' = 'Navaratri window', 'follow-up linked to its task';

  _begin := public.ledger_google_begin();
  assert length(_begin->>'nonce') = 64 and (_begin->>'owner')::uuid = audit_ledger.id(6,1), 'nonce for the OAuth state';
  insert into ids(label, id) values ('nonce-owner', (_begin->>'owner')::uuid);
  create temp table nonce(value text);
  insert into nonce values (_begin->>'nonce');
end $$;
grant select on nonce to anon, authenticated;
select audit_ledger.expect_error(format('select public.ledger_snooze_reminder(%L, %L)', audit_ledger.idof('remind1'), '2026-10-28T10:00'), '22023');
reset role;
set role anon;
set request.jwt.claim.sub = '';
select audit_ledger.expect_error(format('select public.ledger_google_complete(%L, %L, %L, %L)', repeat('0', 64), audit_ledger.id(6,1), 'me@example.test', 'v1:abc'), '42501');
select audit_ledger.expect_error(format('select public.ledger_google_complete(%L, %L, %L, %L)', (select value from nonce), audit_ledger.id(6,2), 'me@example.test', 'v1:abc'), '42501');
do $$ begin
  assert public.ledger_google_complete((select value from nonce), audit_ledger.id(6,1), 'vivek@parakkat.example', 'v1:c2VjcmV0LWNpcGhlcnRleHQ', 'workspace'), 'connected';
end $$;
select audit_ledger.expect_error(format('select public.ledger_google_complete(%L, %L, %L, %L)', (select value from nonce), audit_ledger.id(6,1), 'me@example.test', 'v1:abc'), '42501');
select audit_ledger.expect_error('select * from app.ledger_google', '42501');
reset role;
set role authenticated;
select audit_ledger.as_user(1);
do $$ declare _out jsonb; _status jsonb;
begin
  _status := public.ledger_google_status();
  assert (_status->>'connected')::boolean and _status->>'email' = 'vivek@parakkat.example', 'status shows the account';
  assert public.ledger_google_secret()->>'ciphertext' = 'v1:c2VjcmV0LWNpcGhlcnRleHQ', 'the server can fetch the sealed token';
  _out := public.ledger_calendar_outbox();
  assert _out @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind1'), 'op', 'insert', 'repeat', 'weekdays')), 'open reminders queued for the calendar';
  assert not (_out @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind2')))), 'finished reminders are not sent';
  perform public.ledger_calendar_ack(jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind1'), 'op', 'insert', 'ok', true, 'event_id', 'ldrabc'),
    jsonb_build_object('id', audit_ledger.idof('remind3'), 'op', 'insert', 'ok', false, 'error', 'quota')));
  assert (select calendar_state = 'synced' and calendar_event_id = 'ldrabc' from public.ledger_reminders where id = audit_ledger.idof('remind1')), 'synced';
  assert (select calendar_state = 'failed' and calendar_error = 'quota' from public.ledger_reminders where id = audit_ledger.idof('remind3')), 'failure recorded';
  perform public.ledger_delete_reminder(audit_ledger.idof('remind1'));
  assert public.ledger_calendar_outbox() @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind1'), 'op', 'delete', 'event_id', 'ldrabc')), 'deleting removes the event';
  perform public.ledger_calendar_ack(jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind1'), 'op', 'delete', 'ok', true)));
  assert (select calendar_state = 'none' and calendar_event_id is null and deleted_at is not null from public.ledger_reminders where id = audit_ledger.idof('remind1')), 'event gone, reminder kept';
  perform public.ledger_google_mark('needs_reconnect');
  assert public.ledger_google_status()->>'status' = 'needs_reconnect', 'expired grants ask to reconnect';
  perform public.ledger_google_disconnect();
  assert not (public.ledger_google_status()->>'connected')::boolean and public.ledger_google_secret() is null, 'disconnect forgets the token';
end $$;
select audit_ledger.as_user(3);
do $$ begin
  assert public.ledger_google_secret() is null, 'nobody else can fetch it';
  assert (select count(*) from public.ledger_reminders where owner_user = audit_ledger.id(6,1)) = 0, 'manager sees no reminders';
end $$;
select 'PASS: reminders move off weekends, repeat, snooze and follow up; Google connects only with a fresh single-use nonce; the outbox syncs inserts, failures and deletes' as result;

-- Files -------------------------------------------------------------------------------------------
select audit_ledger.as_user(1);
do $$ declare _path text := audit_ledger.id(6,1)::text || '/' || audit_ledger.idof('hoarding')::text || '/' || audit_ledger.idof('file1')::text || '-proof.pdf';
begin
  insert into storage.objects(bucket_id, name) values ('ledger-files', _path);
  perform public.ledger_add_file(audit_ledger.idof('file1'), audit_ledger.idof('hoarding'), 'proof.pdf', _path, 120000, 'application/pdf');
  perform public.ledger_add_link(audit_ledger.idof('link1'), audit_ledger.idof('hoarding'), 'Figma', 'https://figma.example/f');
  assert (select count(*) from storage.objects where bucket_id = 'ledger-files') = 1, 'owner reads their file';
end $$;
select audit_ledger.expect_error(format($q$insert into storage.objects(bucket_id, name) values ('ledger-files', %L)$q$,
  audit_ledger.id(6,2)::text || '/' || audit_ledger.idof('hoarding')::text || '/x.pdf'), '42501');
select audit_ledger.expect_error(format($q$insert into storage.objects(bucket_id, name) values ('ledger-files', %L)$q$,
  audit_ledger.id(6,1)::text || '/' || gen_random_uuid()::text || '/x.pdf'), '42501');
select audit_ledger.expect_error(format('select public.ledger_add_file(gen_random_uuid(), %L, %L, %L, 10, %L)', audit_ledger.idof('hoarding'), 'x', 'elsewhere/x.pdf', 'application/pdf'), '22023');
select audit_ledger.expect_error(format('select public.ledger_add_link(gen_random_uuid(), %L, %L, %L)', audit_ledger.idof('hoarding'), 'x', 'javascript:alert(1)'), '22023');
select audit_ledger.as_user(3);
do $$ begin assert (select count(*) from storage.objects where bucket_id = 'ledger-files') = 1, 'manager reads the attached file'; end $$;
select audit_ledger.as_user(2);
do $$ begin assert (select count(*) from storage.objects where bucket_id = 'ledger-files') = 0, 'peer cannot'; end $$;
select 'PASS: files upload only into the owner''s own task folders, and are readable exactly where the task is' as result;

-- Search and alerts -------------------------------------------------------------------------------
select audit_ledger.as_user(1);
do $$ declare _s jsonb;
begin
  _s := public.ledger_search('NAVARATRI');
  assert _s->'tasks' @> jsonb_build_array(jsonb_build_object('title', 'Navaratri window')), 'search finds titles, any case';
  assert jsonb_array_length(public.ledger_search('%')->'tasks') = 0 and jsonb_array_length(public.ledger_search('n')->'tasks') = 0, 'wildcards are literal; one letter is too short';
  assert public.ledger_search('MG Road')->'deliverables' @> '[{"version":"v3"}]', 'deliverables searchable';
end $$;
reset role;
update public.ledger_campaigns set stage = 'Decision', decision = null where name = 'Navaratri 2026' and owner_user = audit_ledger.id(6,1);
update public.ledger_campaigns set stage = 'Live', measure = '{}' where name = 'Diwali 2026' and owner_user = audit_ledger.id(6,1);
update public.ledger_campaigns set stage = 'Parked', blocker = 'Budget' where name = 'Monsoon stays' and owner_user = audit_ledger.id(6,1);
update public.ledger_ideas set status = 'Parked', revisit_date = app.ledger_today() + 3, revisit_when = 'after Diwali' where owner_user = audit_ledger.id(6,1);
set role authenticated;
select audit_ledger.as_user(1);
do $$ declare _alerts jsonb := public.ledger_home()->'alerts';
begin
  assert _alerts @> '[{"kind":"decision","title":"Navaratri 2026","text":"Decision needed is not written yet"}]', 'decision alert';
  assert _alerts @> '[{"kind":"review","title":"Diwali 2026","text":"Live without a review date"}]', 'review alert';
  assert _alerts @> '[{"kind":"idea","text":"Revisit when after Diwali"}]', 'parked idea resurfaces';
  assert not (_alerts @> '[{"title":"Monsoon stays"}]'), 'parked campaigns stay quiet';
end $$;
reset role;
select 'PASS: search is literal and covers deliverables; Home alerts cover decisions, reviews and parked ideas but not parked campaigns' as result;
