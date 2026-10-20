-- Creative extras (0174): the creative-team setting, shared campaigns, ideas and library, the creative
-- task fields, and the creative parts of reports and insights. Runs after work_tasks.sql and reuses its
-- people: dept A ("Creative") holds 1, 2, 3, 5, 6, 7, 8 and 10; 4 heads dept B; 9 is in another company.
\set ON_ERROR_STOP on
insert into work_ids(label) select unnest(array['shoot','campaign','idea','vendor']);

-- Grants --------------------------------------------------------------------------------------------
do $$
declare _table text;
begin
  foreach _table in array array['creative_brands','creative_vendors','creative_templates','creative_key_dates',
    'creative_campaigns','creative_campaign_log','creative_ideas','creative_campaign_ideas'] loop
    assert not has_table_privilege('anon', 'public.'||_table, 'select'), 'anon cannot read '||_table;
    assert not has_table_privilege('authenticated', 'public.'||_table, 'delete'), 'nobody hard-deletes '||_table;
    assert (select relrowsecurity from pg_class where oid = ('public.'||_table)::regclass), 'RLS on '||_table;
    assert exists(select 1 from pg_policies where schemaname = 'public' and tablename = _table
      and policyname = 'active_account_required' and permissive = 'RESTRICTIVE'), 'active account guard on '||_table;
  end loop;
  assert not has_table_privilege('authenticated', 'public.creative_campaign_log', 'insert,update'), 'the campaign log is written by the app';
  assert not has_function_privilege('anon', 'public.creative_home()', 'execute'), 'anon cannot read the creative Home';
  assert not has_function_privilege('authenticated', 'app.tg_creative_idea()', 'execute'), 'trigger functions are internal';
  assert (select count(*) from public.creative_brands where deleted_at is null) = 5, 'five starter brands';
  assert (select count(*) from public.creative_templates where seed_key is not null) = 4, 'four starter templates';
  assert (select count(*) from public.creative_key_dates where seed_key is not null) > 0, 'festival dates from today on';
end $$;
select 'PASS: creative tables are RLS-protected, never hard-deleted, and seeded once' as result;

-- Nobody is on the creative team until a super admin says so -----------------------------------------
set role authenticated;
select audit_ledger.as_user(1);
do $$ begin
  assert (public.creative_settings()->>'member')::boolean is false, 'not a member before the team is chosen';
  assert (select count(*) from public.creative_brands) = 0, 'brands are hidden from non-members';
  assert public.creative_home() is null, 'no creative Home';
end $$;
select audit_ledger.expect_error($q$insert into public.creative_ideas(text) values ('Sneaky')$q$, '42501');
select audit_ledger.as_user(3);
select audit_ledger.expect_error($q$select public.set_creative_departments(array[audit_ledger.id(4,1)])$q$, '42501');
select audit_ledger.as_user(8);
select audit_ledger.expect_error($q$select public.set_creative_departments(array[gen_random_uuid()])$q$, '22023');
do $$ declare _s jsonb;
begin
  _s := public.set_creative_departments(array[audit_ledger.id(4,1)]);
  assert jsonb_array_length(_s->'departments') = 1 and _s->'departments'->0->>'name' = 'Creative', 'the creative team is dept A';
  assert (_s->>'can_configure')::boolean, 'a super admin configures it';
end $$;
select audit_ledger.as_user(1);
do $$ begin
  assert (public.creative_settings()->>'member')::boolean, 'a member of dept A is on the team';
  assert (public.creative_settings()->>'can_configure')::boolean is false, 'members do not configure it';
  assert (select count(*) from public.creative_brands) = 5, 'members see the brands';
end $$;
select audit_ledger.as_user(4);
do $$ begin
  assert (public.creative_settings()->>'member')::boolean is false, 'another department is not on the team';
end $$;
select audit_ledger.as_user(9);
do $$ begin assert (public.creative_settings()->>'member')::boolean is false, 'another company is not on the team'; end $$;
select 'PASS: a super admin chooses the creative departments; only their people are members' as result;

