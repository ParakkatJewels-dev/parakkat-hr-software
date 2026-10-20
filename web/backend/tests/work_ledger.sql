-- Work Ledger (0169): privacy, import, reports and date rules. Disposable database, synthetic data only.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_work_ledger_audit' then raise exception 'requires disposable hr_work_ledger_audit database'; end if;
end $$;

create schema audit_ledger;
create function audit_ledger.id(prefix integer, n integer) returns uuid language sql immutable as $$
  select (prefix::text || '0000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
create function audit_ledger.expect_error(statement text, expected_code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate <> expected_code then raise; end if;
    return;
  end;
  raise exception 'Expected SQLSTATE %', expected_code;
end $$;
-- Rows of ledger_tasks the current session can see.
create function audit_ledger.visible_tasks() returns bigint language sql as $$ select count(*) from public.ledger_tasks $$;
create function audit_ledger.as_user(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', audit_ledger.id(6, n)::text, false);
end $$;
grant usage on schema audit_ledger to authenticated, anon;
grant execute on all functions in schema audit_ledger to authenticated, anon;

-- Company 1 has departments A (4,1) and B (4,2) in branch 3,1; company 2 is elsewhere.
insert into public.entities(id, code, name) select audit_ledger.id(1,n), 'LED-ENT-'||n, 'Ledger company '||n from generate_series(1,2)n;
insert into public.zones(id, entity_id, code, name) select audit_ledger.id(2,n), audit_ledger.id(1,n), 'LED-ZONE-'||n, 'Ledger zone '||n from generate_series(1,2)n;
insert into public.branches(id, entity_id, zone_id, code, name, address)
  select audit_ledger.id(3,n), audit_ledger.id(1,n), audit_ledger.id(2,n), 'LED-BR-'||n, 'Ledger branch '||n, 'Address' from generate_series(1,2)n;
insert into public.departments(id, entity_id, branch_id, code, name) values
  (audit_ledger.id(4,1), audit_ledger.id(1,1), audit_ledger.id(3,1), 'LED-A', 'Creative'),
  (audit_ledger.id(4,2), audit_ledger.id(1,1), audit_ledger.id(3,1), 'LED-B', 'Sales'),
  (audit_ledger.id(4,3), audit_ledger.id(1,2), audit_ledger.id(3,2), 'LED-C', 'Elsewhere');
-- 1 owner (employee, dept A)      2 peer (employee, dept A)      3 head of dept A
-- 4 head of dept B                5 branch manager of branch 1   6 entity admin of company 1
-- 7 HR manager of company 1       8 super admin (profile flag)   9 entity admin of company 2
-- 10 second head of dept A (peer rank of an owner who is a head)
insert into auth.users(id, email) select audit_ledger.id(6,n), 'ledger-'||n||'@audit.invalid' from generate_series(1,10)n;
insert into public.employees(id, entity_id, branch_id, department_id, full_name, employee_code, email, join_date)
  select audit_ledger.id(7,n), audit_ledger.id(1, case when n = 9 then 2 else 1 end), audit_ledger.id(3, case when n = 9 then 2 else 1 end),
    audit_ledger.id(4, case when n in (4) then 2 when n = 9 then 3 else 1 end), 'Ledger Person '||n, 'LED-'||n, 'p'||n||'@audit.invalid', '2026-01-01'
  from generate_series(1,10)n;
update public.profiles p set employee_id = audit_ledger.id(7, n) from generate_series(1,10)n where p.user_id = audit_ledger.id(6, n);
update public.profiles set is_super_admin = true where user_id = audit_ledger.id(6,8);
insert into public.role_assignments(user_id, role_id, scope_type, scope_id)
  select audit_ledger.id(6,3), id, 'department'::scope_type, audit_ledger.id(4,1) from public.roles where key = 'dept_head'
  union all select audit_ledger.id(6,4), id, 'department'::scope_type, audit_ledger.id(4,2) from public.roles where key = 'dept_head'
  union all select audit_ledger.id(6,5), id, 'branch'::scope_type, audit_ledger.id(3,1) from public.roles where key = 'branch_manager'
  union all select audit_ledger.id(6,6), id, 'entity'::scope_type, audit_ledger.id(1,1) from public.roles where key = 'entity_admin'
  union all select audit_ledger.id(6,7), id, 'entity'::scope_type, audit_ledger.id(1,1) from public.roles where key = 'hr_manager'
  union all select audit_ledger.id(6,9), id, 'entity'::scope_type, audit_ledger.id(1,2) from public.roles where key = 'entity_admin'
  union all select audit_ledger.id(6,10), id, 'department'::scope_type, audit_ledger.id(4,1) from public.roles where key = 'dept_head';
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_ledger.id(6,n), id, 'self'::scope_type from public.roles, generate_series(1,2) n where key = 'employee';

-- Grants: read-only tables, RPCs for signed-in users only ------------------------------------------
do $$ declare _table text; _role text;
begin
  foreach _table in array array['ledger_tasks','ledger_task_log','ledger_subtasks','ledger_deliverables','ledger_progress',
    'ledger_campaigns','ledger_campaign_log','ledger_ideas','ledger_vendors','ledger_templates','ledger_key_dates',
    'ledger_brands','ledger_reminders','ledger_settings','ledger_attachments','ledger_campaign_ideas'] loop
    assert has_table_privilege('authenticated', 'public.'||_table, 'select'), 'readable '||_table;
    foreach _role in array array['authenticated','anon'] loop
      assert not has_table_privilege(_role, 'public.'||_table, 'insert,update,delete'), _role||' cannot write '||_table;
    end loop;
    assert not has_table_privilege('anon', 'public.'||_table, 'select'), 'anon cannot read '||_table;
    assert (select relrowsecurity from pg_class where oid = ('public.'||_table)::regclass), 'RLS on '||_table;
    assert exists(select 1 from pg_policies where schemaname = 'public' and tablename = _table
      and policyname = 'active_account_required' and permissive = 'RESTRICTIVE'), 'active account guard on '||_table;
  end loop;
  assert not has_function_privilege('anon', 'public.ledger_open()', 'execute'), 'anon cannot open a ledger';
  assert not has_function_privilege('authenticated', 'app.ledger_report_data(uuid,text,date,date,date,boolean)', 'execute'), 'report core is internal';
end $$;
select 'PASS: ledger tables are read-only to clients, closed to anon, RLS-protected with the active-account guard' as result;

-- Dates -------------------------------------------------------------------------------------------
do $$ begin
  assert app.ledger_advance_date('2026-01-31', 'monthly') = '2026-02-28', 'monthly clamps to February';
  assert app.ledger_advance_date('2028-01-31', 'monthly') = '2028-02-29', 'leap year';
  assert app.ledger_advance_date('2026-02-28', 'monthly') = '2026-03-28', 'counts from the previous deadline';
  assert app.ledger_advance_date('2026-10-09', 'weekdays') = '2026-10-12', 'Friday to Monday';
  assert app.ledger_advance_date('2026-10-10', 'weekdays') = '2026-10-12', 'Saturday to Monday';
  assert app.ledger_advance_date('2026-10-07', 'weekdays') = '2026-10-08', 'midweek to next day';
  assert app.ledger_advance_date('2026-10-07', 'daily') = '2026-10-08' and app.ledger_advance_date('2026-10-07', 'weekly') = '2026-10-14', 'daily and weekly';
  assert (select from_date = '2026-10-05' and to_date = '2026-10-11' and not single_day from app.ledger_period('week', '2026-10-11', '2026-10-20')), 'Sunday belongs to the week starting Monday';
  assert (select from_date = '2026-02-01' and to_date = '2026-02-28' from app.ledger_period('month', '2026-02', '2026-10-20')), 'month range';
  assert (select from_date = '2026-10-20' and single_day from app.ledger_period('day', null, '2026-10-20')), 'today by default';
  assert (select from_date = '2000-01-01' and to_date = '2026-10-20' from app.ledger_period('all', null, '2026-10-20')), 'overall';
  assert (select from_date = '2026-10-01' and to_date = '2026-10-15' from app.ledger_period('range', '2026-10-01|2026-10-15', '2026-10-20')), 'custom';
  assert app.ledger_ist_timestamp('2026-10-07T23:30') = '2026-10-07 18:00:00+00', 'wall-clock time in Asia/Kolkata';
end $$;
select audit_ledger.expect_error($q$select * from app.ledger_period('range','2026-10-15|2026-10-01','2026-10-20')$q$, '22023');
select audit_ledger.expect_error($q$select * from app.ledger_period('month','October','2026-10-20')$q$, '22023');
select audit_ledger.expect_error($q$select * from app.ledger_period('day','2026-02-30','2026-10-20')$q$, '22023');
select audit_ledger.expect_error($q$select * from app.ledger_period('year',null,'2026-10-20')$q$, '22023');
select 'PASS: monthly repeats clamp to month end, weekdays skip weekends, periods run Monday to Sunday in Asia/Kolkata' as result;

-- Opening and importing ---------------------------------------------------------------------------
set role authenticated;
select audit_ledger.as_user(1);
do $$ declare _boot jsonb;
begin
  _boot := public.ledger_open();
  assert jsonb_array_length(_boot->'brands') = 5, 'five starter brands';
  assert _boot->'brands'->0->>'label' = 'Jewels', 'brand order starts with Jewels';
  assert jsonb_array_length(_boot->'templates') = 4, 'four starter templates';
  assert _boot->'owner'->>'name' = 'Ledger Person 1', 'owner from the employee record';
  assert jsonb_array_length(public.ledger_open()->'brands') = 5, 'opening twice adds nothing';
end $$;
select audit_ledger.expect_error($q$insert into public.ledger_tasks(title) values ('direct write')$q$, '42501');
select audit_ledger.expect_error($q$update public.ledger_brands set name = 'x'$q$, '42501');
select audit_ledger.expect_error($q$delete from public.ledger_brands$q$, '42501');

create temp table import_results(kind text, result jsonb);
grant all on import_results to authenticated;
insert into import_results values
  ('brands', public.ledger_import_batch('brands', '[{"legacy_row":2,"brand":"Parakkat Jewels","positioning":"Heritage gold","tone":"Warm"},
    {"legacy_row":3,"brand":"Parakkat Munnar Resort","positioning":"Hill retreat"}]')),
  ('vendors', public.ledger_import_batch('vendors', '[{"legacy_row":2,"name":"Lumen Studio","role":"Photographer","rating":4,"last_worked":"2026-09-30"}]')),
  ('campaigns', public.ledger_import_batch('campaigns', '[{"legacy_row":2,"name":"Diwali 2026","brand":"Parakkat Jewels","stage":"Production",
    "priority":"High","launch_date":"2026-10-25","measure":{"primary":"Walk-ins","target":"300"},"log":[{"at":"2026-09-01T10:00","text":"Captured"},{"at":"2026-09-10T11:00","text":"Stage: Captured → Production"}]}]')),
  ('tasks', public.ledger_import_batch('tasks', '[
    {"legacy_row":2,"logged_at":"2026-10-01T09:00","work_date":"2026-10-01","brand":"Parakkat Jewels","title":"Diwali hoarding v2","status":"Internal Review","priority":"High",
     "status_since":"2026-10-07","last_updated":"2026-10-07","campaign":"Diwali 2026","vendor":"Lumen Studio","tags":["print","outdoor"],"est_cost":12000,"actual_cost":11500,
     "notes":"[1 Oct] Draft shared\n📎 proof.pdf — https://drive.example/proof","attachments":[{"name":"proof.pdf","url":"https://drive.example/proof"}],"type":"Print"},
    {"legacy_row":3,"logged_at":"2026-10-07T10:00","work_date":"2026-10-07","brand":"General","title":"New banner idea","status":"Brief","status_since":"2026-10-07","last_updated":"2026-10-07"},
    {"legacy_row":4,"logged_at":"2026-09-20T10:00","work_date":"2026-09-20","brand":"Parakkat Munnar Resort","title":"Resort reel edit","status":"In Progress","status_since":"2026-09-25","last_updated":"2026-10-07","campaign":"Monsoon stays"},
    {"legacy_row":5,"logged_at":"2026-09-15T10:00","work_date":"2026-09-15","brand":"Parakkat Riverscape","title":"Menu card print","status":"Delivered","status_since":"2026-10-07","last_updated":"2026-10-07","outcome":"Printed 200 cards","actual_cost":4000},
    {"legacy_row":6,"logged_at":"2026-10-07T12:00","work_date":"2026-10-07","brand":"Parakkat Riverscape","title":"Reviewed menu layout","status":"Delivered","entry_kind":"support","for_whom":"Priya","minutes":20,"type":"Review / Feedback","status_since":"2026-10-07","last_updated":"2026-10-07"},
    {"legacy_row":7,"logged_at":"2026-09-01T10:00","work_date":"2026-09-01","brand":"Parakkat Adimali Retreat","title":"Brochure reprint","status":"In Progress","deadline":"2026-10-01","status_since":"2026-09-05","last_updated":"2026-09-05"},
    {"legacy_row":8,"logged_at":"2026-09-01T10:00","work_date":"2026-09-01","brand":"Parakkat Jewels","title":"Showroom signage","status":"Blocked","waiting_on":"Landlord approval","status_since":"2026-10-06","last_updated":"2026-10-06"},
    {"legacy_row":9,"logged_at":"2026-09-01T10:00","work_date":"2026-09-01","brand":"Parakkat Jewels","title":"Old flyer","status":"Cancelled","status_since":"2026-10-07","last_updated":"2026-10-07"},
    {"legacy_row":11,"logged_at":"2026-09-01T10:00","work_date":"2026-09-01","brand":"Parakkat Jewels","title":"Website banner","status":"Approved","status_since":"2026-09-30","last_updated":"2026-09-30","approved_version":"v3"}
  ]')),
  ('subtasks', public.ledger_import_batch('subtasks', '[{"legacy_row":2,"parent_row":2,"text":"Copy","done":true},{"legacy_row":3,"parent_row":2,"text":"Layout"},{"legacy_row":4,"parent_row":99,"text":"Orphan"}]')),
  ('deliverables', public.ledger_import_batch('deliverables', '[{"legacy_row":2,"parent_row":2,"type":"Hoarding 20x10","version":"v2","link":"https://drive.example/v2","used_where":"MG Road"}]')),
  ('progress', public.ledger_import_batch('progress', '[{"legacy_row":2,"task_row":4,"date":"2026-10-07","note":"Colour grade first half","minutes":90},
    {"legacy_row":3,"task_row":5,"date":"2026-10-06","note":"Proof approved"}]')),
  ('ideas', public.ledger_import_batch('ideas', '[{"legacy_row":2,"text":"Reel series on resort mornings","original":"reel series on mornings","brand":"Parakkat Munnar Resort","status":"Promoted","created_at":"2026-10-07T08:00"}]')),
  ('reminders', public.ledger_import_batch('reminders', '[{"legacy_row":2,"text":"Call printer","due_at":"2026-10-08T10:00","task_row":5,"source":"followup"}]')),
  ('links', public.ledger_import_batch('links', '[{"kind":"task_depends","legacy_row":2,"depends_on_row":11},{"kind":"idea_refs","legacy_row":2,"task_row":4,"campaign_row":2},
    {"kind":"campaign_ideas","legacy_row":2,"idea_rows":[2]}]'));
do $$ declare _boot jsonb := public.ledger_bootstrap();
begin
  assert (select (result->>'inserted')::integer from import_results where kind = 'tasks') = 9, 'nine task rows inserted';
  assert (select result->'unresolved_rows' from import_results where kind = 'subtasks') = '[4]'::jsonb, 'orphan subtask reported';
  assert (_boot->'counts'->>'tasks')::integer = 8 and (_boot->'counts'->>'support')::integer = 1, 'support kept apart from tasks';
  assert (_boot->'counts'->>'campaigns')::integer = 2, 'campaign named only on a task is created';
  assert exists(select 1 from public.ledger_campaigns where name = 'Monsoon stays' and stage = 'Captured'), 'created at Captured';
  assert (select count(*) from public.ledger_campaign_log) = 2, 'campaign log imported';
  assert (select depends_on from public.ledger_tasks where legacy_row = 2) = (select id from public.ledger_tasks where legacy_row = 11), 'dependency linked';
  assert (select task_id is not null and campaign_id is not null from public.ledger_ideas where legacy_row = 2), 'idea references linked';
  assert (select count(*) from public.ledger_campaign_ideas) = 1, 'campaign origin linked';
  assert (select count(*) from public.ledger_attachments where kind = 'link') = 1, 'attachment link kept';
  assert (select foundation->>'positioning' from public.ledger_brands where name = 'Parakkat Jewels') = 'Heritage gold', 'brand foundation merged into the starter brand';
  assert (select count(*) from public.ledger_brands) = 5, 'no duplicate brands';
  assert (select vendor_id is not null from public.ledger_tasks where legacy_row = 2), 'vendor linked';
end $$;
-- Importing the same rows again changes nothing; a row edited here since import is reported, not overwritten.
do $$ declare _again jsonb; _preview jsonb;
begin
  _again := public.ledger_import_batch('progress', '[{"legacy_row":2,"task_row":4,"date":"2026-10-07","note":"Colour grade first half","minutes":90}]');
  assert (_again->>'inserted')::integer = 0 and (_again->>'updated')::integer = 1, 're-import updates in place';
  assert (select count(*) from public.ledger_progress) = 2, 'no duplicate progress';
end $$;
reset role;
update public.ledger_tasks set title = 'Edited in the new app', updated_at = clock_timestamp() + interval '1 second' where legacy_row = 3;
set role authenticated;
do $$ declare _again jsonb; _preview jsonb;
begin
  _preview := public.ledger_import_preview('tasks', array[2,3,77]);
  assert (_preview->>'existing')::integer = 2 and _preview->'edited_rows' = '[3]'::jsonb, 'preview flags the edited row';
  _again := public.ledger_import_batch('tasks', '[{"legacy_row":3,"logged_at":"2026-10-07T10:00","brand":"General","title":"New banner idea","status":"Brief"}]');
  assert _again->'saved_rows' = '[]'::jsonb, 'edited row not saved';
  assert (select title from public.ledger_tasks where legacy_row = 3) = 'Edited in the new app', 'edit kept';
  assert (select count(*) from public.ledger_tasks) = 9, 'no duplicate tasks';
end $$;
select audit_ledger.expect_error($q$select public.ledger_import_batch('payroll','[]')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_import_batch('tasks','{}')$q$, '22023');
select public.ledger_import_lock(true);
select audit_ledger.expect_error($q$select public.ledger_import_batch('ideas','[]')$q$, '55000');
select public.ledger_import_lock(false);
select 'PASS: import creates every entity, links references, keeps support apart, re-imports in place and never overwrites edits' as result;

-- Privacy -----------------------------------------------------------------------------------------
do $$ begin
  assert audit_ledger.visible_tasks() = 9, 'owner sees their ledger';
  assert (select count(*) from public.ledger_reminders) = 1, 'owner sees their reminders';
end $$;
select audit_ledger.as_user(2);
do $$ begin assert audit_ledger.visible_tasks() = 0, 'a peer sees nothing'; end $$;
select audit_ledger.expect_error(format('select public.ledger_bootstrap(%L)', audit_ledger.id(6,1)), '42501');
select audit_ledger.expect_error(format('select public.ledger_report(''day'', null, %L)', audit_ledger.id(6,1)), '42501');
select audit_ledger.as_user(3);
do $$ declare _boot jsonb;
begin
  assert audit_ledger.visible_tasks() = 9, 'department head reads their team member''s ledger';
  assert (select count(*) from public.ledger_reminders) = 0, 'managers never see reminders';
  _boot := public.ledger_bootstrap(audit_ledger.id(6,1));
  assert _boot->'counts'->'reminders' = 'null'::jsonb, 'reminder count hidden from managers';
  assert (public.ledger_report('all', null, audit_ledger.id(6,1))->'delivered') @> '[{"title":"Menu card print"}]', 'manager can read reports';
  assert exists(select 1 from public.ledger_team_members() where user_id = audit_ledger.id(6,1)), 'owner listed in the team view';
  assert not exists(select 1 from public.ledger_team_members() where user_id = audit_ledger.id(6,10)), 'a fellow head is not listed';
  -- A manager's own ledger stays separate: writing goes to their own rows only.
  perform public.ledger_import_batch('ideas', '[{"legacy_row":2,"text":"Head''s own idea"}]');
  assert (select count(*) from public.ledger_ideas where owner_user = audit_ledger.id(6,1)) = 1, 'owner''s ideas untouched by the manager';
end $$;
select audit_ledger.as_user(4);
do $$ begin assert audit_ledger.visible_tasks() = 0, 'head of another department sees nothing'; end $$;
select audit_ledger.as_user(5);
do $$ begin assert audit_ledger.visible_tasks() = 9, 'branch manager above the owner reads'; end $$;
select audit_ledger.as_user(6);
do $$ begin assert audit_ledger.visible_tasks() = 9, 'company admin above the owner reads'; end $$;
select audit_ledger.as_user(7);
do $$ begin assert audit_ledger.visible_tasks() = 0, 'HR manager is not a line manager'; end $$;
select audit_ledger.as_user(8);
do $$ begin assert audit_ledger.visible_tasks() = 0, 'super admin does not read personal ledgers'; end $$;
select audit_ledger.expect_error(format('select public.ledger_bootstrap(%L)', audit_ledger.id(6,1)), '42501');
select audit_ledger.as_user(9);
do $$ begin assert audit_ledger.visible_tasks() = 0, 'admin of another company sees nothing'; end $$;
-- An owner who is themselves a department head: a fellow head (same rank) cannot read, the branch manager can.
select audit_ledger.as_user(3);
select public.ledger_import_batch('tasks', '[{"legacy_row":2,"title":"Head''s own task","status":"Brief"}]');
select audit_ledger.as_user(10);
do $$ begin assert (select count(*) from public.ledger_tasks where owner_user = audit_ledger.id(6,3)) = 0, 'same rank cannot read'; end $$;
select audit_ledger.as_user(5);
do $$ begin assert (select count(*) from public.ledger_tasks where owner_user = audit_ledger.id(6,3)) = 1, 'higher rank can read'; end $$;
reset role;
update auth.users set banned_until = clock_timestamp() + interval '1 day' where id = audit_ledger.id(6,5);
set role authenticated;
do $$ begin assert audit_ledger.visible_tasks() = 0, 'a banned manager loses access at once'; end $$;
reset role;
update auth.users set banned_until = null where id = audit_ledger.id(6,5);
set role authenticated;
reset role;
-- Without ledger.use a person cannot open or write a ledger.
delete from public.role_permissions where role_id = (select id from public.roles where key = 'employee')
  and permission_id = (select id from public.permissions where key = 'ledger.use');
set role authenticated;
select audit_ledger.as_user(2);
select audit_ledger.expect_error('select public.ledger_open()', '42501');
reset role;
insert into public.role_permissions(role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p
  where r.key = 'employee' and p.key = 'ledger.use';
select 'PASS: owner and line managers above them read; peers, other departments, HR, super admins and banned accounts do not; managers never see reminders' as result;

-- Reports -----------------------------------------------------------------------------------------
do $$ declare _day jsonb; _week jsonb; _worked jsonb;
begin
  _day := app.ledger_report_data(audit_ledger.id(6,1), 'day', '2026-10-07', '2026-10-07', '2026-10-07', true);
  _worked := _day->'worked_on';
  assert jsonb_array_length(_worked) = 3, 'three tasks worked on';
  assert _worked->0->>'title' = 'Diwali hoarding v2' and _worked->0->>'event' = 'Sent for internal review' and (_worked->0->>'group')::integer = 0, 'review moves first';
  assert _worked @> '[{"title":"Resort reel edit","event":null,"group":2}]', 'a progress note counts as worked on';
  assert (select jsonb_array_length(w->'notes') from jsonb_array_elements(_worked) w where w->>'title' = 'Resort reel edit') = 1, 'note of the day attached';
  assert _worked @> '[{"title":"Edited in the new app","is_new":true,"event":null}]', 'logged today at Brief is new, not a move';
  assert not (_worked @> '[{"title":"Old flyer"}]'), 'cancelled tasks are not worked on';
  assert not (_worked @> '[{"title":"Reviewed menu layout"}]'), 'support never appears as work';
  assert _day->'delivered' @> '[{"title":"Menu card print","outcome":"Printed 200 cards"}]', 'delivered today';
  assert (select jsonb_array_length(d->'notes') from jsonb_array_elements(_day->'delivered') d) = 1, 'delivered keeps its progress notes';
  assert _day->'support' @> '[{"title":"Reviewed menu layout","for_whom":"Priya","minutes":20}]', 'support listed';
  assert (_day->>'support_minutes')::integer = 20 and _day->'support_by_person' @> '[{"person":"Priya","count":1}]', 'support totals';
  assert _day->'wins' @> '[{"title":"Menu card print"}]', 'win from outcome';
  assert _day->'overdue' @> '[{"title":"Brochure reprint","deadline":"2026-10-01"}]', 'overdue';
  assert _day->'blocked' @> '[{"title":"Showroom signage","waiting_on":"Landlord approval"}]' and _day->'blocked' @> '[{"title":"Diwali hoarding v2"}]', 'blocked and in review';
  assert _day->'pending_now' @> '[{"title":"Brochure reprint","untouched":true}]' and _day->'pending_now' @> '[{"title":"Diwali hoarding v2","untouched":false}]', 'still open, with untouched flags';
  assert not (_day->'pending_now' @> '[{"title":"Reviewed menu layout"}]'), 'support is never pending';
  assert _day->'by_campaign' @> '[{"campaign":"Diwali 2026","total":1,"done":0,"spend":11500}]', 'campaign spend';
  assert _day->'ideas_captured' @> '[{"text":"Reel series on resort mornings"}]', 'ideas captured today';
  assert (_day->'cost'->>'actual')::numeric = 15500, 'spend across active tasks';
  _week := app.ledger_report_data(audit_ledger.id(6,1), 'week', '2026-10-05', '2026-10-11', '2026-10-07', false);
  assert _week->'pending_now' = '[]'::jsonb, 'weekly report never lists the backlog';
  assert _week->'worked_on' @> '[{"title":"Showroom signage","event":"Blocked","group":1}]', 'other moves in the week';
  assert jsonb_array_length(_week->'worked_on') = 4, 'one line per task';
end $$;
select 'PASS: report sections follow the activity model: moves, new and noted work; delivered with notes; support apart; backlog only on single days' as result;

-- Export ------------------------------------------------------------------------------------------
set role authenticated;
select audit_ledger.as_user(1);
do $$ declare _row jsonb;
begin
  assert (select count(*) from public.ledger_export_tasks()) = 9, 'every task exported';
  select r into _row from public.ledger_export_tasks() r where r->>'task' = 'Diwali hoarding v2';
  assert _row->>'notes' like '[1 Oct] Draft shared%', 'notes column rebuilt from history';
  assert _row->>'campaign' = 'Diwali 2026' and _row->>'vendor' = 'Lumen Studio' and _row->>'tags' = 'print, outdoor', 'names, not ids';
  assert _row->>'logged_at' = '2026-10-01T09:00', 'IST wall-clock';
end $$;
select audit_ledger.as_user(3);
do $$ begin assert (select count(*) from public.ledger_export_tasks() r where r->>'task' = 'Diwali hoarding v2') = 0, 'export is owner only'; end $$;
reset role;
select 'PASS: CSV export returns the owner''s tasks with the original columns and rebuilt notes' as result;
