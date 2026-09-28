-- Employee explanations are append-only occurrence evidence, independent of later schedule edits.
begin;
create table if not exists public.routine_notes (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routine_sets(id) on delete restrict,
  batch_id uuid not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  on_date date not null,
  body text not null check(char_length(body) between 1 and 4000),
  -- Immutable actor snapshots deliberately survive later account unlinking or removal.
  author_user uuid not null,
  author_name text not null,
  routine_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  client_id uuid not null,
  completed_jobs integer not null check(completed_jobs>=0),
  total_jobs integer not null check(total_jobs between 1 and 100 and completed_jobs<=total_jobs),
  job_snapshot jsonb not null check(jsonb_typeof(job_snapshot)='array'),
  unique(author_user,client_id)
);
comment on table public.routine_notes is 'Append-only employee explanations with server-owned author, time and completion evidence. Corrections are new notes.';
comment on column public.routine_notes.batch_id is 'Stable schedule lineage, paired with employee_id because bulk assignment shares its batch.';
create index if not exists routine_notes_occurrence_idx on public.routine_notes(batch_id,employee_id,on_date,created_at,id);
create index if not exists routine_notes_audit_idx on public.routine_notes(on_date,employee_id,created_at,id);
alter table public.routine_notes enable row level security;
drop policy if exists routine_notes_read on public.routine_notes;
create policy routine_notes_read on public.routine_notes for select to authenticated
  using(app.routine_allowed('task.read',employee_id));
drop policy if exists active_account_required on public.routine_notes;
create policy active_account_required on public.routine_notes as restrictive for all to authenticated
  using((select app.session_is_active())) with check((select app.session_is_active()));
revoke all on public.routine_notes from public,anon,authenticated;
grant select on public.routine_notes to authenticated;

create or replace function app.routine_note_immutable()
returns trigger language plpgsql set search_path=pg_catalog,public,app as $$
begin
  raise exception 'Saved routine notes are audit records. Add a new note to correct an earlier note.' using errcode='42501';
end $$;
revoke all on function app.routine_note_immutable() from public,anon,authenticated;
drop trigger if exists routine_note_immutable on public.routine_notes;
create trigger routine_note_immutable before update or delete on public.routine_notes
  for each row execute function app.routine_note_immutable();