-- Campaigns: stage log, derived status, soft delete --------------------------------------------------
select audit_ledger.as_user(1);
do $$ declare _c public.creative_campaigns;
begin
  insert into public.creative_campaigns(id, name, brand, launch_date, created_by)
    values (audit_ledger.wid('campaign'), '  Onam push ', 'Parakkat Jewels', app.ledger_today() + 10, audit_ledger.id(6,3));
  select * into _c from public.creative_campaigns where id = audit_ledger.wid('campaign');
  assert _c.name = 'Onam push' and _c.status = 'Planning' and _c.stage = 'Captured', 'a new campaign is Captured and Planning';
  assert _c.created_by = audit_ledger.id(6,1), 'the creator is stamped';
  update public.creative_campaigns set stage = 'Decision', decision = 'Gold or diamond lead?' where id = _c.id;
  select * into _c from public.creative_campaigns where id = audit_ledger.wid('campaign');
  assert _c.status = 'Active', 'status follows the stage';
  assert (select count(*) from public.creative_campaign_log where campaign_id = _c.id) = 3, 'created, stage and decision are logged';
  assert exists(select 1 from public.creative_campaign_log where campaign_id = _c.id and text = 'Stage: Captured → Decision'
    and actor_name = 'Ledger Person 1'), 'the stage move names who made it';
  perform public.creative_campaign_note(_c.id, 'Asked the MD');
  assert (public.creative_campaign(_c.id)->'log'->0->>'text') = 'Asked the MD', 'notes go on the log, newest first';
end $$;
select audit_ledger.expect_error($q$delete from public.creative_campaigns where id = audit_ledger.wid('campaign')$q$, '42501');
select audit_ledger.expect_error($q$select public.creative_campaign_note(audit_ledger.wid('campaign'), '  ')$q$, '22023');
select audit_ledger.as_user(2);
do $$ begin
  assert exists(select 1 from public.creative_campaigns where id = audit_ledger.wid('campaign')), 'the whole team shares campaigns';
  update public.creative_campaigns set next_action = 'Mock up both' where id = audit_ledger.wid('campaign');
  assert (select next_action from public.creative_campaigns where id = audit_ledger.wid('campaign')) = 'Mock up both', 'teammates edit them';
end $$;
select audit_ledger.as_user(4);
do $$ begin
  assert (select count(*) from public.creative_campaigns) = 0, 'outsiders see no campaigns';
  update public.creative_campaigns set name = 'Hijacked' where id = audit_ledger.wid('campaign');
end $$;
select audit_ledger.expect_error($q$insert into public.creative_campaigns(name) values ('Outside')$q$, '42501');
select audit_ledger.expect_error($q$select public.creative_campaign_note(audit_ledger.wid('campaign'), 'Hi')$q$, '42501');
select audit_ledger.as_user(1);
do $$ begin
  assert (select name from public.creative_campaigns where id = audit_ledger.wid('campaign')) = 'Onam push', 'outsiders cannot change campaigns';
end $$;
select 'PASS: campaigns are shared by the team, log their stages and decisions, and are closed to everyone else' as result;

-- Ideas: first wording kept, concept moves it on, idea → campaign once ---------------------------------
do $$ declare _i public.creative_ideas; _c jsonb; _again jsonb;
begin
  insert into public.creative_ideas(id, text, brand, tags) values (audit_ledger.wid('idea'), ' Gold rush reel ', 'Parakkat Jewels', array['Reel',' reel ','Gold']);
  select * into _i from public.creative_ideas where id = audit_ledger.wid('idea');
  assert _i.original = 'Gold rush reel' and _i.status = 'Open' and _i.author_name = 'Ledger Person 1', 'captured as written, by me';
  assert _i.tags = array['gold','reel'], 'tags are tidied';
  update public.creative_ideas set text = 'Gold rush reel for Onam', original = 'forged', author_name = 'Someone else' where id = _i.id;
  select * into _i from public.creative_ideas where id = audit_ledger.wid('idea');
  assert _i.original = 'Gold rush reel' and _i.author_name = 'Ledger Person 1', 'the first wording and author stay';
  update public.creative_ideas set concept = '{"oneLine":"Gold rush","objective":"Footfall in Onam week","nextAction":"Script it"}' where id = _i.id;
  assert (select status from public.creative_ideas where id = _i.id) = 'Developing', 'writing the concept develops the idea';
  _c := public.creative_idea_to_campaign(_i.id);
  assert _c->>'name' = 'Gold rush' and _c->>'stage' = 'Developing' and _c->>'objective' = 'Footfall in Onam week', 'campaign from the concept';
  assert (select status from public.creative_ideas where id = _i.id) = 'Promoted', 'the idea is promoted';
  assert jsonb_array_length(_c->'ideas') = 1 and exists(select 1 from jsonb_array_elements(_c->'log') l where l->>'text' like 'From idea:%'), 'linked and logged';
  _again := public.creative_idea_to_campaign(_i.id, gen_random_uuid());
  assert _again->>'id' = _c->>'id', 'promoting twice returns the same campaign';
end $$;
select audit_ledger.as_user(4);
select audit_ledger.expect_error($q$select public.creative_idea_to_campaign(audit_ledger.wid('idea'))$q$, '42501');
select 'PASS: ideas keep their first wording, develop with a concept, and become one campaign' as result;

