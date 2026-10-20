-- Work Ledger planning (0171): campaigns, ideas, library, festival calendar, insights.
\set ON_ERROR_STOP on
insert into ids(label) select unnest(array['camp1','camp2','idea1','idea2','ideacamp','ideatask','vendor1','template1','keydate1']);
create temp table seed_count as select count(*)::integer as n from app.ledger_seed_key_dates where on_date >= app.ledger_today();
grant select on seed_count to authenticated;
set role authenticated;

-- A brand-new ledger brings the festival calendar; importing your own dates replaces it.
select audit_ledger.as_user(4);
do $$ declare _seeds integer := (select n from seed_count); _added integer;
begin
  perform public.ledger_open();
  assert (select count(*) from public.ledger_key_dates where owner_user = audit_ledger.id(6,4)) = _seeds, 'festival calendar on first open';
  assert public.ledger_refresh_key_dates() = 0, 'refresh adds nothing twice';
  perform public.ledger_import_batch('key_dates', '[{"legacy_row":2,"name":"Store anniversary","date":"2026-12-05"}]');
  assert (select count(*) from public.ledger_key_dates where owner_user = audit_ledger.id(6,4) and deleted_at is null) = 1, 'own dates replace starter rows';
  _added := public.ledger_refresh_key_dates();
  assert _added = 0, 'removed starter rows are never re-added';
end $$;

select audit_ledger.as_user(1);
-- Campaigns -----------------------------------------------------------------------------------------
do $$ declare _c jsonb;
begin
  _c := public.ledger_save_campaign(audit_ledger.idof('camp1'), '{"name":"Wedding edit 2026","brand":"Parakkat Jewels","launch_date":"2026-11-20","priority":"High","objective":"Bridal enquiries","brief":{"insight":"Brides plan 3 months ahead"}}');
  assert _c->>'stage' = 'Captured' and _c->>'status' = 'Planning' and _c->'brief'->>'insight' = 'Brides plan 3 months ahead', 'created at Captured';
  _c := public.ledger_save_campaign(audit_ledger.idof('camp1'), '{"stage":"developing","next_action":"Shortlist models"}');
  assert _c->>'stage' = 'Developing' and _c->>'status' = 'Active' and _c->>'objective' = 'Bridal enquiries', 'partial update keeps the rest';
  assert _c->'log'->0->>'text' = 'Stage: Captured → Developing', 'stage move logged, newest first';
  _c := public.ledger_advance_campaign(audit_ledger.idof('camp1'));
  assert _c->>'stage' = 'Decision', 'advance to the next stage';
  _c := public.ledger_save_campaign(audit_ledger.idof('camp1'), '{"decision":"Approve ₹2L shoot budget"}');
  assert _c->'log'->0->>'text' = 'Decision: Approve ₹2L shoot budget', 'decision logged';
  perform public.ledger_save_campaign(audit_ledger.idof('camp2'), '{"name":"Old idea","stage":"Reviewed"}');
  _c := public.ledger_save_campaign(audit_ledger.idof('camp2'), '{"measure":{"primary":"Walk-ins","target":"300"},"results":{"actual":"340","next":"Repeat in March"}}');
  assert _c->'results'->>'actual' = '340' and _c->>'status' = 'Done', 'measure and results';
  perform public.ledger_add_task(gen_random_uuid(), '{"task":"Bridal shoot","campaign":"Wedding edit 2026","vendor":"Lumen Studio","deadline":"2026-11-01"}');
  _c := public.ledger_campaign(audit_ledger.idof('camp1'));
  assert _c->'tasks' @> '[{"title":"Bridal shoot","vendor":"Lumen Studio"}]' and (_c->>'total')::integer = 1, 'campaign detail lists its tasks';
  assert jsonb_array_length(public.ledger_campaign_details()) >= 4, 'all campaigns with detail for documents';
