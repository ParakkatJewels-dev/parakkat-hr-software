-- Named routines are immutable sets of jobs assigned to one employee. Bulk assignment copies
-- the definition atomically; replacement versions start in the future and preserve past totals.
begin;

create table if not exists public.routine_sets (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  entity_id uuid, zone_id uuid, branch_id uuid, department_id uuid,
  title text not null check(char_length(regexp_replace(title,'^[[:space:]]+|[[:space:]]+$','','g')) between 1 and 120),
  detail text check(char_length(detail)<=4000),
  frequency text not null check(frequency in('daily','weekly','monthly','interval','once')),
  start_date date not null,
  end_date date,
  weekdays integer[] not null default '{}',
  month_day integer,
  interval_days integer,
  -- Last scheduled date, inclusive. Retiring today preserves all jobs due today.
  retired_on date,
  history_start_date date not null,
  is_legacy boolean not null default false,
  replaces_id uuid references public.routine_sets(id) on delete restrict,
  replaced_by uuid references public.routine_sets(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  check(end_date is null or end_date>=start_date),
  check(weekdays <@ array[1,2,3,4,5,6,7]),
  check(frequency<>'weekly' or cardinality(weekdays)>0),
  check(frequency<>'monthly' or (month_day is not null and month_day between 1 and 31)),
  check(frequency<>'interval' or (interval_days is not null and interval_days between 1 and 366))
);
create index if not exists routine_sets_employee_idx on public.routine_sets(employee_id,start_date,id);
create index if not exists routine_sets_batch_idx on public.routine_sets(batch_id,id);
alter table public.routine_sets enable row level security;
alter table public.routine_items add column if not exists routine_id uuid references public.routine_sets(id) on delete restrict;
create index if not exists routine_items_set_idx on public.routine_items(routine_id,sort_order,id);

-- 0107 accepted a client employee_id independently from the referenced duty. Preserve suspect
-- payloads privately instead of treating a forged owner as a legitimate historical completion.
create table if not exists app.routine_tick_quarantine (
  id uuid primary key,
  payload jsonb not null,
  reason text not null,
  captured_at timestamptz not null default clock_timestamp()
);
revoke all on app.routine_tick_quarantine from public,anon,authenticated;
insert into app.routine_tick_quarantine(id,payload,reason)
  select t.id,to_jsonb(t),case when t.employee_id is distinct from i.employee_id
    then 'Completion owner did not match the assigned duty' else 'Completion was recorded for a future date' end
  from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id
  where t.employee_id is distinct from i.employee_id or t.on_date>(now() at time zone 'Asia/Kolkata')::date on conflict(id) do nothing;
delete from public.routine_ticks t using public.routine_items i
  where i.id=t.routine_item_id and (t.employee_id is distinct from i.employee_id or t.on_date>(now() at time zone 'Asia/Kolkata')::date);

-- Legacy ticks remain intact. The former schema has no reliable retirement/activation history,
-- so exact expected/missed totals begin at migration time; older ticks are reported separately.
do $$ declare _employee uuid; _set uuid; _today date:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
begin
  for _employee in select distinct employee_id from public.routine_items where routine_id is null loop
    insert into public.routine_sets(employee_id,entity_id,zone_id,branch_id,department_id,title,frequency,start_date,history_start_date,is_legacy)
      select e.id,e.entity_id,e.zone_id,e.branch_id,e.department_id,'Daily routine','daily',_today,_today,true
      from public.employees e where e.id=_employee returning id into _set;
    update public.routine_items set routine_id=_set where employee_id=_employee and routine_id is null;
  end loop;
end $$;
alter table public.routine_items alter column routine_id set not null;

create or replace function app.routine_actor_active()
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select auth.uid() is not null and exists(select 1 from auth.users u where u.id=auth.uid()
    and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()))
    and not exists(select 1 from public.profiles p join public.employees e on e.id=p.employee_id
      where p.user_id=auth.uid() and e.status<>'Active');
