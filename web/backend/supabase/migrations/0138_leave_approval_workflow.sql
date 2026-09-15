-- Department review precedes HR sanction. Pending remains Pending after department approval,
-- so attendance, leave balances and payroll continue to recognize only a final HR approval.
begin;

alter table public.leaves add column if not exists approval_stage text;

-- Match an actual standard role at the leave's scope, rather than treating every holder of the
-- historic leave.approve permission as an HR officer or department head.
create or replace function app.leave_has_review_role(_user uuid, _roles text[], _leave public.leaves)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select _user is not null
    and exists (select 1 from auth.users u where u.id = _user and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now()))
    and not exists (select 1 from public.profiles p join public.employees e on e.id = p.employee_id
      where p.user_id = _user and e.status <> 'Active')
    and exists (
      select 1 from public.role_assignments ra
      join public.roles r on r.id = ra.role_id
      join public.role_permissions rp on rp.role_id = r.id
      join public.permissions p on p.id = rp.permission_id and p.key = 'leave.approve'
      where ra.user_id = _user and r.key = any(_roles)
        and (r.key <> 'super_admin' or ra.scope_type = 'global') and (
        ra.scope_type = 'global'
        or (ra.scope_type = 'entity' and ra.scope_id = _leave.entity_id)
        or (ra.scope_type = 'zone' and ra.scope_id = _leave.zone_id)
        or (ra.scope_type = 'branch' and ra.scope_id = _leave.branch_id)
        or (ra.scope_type = 'department' and ra.scope_id = _leave.department_id)
      )
    );
$$;

create or replace function app.leave_reviewer(_user uuid, _stage text, _leave public.leaves)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select _user is not null
    and not exists (select 1 from public.profiles p where p.user_id = _user and p.employee_id = _leave.employee_id)
    and not exists (select 1 from public.employees e where e.id = _leave.employee_id and e.user_id = _user)
    and case _stage
      when 'department' then _leave.department_id is not null
        and app.leave_has_review_role(_user, array['dept_head'], _leave)
      when 'hr' then app.leave_has_review_role(_user, array['hr_manager','entity_admin','super_admin'], _leave)
        or exists (select 1 from public.profiles p join auth.users u on u.id = p.user_id
          where p.user_id = _user and p.is_super_admin and u.deleted_at is null
            and (u.banned_until is null or u.banned_until <= now())
            and not exists (select 1 from public.employees e where e.id = p.employee_id and e.status <> 'Active'))
      else false
    end;
$$;

create or replace function app.leave_initial_stage(_leave public.leaves)
returns text language sql stable security definer set search_path = pg_catalog, public, app as $$
  select case
    -- A department head's own request goes directly to HR, including departments with two heads.
    when _leave.department_id is null or exists (
      select 1 from public.employees e where e.id = _leave.employee_id
        and app.leave_has_review_role(e.user_id, array['dept_head'], _leave)
    ) then 'hr'
    when exists (select 1 from public.role_assignments ra join public.roles r on r.id = ra.role_id
      where r.key = 'dept_head' and app.leave_reviewer(ra.user_id, 'department', _leave)) then 'department'
    else 'hr'
  end;
$$;

update public.leaves l set approval_stage = case
  when l.status in ('Pending', 'On Hold') then app.leave_initial_stage(l) else 'completed' end
  where l.approval_stage is null;
alter table public.leaves alter column approval_stage set not null;
alter table public.leaves alter column approval_stage set default 'hr';
alter table public.leaves drop constraint if exists leaves_approval_stage_check;
alter table public.leaves add constraint leaves_approval_stage_check check (
  (status in ('Pending','On Hold') and approval_stage in ('department','hr'))
  or (status in ('Approved','Rejected','Cancelled') and approval_stage = 'completed')
);

create table if not exists public.leave_decisions (
  id uuid primary key default gen_random_uuid(),
  leave_id uuid not null references public.leaves(id) on delete cascade,
  stage text not null check (stage in ('department','hr','system')),
  decision text not null check (decision in ('Approved','Rejected','On Hold','Pending','Cancelled')),
  remarks text not null check (char_length(remarks) between 1 and 2000),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_employee_id uuid references public.employees(id) on delete set null,
  actor_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  from_status text not null,
  to_status text not null,
  from_stage text not null,
  to_stage text not null
);
create index if not exists leave_decisions_leave_idx on public.leave_decisions(leave_id, created_at, id);
alter table public.leave_decisions enable row level security;
drop policy if exists leave_decisions_select on public.leave_decisions;
create policy leave_decisions_select on public.leave_decisions for select to authenticated
  using (exists (select 1 from public.leaves l where l.id = leave_id));