create or replace function public.add_routine_note(_routine_id uuid,_on_date date,_body text,_client_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare
  _routine public.routine_sets; _existing public.routine_notes; _id uuid;
  _clean text:=regexp_replace(coalesce(_body,''),'^[[:space:]]+|[[:space:]]+$','','g');
  _name text; _snapshot jsonb; _total integer; _completed integer;
begin
  -- The same parent lock used by ticks and edits makes the evidence a consistent observation.
  select * into _routine from public.routine_sets where id=_routine_id for update;
  if _routine.id is null or _routine.employee_id is distinct from app.current_employee_id()
      or not app.routine_allowed('task.read',_routine.employee_id)
      or not app.routine_allowed('task.update',_routine.employee_id) then
    raise exception 'You can add a routine note only for your own assigned routine.' using errcode='42501';
  end if;
  if _client_id is null or _on_date is null or char_length(_clean) not between 1 and 4000 then
    raise exception 'Choose a routine date and enter a note of 1 to 4000 characters.' using errcode='22023';
  end if;
  -- A network retry must return the original record even after a same-day schedule replacement.
  select * into _existing from public.routine_notes where author_user=auth.uid() and client_id=_client_id;
  if _existing.id is not null then
    if _existing.batch_id=_routine.batch_id and _existing.employee_id=_routine.employee_id
        and _existing.on_date=_on_date and _existing.body=_clean then return _existing.id; end if;
    raise exception 'This note request was already used for different content. Reload and add a new note.' using errcode='22023';
  end if;
  if _on_date>(now() at time zone 'Asia/Kolkata')::date or not app.routine_due(_routine,_on_date) then
    raise exception 'Add notes only for a due routine on today or an earlier date. Reload if its schedule has changed.' using errcode='42501';
  end if;
  select coalesce(nullif(btrim(e.full_name),''),'Employee') into _name from public.employees e
    where e.id=_routine.employee_id and e.status='Active' for share;
  if not found then raise exception 'Only an active employee can add a routine note.' using errcode='42501'; end if;
  select count(*)::integer,count(t.id)::integer,
    jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'done',t.id is not null,'done_at',t.done_at) order by i.sort_order,i.id)
    into _total,_completed,_snapshot
    from public.routine_items i left join public.routine_ticks t
      on t.routine_item_id=i.id and t.employee_id=_routine.employee_id and t.on_date=_on_date
    where i.routine_id=_routine.id and i.is_active;
  if _total=0 then raise exception 'This routine has no scheduled jobs. Reload its current schedule.' using errcode='22023'; end if;
  insert into public.routine_notes(routine_id,batch_id,employee_id,on_date,body,author_user,author_name,routine_name,
    client_id,completed_jobs,total_jobs,job_snapshot)
    values(_routine.id,_routine.batch_id,_routine.employee_id,_on_date,_clean,auth.uid(),_name,_routine.title,
      _client_id,_completed,_total,_snapshot)
    on conflict(author_user,client_id) do nothing returning id into _id;
  if _id is not null then return _id; end if;
  -- Concurrent retries can reach different schedule versions; the unique actor/client key wins.
  select * into _existing from public.routine_notes where author_user=auth.uid() and client_id=_client_id;
  if _existing.batch_id=_routine.batch_id and _existing.employee_id=_routine.employee_id
      and _existing.on_date=_on_date and _existing.body=_clean then return _existing.id; end if;
  raise exception 'This note request was already used for different content. Reload and add a new note.' using errcode='22023';
end $$;

create or replace function public.list_routine_notes(_routine_id uuid,_on_date date)
returns table(id uuid,routine_id uuid,on_date date,body text,created_at timestamptz,author_name text,
  employee_id uuid,completed_jobs integer,total_jobs integer,routine_name text)
language sql stable security definer set search_path=pg_catalog,public,app as $$
  select n.id,n.routine_id,n.on_date,n.body,n.created_at,n.author_name,n.employee_id,n.completed_jobs,n.total_jobs,n.routine_name
    from public.routine_sets s join public.routine_notes n on n.batch_id=s.batch_id and n.employee_id=s.employee_id
    where s.id=_routine_id and n.on_date=_on_date and app.routine_allowed('task.read',s.employee_id)
    order by n.created_at,n.id;
$$;

create or replace function public.list_routine_note_audit(_from date,_to date,_employee_id uuid default null)
returns table(id uuid,routine_id uuid,on_date date,body text,created_at timestamptz,author_name text,
  employee_id uuid,completed_jobs integer,total_jobs integer,routine_name text,employee jsonb)
language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
begin
  if _from is null or _to is null or _to<_from or _to-_from>365 then
    raise exception 'Choose a note audit date range of up to 366 days.' using errcode='22023';
  end if;
  return query select n.id,n.routine_id,n.on_date,n.body,n.created_at,n.author_name,n.employee_id,n.completed_jobs,n.total_jobs,
    n.routine_name,app.routine_employee_json(n.employee_id)
    from public.routine_notes n where n.on_date between _from and _to
      and (_employee_id is null or n.employee_id=_employee_id) and app.routine_allowed('task.read',n.employee_id)
    order by n.on_date desc,n.created_at desc,n.id;
end $$;
revoke all on function public.add_routine_note(uuid,date,text,uuid),public.list_routine_notes(uuid,date),
  public.list_routine_note_audit(date,date,uuid) from public,anon;
grant execute on function public.add_routine_note(uuid,date,text,uuid),public.list_routine_notes(uuid,date),
  public.list_routine_note_audit(date,date,uuid) to authenticated;
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='routine_notes') then
    alter publication supabase_realtime add table public.routine_notes;
  end if;
end $$;
notify pgrst,'reload schema';
commit;