$$;
create or replace function app.routine_allowed(_permission text,_employee uuid,_beyond_self boolean default false)
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  -- Current employee ancestry governs access after a transfer; an old head cannot keep editing
  -- an assignment merely because its creation snapshot belonged to that department.
  select app.routine_actor_active() and exists(select 1 from public.employees e where e.id=_employee
    and app.has_perm(_permission,e.entity_id,e.zone_id,e.branch_id,e.department_id,case when _beyond_self then null else e.id end));
$$;
create or replace function app.routine_due(_routine public.routine_sets,_on_date date)
returns boolean language sql immutable set search_path=pg_catalog,public,app as $$
  select coalesce(_on_date>=_routine.start_date
    and (_routine.end_date is null or _on_date<=_routine.end_date)
    and (_routine.retired_on is null or _on_date<=_routine.retired_on)
    and case _routine.frequency
      when 'daily' then true
      when 'weekly' then extract(isodow from _on_date)::integer=any(_routine.weekdays)
      when 'monthly' then extract(day from _on_date)::integer=least(_routine.month_day,
        extract(day from (date_trunc('month',_on_date::timestamp)+interval'1 month - 1 day'))::integer)
      when 'interval' then mod(_on_date-_routine.start_date,_routine.interval_days)=0
      when 'once' then _on_date=_routine.start_date
      else false end,false);
$$;
create or replace function app.routine_can_tick(_routine public.routine_sets,_on_date date)
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select app.routine_allowed('task.read',_routine.employee_id)
    and app.routine_allowed('task.update',_routine.employee_id)
    and _on_date<=(now() at time zone 'Asia/Kolkata')::date
    and (_on_date=(now() at time zone 'Asia/Kolkata')::date
      or app.routine_allowed('task.update',_routine.employee_id,true))
    and app.routine_due(_routine,_on_date);
$$;

-- Drop the old FOR ALL policies as well as write grants: otherwise task.create/task.update
-- silently act as alternate SELECT permissions even after task.read is revoked.
drop policy if exists routine_items_write on public.routine_items;
drop policy if exists routine_ticks_write on public.routine_ticks;
drop policy if exists routine_items_select on public.routine_items;
create policy routine_items_select on public.routine_items for select to authenticated
  using(app.routine_allowed('task.read',employee_id));
drop policy if exists routine_ticks_select on public.routine_ticks;
create policy routine_ticks_select on public.routine_ticks for select to authenticated
  using(exists(select 1 from public.routine_items i where i.id=routine_ticks.routine_item_id and i.employee_id=routine_ticks.employee_id));
drop policy if exists routine_sets_select on public.routine_sets;
create policy routine_sets_select on public.routine_sets for select to authenticated
  using(app.routine_allowed('task.read',employee_id));
revoke all on public.routine_sets,public.routine_items,public.routine_ticks from public,anon,authenticated;
grant select on public.routine_sets,public.routine_items,public.routine_ticks to authenticated;

