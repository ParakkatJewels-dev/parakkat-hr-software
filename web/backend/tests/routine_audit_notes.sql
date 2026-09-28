\set ON_ERROR_STOP on
-- Runs after routine_scheduling.sql with its synthetic scoped identities. Never production.
do $$ begin
  if current_database()<>'hr_message_requests_audit' then raise exception 'Disposable routine audit database required'; end if;
end $$;
begin;
reset role;
set request.jwt.claim.sub='';
do $$ begin
  assert not has_table_privilege('authenticated','public.routine_notes','insert,update,delete'),'audit notes are RPC-only and append-only';
  assert not has_function_privilege('anon','public.add_routine_note(uuid,date,text,uuid)','execute'),'anonymous note creation denied';
  assert not has_function_privilege('anon','public.list_routine_notes(uuid,date)','execute'),'anonymous occurrence read denied';
  assert not has_function_privilege('anon','public.list_routine_note_audit(date,date,uuid)','execute'),'anonymous audit read denied';
  assert exists(select 1 from pg_publication_tables where pubname='supabase_realtime'and tablename='routine_notes'),'note insertion publishes live updates';
end $$;
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000001';
do $$ declare _result jsonb; begin
  _result:=public.create_routine_set(array[audit_routine.id(5,4),audit_routine.id(5,5)],'Original audit routine',
    '[{"title":"Stock count"},{"title":"Send report"}]',jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  insert into audit_routine.refs select 'note_routine'||employee_id::text,id from public.routine_sets where batch_id=(_result->>'batch_id')::uuid;
  insert into audit_routine.refs select 'note4',id from public.routine_sets where batch_id=(_result->>'batch_id')::uuid and employee_id=audit_routine.id(5,4);
  insert into audit_routine.refs select 'note5',id from public.routine_sets where batch_id=(_result->>'batch_id')::uuid and employee_id=audit_routine.id(5,5);
  insert into audit_routine.refs select 'note4job',id from public.routine_items where routine_id=audit_routine.ref('note4') and sort_order=0;
  _result:=public.create_routine_set(array[audit_routine.id(5,4)],'Removed occurrence','[{"title":"Pending job"}]',
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  insert into audit_routine.refs values('note_removed',(_result->'routine_ids'->>0)::uuid);
  _result:=public.create_routine_set(array[audit_routine.id(5,4)],'Weekly not due','[{"title":"Weekly job"}]',
    jsonb_build_object('frequency','weekly','weekdays',jsonb_build_array(extract(isodow from audit_routine.today()+1)::integer),'start_date',audit_routine.today()));
  insert into audit_routine.refs values('note_not_due',(_result->'routine_ids'->>0)::uuid);
end $$;
reset role;
update public.routine_sets set start_date=audit_routine.today()-2,history_start_date=audit_routine.today()-2 where id=audit_routine.ref('note4');
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000004';
select public.set_routine_job_tick(audit_routine.ref('note4job'),audit_routine.today(),true);
do $$ declare _id uuid; _tick uuid; begin
  select id into _tick from public.routine_ticks where routine_item_id=audit_routine.ref('note4job') and on_date=audit_routine.today();
  _id:=public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),E' \n Waiting for the supplier report. \t ',audit_routine.id(10,1));
  insert into audit_routine.refs values('note_saved',_id);
  assert public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),'Waiting for the supplier report.',audit_routine.id(10,1))=_id,
    'identical trimmed retries return one immutable note';
  assert (select count(*)=1 from public.list_routine_notes(audit_routine.ref('note4'),audit_routine.today())),'retry never duplicates a note';
  assert (select body='Waiting for the supplier report.' and author_user=auth.uid() and employee_id=audit_routine.id(5,4)
      and author_name='Routine actor 4' and routine_name='Original audit routine' and created_at>=now()-interval'1 minute'
      and completed_jobs=1 and total_jobs=2 and jsonb_array_length(job_snapshot)=2
      and job_snapshot->0->>'title'='Stock count' and job_snapshot->0->>'done'='true'
    from public.routine_notes where id=_id),'server derives actor, time, routine name and actual partial completion evidence';
  assert exists(select 1 from public.routine_ticks where id=_tick),'adding an explanation leaves completion facts unchanged';
  perform public.add_routine_note(audit_routine.ref('note4'),audit_routine.today()-1,'Could not complete yesterday.',audit_routine.id(10,2));
  assert (select completed_jobs=0 and total_jobs=2 from public.list_routine_notes(audit_routine.ref('note4'),audit_routine.today()-1)),
    'employee can explain a missed past occurrence without changing historical ticks';
  perform public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),'Correction: report arrived late.',audit_routine.id(10,3));
  assert (select count(*)=2 from public.list_routine_notes(audit_routine.ref('note4'),audit_routine.today())),'corrections append alongside original evidence';