revoke all on public.leave_decisions from anon, authenticated;
grant select on public.leave_decisions to authenticated;

-- Computed fields can be selected alongside leaves through PostgREST. Resolve the persisted row
-- and its read permission, so passing a forged composite value does not manufacture capabilities.
create or replace function public.leave_effective_stage(_leave public.leaves)
returns text language sql stable security definer set search_path = pg_catalog, public, app as $$
  select case when l.approval_stage = 'department' and app.leave_initial_stage(l) = 'hr'
    then 'hr' else l.approval_stage end
  from public.leaves l where l.id = _leave.id
    and app.has_perm('leave.read',l.entity_id,l.zone_id,l.branch_id,l.department_id,l.employee_id);
$$;
create or replace function public.leave_can_decide(_leave public.leaves)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select coalesce((select l.status in ('Pending','On Hold')
    and app.leave_reviewer(auth.uid(), public.leave_effective_stage(l), l)
    and not exists (select 1 from public.attendance a where a.employee_id = l.employee_id
      and a.work_date between l.start_date and l.end_date and a.is_locked)
    from public.leaves l where l.id = _leave.id
      and app.has_perm('leave.read',l.entity_id,l.zone_id,l.branch_id,l.department_id,l.employee_id)), false);
$$;
create or replace function public.leave_can_reopen(_leave public.leaves)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select coalesce((select l.status in ('Approved','Rejected','Cancelled')
    and app.leave_reviewer(auth.uid(), 'hr', l)
    and not (cardinality(coalesce(l.cancelled_dates,'{}'::date[])) > 0 and coalesce(l.days,0) <= 0)
    and not exists (select 1 from public.attendance a where a.employee_id = l.employee_id
      and a.work_date between l.start_date and l.end_date and a.is_locked)
    from public.leaves l where l.id = _leave.id
      and app.has_perm('leave.read',l.entity_id,l.zone_id,l.branch_id,l.department_id,l.employee_id)), false);
$$;

-- Preserve trusted imports and attendance's automatic cancellations. API applicants can supply
-- only request details; decisions and workflow metadata are written through the authenticated RPC.
create or replace function app.tg_route_leave_workflow()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.status <> 'Pending' then
      raise exception 'A new leave request must start pending department/HR review.' using errcode = '42501';
    end if;
    new.approval_stage := case when new.status in ('Pending','On Hold') then app.leave_initial_stage(new) else 'completed' end;
  elsif new.status in ('Approved','Rejected','Cancelled') then
    new.approval_stage := 'completed';
  elsif old.status in ('Approved','Rejected','Cancelled') then
    new.approval_stage := app.leave_initial_stage(new);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_leaves_workflow_route on public.leaves;
create trigger trg_leaves_workflow_route before insert or update on public.leaves
  for each row execute function app.tg_route_leave_workflow();
revoke insert, update, delete on public.leaves from authenticated;
grant insert (id,employee_id,type,start_date,end_date,days,reason,status,leave_type_id,day_fraction)
  on public.leaves to authenticated;