create or replace function app.routine_validate(_title text,_jobs jsonb,_schedule jsonb,_detail text,_minimum_date date)
returns jsonb language plpgsql stable set search_path=pg_catalog,public,app as $$
declare _start date; _end date; _frequency text; _weekdays integer[]:='{}'; _month_day integer; _interval integer;
begin
  if char_length(regexp_replace(coalesce(_title,''),'^[[:space:]]+|[[:space:]]+$','','g')) not between 1 and 120 or char_length(coalesce(_detail,''))>4000
      or jsonb_typeof(_jobs) is distinct from 'array' or jsonb_array_length(_jobs) not between 1 and 100 then
    raise exception 'Name the routine (1 to 120 characters) and add 1 to 100 jobs.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(_jobs) j where jsonb_typeof(j) is distinct from 'object'
      or jsonb_typeof(j->'title') is distinct from 'string'
      or char_length(regexp_replace(coalesce(j->>'title',''),'^[[:space:]]+|[[:space:]]+$','','g')) not between 1 and 200
      or char_length(coalesce(j->>'detail',''))>4000) then
    raise exception 'Every job needs a title of 1 to 200 characters; details can contain up to 4000.' using errcode='22023';
  end if;
  if jsonb_typeof(_schedule) is distinct from 'object' then
    raise exception 'Choose a routine schedule.' using errcode='22023';
  end if;
  begin
    _start:=(_schedule->>'start_date')::date; _end:=nullif(_schedule->>'end_date','')::date;
    _frequency:=_schedule->>'frequency';
    if _frequency='weekly' then
      if jsonb_typeof(_schedule->'weekdays') is distinct from 'array' then raise invalid_parameter_value; end if;
      select array_agg(distinct v::integer order by v::integer) into _weekdays from jsonb_array_elements_text(_schedule->'weekdays') v;
    elsif _frequency='monthly' then _month_day:=(_schedule->>'month_day')::integer;
    elsif _frequency='interval' then _interval:=(_schedule->>'interval_days')::integer;
    end if;
  exception when others then
    raise exception 'Use valid dates, ISO weekdays 1 to 7, month day 1 to 31, or an interval of 1 to 366 days.' using errcode='22023';
  end;
  if _start is null or _start<_minimum_date or (_end is not null and _end<_start)
      or _frequency is null or _frequency not in('daily','weekly','monthly','interval','once')
      or (_frequency='weekly' and (coalesce(cardinality(_weekdays),0)=0 or not _weekdays<@array[1,2,3,4,5,6,7]))
      or (_frequency='monthly' and (_month_day is null or _month_day not between 1 and 31))
      or (_frequency='interval' and (_interval is null or _interval not between 1 and 366)) then
    raise exception 'Choose a valid schedule starting on or after %.',_minimum_date using errcode='22023';
  end if;
  return jsonb_build_object('frequency',_frequency,'start_date',_start,'end_date',_end,
    'weekdays',coalesce(to_jsonb(_weekdays),'[]'::jsonb),'month_day',_month_day,'interval_days',_interval);
end $$;

