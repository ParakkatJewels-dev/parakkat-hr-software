\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'hr_message_requests_audit' then raise exception 'Disposable routine audit database required'; end if;
end $$;
begin;
reset role;
set request.jwt.claim.sub='';

-- Administrative logins need not be employee records. Exercise both super-admin
-- representations and an entity-scoped administrator through the public RPCs.
insert into auth.users(id,email)
  select audit_routine.id(4,n),'routine-unlinked-admin-'||n||'@audit.invalid' from generate_series(10,12)n;
update public.profiles set is_super_admin=true where user_id=audit_routine.id(4,10);
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
  (audit_routine.id(4,11),(select id from public.roles where key='super_admin'),'global',null),
  (audit_routine.id(4,12),(select id from public.roles where key='entity_admin'),'entity',audit_routine.id(1,1));

create function audit_routine.exercise_unlinked_admin(_employee uuid,_label text)
returns uuid language plpgsql as $$
declare _result jsonb; _id uuid; _resumed uuid; _first uuid; _second uuid; _jobs jsonb; _schedule jsonb;
begin
  assert app.current_employee_id() is null,'this regression must exercise an admin without an employee link';
  _schedule:=jsonb_build_object('frequency','daily','start_date',audit_routine.today()+2);
  _result:=public.create_routine_set(array[_employee],_label,'[{"title":"Original job"}]',_schedule);
  _id:=(_result->'routine_ids'->>0)::uuid;
  select id into _first from public.routine_items where routine_id=_id;
  assert _first is not null,'admin can create and read routine jobs without an employee link';
  assert exists(select 1 from public.list_routine_sets(_employee) where id=_id and can_manage),
    'server advertises admin management permission';
  assert (select created_by=auth.uid() from public.routine_sets where id=_id),'routine creator retains admin auth identity';
  assert (select created_by is null from public.routine_items where id=_first),'no employee identity is invented for an unlinked admin';

  _jobs:=jsonb_build_array(jsonb_build_object('id',_first,'title','Renamed job'),jsonb_build_object('title','Additional job'));
  _schedule:=jsonb_build_object('frequency','daily','start_date',audit_routine.today());
  assert public.replace_routine_set(_id,_label||' edited',_jobs,_schedule)=_id,'admin can edit date, title and jobs';
  assert (select start_date=audit_routine.today() from public.routine_sets where id=_id),'admin date edit is saved';
  select id into _second from public.routine_items where routine_id=_id and title='Additional job';
  assert _second is not null,'admin can add another job to the same routine';

  _jobs:=jsonb_build_array(jsonb_build_object('id',_first,'title','Renamed job'));
  perform public.replace_routine_set(_id,_label,_jobs,_schedule);
  assert (select not is_active and deleted_at is not null from public.routine_items where id=_second),
    'admin can delete an uncompleted routine job';
  assert exists(select 1 from public.list_routine_sets(_employee) r,
    lateral jsonb_array_elements(r.jobs) j where r.id=_id and (j->>'id')::uuid=_second and j->>'deleted_at' is not null),
    'admin can read recoverable deleted jobs';
  _jobs:=_jobs||jsonb_build_array(jsonb_build_object('id',_second,'title','Additional job'));
  perform public.replace_routine_set(_id,_label,_jobs,_schedule);
  assert (select is_active and deleted_at is null from public.routine_items where id=_second),'admin can restore a deleted job';
  assert (select count(*)=2 from public.routine_day(audit_routine.today(),_employee) where routine_id=_id and can_manage and can_tick),
    'admin can manage and complete all restored jobs';

  perform public.set_routine_job_tick(_first,audit_routine.today(),true);
  assert exists(select 1 from public.routine_ticks where routine_item_id=_first and done_by is null),
    'unlinked admin can mark completion without fabricating an employee actor';
  perform public.set_routine_job_tick(_first,audit_routine.today(),false);
  assert not exists(select 1 from public.routine_ticks where routine_item_id=_first),'admin can undo completion';
  perform public.retire_routine_set(_id);
  assert (select retired_on=audit_routine.today() from public.routine_sets where id=_id),'admin can retire the routine';
  _schedule:=jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1);
  _resumed:=public.replace_routine_set(_id,_label||' resumed',_jobs,_schedule);
  assert _resumed<>_id,'admin can edit a retired latest routine by resuming its schedule';
  assert (select retired_on=audit_routine.today() and replaced_by=_resumed from public.routine_sets where id=_id),
    'resuming preserves the retired routine history';
  assert exists(select 1 from public.list_routine_sets(_employee) where id=_resumed and can_manage and retired_on is null),
    'admin can manage the resumed latest routine';
  return _resumed;
