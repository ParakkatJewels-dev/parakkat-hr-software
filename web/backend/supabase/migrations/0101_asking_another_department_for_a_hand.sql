-- 0101_asking_another_department_for_a_hand.sql
--
-- Work does not respect the org chart. A department head needs a hand from somebody who does not
-- report to them, and today there is no way to ask: tasks_insert checks task.create against the
-- ASSIGNEE's ancestry, so filing a task on another department's employee is refused, and correctly
-- so — nobody should be able to put work on a stranger's board without their head knowing.
--
-- So the ask becomes a thing in its own right. One head raises a request against another
-- DEPARTMENT, naming the work and, if they have someone in mind, a preferred person. The receiving
-- head accepts — taking the preference or picking somebody else on their own team — or declines.
-- Accepting is what creates the task, and it is created by the same rules as any other task, in the
-- receiving department, on the board of whoever actually got it.
--
-- WHO SEES WHAT AFTERWARDS. tasks_select scopes by the assignee's ancestry, so the head who ASKED
-- would ordinarily lose sight of the work the moment it was assigned. That is the wrong answer to
-- "how is the thing I asked for going", so this file widens tasks_select by exactly one clause:
-- a task is also readable by whoever may act for the department that requested it. Nothing else
-- about task visibility changes.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. permission
-- ---------------------------------------------------------------------------
insert into public.permissions (key, resource, action, description) values
  ('task.request', 'task', 'request', 'Ask another department for help, and answer such requests')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'super_admin' and p.key = 'task.request'
on conflict do nothing;

