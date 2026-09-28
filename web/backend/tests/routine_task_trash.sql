\set ON_ERROR_STOP on
-- Runs after routine_scheduling.sql in its disposable database and shares its scoped actors.
do $$ begin
  if current_database()<>'hr_message_requests_audit' then raise exception 'Disposable routine audit database required'; end if;
end $$;
begin;
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000002';
do $$ declare _result jsonb; _id uuid; _kept uuid; _deleted uuid; _jobs jsonb; begin
  _result:=public.create_routine_set(array[audit_routine.id(5,4)],'Recoverable draft',
    '[{"title":"Keep job"},{"title":"Delete job","detail":"Restore these instructions"}]',
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  _id:=(_result->'routine_ids'->>0)::uuid;
  select id into _kept from public.routine_items where routine_id=_id and title='Keep job';
  select id into _deleted from public.routine_items where routine_id=_id and title='Delete job';
  insert into audit_routine.refs values('trash_draft',_id),('trash_draft_kept',_kept),('trash_draft_deleted',_deleted);
  _jobs:=jsonb_build_array(jsonb_build_object('id',_kept,'title','Keep job'));
  assert public.replace_routine_set(_id,'Recoverable draft',_jobs,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()))=_id,'deletion retains a new routine identity';
  assert (select not is_active and deleted_at is not null and detail='Restore these instructions'
    from public.routine_items where id=_deleted),'deletion retains job identity, text and a deletion date';
  assert (select count(*)=1 from public.routine_day(audit_routine.today()) where routine_id=_id),'deleted jobs are absent from the due checklist';
  assert (select scheduled=1 and pending=1 from public.routine_completion_stats(audit_routine.today(),audit_routine.today()) where routine_id=_id),
    'deleted jobs do not count toward current completion totals';
  assert exists(select 1 from public.list_routine_sets() s,jsonb_array_elements(s.jobs) j
    where s.id=_id and j->>'id'=_deleted::text and j->>'is_active'='false' and j->>'deleted_at' is not null),
    'authorized editors receive recoverable definitions';
  perform audit_routine.expect_error(format('select public.set_routine_job_tick(%L,%L,true)',_deleted,audit_routine.today()),'42501');
  _jobs:=_jobs||jsonb_build_array(jsonb_build_object('id',_deleted,'title','Delete job','detail','Restore these instructions'));
  assert public.replace_routine_set(_id,'Recoverable draft',_jobs,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()))=_id,'restoration does not create another draft routine';
  assert (select is_active and deleted_at is null from public.routine_items where id=_deleted),'restoration clears deletion and reuses the job';
  assert (select count(*)=2 from public.routine_day(audit_routine.today()) where routine_id=_id),'restored job is due again';
  assert (select count(*)=2 from public.routine_items where routine_id=_id),'restore does not duplicate a job';
  perform public.set_routine_job_tick(_deleted,audit_routine.today(),true);
  perform audit_routine.expect_error(format('select public.replace_routine_set(%L,%L,%L::jsonb,%L::jsonb)',_id,'Recoverable draft',
    jsonb_build_array(jsonb_build_object('id',_kept,'title','Keep job')),
    jsonb_build_object('frequency','daily','start_date',audit_routine.today())),'22023');
  assert exists(select 1 from public.routine_ticks where routine_item_id=_deleted and on_date=audit_routine.today()),
    'completed-today deletion refuses without losing its tick';
end $$;