end $$;
grant execute on function audit_routine.exercise_unlinked_admin(uuid,text) to authenticated;

set role authenticated;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000010';
insert into audit_routine.refs values('admin_profile_own',audit_routine.exercise_unlinked_admin(audit_routine.id(5,4),'Profile super admin own company')),
  ('admin_profile_other',audit_routine.exercise_unlinked_admin(audit_routine.id(5,6),'Profile super admin other company'));
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000011';
insert into audit_routine.refs values('admin_role_other',audit_routine.exercise_unlinked_admin(audit_routine.id(5,6),'Role super admin other company'));
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000012';
insert into audit_routine.refs values('admin_entity_own',audit_routine.exercise_unlinked_admin(audit_routine.id(5,4),'Entity admin own company'));

-- Entity admin authority still stops at its assigned entity. A UI affordance must
-- never become a bypass for hidden records, foreign employees or other managers.
do $$ begin
  assert not exists(select 1 from public.list_routine_sets(audit_routine.id(5,6),true)),
    'entity admin cannot read another entity routines';
end $$;
select audit_routine.expect_error($q$select public.create_routine_set(array[audit_routine.id(5,6)],'Outside entity','[{"title":"Job"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()))$q$,'42501');
select audit_routine.expect_error($q$select public.replace_routine_set(audit_routine.ref('admin_role_other'),'Outside entity','[{"title":"Job"}]',
  jsonb_build_object('frequency','daily','start_date',audit_routine.today()+1))$q$,'42501');
select audit_routine.expect_error($q$select public.retire_routine_set(audit_routine.ref('admin_role_other'))$q$,'42501');

-- An explicit Restore action uses the existing versioned edit RPC, preserving
-- completed work and deleted jobs rather than recreating a blank routine.
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000010';
do $$ declare _result jsonb; _id uuid; _restored uuid; _future uuid; _job uuid;
  _jobs jsonb; _schedule jsonb; _tick uuid; _done_at timestamptz; _deleted_at timestamptz;
begin
  _schedule:=jsonb_build_object('frequency','daily','start_date',audit_routine.today());
  _result:=public.create_routine_set(array[audit_routine.id(5,4)],'Explicit retired routine restore',
    '[{"title":"Completed before retirement","detail":"Keep the instructions"},{"title":"Previously deleted job"}]',_schedule);
  _id:=(_result->'routine_ids'->>0)::uuid;
  select id into _job from public.routine_items where routine_id=_id and title='Completed before retirement';
  _jobs:=jsonb_build_array(jsonb_build_object('id',_job,'title','Completed before retirement','detail','Keep the instructions'));
  perform public.replace_routine_set(_id,'Explicit retired routine restore',_jobs,_schedule);
  select deleted_at into _deleted_at from public.routine_items where routine_id=_id and not is_active;
  perform public.set_routine_job_tick(_job,audit_routine.today(),true);
  select id,done_at into _tick,_done_at from public.routine_ticks where routine_item_id=_job;
  perform public.retire_routine_set(_id);
  _restored:=public.replace_routine_set(_id,'Explicit retired routine restore',_jobs,_schedule);
  assert exists(select 1 from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id
    where t.id=_tick and t.done_at=_done_at and t.done_by is null and i.routine_id=_restored and i.is_active
      and i.title='Completed before retirement' and i.detail='Keep the instructions'),
    'restoring today preserves completed job identity, time, actor and instructions';
  assert (select count(*)=1 from public.routine_day(audit_routine.today()) where routine_id in(_id,_restored)),
    'restoring today does not duplicate the scheduled occurrence';
  assert exists(select 1 from public.routine_items where routine_id=_restored and not is_active
    and title='Previously deleted job' and deleted_at=_deleted_at),
    'restoring a routine retains deleted jobs for separate recovery';
  perform audit_routine.expect_error(format('select public.replace_routine_set(%L,%L,%L::jsonb,%L::jsonb)',
    _id,'Explicit retired routine restore',_jobs,_schedule),'22023');
  assert (select count(*)=1 from public.routine_sets where replaces_id=_id),
    'repeated restore of the old version cannot create duplicate routines';

  select jsonb_agg(jsonb_build_object('id',id,'title',title,'detail',detail) order by sort_order) into _jobs
    from public.routine_items where routine_id=_restored and is_active;
  perform public.retire_routine_set(_restored);
  _schedule:=jsonb_build_object('frequency','daily','start_date',audit_routine.today()+2);
  _future:=public.replace_routine_set(_restored,'Explicit retired routine restore',_jobs,_schedule);
  assert exists(select 1 from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id
    where t.id=_tick and t.done_at=_done_at and i.routine_id=_restored),
    'restoring from a future date leaves completed historical work in place';
  assert not exists(select 1 from public.routine_day(audit_routine.today()+1)
    where routine_id in(_id,_restored,_future)),'restore does not fill the retired schedule gap';
  assert exists(select 1 from public.routine_day(audit_routine.today()+2) where routine_id=_future),
    'restored routine resumes on the chosen date';
end $$;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000012';

-- Past-date correction is also a manager permission, including unlinked admins.
reset role;
set request.jwt.claim.sub='';
update public.routine_sets set start_date=audit_routine.today()-1,history_start_date=audit_routine.today()-1
  where id in(audit_routine.ref('admin_profile_other'),audit_routine.ref('admin_role_other'),audit_routine.ref('admin_entity_own'));
-- An expired routine is still editable as a new schedule. This setup models an
-- existing end date, without allowing clients to invent historical assignments.
insert into public.routine_sets(id,employee_id,title,frequency,start_date,end_date,history_start_date)
  select audit_routine.id(20,n),audit_routine.id(5,case when n=12 then 4 else 6 end),'Expired admin routine '||n,
    'daily',audit_routine.today()-2,audit_routine.today()-1,audit_routine.today()-2 from generate_series(10,12)n;
insert into public.routine_items(routine_id,employee_id,title)
  select id,employee_id,'Expired job' from public.routine_sets where id in(audit_routine.id(20,10),audit_routine.id(20,11),audit_routine.id(20,12));
set role authenticated;
do $$ declare _n integer; _key text; _item uuid; _resumed uuid; _jobs jsonb; begin
  for _n in 10..12 loop
    perform set_config('request.jwt.claim.sub',audit_routine.id(4,_n)::text,true);
    _key:=case _n when 10 then 'admin_profile_other' when 11 then 'admin_role_other' else 'admin_entity_own' end;
    select id into _item from public.routine_items where routine_id=audit_routine.ref(_key) order by sort_order limit 1;
    perform public.set_routine_job_tick(_item,audit_routine.today()-1,true);
    assert exists(select 1 from public.routine_ticks where routine_item_id=_item and on_date=audit_routine.today()-1),
      'admin can correct completion for a prior due date';
    perform public.set_routine_job_tick(_item,audit_routine.today()-1,false);
    select jsonb_agg(jsonb_build_object('id',id,'title',title)) into _jobs from public.routine_items where routine_id=audit_routine.id(20,_n);
    assert exists(select 1 from public.list_routine_sets(null,true) where id=audit_routine.id(20,_n) and can_manage),
      'admin can inspect the latest expired routine';
    _resumed:=public.replace_routine_set(audit_routine.id(20,_n),'Expired routine resumed',_jobs,
      jsonb_build_object('frequency','daily','start_date',audit_routine.today()));
    assert exists(select 1 from public.routine_day(audit_routine.today()) where routine_id=_resumed and can_tick and can_manage),
      'admin can edit and resume the latest expired routine';
  end loop;
end $$;
set request.jwt.claim.sub='e4000004-0000-0000-0000-000000000005';
select audit_routine.expect_error($q$select public.retire_routine_set(audit_routine.ref('admin_entity_own'))$q$,'42501');
reset role;
set request.jwt.claim.sub='';
rollback;
select 'PASS: unlinked profile/role super admins and scoped entity admins can create, read, edit dates/jobs, delete, restore, retire and correct routine completion' as result;