end $$;
select audit_ledger.expect_error(format('select public.ledger_advance_campaign(%L)', audit_ledger.idof('camp2')), '22023');
select audit_ledger.expect_error($q$select public.ledger_save_campaign(gen_random_uuid(), '{"name":"wedding EDIT 2026"}')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_save_campaign(gen_random_uuid(), '{"name":"x","stage":"Someday"}')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_save_campaign(gen_random_uuid(), '{"name":"x","brief":"plain"}')$q$, '22023');
do $$ begin
  perform public.ledger_save_campaign(audit_ledger.idof('camp2'), '{"stage":"Parked"}');
  assert (public.ledger_campaigns()->-1->>'stage') in ('Parked','Cancelled'), 'off-pipeline campaigns sort last';
end $$;
select audit_ledger.expect_error(format('select public.ledger_advance_campaign(%L)', audit_ledger.idof('camp2')), '22023');
select 'PASS: campaigns move through the pipeline with a log; advance stops at Reviewed and off-pipeline; names are unique per person' as result;

-- Ideas -------------------------------------------------------------------------------------------
do $$ declare _i jsonb; _c jsonb; _t jsonb;
begin
  _i := public.ledger_add_idea(audit_ledger.idof('idea1'), 'reel on bridal mornings', 'Parakkat Jewels', array['Reels','reels']);
  assert _i->>'status' = 'Open' and _i->'tags' = '["reels"]', 'tags lower-cased once';
  _i := public.ledger_update_idea(audit_ledger.idof('idea1'), '{"text":"Reel series on bridal mornings"}');
  assert _i->>'original' = 'reel on bridal mornings' and (_i->>'edited')::boolean, 'first wording kept';
  _i := public.ledger_update_idea(audit_ledger.idof('idea1'), '{"concept":{"oneLine":"Bridal mornings","objective":"Saves and shares","insight":"Morning light sells gold","nextAction":"Book a bride"}}');
  assert _i->>'status' = 'Developing', 'writing the concept starts developing';
  _c := public.ledger_idea_to_campaign(audit_ledger.idof('idea1'), audit_ledger.idof('ideacamp'));
  assert _c->>'stage' = 'Developing' and _c->>'objective' = 'Saves and shares' and _c->'brief'->>'insight' = 'Morning light sells gold', 'campaign pre-filled from the concept';
  assert (select status = 'Promoted' and campaign_id = audit_ledger.idof('ideacamp') from public.ledger_ideas where id = audit_ledger.idof('idea1')), 'idea promoted';
  assert (public.ledger_idea_to_campaign(audit_ledger.idof('idea1'), gen_random_uuid())->>'id')::uuid = audit_ledger.idof('ideacamp'), 'asking twice returns the same campaign';
  _i := public.ledger_add_idea(audit_ledger.idof('idea2'), 'Monsoon offer poster');
  _i := public.ledger_update_idea(audit_ledger.idof('idea2'), '{"status":"Parked","revisit_date":"2026-11-30","revisit_when":"after Diwali"}');
  assert _i->>'status' = 'Parked' and _i->>'revisit_when' = 'after Diwali', 'parked with a revisit';
  _t := public.ledger_add_task(audit_ledger.idof('ideatask'), jsonb_build_object('task', 'Monsoon poster', 'idea_id', audit_ledger.idof('idea2')));
  assert (select status = 'Promoted' and task_id = audit_ledger.idof('ideatask') from public.ledger_ideas where id = audit_ledger.idof('idea2')), 'to task promotes the idea';
  assert public.ledger_ideas('promoted') @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('idea2'), 'task_title', 'Monsoon poster')), 'filter by status';
  perform public.ledger_delete_idea(audit_ledger.idof('idea2'));
  assert not (public.ledger_ideas() @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('idea2')))), 'deleted ideas leave the list';
end $$;
select audit_ledger.expect_error(format('select public.ledger_update_idea(%L, %L)', audit_ledger.idof('idea1'), '{"original":"rewrite"}'), '22023');
select 'PASS: ideas keep their first wording, develop when the concept is written, park with a revisit and become campaigns or tasks once' as result;