end $$;
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),'Changed retry',audit_routine.id(10,1))$q$,'22023');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today()-1,'Waiting for the supplier report.',audit_routine.id(10,1))$q$,'22023');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today()+1,'Future',gen_random_uuid())$q$,'42501');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today()-3,'Before assignment',gen_random_uuid())$q$,'42501');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note_not_due'),audit_routine.today(),'Not due',gen_random_uuid())$q$,'42501');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),E'\n\t ',gen_random_uuid())$q$,'22023');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),repeat('x',4001),gen_random_uuid())$q$,'22023');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),'Missing retry id',null)$q$,'22023');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),null,'Missing date',gen_random_uuid())$q$,'22023');
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note5'),audit_routine.today(),'Impersonation',gen_random_uuid())$q$,'42501');
select audit_routine.expect_error($q$update public.routine_notes set body='Rewrite' where id=audit_routine.ref('note_saved')$q$,'42501');
select audit_routine.expect_error($q$delete from public.routine_notes where id=audit_routine.ref('note_saved')$q$,'42501');
select audit_routine.expect_error($q$insert into public.routine_notes(id) values(gen_random_uuid())$q$,'42501');
select public.set_routine_job_tick(audit_routine.ref('note4job'),audit_routine.today(),false);
do $$ begin
  assert (select completed_jobs=1 and total_jobs=2 and job_snapshot->0->>'done'='true' from public.routine_notes where id=audit_routine.ref('note_saved')),
    'later unticking never rewrites the completion evidence captured with a note';
  perform public.add_routine_note(audit_routine.ref('note_removed'),audit_routine.today(),'No work completed because equipment failed.',audit_routine.id(10,4));
end $$;

-- The shared bulk batch never merges employees, and permission-filtered audit views stay scoped.
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000005';
select public.add_routine_note(audit_routine.ref('note5'),audit_routine.today(),'Other employee explanation.',audit_routine.id(10,1));
do $$ begin
  assert not exists(select 1 from public.list_routine_notes(audit_routine.ref('note4'),audit_routine.today())),'unrelated employee cannot read another batch member';
  assert (select count(*)=1 from public.list_routine_notes(audit_routine.ref('note5'),audit_routine.today())),'same bulk batch and client uuid remain isolated by employee and actor';
  assert (select count(*)=1 from public.list_routine_note_audit(audit_routine.today()-2,audit_routine.today())),'employee audit reads own notes only';
  assert not exists(select 1 from public.list_routine_note_audit(audit_routine.today()-2,audit_routine.today(),audit_routine.id(5,4))),
    'employee filter cannot widen note visibility';
end $$;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000002';
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),'Head impersonation',gen_random_uuid())$q$,'42501');
do $$ declare _jobs jsonb; _new uuid; begin
  assert (select count(*)=4 from public.list_routine_note_audit(audit_routine.today()-2,audit_routine.today())),'department head reads scoped employee notes';
  assert not exists(select 1 from public.list_routine_notes(audit_routine.ref('note5'),audit_routine.today())),'head cannot inspect another department';
  select jsonb_agg(jsonb_build_object('id',id,'title',title) order by sort_order) into _jobs from public.routine_items where routine_id=audit_routine.ref('note4');
  _new:=public.replace_routine_set(audit_routine.ref('note4'),'Renamed audit routine',_jobs||'[{"title":"Additional work"}]'::jsonb,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  insert into audit_routine.refs values('note4new',_new);
  assert _new<>audit_routine.ref('note4'),'established routine edit creates a new version';
  assert (select count(*)=2 from public.list_routine_notes(_new,audit_routine.today())),'latest version includes original occurrence notes';
  assert (select count(*)=2 from public.list_routine_notes(audit_routine.ref('note4'),audit_routine.today())),'old version still reads same occurrence notes';
  assert (select routine_id=audit_routine.ref('note4') and routine_name='Original audit routine' and completed_jobs=1 and total_jobs=2
    from public.list_routine_notes(_new,audit_routine.today()) where id=audit_routine.ref('note_saved')),'renaming and job additions preserve original note evidence';
  perform public.replace_routine_set(audit_routine.ref('note_removed'),'Rescheduled removed occurrence','[{"title":"Pending job"}]',
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1));
  assert not exists(select 1 from public.routine_day(audit_routine.today()) where routine_id=audit_routine.ref('note_removed')),'date edit removes the due card';
  assert exists(select 1 from public.list_routine_note_audit(audit_routine.today(),audit_routine.today()) where routine_name='Removed occurrence'),
    'standalone date audit preserves evidence when its occurrence disappears from the checklist';
  perform public.retire_routine_set(_new);
  select jsonb_agg(jsonb_build_object('id',id,'title',title) order by sort_order) into _jobs from public.routine_items where routine_id=_new;
  _new:=public.replace_routine_set(_new,'Restored audit routine',_jobs,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1));
  insert into audit_routine.refs values('note4restored',_new);
  assert (select count(*)=2 from public.list_routine_notes(_new,audit_routine.today())),'retirement and restore preserve note lineage';