-- Historical schedules are immutable. Carry the trash forward to the latest editable version.
do $$ declare _result jsonb; _id uuid; begin
  _result:=public.create_routine_set(array[audit_routine.id(5,4)],'Recoverable history',
    '[{"title":"Temperature record","detail":"Original detail"},{"title":"Daily register"}]',
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  _id:=(_result->'routine_ids'->>0)::uuid;
  insert into audit_routine.refs values('trash_history',_id);
  insert into audit_routine.refs select 'trash_history_deleted',id from public.routine_items where routine_id=_id and title='Temperature record';
end $$;
reset role;
update public.routine_sets set start_date=audit_routine.today()-1,history_start_date=audit_routine.today()-1
  where id=audit_routine.ref('trash_history');
set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000002';
select public.set_routine_job_tick(audit_routine.ref('trash_history_deleted'),audit_routine.today()-1,true);
do $$ declare _jobs jsonb; _new uuid; _future uuid; _deleted uuid; _kept uuid; _tick uuid; _time timestamptz; _today_tick uuid; begin
  select id,done_at into _tick,_time from public.routine_ticks where routine_item_id=audit_routine.ref('trash_history_deleted');
  select id into _kept from public.routine_items where routine_id=audit_routine.ref('trash_history') and title='Daily register';
  perform public.set_routine_job_tick(_kept,audit_routine.today(),true);
  select id into _today_tick from public.routine_ticks where routine_item_id=_kept and on_date=audit_routine.today();
  select jsonb_agg(jsonb_build_object('id',id,'title',title,'detail',detail)) into _jobs
    from public.routine_items where routine_id=audit_routine.ref('trash_history') and title='Daily register';
  _new:=public.replace_routine_set(audit_routine.ref('trash_history'),'Recoverable history',_jobs,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  assert _new<>audit_routine.ref('trash_history'),'established history gets a new current version';
  assert (select count(*)=2 from public.routine_day(audit_routine.today()-1) where routine_id=audit_routine.ref('trash_history')),
    'deletion today preserves yesterday expected work';
  assert exists(select 1 from public.routine_ticks where id=_tick and done_at=_time and routine_item_id=audit_routine.ref('trash_history_deleted')),
    'deletion keeps historical completion identity, timestamp and job';
  assert exists(select 1 from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id
    where t.id=_today_tick and i.routine_id=_new and i.is_active and i.title='Daily register'),
    'today tick follows its kept job even when a deleted copy has the same sort order';
  select id into _deleted from public.routine_items where routine_id=_new and not is_active and deleted_at is not null;
  assert _deleted is not null and _deleted<>audit_routine.ref('trash_history_deleted'),'latest version carries a separate recoverable definition';
  select id into _kept from public.routine_items where routine_id=_new and is_active;
  perform public.set_routine_job_tick(_kept,audit_routine.today(),true);
  _jobs:=jsonb_build_array(jsonb_build_object('id',_kept,'title','Daily register'));
  _future:=public.replace_routine_set(_new,'Recoverable history',_jobs,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1));
  assert _future<>_new,'future edit keeps today completed work in its current version';
  select id into _deleted from public.routine_items where routine_id=_future and not is_active and deleted_at is not null;
  assert _deleted is not null,'deleted definitions survive unrelated later edits';
  assert (select count(*)=1 from public.routine_items where routine_id=_future and not is_active),'trash is carried once';
  select jsonb_agg(jsonb_build_object('id',id,'title',title,'detail',detail) order by sort_order) into _jobs
    from public.routine_items where routine_id=_future;
  assert public.replace_routine_set(_future,'Recoverable history',_jobs,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1))=_future,'restoration reuses the latest future version';
  assert (select is_active and deleted_at is null and detail='Original detail' from public.routine_items where id=_deleted),
    'restoration preserves saved job instructions';
  assert (select count(*)=1 from public.routine_day(audit_routine.today()) where routine_id=_new),'restoring from tomorrow leaves today unchanged';
  assert (select count(*)=2 from public.routine_day(audit_routine.today()+1) where routine_id=_future),'restored job is due from the selected date';
  assert not exists(select 1 from public.routine_ticks where routine_item_id=_deleted),'restoration never invents or copies old completions';
  assert exists(select 1 from public.routine_ticks where id=_tick and done_at=_time),'restoration preserves historical completion';
  insert into audit_routine.refs values('trash_future',_future);
end $$;

-- Deleted jobs remain restorable after the latest routine is retired.
do $$ declare _result jsonb; _id uuid; _new uuid; _jobs jsonb; begin
  _result:=public.create_routine_set(array[audit_routine.id(5,4)],'Retired with trash',
    '[{"title":"Keep retired job"},{"title":"Restore after retirement"}]',
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  _id:=(_result->'routine_ids'->>0)::uuid;
  select jsonb_agg(jsonb_build_object('id',id,'title',title)) into _jobs
    from public.routine_items where routine_id=_id and title='Keep retired job';
  perform public.replace_routine_set(_id,'Retired with trash',_jobs,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
  perform public.retire_routine_set(_id);
  select jsonb_agg(jsonb_build_object('id',id,'title',title)) into _jobs from public.routine_items where routine_id=_id;
  _new:=public.replace_routine_set(_id,'Retired with trash',_jobs,
    jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1));
  assert _new<>_id,'restoring retired routines creates a new schedule version';
  assert (select retired_on=audit_routine.today() from public.routine_sets where id=_id),'old retirement date remains intact';
  assert (select count(*)=1 from public.routine_day(audit_routine.today()) where routine_id=_id),'resuming tomorrow leaves earlier due work unchanged';
  assert (select count(*)=2 from public.routine_day(audit_routine.today()+1) where routine_id=_new),'new schedule includes the restored job';
end $$;

-- The same scoped manager permission is required for deletion and restoration.
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000004';
select audit_routine.expect_error($q$select public.replace_routine_set(audit_routine.ref('trash_future'),'Forbidden',
  '[{"title":"Changed"}]',jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1))$q$,'42501');
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000005';
do $$ begin
  assert not exists(select 1 from public.list_routine_sets() where id=audit_routine.ref('trash_future')),'unrelated employee cannot inspect deleted jobs';
end $$;
select audit_routine.expect_error($q$select public.replace_routine_set(audit_routine.ref('trash_future'),'Forbidden',
  '[{"title":"Changed"}]',jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1))$q$,'42501');
reset role;
set request.jwt.claim.sub='';
rollback;
select 'PASS: routine job deletion and restoration preserve history, completion facts, scope and latest-version recoverability' as result;