-- The people who run a slice of the org. One permission covers both ends on purpose: anyone who
-- can ask can also be asked, which is what makes it a conversation between peers rather than a
-- queue that only flows one way.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'task.request'
where r.key in ('entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. the request
-- ---------------------------------------------------------------------------
create table if not exists public.help_requests (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null,          -- both departments; a request never crosses companies
  from_department_id    uuid not null references public.departments(id) on delete cascade,
  from_branch_id        uuid,
  to_department_id      uuid not null references public.departments(id) on delete cascade,
  to_branch_id          uuid,
  requested_by          uuid references public.employees(id) on delete set null,
  preferred_employee_id uuid references public.employees(id) on delete set null,
  title                 text not null,
  description           text,
  priority              text not null default 'Medium',
  due_date              date,
  status                text not null default 'Pending',   -- Pending/Accepted/Declined/Cancelled
  decided_by            uuid references public.employees(id) on delete set null,
  decided_at            timestamptz,
  decision_note         text,
  assigned_employee_id  uuid references public.employees(id) on delete set null,
  task_id               uuid references public.tasks(id) on delete set null,
  created_at            timestamptz not null default now(),
  constraint help_requests_not_self check (from_department_id <> to_department_id)
);

create index if not exists idx_help_requests_to     on public.help_requests(to_department_id, status);
create index if not exists idx_help_requests_from   on public.help_requests(from_department_id, status);
create index if not exists idx_help_requests_task   on public.help_requests(task_id);

alter table public.help_requests enable row level security;

-- Both ends of the conversation can read it, and nobody else. Written as one predicate rather than
-- two policies so a person who happens to run both departments does not see the row twice.
drop policy if exists help_requests_select on public.help_requests;
create policy help_requests_select on public.help_requests for select to authenticated
  using (
       app.has_perm('task.request', entity_id, null, to_branch_id,   to_department_id,   null)
    or app.has_perm('task.request', entity_id, null, from_branch_id, from_department_id, null)
  );

-- No insert/update/delete policy and no write grant: everything is written by the two definer
-- functions below, which is what keeps "who may accept" from being a client-side opinion.
grant select on public.help_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 3. who is in that department?
--
-- Naming a preferred person means seeing the other department's people, and a requesting head
-- holds employee.read at their OWN department only. Same shape as assignable_employees in 0099:
-- a purpose-built picker rather than a wider employee.read, returning a name and a code and
-- nothing else. Not workload, not designation, not contact details — enough to say who you have
-- in mind, and no more. The head who decides can already see the rest.
-- ---------------------------------------------------------------------------
/** Do you hold task.request anywhere inside this company? One place, so both functions agree. */
create or replace function app.can_request_help_in(_entity uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.is_super_admin()
    or exists (
      select 1
        from public.role_assignments ra
        join public.role_permissions rp on rp.role_id = ra.role_id
        join public.permissions p on p.id = rp.permission_id
        left join public.departments d on ra.scope_type = 'department' and d.id = ra.scope_id
        left join public.branches    b on ra.scope_type = 'branch'     and b.id = ra.scope_id
        left join public.zones       z on ra.scope_type = 'zone'       and z.id = ra.scope_id
       where ra.user_id = auth.uid()
         and p.key = 'task.request'
         and (
              ra.scope_type = 'global'
           or (ra.scope_type = 'entity'     and ra.scope_id  = _entity)
           or (ra.scope_type = 'zone'       and z.entity_id  = _entity)
           or (ra.scope_type = 'branch'     and b.entity_id  = _entity)
           or (ra.scope_type = 'department' and d.entity_id  = _entity)
         )
    )
$$;

revoke all on function app.can_request_help_in(uuid) from public, anon;
grant execute on function app.can_request_help_in(uuid) to authenticated;

create or replace function public.department_people(_department uuid, _q text default null)
returns table (id uuid, full_name text, employee_code text)
language plpgsql stable security definer set search_path = public, app, pg_temp as $$
declare
  _entity uuid; _branch uuid;
begin
  select d.entity_id, d.branch_id into _entity, _branch
  from public.departments d where d.id = _department;

  if _entity is null then
    raise exception 'That department does not exist.' using errcode = '42704';
  end if;

  -- You may look inside a department you could plausibly ask for help: one in a company where you
  -- already hold task.request somewhere. Not at the TARGET department — not already having rights
  -- there is the whole reason for asking.
  if not app.can_request_help_in(_entity) then
    raise exception 'You cannot look inside that department.' using errcode = '42501';
  end if;

  return query
    select e.id, e.full_name, e.employee_code
      from public.employees e
     where e.department_id = _department
       and e.status = 'Active'
       and (_q is null or btrim(_q) = ''
            or e.full_name ilike '%' || btrim(_q) || '%'
            or e.employee_code ilike '%' || btrim(_q) || '%')
     order by e.full_name
     limit 50;
end $$;

revoke all on function public.department_people(uuid, text) from public, anon;
grant execute on function public.department_people(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. asking
-- ---------------------------------------------------------------------------
create or replace function public.request_department_help(
  _from_department uuid,
  _to_department   uuid,
  _title           text,
  _description     text default null,
  _preferred       uuid default null,
  _priority        text default 'Medium',
  _due_date        date default null
) returns uuid
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  _from record; _to record; _me uuid; _id uuid; _pref_dept uuid;
begin
  select entity_id, branch_id into _from from public.departments where id = _from_department;
  select entity_id, branch_id into _to   from public.departments where id = _to_department;

  if _from.entity_id is null or _to.entity_id is null then
    raise exception 'That department does not exist.' using errcode = '42704';
  end if;
  if _from_department = _to_department then
    raise exception 'That is your own department.' using errcode = '22023';
  end if;
  -- Four separately registered companies; borrowing staff across them is not a team decision.
  if _from.entity_id is distinct from _to.entity_id then
    raise exception 'That department belongs to a different company.' using errcode = '42501';
  end if;
  -- You must actually run the department doing the asking.
  if not app.has_perm('task.request', _from.entity_id, null, _from.branch_id, _from_department, null) then
    raise exception 'You cannot raise a request for that department.' using errcode = '42501';
  end if;
  if coalesce(btrim(_title), '') = '' then
    raise exception 'A request needs a title.' using errcode = '22023';
  end if;

  -- A preference has to be someone who actually works there, or the receiving head is being asked
  -- about a person who is not theirs to give.
  if _preferred is not null then
    select department_id into _pref_dept from public.employees
     where id = _preferred and status = 'Active';
    if _pref_dept is distinct from _to_department then
      raise exception 'That person is not in the department you are asking.' using errcode = '22023';
    end if;
  end if;

  select employee_id into _me from public.profiles where user_id = auth.uid();

  insert into public.help_requests (
    entity_id, from_department_id, from_branch_id, to_department_id, to_branch_id,
    requested_by, preferred_employee_id, title, description, priority, due_date
  ) values (
    _from.entity_id, _from_department, _from.branch_id, _to_department, _to.branch_id,
    -- coalesce, not the column default: a default only applies when the column is OMITTED, and a
    -- caller that passes priority: null explicitly (which any client will, for an untouched field)
    -- would hit the not-null constraint instead.
    _me, _preferred, btrim(_title), nullif(btrim(coalesce(_description,'')),''),
    coalesce(nullif(btrim(coalesce(_priority,'')),''), 'Medium'), _due_date
  ) returning id into _id;

  -- Tell whoever can answer it. notify_perm_holders skips the actor, so asking a department you
  -- also happen to run does not notify you about your own request.
  perform app.notify_perm_holders('task.request',
    _to.entity_id, null, _to.branch_id, _to_department,
    'help', 'A department needs a hand',
    coalesce((select name from public.departments where id = _from_department), 'Another department')
      || ' asked for help: "' || btrim(_title) || '"'
      || case when _preferred is not null
              then ' — they suggested ' || coalesce((select full_name from public.employees where id = _preferred), 'someone')
              else '' end || '.',
    'team/requests', _id);

  return _id;
end $$;

revoke all on function public.request_department_help(uuid, uuid, text, text, uuid, text, date) from public, anon;
grant execute on function public.request_department_help(uuid, uuid, text, text, uuid, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. answering
--
-- Accepting is what creates the task, and the task is an ordinary one: filed against the chosen
-- person, ancestry stamped from them by trg_tasks_ancestry, notified by trg_tasks_notify, and
-- showing up on the board and in the counts like anything else.
--
-- `assigned_by` is set to the head who ASKED, not the head who accepted. It is the field the task
-- card renders as "by …" and the notification reads as "assigned by …", and the useful answer to
-- both is the person who wants the work, since they are who the assignee will go and talk to.
-- Who agreed to it is recorded on the request as decided_by.
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_help_request(
  _request  uuid,
  _accept   boolean,
  _assignee uuid default null,
  _note     text default null
) returns uuid
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  _r record; _me uuid; _task uuid; _assignee_dept uuid; _requester_user uuid;
begin
  select * into _r from public.help_requests where id = _request;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = '42704';
  end if;
  if _r.status <> 'Pending' then
    raise exception 'That request has already been %.', lower(_r.status) using errcode = '22023';
  end if;
  -- Only the department being asked may answer.
  if not app.has_perm('task.request', _r.entity_id, null, _r.to_branch_id, _r.to_department_id, null) then
    raise exception 'That request was not addressed to you.' using errcode = '42501';
  end if;

  select employee_id into _me from public.profiles where user_id = auth.uid();

  if not _accept then
    update public.help_requests
       set status = 'Declined', decided_by = _me, decided_at = now(),
           decision_note = nullif(btrim(coalesce(_note,'')),'')
     where id = _request;
  else
    -- Default to what was asked for; the head may override with anyone on their own team.
    _assignee := coalesce(_assignee, _r.preferred_employee_id);
    if _assignee is null then
      raise exception 'Choose who will do the work.' using errcode = '22023';
    end if;

    select department_id into _assignee_dept from public.employees
     where id = _assignee and status = 'Active';
    -- The whole point of the request is that the work lands on YOUR team. Assigning it elsewhere
    -- would put a task on a third department's board with nobody having agreed to it.
    if _assignee_dept is distinct from _r.to_department_id then
      raise exception 'You can only assign this to somebody in your own department.' using errcode = '42501';
    end if;

    insert into public.tasks (employee_id, assigned_by, title, description, priority, due_date, status)
    values (_assignee, _r.requested_by, _r.title, _r.description, _r.priority, _r.due_date, 'To Do')
    returning id into _task;

    update public.help_requests
       set status = 'Accepted', decided_by = _me, decided_at = now(),
           decision_note = nullif(btrim(coalesce(_note,'')),''),
           assigned_employee_id = _assignee, task_id = _task
     where id = _request;
  end if;

  -- Tell the head who asked how it went. They are one person, so notify_user rather than
  -- notify_perm_holders: the rest of their department did not ask for this.
  select e.user_id into _requester_user from public.employees e where e.id = _r.requested_by;
  perform app.notify_user(_requester_user, 'help',
    case when _accept then 'Your request was accepted' else 'Your request was declined' end,
    '"' || _r.title || '" — '
      || case when _accept
              then coalesce((select full_name from public.employees where id = _assignee), 'somebody') || ' is on it.'
              else 'declined by ' || coalesce((select name from public.departments where id = _r.to_department_id), 'the other department') || '.'
         end
      || case when nullif(btrim(coalesce(_note,'')),'') is not null then ' Note: ' || btrim(_note) else '' end,
    'team/requests', _request);

  return _task;
end $$;

revoke all on function public.respond_to_help_request(uuid, boolean, uuid, text) from public, anon;
grant execute on function public.respond_to_help_request(uuid, boolean, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. withdrawing
-- ---------------------------------------------------------------------------
create or replace function public.cancel_help_request(_request uuid)
returns void language plpgsql security definer set search_path = public, app, pg_temp as $$
declare _r record;
begin
  select * into _r from public.help_requests where id = _request;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = '42704';
  end if;
  if _r.status <> 'Pending' then
    raise exception 'Only a request still waiting for an answer can be withdrawn.' using errcode = '22023';
  end if;
  if not app.has_perm('task.request', _r.entity_id, null, _r.from_branch_id, _r.from_department_id, null) then
    raise exception 'That is not your request to withdraw.' using errcode = '42501';
  end if;
  update public.help_requests set status = 'Cancelled' where id = _request;
end $$;

revoke all on function public.cancel_help_request(uuid) from public, anon;
grant execute on function public.cancel_help_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. the head who asked can watch the work
--
-- One clause added to tasks_select (0017). Everything else about task visibility is unchanged:
-- this only says that a task which exists BECAUSE somebody asked for it is also readable by
-- whoever may act for the department that asked.
-- ---------------------------------------------------------------------------
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (
    app.has_perm('task.read', entity_id, zone_id, branch_id, department_id, employee_id)
    or exists (
      select 1 from public.help_requests hr
       where hr.task_id = tasks.id
         and app.has_perm('task.request', hr.entity_id, null, hr.from_branch_id, hr.from_department_id, null)
    )
  );

commit;