end $$;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000004';
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),'Stale new note',gen_random_uuid())$q$,'42501');
do $$ begin
  assert public.add_routine_note(audit_routine.ref('note4'),audit_routine.today(),'Waiting for the supplier report.',audit_routine.id(10,1))=audit_routine.ref('note_saved'),
    'old-client retry after replacement still acknowledges the original successful save';
  assert public.add_routine_note(audit_routine.ref('note4restored'),audit_routine.today(),'Waiting for the supplier report.',audit_routine.id(10,1))=audit_routine.ref('note_saved'),
    'retry through restored latest version resolves the same lineage evidence';
  perform public.add_routine_note(audit_routine.ref('note4new'),audit_routine.today(),'Additional explanation after retirement.',gen_random_uuid());
end $$;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000001';
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4new'),audit_routine.today(),'Admin impersonation',gen_random_uuid())$q$,'42501');
do $$ begin
  assert (select count(*)=6 from public.list_routine_note_audit(audit_routine.today()-2,audit_routine.today())),'entity admin reads all scoped notes';
end $$;
select audit_routine.expect_error($q$select public.list_routine_note_audit(audit_routine.today()-366,audit_routine.today())$q$,'22023');
select audit_routine.expect_error($q$select public.list_routine_note_audit(audit_routine.today(),audit_routine.today()-1)$q$,'22023');

-- Immutable snapshots survive profile/name updates; current employee scope controls who audits.
reset role;
set request.jwt.claim.sub='';
update public.employees set full_name='Changed employee name',department_id=audit_routine.id(3,2) where id=audit_routine.id(5,4);
select audit_routine.expect_error($q$update public.routine_notes set body='Owner rewrite' where id=audit_routine.ref('note_saved')$q$,'42501');
select audit_routine.expect_error($q$delete from public.routine_notes where id=audit_routine.ref('note_saved')$q$,'42501');
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000002';
do $$ begin
  assert not exists(select 1 from public.routine_notes),'old department head loses access after employee transfer';
  assert not exists(select 1 from public.list_routine_note_audit(audit_routine.today()-2,audit_routine.today())),'definer audit follows current employee scope';
end $$;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000004';
do $$ begin
  assert (select author_name='Routine actor 4' from public.list_routine_notes(audit_routine.ref('note4'),audit_routine.today()) where id=audit_routine.ref('note_saved')),
    'original author snapshot survives later employee-name changes';
end $$;
reset role;
update auth.users set banned_until=now()+interval'1 day' where id=audit_routine.id(4,4);
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000004';
do $$ begin
  assert not exists(select 1 from public.routine_notes),'disabled account loses raw note read immediately';
  assert not exists(select 1 from public.list_routine_notes(audit_routine.ref('note4'),audit_routine.today())),'disabled account loses occurrence RPC reads';
  assert not exists(select 1 from public.list_routine_note_audit(audit_routine.today()-2,audit_routine.today())),'disabled account loses audit RPC reads';
end $$;
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4new'),audit_routine.today(),'Banned',gen_random_uuid())$q$,'42501');
reset role;
update auth.users set banned_until=null where id=audit_routine.id(4,4);
delete from public.role_assignments where user_id=audit_routine.id(4,4);
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000004';
do $$ begin assert not exists(select 1 from public.routine_notes),'revoked task grants remove audit reads'; end $$;
select audit_routine.expect_error($q$select public.add_routine_note(audit_routine.ref('note4new'),audit_routine.today(),'Revoked',gen_random_uuid())$q$,'42501');
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000009';
do $$ begin assert not exists(select 1 from public.routine_notes),'writer without read cannot inspect note evidence'; end $$;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000006';
do $$ begin assert not exists(select 1 from public.list_routine_note_audit(audit_routine.today()-2,audit_routine.today())),'foreign entity cannot inspect note evidence'; end $$;
reset role;
set request.jwt.claim.sub='';
rollback;
select 'PASS: routine audit notes are scoped, append-only, idempotent employee explanations with trusted snapshots across dates, edits, retirement and restore' as result;
