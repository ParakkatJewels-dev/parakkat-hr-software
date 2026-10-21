-- The old Google Sheet import (0175). Runs after work_creative.sql: dept A is the creative team, so
-- person 1 is a member and person 4 is not. Each import batch is its own statement, as each call from
-- the app is its own transaction (the import switch lasts only that long).
\set ON_ERROR_STOP on
create temp table import_ids(label text primary key, id uuid);
grant all on import_ids to authenticated, anon;

do $$ begin
  assert not has_function_privilege('anon', 'public.work_import_batch(text,jsonb)', 'execute'), 'anon cannot import';
  assert has_function_privilege('authenticated', 'public.work_import_batch(text,jsonb)', 'execute'), 'signed-in staff call it';
  assert not has_function_privilege('authenticated', 'app.work_import_rows(uuid,uuid,text,jsonb)', 'execute'), 'the worker is internal';
  assert not has_table_privilege('authenticated', 'app.work_import_map', 'select'), 'the import map is internal';
end $$;

set role authenticated;
select audit_ledger.as_user(4);
select audit_ledger.expect_error($q$select public.work_import_batch('tasks', '[]')$q$, '42501');
select audit_ledger.as_user(1);
select audit_ledger.expect_error($q$select public.work_import_batch('people', '[]')$q$, '22023');
select audit_ledger.expect_error($q$select public.work_import_batch('tasks', (select jsonb_agg(jsonb_build_object('legacy_row', n)) from generate_series(1, 301) n))$q$, '22023');

-- Library first, then campaigns, tasks and what hangs off them -----------------------------------------
select public.work_import_batch('brands', '[{"legacy_row":2,"brand":"Parakkat Jewels","tone":"Sheet tone"},{"legacy_row":3,"brand":"Parakkat Bakes","tone":"Warm"}]');
select public.work_import_batch('vendors', '[{"legacy_row":2,"name":"studio lumen","phone":"000"},{"legacy_row":3,"name":"Kochi Prints","role":"Printer","rating":4}]');
select public.work_import_batch('campaigns', '[{"legacy_row":2,"name":"Onam push","stage":"Live"},
  {"legacy_row":3,"name":"Vishu 2027","brand":"Parakkat Jewels","stage":"Developing","priority":"High","created_at":"2026-08-01T10:00",
   "log":[{"at":"2026-08-01T10:00","text":"Created at Captured"},{"at":"2026-08-05T11:00","text":"Stage: Captured → Developing"}]}]');
select public.work_import_batch('tasks', '[
  {"legacy_row":2,"title":"Wedding catalogue","status":"Revisions","revision":2,"priority":"High","campaign":"Vishu 2027","vendor":"Kochi Prints",
   "deadline":"2026-12-01","logged_at":"2026-09-01T10:00","est_cost":5000,"tags":["Print"],"brand":"Parakkat Jewels","type":"Print",
   "notes":"📎 Proof — https://example.test/proof","attachments":[{"name":"Proof","url":"https://example.test/proof"}],"pinned":true},
  {"legacy_row":3,"title":"Old poster","status":"Delivered","logged_at":"2026-09-02T10:00","end_date":"2026-09-10","outcome":"Printed 200"},
  {"legacy_row":4,"title":"Reviewed menu","entry_kind":"support","for_whom":"Priya","minutes":30,"work_date":"2026-09-05"},
  {"legacy_row":5,"title":"Christmas window","status":"Brief","campaign":"Christmas lights","logged_at":"2026-09-06T10:00"}]');
select public.work_import_batch('subtasks', '[{"legacy_row":2,"parent_row":2,"text":"Layout","done":true},{"legacy_row":3,"parent_row":2,"text":"Proof","done":true},
  {"legacy_row":4,"parent_row":3,"text":"Never ticked","done":false},{"legacy_row":5,"parent_row":99,"text":"Orphan"}]');
select public.work_import_batch('deliverables', '[{"legacy_row":2,"parent_row":2,"type":"Catalogue","version":"v2","link":"https://example.test/v2"},
  {"legacy_row":3,"parent_row":2,"type":null,"link":"Shared drive folder"}]');