create or replace function public.decide_leave(_leave_id uuid, _decision text, _remarks text)
returns public.leaves language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare
  _before public.leaves%rowtype;
  _after public.leaves%rowtype;
  _stage text;
  _note text := regexp_replace(coalesce(_remarks, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  _next_status text;
  _next_stage text;
  _name text;
begin
  if auth.uid() is null then raise exception 'Sign in to review leave.' using errcode = '42501'; end if;
  if _decision is null or _decision not in ('Approved','Rejected','On Hold','Pending','Cancelled') then
    raise exception 'Choose a valid leave decision.' using errcode = '22023';
  end if;
  if char_length(_note) not between 1 and 2000 then
    raise exception 'Add remarks between 1 and 2000 characters.' using errcode = '22023';
  end if;
  select * into _before from public.leaves where id = _leave_id for update;
  if not found or not app.has_perm('leave.read', _before.entity_id, _before.zone_id,
    _before.branch_id, _before.department_id, _before.employee_id) then
    raise exception 'That leave request is outside your review scope.' using errcode = '42501';
  end if;
  _stage := public.leave_effective_stage(_before);
  if _before.status in ('Pending','On Hold') then
    if not app.leave_reviewer(auth.uid(), _stage, _before) then
      raise exception 'Only the current department/HR reviewer can decide this leave. You cannot review your own request.' using errcode = '42501';
    end if;
    if _decision = 'Pending' and _before.status <> 'On Hold' then
      raise exception 'This leave request is already pending review.' using errcode = '22023';
    end if;
    if _decision = 'On Hold' and _before.status = 'On Hold' then
      raise exception 'This leave request is already on hold.' using errcode = '22023';
    end if;
  else
    if not app.leave_reviewer(auth.uid(), 'hr', _before) then
      raise exception 'Only an HR reviewer can revisit completed leave. You cannot review your own request.' using errcode = '42501';
    end if;
    -- A previous sanction can be withdrawn, but a rejected/cancelled request cannot jump straight
    -- to approval. Reopening starts a fresh review cycle and preserves every earlier decision.
    if _decision not in ('Pending','Cancelled') or (_decision = 'Cancelled' and _before.status = 'Cancelled') then
      raise exception 'Reopen completed leave for review before making another approval decision.' using errcode = '22023';
    end if;
    _stage := 'hr';
  end if;
  if exists (select 1 from public.attendance a where a.employee_id = _before.employee_id
      and a.work_date between _before.start_date and _before.end_date and a.is_locked) then
    raise exception 'Attendance is locked by finalized payroll; this leave cannot be changed.' using errcode = '55000';
  end if;
  if _decision in ('Approved','Pending') and cardinality(coalesce(_before.cancelled_dates,'{}'::date[])) > 0
    and coalesce(_before.days,0) <= 0 then
    raise exception 'All leave dates were cancelled by recorded attendance. Submit a new request for different dates.' using errcode = '22023';
  end if;
  _next_status := case when _stage = 'department' and _decision = 'Approved' then 'Pending' else _decision end;
  _next_stage := case
    when _stage = 'department' and _decision = 'Approved' then 'hr'
    when _next_status in ('Approved','Rejected','Cancelled') then 'completed'
    when _before.approval_stage = 'completed' then app.leave_initial_stage(_before)
    else _stage end;
  select coalesce(e.full_name, 'Reviewer') into _name
    from public.profiles p left join public.employees e on e.id = p.employee_id where p.user_id = auth.uid();
  update public.leaves set status = _next_status, approval_stage = _next_stage,
    decision_note = _note,
    approver_id = case when _next_status in ('Approved','Rejected','Cancelled') then app.current_employee_id() else null end
    where id = _leave_id returning * into _after;
  -- Balance/attendance triggers may update derived fields after the outer UPDATE returns.
  select * into _after from public.leaves where id = _leave_id;
  insert into public.leave_decisions(leave_id,stage,decision,remarks,actor_user_id,actor_employee_id,
    actor_name,from_status,to_status,from_stage,to_stage)
    values (_leave_id,_stage,_decision,_note,auth.uid(),app.current_employee_id(),coalesce(_name,'Reviewer'),
      _before.status,_after.status,_before.approval_stage,_after.approval_stage);
  return _after;
end;
$$;

-- Notify only the current reviewers. Department endorsement is explicitly a hand-off, not a
-- sanction, and stale reviewer notifications are cleared when the request moves to another stage.
create or replace function app.tg_notify_leave()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _name text; _emp_user uuid; _range text; _title text; _message text; _cancelled_date date; _stage text; _reviewer uuid;
begin
  select e.full_name,e.user_id into _name,_emp_user from public.employees e where e.id = new.employee_id;
  _range := to_char(new.start_date,'DD Mon') || ' - ' || to_char(new.end_date,'DD Mon');
  if tg_op = 'UPDATE' and new.cancelled_dates is distinct from old.cancelled_dates then
    select d into _cancelled_date from unnest(new.cancelled_dates) d
      where not (d = any(coalesce(old.cancelled_dates,'{}'::date[]))) order by d desc limit 1;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.approval_stage is distinct from old.approval_stage then
    update public.notifications set read_at = clock_timestamp()
      where type = 'leave' and ref_id = new.id and read_at is null and user_id is distinct from _emp_user;
    if new.status in ('Pending','On Hold') then
      _stage := new.approval_stage;
      for _reviewer in select u.id from auth.users u where app.leave_reviewer(u.id,_stage,new) loop
        perform app.notify_user(_reviewer,'leave',case when _stage = 'hr' then 'Leave awaiting HR sanction' else 'Leave awaiting department review' end,
          coalesce(_name,'An employee') || ' requested ' || coalesce(new.days::text,'?') || ' day(s) of ' || new.type || ' leave (' || _range || ').', 'leave',new.id);
      end loop;
    end if;
  end if;
  if tg_op = 'UPDATE' and old.approval_stage = 'department' and new.approval_stage = 'hr'
    and new.status = 'Pending' and app.leave_initial_stage(old) = 'department' then
    perform app.notify_user(_emp_user,'leave','Department approved; awaiting HR sanction',
      'Your ' || new.type || ' leave (' || _range || ') passed department review and is awaiting final HR sanction.', 'leave',new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    _title := case new.status when 'Pending' then 'Leave returned for review' when 'On Hold' then 'Leave put on hold' else 'Leave ' || lower(new.status) end;
    _message := case when new.status = 'Cancelled' and _cancelled_date is not null then
      'Your ' || new.type || ' leave was cancelled because attendance was recorded on ' || to_char(_cancelled_date,'DD Mon YYYY') || '.'
      when new.status = 'Pending' then 'Your ' || new.type || ' leave (' || _range || ') is pending review again.'
      when new.status = 'On Hold' then 'Your ' || new.type || ' leave (' || _range || ') is now on hold.'
      else 'Your ' || new.type || ' leave (' || _range || ') was ' || lower(new.status) || '.' end;
    perform app.notify_user(_emp_user,'leave',_title,_message,'leave',new.id);
  elsif tg_op = 'UPDATE' and _cancelled_date is not null then
    perform app.notify_user(_emp_user,'leave','Leave day cancelled',
      'Your leave on ' || to_char(_cancelled_date,'DD Mon YYYY') || ' was cancelled because attendance was recorded. The other approved dates are unchanged.', 'leave',new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_leaves_notify on public.leaves;
create trigger trg_leaves_notify after insert or update of status,approval_stage,cancelled_dates on public.leaves
  for each row execute function app.tg_notify_leave();

-- Existing requests move to the same queue as new requests, without changing a settled sanction.
update public.notifications n set read_at = clock_timestamp()
  from public.leaves l join public.employees e on e.id = l.employee_id
  where n.type = 'leave' and n.ref_id = l.id and n.read_at is null
    and n.user_id is distinct from e.user_id
    and (l.status not in ('Pending','On Hold') or not app.leave_reviewer(n.user_id,l.approval_stage,l));
insert into public.notifications(user_id,type,title,body,tab,ref_id)
  select u.id,'leave',case l.approval_stage when 'hr' then 'Leave awaiting HR sanction' else 'Leave awaiting department review' end,
    e.full_name || ' has a leave request awaiting your review.','leave',l.id
    from public.leaves l join public.employees e on e.id = l.employee_id
    join auth.users u on app.leave_reviewer(u.id,l.approval_stage,l)
    where l.status in ('Pending','On Hold') and not exists (
      select 1 from public.notifications n where n.user_id = u.id and n.type = 'leave' and n.ref_id = l.id and n.read_at is null
    );

revoke all on function app.leave_has_review_role(uuid,text[],public.leaves), app.leave_reviewer(uuid,text,public.leaves),
  app.leave_initial_stage(public.leaves), app.tg_route_leave_workflow() from public,anon,authenticated;
revoke all on function public.leave_effective_stage(public.leaves), public.leave_can_decide(public.leaves),
  public.leave_can_reopen(public.leaves), public.decide_leave(uuid,text,text) from public,anon;
grant execute on function public.leave_effective_stage(public.leaves), public.leave_can_decide(public.leaves),
  public.leave_can_reopen(public.leaves), public.decide_leave(uuid,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