-- Creative fields on tasks; vendors; library -------------------------------------------------------
select audit_ledger.as_user(1);
insert into public.creative_vendors(id, name, role) values (audit_ledger.wid('vendor'), 'Studio Lumen', 'Photographer');
update public.creative_brands set foundation = '{"voice":"Warm, family"}' where name = 'Parakkat Jewels';
do $$ begin
  assert (select foundation_updated_at from public.creative_brands where name = 'Parakkat Jewels') is not null, 'brand notes are dated';
  assert (select jsonb_array_length(public.creative_library()->'vendors')) = 1, 'the library lists vendors';
  assert (select jsonb_array_length(public.creative_library()->'templates')) = 4, 'and templates';
  assert public.creative_refresh_key_dates() = 0, 'refreshing festival dates adds no duplicates';
end $$;
select audit_ledger.as_user(3);
insert into public.tasks(id, employee_id, assigned_by, title, priority, status, brand, work_type, campaign_id, vendor_id, actual_cost)
values (audit_ledger.wid('shoot'), audit_ledger.id(7,1), audit_ledger.id(7,3), 'Onam product shoot', 'High', 'To Do',
  'Parakkat Jewels', 'Photography', audit_ledger.wid('campaign'), audit_ledger.wid('vendor'), 18000);
insert into public.task_assignees(task_id, employee_id, added_by) values (audit_ledger.wid('shoot'), audit_ledger.id(7,1), audit_ledger.id(7,3));
select audit_ledger.as_user(1);
do $$ declare _t jsonb; _c jsonb;
begin
  assert (select last_worked from public.creative_vendors where id = audit_ledger.wid('vendor')) = app.ledger_today(), 'naming a vendor dates the work';
  _t := public.work_task(audit_ledger.wid('shoot'));
  assert _t->>'campaign' = 'Onam push' and _t->>'vendor' = 'Studio Lumen' and _t->>'brand_label' = 'Jewels', 'the card names campaign, vendor and brand';
  _c := public.creative_campaign(audit_ledger.wid('campaign'));
  assert (_c->>'total')::int = 1 and (_c->>'spend')::numeric = 18000, 'the campaign counts its work and spend';
  assert _c->'tasks'->0->>'title' = 'Onam product shoot', 'and lists it';
end $$;
select audit_ledger.as_user(2);
do $$ declare _c jsonb;
begin
  _c := public.creative_campaign(audit_ledger.wid('campaign'));
  assert (_c->>'total')::int = 1, 'a teammate sees the campaign''s progress';
  assert jsonb_array_length(_c->'tasks') = 0, 'but not the titles of tasks they cannot open';
end $$;
select 'PASS: tasks carry brand, campaign, vendor and cost; the library and campaign detail follow' as result;

-- Home, reports and insights --------------------------------------------------------------------------
select audit_ledger.as_user(1);
update public.creative_campaigns set stage = 'Live', measure = '{"reviewDate":"soon"}' where id = (select campaign_id from public.creative_ideas where id = audit_ledger.wid('idea'));
do $$ declare _h jsonb; _r jsonb; _i jsonb;
begin
  _h := public.creative_home();
  assert exists(select 1 from jsonb_array_elements(_h->'alerts') a where a->>'kind' = 'decision' and a->>'title' = 'Onam push'), 'decisions are pointed out';
  assert exists(select 1 from jsonb_array_elements(_h->'alerts') a where a->>'kind' = 'review' and a->>'text' = 'Live without a review date'),
    'a hand-written review date that is not a date does not break Home';
  assert exists(select 1 from jsonb_array_elements(_h->'alerts') a where a->>'kind' = 'launch'), 'a launch within two weeks is pointed out';
  assert jsonb_array_length(_h->'campaigns') = 2, 'running campaigns';
  _r := public.work_report('month', null, null);
  assert exists(select 1 from jsonb_array_elements(_r->'by_campaign') c where c->>'campaign' = 'Onam push' and (c->>'spend')::numeric = 18000), 'report by campaign';
  assert exists(select 1 from jsonb_array_elements(_r->'ideas_captured') i where i->>'text' = 'Gold rush reel for Onam'), 'ideas I captured';
  assert exists(select 1 from jsonb_array_elements(_r->'by_brand') b where b->>'brand' = 'Jewels'), 'brands by their short label';
  _i := public.work_insights(null);
  assert exists(select 1 from jsonb_array_elements(_i->'vendors') v where v->>'vendor' = 'Studio Lumen' and (v->>'tasks')::int = 1), 'insights list vendors';
end $$;
select audit_ledger.as_user(4);
do $$ begin assert public.creative_home() is null, 'no creative Home for outsiders'; end $$;
reset role;
select 'PASS: creative Home alerts, report campaigns and ideas, and insight vendors' as result;