create or replace function app.routine_insert(_employee uuid,_batch uuid,_title text,_jobs jsonb,_schedule jsonb,_detail text,_replaces uuid default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _id uuid;
begin
  insert into public.routine_sets(batch_id,employee_id,entity_id,zone_id,branch_id,department_id,title,detail,
      frequency,start_date,end_date,weekdays,month_day,interval_days,history_start_date,created_by,replaces_id)
    select _batch,e.id,e.entity_id,e.zone_id,e.branch_id,e.department_id,regexp_replace(_title,'^[[:space:]]+|[[:space:]]+$','','g'),nullif(btrim(_detail),''),
      _schedule->>'frequency',(_schedule->>'start_date')::date,(_schedule->>'end_date')::date,
      array(select v::integer from jsonb_array_elements_text(_schedule->'weekdays') v),
      (_schedule->>'month_day')::integer,(_schedule->>'interval_days')::integer,
      (_schedule->>'start_date')::date,auth.uid(),_replaces from public.employees e where e.id=_employee returning id into _id;
  insert into public.routine_items(routine_id,employee_id,title,detail,sort_order,created_by)
    select _id,_employee,regexp_replace(j.value->>'title','^[[:space:]]+|[[:space:]]+$','','g'),nullif(btrim(j.value->>'detail'),''),j.ordinality::integer-1,app.current_employee_id()
    from jsonb_array_elements(_jobs) with ordinality j;
  return _id;
end $$;

create or replace function public.create_routine_set(_employee_ids uuid[],_title text,_jobs jsonb,_schedule jsonb,_detail text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _schedule_clean jsonb; _ids uuid[]; _employee uuid; _batch uuid:=gen_random_uuid(); _created uuid[]:='{}';
begin
  if not app.routine_actor_active() then raise exception 'Sign in with an active account.' using errcode='42501'; end if;
  if _employee_ids is null or cardinality(_employee_ids) not between 1 and 1000 or array_position(_employee_ids,null) is not null then
    raise exception 'Choose between 1 and 1000 employees.' using errcode='22023';
  end if;
  select array_agg(distinct id order by id) into _ids from unnest(_employee_ids) id;
  _schedule_clean:=app.routine_validate(_title,_jobs,_schedule,_detail,(now() at time zone 'Asia/Kolkata')::date);
  perform 1 from public.employees e where e.id=any(_ids) order by e.id for share;
  if (select count(*) from public.employees e where e.id=any(_ids) and e.status='Active'
      and app.routine_allowed('task.create',e.id))<>cardinality(_ids) then
    raise exception 'Every selected employee must be active and within your routine assignment scope.' using errcode='42501';
  end if;
  foreach _employee in array _ids loop
    _created:=array_append(_created,app.routine_insert(_employee,_batch,_title,_jobs,_schedule_clean,_detail));
  end loop;
  return jsonb_build_object('batch_id',_batch,'routine_ids',to_jsonb(_created),'assigned_count',cardinality(_created));
end $$;

create or replace function public.replace_routine_set(_id uuid,_title text,_jobs jsonb,_schedule jsonb,_detail text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _old public.routine_sets; _new uuid; _clean jsonb; _start date;
begin
  select * into _old from public.routine_sets where id=_id for update;
  if _old.id is null or not app.routine_allowed('task.read',_old.employee_id)
      or not app.routine_allowed('task.create',_old.employee_id) then
    raise exception 'That routine is outside the scope you can manage.' using errcode='42501';
  end if;
  perform 1 from public.employees where id=_old.employee_id and status='Active' for share;
  if not found then raise exception 'Assign a replacement only to an active employee.' using errcode='42501'; end if;
  if _old.replaced_by is not null then raise exception 'This routine already has a replacement. Edit its latest version.' using errcode='22023'; end if;
  _clean:=app.routine_validate(_title,_jobs,_schedule,_detail,(now() at time zone 'Asia/Kolkata')::date+1);
  _start:=(_clean->>'start_date')::date;
  _new:=app.routine_insert(_old.employee_id,_old.batch_id,_title,_jobs,_clean,_detail,_old.id);
  update public.routine_sets set retired_on=least(coalesce(retired_on,_start-1),coalesce(end_date,_start-1),_start-1),replaced_by=_new where id=_old.id;
  return _new;
end $$;

create or replace function public.retire_routine_set(_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _routine public.routine_sets; _today date:=(now() at time zone 'Asia/Kolkata')::date;
begin
  select * into _routine from public.routine_sets where id=_id for update;
  if _routine.id is null or not app.routine_allowed('task.read',_routine.employee_id)
      or not app.routine_allowed('task.create',_routine.employee_id) then
    raise exception 'That routine is outside the scope you can manage.' using errcode='42501';
  end if;
  update public.routine_sets set retired_on=least(coalesce(retired_on,_today),coalesce(end_date,_today),_today) where id=_id;
end $$;

create or replace function public.set_routine_job_tick(_item_id uuid,_on_date date,_done boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _item public.routine_items; _routine public.routine_sets;
begin
  select * into _item from public.routine_items where id=_item_id for update;
  select * into _routine from public.routine_sets where id=_item.routine_id for share;
  if _item.id is null or not _item.is_active or not app.routine_can_tick(_routine,_on_date) then
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

create or replace function app.routine_employee_json(_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,app as $$
  select jsonb_build_object('id',e.id,'full_name',e.full_name,'employee_code',e.employee_code,
    'entity_id',e.entity_id,'zone_id',e.zone_id,'branch_id',e.branch_id,'department_id',e.department_id,'designation_id',e.designation_id,
    'designation',case when g.id is not null then jsonb_build_object('id',g.id,'title',g.title)end,
    'department',case when d.id is not null then jsonb_build_object('id',d.id,'name',d.name,'code',d.code)end,
    'branch',case when b.id is not null then jsonb_build_object('id',b.id,'name',b.name,'code',b.code)end)
  from public.employees e left join public.designations g on g.id=e.designation_id
  left join public.departments d on d.id=e.department_id left join public.branches b on b.id=e.branch_id where e.id=_id;
$$;
create or replace function public.list_routine_sets(_employee_id uuid default null,_include_retired boolean default false)
returns table(id uuid,batch_id uuid,title text,detail text,employee_id uuid,employee jsonb,frequency text,start_date date,end_date date,
  weekdays integer[],month_day integer,interval_days integer,retired_on date,history_start_date date,is_legacy boolean,
  replaces_id uuid,replaced_by uuid,created_at timestamptz,jobs jsonb,can_manage boolean)
language sql stable security definer set search_path=pg_catalog,public,app as $$
  select s.id,s.batch_id,s.title,s.detail,s.employee_id,app.routine_employee_json(s.employee_id),s.frequency,s.start_date,s.end_date,
    s.weekdays,s.month_day,s.interval_days,s.retired_on,s.history_start_date,s.is_legacy,s.replaces_id,s.replaced_by,s.created_at,
    coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'detail',i.detail,'sort_order',i.sort_order,'is_active',i.is_active)
      order by i.sort_order,i.id)from public.routine_items i where i.routine_id=s.id),'[]'::jsonb),
    app.routine_allowed('task.create',s.employee_id)
  from public.routine_sets s where app.routine_allowed('task.read',s.employee_id)
    and (_employee_id is null or s.employee_id=_employee_id)
    and (_include_retired or ((s.retired_on is null or s.retired_on>=(now() at time zone 'Asia/Kolkata')::date)
      and (s.end_date is null or s.end_date>=(now() at time zone 'Asia/Kolkata')::date)
      and (s.frequency<>'once' or s.start_date>=(now() at time zone 'Asia/Kolkata')::date)))
  order by s.created_at desc,s.id;
$$;

create or replace function public.routine_day(_on_date date,_employee_id uuid default null)
returns table(id uuid,routine_id uuid,routine_name text,title text,detail text,sort_order integer,employee_id uuid,employee jsonb,
  frequency text,start_date date,end_date date,weekdays integer[],month_day integer,interval_days integer,
  on_date date,done boolean,done_at timestamptz,can_tick boolean,can_manage boolean)
language sql stable security definer set search_path=pg_catalog,public,app as $$
  select i.id,s.id,s.title,i.title,i.detail,i.sort_order,s.employee_id,app.routine_employee_json(s.employee_id),s.frequency,
    s.start_date,s.end_date,s.weekdays,s.month_day,s.interval_days,_on_date,
    t.id is not null,t.done_at,app.routine_can_tick(s,_on_date),app.routine_allowed('task.create',s.employee_id)
  from public.routine_sets s join public.routine_items i on i.routine_id=s.id and i.is_active
  left join public.routine_ticks t on t.routine_item_id=i.id and t.employee_id=s.employee_id and t.on_date=_on_date
  where app.routine_allowed('task.read',s.employee_id) and (_employee_id is null or s.employee_id=_employee_id)
    and app.routine_due(s,_on_date) order by s.employee_id,s.created_at,s.id,i.sort_order,i.id;
$$;

create or replace function public.routine_completion_stats(_from date,_to date,_employee_ids uuid[] default null)
returns table(id uuid,employee_id uuid,employee jsonb,routine_id uuid,routine_name text,frequency text,
  scheduled bigint,completed bigint,missed bigint,pending bigint,total_jobs bigint,done_jobs bigint,pct integer,
  scheduled_runs bigint,completed_runs bigint,history_start_date date,unscored_done_jobs bigint)
language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare _today date:=(now() at time zone 'Asia/Kolkata')::date;
begin
  if _from is null or _to is null or _to<_from or _to-_from>365 then
    raise exception 'Choose a date range of up to 366 days.' using errcode='22023';
  end if;
  if _employee_ids is not null and cardinality(_employee_ids)>1000 then
    raise exception 'Filter at most 1000 employees at a time.' using errcode='22023';
  end if;
  return query
  with allowed as materialized (
    select s.* from public.routine_sets s where app.routine_allowed('task.read',s.employee_id)
      and (_employee_ids is null or s.employee_id=any(_employee_ids))
  ), days as (
    select s.id as sid,g.day::date as day from allowed s
    cross join lateral generate_series(greatest(_from,s.start_date,s.history_start_date),
      least(_to,_today,coalesce(s.end_date,_today),coalesce(s.retired_on,_today)),interval'1 day') g(day)
    where app.routine_due(s,g.day::date)
  ), runs as (
    select d.sid,d.day,count(i.id)::bigint as jobs,count(t.id)::bigint as done
    from days d join public.routine_items i on i.routine_id=d.sid and i.is_active
    join allowed s on s.id=d.sid
    left join public.routine_ticks t on t.routine_item_id=i.id and t.employee_id=s.employee_id and t.on_date=d.day
    group by d.sid,d.day
  ), totals as (
    select r.sid,sum(r.jobs)::bigint as jobs,sum(r.done)::bigint as done,
      coalesce(sum(r.jobs-r.done)filter(where r.day<_today),0)::bigint as missed,
      coalesce(sum(r.jobs-r.done)filter(where r.day=_today),0)::bigint as pending,
      count(*)::bigint as runs,count(*)filter(where r.jobs=r.done)::bigint as done_runs
    from runs r group by r.sid
  ), unscored as (
    select s.id as sid,count(t.id)::bigint as done from allowed s
    join public.routine_items i on i.routine_id=s.id
    join public.routine_ticks t on t.routine_item_id=i.id and t.employee_id=s.employee_id
    where s.is_legacy and t.on_date>=_from and t.on_date<=least(_to,_today)
      and (t.on_date<s.history_start_date or not i.is_active)
    group by s.id
  )
  select s.id,s.employee_id,app.routine_employee_json(s.employee_id),s.id,s.title,s.frequency,
    coalesce(t.jobs,0),coalesce(t.done,0),coalesce(t.missed,0),coalesce(t.pending,0),coalesce(t.jobs,0),coalesce(t.done,0),
    case when coalesce(t.jobs,0)>0 then round(t.done*100.0/t.jobs)::integer else 0 end,
    coalesce(t.runs,0),coalesce(t.done_runs,0),s.history_start_date,coalesce(u.done,0)
  from allowed s left join totals t on t.sid=s.id left join unscored u on u.sid=s.id
  where coalesce(t.jobs,0)>0 or coalesce(u.done,0)>0 order by s.employee_id,s.id;
end $$;

revoke all on function app.routine_actor_active(),app.routine_due(public.routine_sets,date),
  app.routine_can_tick(public.routine_sets,date),app.routine_validate(text,jsonb,jsonb,text,date),
  app.routine_insert(uuid,uuid,text,jsonb,jsonb,text,uuid),app.routine_employee_json(uuid) from public,anon,authenticated;
revoke all on function app.routine_allowed(text,uuid,boolean) from public,anon;
grant execute on function app.routine_allowed(text,uuid,boolean) to authenticated;
revoke all on function public.create_routine_set(uuid[],text,jsonb,jsonb,text),
  public.replace_routine_set(uuid,text,jsonb,jsonb,text),public.retire_routine_set(uuid),
  public.set_routine_job_tick(uuid,date,boolean),public.list_routine_sets(uuid,boolean),
  public.routine_day(date,uuid),public.routine_completion_stats(date,date,uuid[]) from public,anon;
grant execute on function public.create_routine_set(uuid[],text,jsonb,jsonb,text),
  public.replace_routine_set(uuid,text,jsonb,jsonb,text),public.retire_routine_set(uuid),
  public.set_routine_job_tick(uuid,date,boolean),public.list_routine_sets(uuid,boolean),
  public.routine_day(date,uuid),public.routine_completion_stats(date,date,uuid[]) to authenticated;
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='routine_sets') then
    alter publication supabase_realtime add table public.routine_sets;
  end if;
end $$;
notify pgrst,'reload schema';
commit;