select public.work_import_batch('progress', '[{"legacy_row":2,"task_row":5,"date":"2026-09-07","note":"Measured the window","minutes":20}]');
select public.work_import_batch('ideas', '[{"legacy_row":2,"text":"Vishu gold rush","original":"Vishu idea","status":"Developing","created_at":"2026-08-02T09:00",
  "concept":{"oneLine":"Gold rush"}}]');
select public.work_import_batch('reminders', '[{"legacy_row":2,"text":"Chase the catalogue printer","due_at":"2026-12-01T10:00","task_row":2}]');
select public.work_import_batch('links', '[{"kind":"task_depends","legacy_row":5,"depends_on_row":2},{"kind":"idea_refs","legacy_row":2,"campaign_row":3},
  {"kind":"campaign_ideas","legacy_row":3,"idea_rows":[2]}]');

insert into import_ids select 'catalogue', id from public.tasks where title = 'Wedding catalogue' and deleted_at is null;
insert into import_ids select 'poster', id from public.tasks where title = 'Old poster' and deleted_at is null;
insert into import_ids select 'window', id from public.tasks where title = 'Christmas window' and deleted_at is null;

do $$ declare _t public.tasks; _c jsonb;
begin
  select * into _t from public.tasks where id = (select id from import_ids where label = 'catalogue');
  assert _t.employee_id = audit_ledger.id(7,1) and _t.assigned_by = audit_ledger.id(7,1), 'imported work is the importer''s own';
  assert _t.status = 'In Progress' and _t.review_stage = 'Revisions' and _t.revision = 2, 'Revisions keeps its round count';
  assert app.ledger_ist_date(_t.created_at) = '2026-09-01', 'logged on the Sheet''s day';
  assert _t.est_cost = 5000 and _t.actual_cost is null and _t.completed_at is null, 'blank costs and an open task stay blank';
  assert _t.tags = array['print'] and _t.work_type = 'Print', 'tags and type';
  assert (select name from public.creative_campaigns where id = _t.campaign_id) = 'Vishu 2027', 'campaign by name';
  assert (select name from public.creative_vendors where id = _t.vendor_id) = 'Kochi Prints', 'vendor by name';
  assert exists (select 1 from public.task_assignees where task_id = _t.id and employee_id = audit_ledger.id(7,1)), 'the importer is on the task';
  assert exists (select 1 from public.task_attachments where task_id = _t.id and url = 'https://example.test/proof'), 'links in the notes become links';
  assert (select pinned from public.task_marks where task_id = _t.id) is true, 'pinned stays pinned';
  assert not exists (select 1 from public.task_events where task_id = _t.id), 'no history is invented by the import';
  assert (select count(*) from public.task_checklist_items where task_id = _t.id and completed_at is not null) = 2, 'ticked subtasks';
  assert (select status from public.tasks where id = _t.id) = 'In Progress', 'all subtasks ticked does not finish work under review';
  assert (select count(*) from public.task_deliverables where task_id = _t.id) = 2
    and exists (select 1 from public.task_deliverables where task_id = _t.id and type = 'Shared drive folder' and link is null), 'a non-web link is kept as a name';
  select * into _t from public.tasks where id = (select id from import_ids where label = 'poster');
  assert _t.status = 'Done' and app.ledger_ist_date(_t.completed_at) = '2026-09-10' and _t.outcome = 'Printed 200', 'Delivered on its own day';
  assert exists (select 1 from public.task_checklist_items where task_id = _t.id and completed_at is null), 'an unticked subtask';
  assert _t.status = 'Done', 'and the delivered task is not reopened';
  select * into _t from public.tasks where id = (select id from import_ids where label = 'window');
  assert _t.status = 'To Do', 'a progress note does not start imported work';
  assert _t.depends_on_task_id = (select id from import_ids where label = 'catalogue'), 'depends on';
  assert (select stage from public.creative_campaigns where name = 'Christmas lights') = 'Captured', 'a campaign named only on a task is created';
  assert exists (select 1 from public.task_progress where task_id = _t.id and on_date = '2026-09-07' and employee_id = audit_ledger.id(7,1)), 'progress note';
  assert exists (select 1 from public.task_help_log where what = 'Reviewed menu' and on_date = '2026-09-05' and minutes = 30
    and employee_id = audit_ledger.id(7,1)), 'support rows go to the help log';
  assert not exists (select 1 from public.tasks where title = 'Reviewed menu'), 'and never onto a board';
  _c := public.creative_campaign((select id from public.creative_campaigns where name = 'Vishu 2027'));
  assert jsonb_array_length(_c->'log') = 2 and _c->'log'->0->>'text' = 'Stage: Captured → Developing', 'the Sheet''s campaign log, not a new one';
  assert (select stage from public.creative_campaigns where name = 'Onam push') = 'Decision', 'an existing campaign is linked, not overwritten';
  assert (select phone from public.creative_vendors where name = 'Studio Lumen') is distinct from '000', 'an existing vendor is not overwritten';
  assert (select foundation->>'tone' from public.creative_brands where name = 'Parakkat Bakes') = 'Warm', 'a new brand';
  assert (select foundation->>'tone' from public.creative_brands where name = 'Parakkat Jewels') is distinct from 'Sheet tone', 'brand notes written here stay';
  assert (select original from public.creative_ideas where text = 'Vishu gold rush') = 'Vishu idea', 'the idea''s first wording';
  assert (select status from public.creative_ideas where text = 'Vishu gold rush') = 'Developing', 'and its status';
  assert (select campaign_id from public.creative_ideas where text = 'Vishu gold rush') = (select id from public.creative_campaigns where name = 'Vishu 2027'), 'idea → campaign';
  assert exists (select 1 from public.creative_campaign_ideas ci join public.creative_campaigns c on c.id = ci.campaign_id where c.name = 'Vishu 2027'), 'campaign ← idea';
  assert (select work_task_id from public.ledger_reminders where text = 'Chase the catalogue printer') = (select id from import_ids where label = 'catalogue'), 'reminder on its task';
