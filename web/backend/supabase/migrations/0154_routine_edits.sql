-- Edit a routine from today without losing completed work or creating versions for drafts.
-- Established schedules retain their earlier occurrences as an immutable prior version.
begin;

create or replace function public.replace_routine_set(_id uuid,_title text,_jobs jsonb,_schedule jsonb,_detail text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare
  _old public.routine_sets; _previous public.routine_sets; _candidate public.routine_sets;
  _today date:=(now() at time zone 'Asia/Kolkata')::date; _start date; _clean jsonb;
  _new uuid; _job_ids uuid[]; _in_place boolean;
begin
  -- Tick writes use the same parent-before-item lock order. A tick cannot arrive between
  -- checking today's completed jobs and applying an edit or moving its completion record.
  select * into _old from public.routine_sets where id=_id for update;
  if _old.id is null or not app.routine_allowed('task.read',_old.employee_id)
      or not app.routine_allowed('task.create',_old.employee_id) then
    raise exception 'That routine is outside the scope you can manage.' using errcode='42501';
  end if;
  perform 1 from public.employees where id=_old.employee_id and status='Active' for share;
  if not found then raise exception 'Edit routines only for an active employee.' using errcode='42501'; end if;
  if _old.replaced_by is not null then
    raise exception 'This routine already has a newer version. Edit its latest version.' using errcode='22023';
  end if;

  _clean:=app.routine_validate(_title,_jobs,_schedule,_detail,_today);
  _start:=(_clean->>'start_date')::date;
  begin
    select coalesce(array_agg((j->>'id')::uuid) filter(where nullif(j->>'id','') is not null),'{}')
      into _job_ids from jsonb_array_elements(_jobs) j;
  exception when invalid_text_representation then
    raise exception 'One of the jobs is no longer valid. Reload the routine and try again.' using errcode='22023';
  end;
  if cardinality(_job_ids)<>(select count(distinct id) from unnest(_job_ids) id)
      or exists(select 1 from unnest(_job_ids) requested(job_id) where not exists(
        select 1 from public.routine_items i where i.id=requested.job_id and i.routine_id=_old.id)) then
    raise exception 'Each existing job must belong to this routine and appear only once.' using errcode='22023';
  end if;

  _candidate:=_old;
  _candidate.frequency:=_clean->>'frequency';
  _candidate.start_date:=_start;
  _candidate.end_date:=(_clean->>'end_date')::date;
  _candidate.weekdays:=array(select v::integer from jsonb_array_elements_text(_clean->'weekdays') v);
  _candidate.month_day:=(_clean->>'month_day')::integer;
  _candidate.interval_days:=(_clean->>'interval_days')::integer;
  _candidate.retired_on:=null;

  if _start=_today and exists(
      select 1 from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id
      where i.routine_id=_old.id and i.is_active and t.on_date=_today and app.routine_due(_old,_today)) then
    if not app.routine_due(_candidate,_today) then
      raise exception 'Jobs are already completed today. Keep the routine due today, or apply the schedule change from tomorrow.' using errcode='22023';
    end if;
    if exists(
      select 1 from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id
      where i.routine_id=_old.id and i.is_active and t.on_date=_today and app.routine_due(_old,_today)
        and not exists(select 1 from jsonb_array_elements(_jobs) j
          where nullif(j->>'id','')::uuid=i.id
            and regexp_replace(j->>'title','^[[:space:]]+|[[:space:]]+$','','g')=i.title
            and nullif(btrim(j->>'detail'),'') is not distinct from i.detail)) then
      raise exception 'Keep jobs already completed today unchanged. You can add jobs now, or remove or change completed jobs from tomorrow.' using errcode='22023';
    end if;
  end if;

  -- A routine that has never had an earlier occurrence can keep its identity. If today's
  -- ticks must stay behind while an edit starts tomorrow, it needs a historical version.
  _in_place:=not _old.is_legacy and _old.retired_on is null and _old.start_date>=_today
    and not exists(select 1 from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id
      where i.routine_id=_old.id and t.on_date<_start);
  if _in_place then
    if _old.replaces_id is not null then
      select * into _previous from public.routine_sets where id=_old.replaces_id for update;
      -- Moving an upcoming version earlier must not hide work completed on its predecessor.
      if exists(select 1 from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id
        where i.routine_id=_previous.id and t.on_date>=_start) then
        raise exception 'The earlier version has completed jobs on that date. Choose a start date after those completed jobs.' using errcode='22023';
      end if;
      update public.routine_sets set retired_on=case
        when retired_on=least(coalesce(end_date,_old.start_date-1),_old.start_date-1)
          then least(coalesce(end_date,_start-1),_start-1)
        else least(retired_on,_start-1) end
        where id=_previous.id;
    end if;

    update public.routine_sets set title=regexp_replace(_title,'^[[:space:]]+|[[:space:]]+$','','g'),
      detail=nullif(btrim(_detail),''),frequency=_candidate.frequency,start_date=_start,end_date=_candidate.end_date,
      weekdays=_candidate.weekdays,month_day=_candidate.month_day,interval_days=_candidate.interval_days,
      history_start_date=_start where id=_old.id;
    delete from public.routine_items where routine_id=_old.id and not(id=any(_job_ids));
    update public.routine_items i set title=regexp_replace(j.value->>'title','^[[:space:]]+|[[:space:]]+$','','g'),
      detail=nullif(btrim(j.value->>'detail'),''),sort_order=j.ordinality::integer-1,is_active=true
      from jsonb_array_elements(_jobs) with ordinality j
      where i.routine_id=_old.id and i.id=nullif(j.value->>'id','')::uuid;
    insert into public.routine_items(routine_id,employee_id,title,detail,sort_order,created_by)
      select _old.id,_old.employee_id,regexp_replace(j.value->>'title','^[[:space:]]+|[[:space:]]+$','','g'),
        nullif(btrim(j.value->>'detail'),''),j.ordinality::integer-1,app.current_employee_id()
      from jsonb_array_elements(_jobs) with ordinality j where nullif(j.value->>'id','') is null;
    return _old.id;
  end if;

  _new:=app.routine_insert(_old.employee_id,_old.batch_id,_title,_jobs,_clean,_detail,_old.id);
  if _start=_today then
    -- Preserve the tick UUID, timestamp and actor; only today's occurrence moves to the
    -- corresponding job. Prior dates and legacy inactive completions stay with the old version.
    update public.routine_ticks t set routine_item_id=n.id
      from jsonb_array_elements(_jobs) with ordinality j
      join public.routine_items n on n.routine_id=_new and n.sort_order=j.ordinality::integer-1
      join public.routine_items o on o.id=nullif(j.value->>'id','')::uuid and o.routine_id=_old.id and o.is_active
      where t.routine_item_id=o.id and t.on_date=_today and app.routine_due(_old,_today);
  end if;
  update public.routine_sets set retired_on=least(coalesce(retired_on,_start-1),coalesce(end_date,_start-1),_start-1),
    replaced_by=_new where id=_old.id;
  return _new;
end $$;

create or replace function public.set_routine_job_tick(_item_id uuid,_on_date date,_done boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _item public.routine_items; _routine public.routine_sets;
begin
  select * into _item from public.routine_items where id=_item_id;
  select * into _routine from public.routine_sets where id=_item.routine_id for update;
  select * into _item from public.routine_items where id=_item_id for update;
  if _item.id is null or _item.routine_id is distinct from _routine.id or not _item.is_active
      or not app.routine_can_tick(_routine,_on_date) then
    raise exception 'Only authorized employees can update a due job for today; scoped managers may correct earlier due dates.' using errcode='42501';
  end if;
  if _done is null then raise exception 'Choose done or not done.' using errcode='22023'; end if;
  if _done then
    insert into public.routine_ticks(routine_item_id,employee_id,on_date,done_at,done_by)
      values(_item.id,_routine.employee_id,_on_date,clock_timestamp(),app.current_employee_id())
      on conflict(routine_item_id,on_date) do nothing;
  else
    delete from public.routine_ticks where routine_item_id=_item.id and on_date=_on_date and employee_id=_routine.employee_id;
  end if;
end $$;

revoke all on function public.replace_routine_set(uuid,text,jsonb,jsonb,text) from public,anon;
revoke all on function public.set_routine_job_tick(uuid,date,boolean) from public,anon;
grant execute on function public.replace_routine_set(uuid,text,jsonb,jsonb,text),
  public.set_routine_job_tick(uuid,date,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