-- Library -----------------------------------------------------------------------------------------
do $$ declare _lib jsonb;
begin
  perform public.ledger_save_vendor(audit_ledger.idof('vendor1'), '{"name":"Shutter Co","role":"Video","rating":5}');
  perform public.ledger_save_vendor(audit_ledger.idof('vendor1'), '{"phone":"+91 98470 00000"}');
  perform public.ledger_save_template(audit_ledger.idof('template1'), jsonb_build_object('name', 'Festival post', 'type', 'Social', 'subtasks', E'Copy\nDesign\n\nApprove'));
  perform public.ledger_save_key_date(audit_ledger.idof('keydate1'), '{"name":"Showroom launch","date":"2026-12-12","brand":"Parakkat Jewels","lead_days":40}');
  perform public.ledger_save_key_date(audit_ledger.idof('keydate1'), '{"notes":"Ribbon cutting"}');
  perform public.ledger_save_brand('Parakkat Jewels', '{"positioning":"Heritage gold, honest pricing","tone":"Warm"}');
  _lib := public.ledger_library();
  assert _lib->'vendors' @> '[{"name":"Shutter Co","phone":"+91 98470 00000","rating":5}]', 'partial vendor edit';
  assert _lib->'templates' @> '[{"name":"Festival post","subtasks":["Copy","Design","Approve"]}]', 'template steps, one per line';
  assert _lib->'key_dates' @> '[{"name":"Showroom launch","lead_days":40,"notes":"Ribbon cutting","starter":false}]', 'key date edited in place';
  assert (select foundation->>'positioning' = 'Heritage gold, honest pricing' and foundation->>'tone' = 'Warm' from public.ledger_brands
    where owner_user = audit_ledger.id(6,1) and name = 'Parakkat Jewels'), 'brand foundation merged';
  perform public.ledger_delete_library_item('template', audit_ledger.idof('template1'));
  assert not (public.ledger_library()->'templates' @> '[{"name":"Festival post"}]'), 'soft deleted';
end $$;
select audit_ledger.expect_error($q$select public.ledger_save_vendor(gen_random_uuid(), '{"name":"shutter co"}')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_save_vendor(gen_random_uuid(), '{"role":"No name"}')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_save_vendor(gen_random_uuid(), '{"name":"X","rating":9}')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_save_key_date(gen_random_uuid(), '{"name":"No date"}')$q$, '22023');
select audit_ledger.expect_error($q$select public.ledger_save_brand('General', '{"secret":"x"}')$q$, '22023');
select 'PASS: library rows add and edit in place, with names unique per person and soft deletes' as result;

-- Insights ----------------------------------------------------------------------------------------
do $$ declare _in jsonb := public.ledger_insights();
begin
  assert jsonb_array_length(_in->'months') = 6, 'six months';
  assert (_in->'months'->5->>'delivered')::integer >= 1, 'this month''s deliveries counted';
  assert _in->'ageing' ? 'older' and _in ? 'turnaround_by_type' and _in ? 'vendors', 'every insight present';
end $$;

-- Managers read planning, never change it --------------------------------------------------------
select audit_ledger.as_user(3);
do $$ begin
  assert public.ledger_campaigns(audit_ledger.id(6,1)) @> '[{"name":"Wedding edit 2026"}]', 'manager reads campaigns';
  assert public.ledger_library(audit_ledger.id(6,1))->'vendors' @> '[{"name":"Shutter Co"}]', 'and the library';
  assert jsonb_array_length(public.ledger_insights(audit_ledger.id(6,1))->'months') = 6, 'and insights';
end $$;
select audit_ledger.expect_error(format('select public.ledger_save_campaign(%L, %L)', audit_ledger.idof('camp1'), '{"stage":"Cancelled"}'), 'P0002');
select audit_ledger.expect_error(format('select public.ledger_update_idea(%L, %L)', audit_ledger.idof('idea1'), '{"text":"x"}'), 'P0002');
select audit_ledger.expect_error(format('select public.ledger_save_vendor(%L, %L)', audit_ledger.idof('vendor1'), '{"name":"Hijack"}'), 'P0002');
select audit_ledger.as_user(2);
select audit_ledger.expect_error(format('select public.ledger_campaigns(%L)', audit_ledger.id(6,1)), '42501');
reset role;
select 'PASS: insights cover six months; managers read campaigns, library and insights but cannot change them; peers cannot read' as result;