end $$;
select 'PASS: the Sheet comes in as tasks, help, subtasks, deliverables, notes, campaigns, ideas and reminders, with its own dates and history' as result;

-- Again: no duplicates; changes made here are kept ---------------------------------------------------
select public.work_import_batch('tasks', '[{"legacy_row":2,"title":"Wedding catalogue","status":"Approved","revision":2,"approved_version":"v2","campaign":"Vishu 2027"},
  {"legacy_row":3,"title":"Old poster (reprint)","status":"Delivered","end_date":"2026-09-10"}]');
do $$ begin
  assert (select count(*) from public.tasks where title like 'Wedding catalogue%' and deleted_at is null) = 1, 'no duplicate';
  assert (select review_stage from public.tasks where id = (select id from import_ids where label = 'catalogue')) = 'Approved', 'an untouched row is updated';
  assert (select title from public.tasks where id = (select id from import_ids where label = 'poster')) = 'Old poster (reprint)', 'and renamed';
end $$;
update public.tasks set title = 'Wedding catalogue — final' where id = (select id from import_ids where label = 'catalogue');
do $$ declare _p jsonb; _r jsonb;
begin
  _p := public.work_import_preview('tasks', array[2,3,4,9]);
  assert (_p->>'existing')::int = 3 and _p->'edited_rows' = '[2]'::jsonb, 'the check names the row changed here';
end $$;
select public.work_import_batch('tasks', '[{"legacy_row":2,"title":"Wedding catalogue","status":"Brief"}]') ->> 'kept_rows' as kept;
do $$ begin
  assert (select title from public.tasks where id = (select id from import_ids where label = 'catalogue')) = 'Wedding catalogue — final', 'an edit here is kept';
  assert (select status from public.tasks where id = (select id from import_ids where label = 'catalogue')) = 'In Progress', 'and not reset';
end $$;
-- After the import call the usual rules are back: a step writes history.
update public.tasks set review_stage = 'Revisions' where id = (select id from import_ids where label = 'catalogue');
do $$ begin
  assert (select revision from public.tasks where id = (select id from import_ids where label = 'catalogue')) = 3, 'rounds count again';
  assert exists (select 1 from public.task_events where task_id = (select id from import_ids where label = 'catalogue') and kind = 'step'), 'and history is written';
end $$;
reset role;
select 'PASS: re-importing updates untouched rows only, the check lists edits, and the usual rules return after each call' as result;
