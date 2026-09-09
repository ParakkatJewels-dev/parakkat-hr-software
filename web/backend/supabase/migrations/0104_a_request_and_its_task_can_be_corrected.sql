-- 0104_a_request_and_its_task_can_be_corrected.sql
--
-- Two things you could raise but never fix.
--
-- 1. A HELP REQUEST was write-once. Get the title wrong, or learn the deadline moved, and the only
--    way out was to withdraw it and raise another — which loses the thread the other head is
--    already looking at, and sends them a second notification about the same work.
--
-- 2. THE TASK IT PRODUCED was write-once to the head who asked for it. They can SEE it (0101 widened
--    tasks_select) and they are the person who wanted it, but tasks_update scopes by the assignee's
--    ancestry, so the pencil belonged to the other department alone.
--
-- Both are narrow functions rather than widened policies, for the same reason as 0099: a policy
-- wide enough to let the requesting head edit the title is also wide enough to let them reassign
-- the task out of the department that agreed to do it. These write named columns and no others.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. correcting a request that has not been answered yet
--
-- Only while Pending: once a head has accepted, the wording is what they agreed to, and editing it
-- underneath them would change the job after the handshake.
-- ---------------------------------------------------------------------------
create or replace function public.update_help_request(
  _request     uuid,
  _title       text default null,
  _description text default null,
  _priority    text default null,
  _due_date    date default null,
  _preferred   uuid default null,
  _clear_preferred boolean default false,
  _clear_due       boolean default false
) returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare _r record; _pref_dept uuid;
begin
  select * into _r from public.help_requests where id = _request;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = '42704';
  end if;
  if _r.status <> 'Pending' then
    raise exception 'That request has already been %; it cannot be changed now.', lower(_r.status) using errcode = '22023';
  end if;
  if not app.has_perm('task.request', _r.entity_id, null, _r.from_branch_id, _r.from_department_id, null) then
    raise exception 'That is not your request to change.' using errcode = '42501';
  end if;

  if _title is not null and coalesce(btrim(_title),'') = '' then
    raise exception 'A request needs a title.' using errcode = '22023';
  end if;
  if _priority is not null and _priority not in ('Low','Medium','High','Urgent') then
    raise exception 'That is not a priority.' using errcode = '22023';
  end if;
  if _preferred is not null then
    select department_id into _pref_dept from public.employees where id = _preferred and status = 'Active';
    if _pref_dept is distinct from _r.to_department_id then
      raise exception 'That person is not in the department you are asking.' using errcode = '22023';
    end if;
  end if;

  -- Null means "leave it alone"; the explicit clear flags exist because null cannot mean both
  -- "unchanged" and "remove it".
  update public.help_requests
     set title       = coalesce(btrim(_title), title),
         description = case when _description is null then description
                            else nullif(btrim(_description), '') end,
         priority    = coalesce(_priority, priority),
         due_date    = case when _clear_due then null else coalesce(_due_date, due_date) end,
         preferred_employee_id = case when _clear_preferred then null
                                      else coalesce(_preferred, preferred_employee_id) end
   where id = _request;
end $$;

revoke all on function public.update_help_request(uuid, text, text, text, date, uuid, boolean, boolean) from public, anon;
grant execute on function public.update_help_request(uuid, text, text, text, date, uuid, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. correcting the task that came out of an accepted request
--
-- The head who asked may change WHAT the work is. They may not change WHO is doing it or where it
-- stands: the receiving head chose the person and the person owns the progress. Those columns are
-- simply not in the update.
-- ---------------------------------------------------------------------------
create or replace function public.update_requested_task(
  _task        uuid,
  _title       text default null,
  _description text default null,
  _priority    text default null,
  _due_date    date default null,
  _clear_due   boolean default false
) returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare _r record;
begin
  select hr.* into _r from public.help_requests hr where hr.task_id = _task;
  if _r.id is null then
    raise exception 'That task did not come from a request.' using errcode = '42704';
  end if;
  if not app.has_perm('task.request', _r.entity_id, null, _r.from_branch_id, _r.from_department_id, null) then
    raise exception 'You did not ask for that work.' using errcode = '42501';
  end if;
  if _title is not null and coalesce(btrim(_title),'') = '' then
    raise exception 'A task needs a title.' using errcode = '22023';
  end if;
  if _priority is not null and _priority not in ('Low','Medium','High','Urgent') then
    raise exception 'That is not a priority.' using errcode = '22023';
  end if;

  update public.tasks
     set title       = coalesce(btrim(_title), title),
         description = case when _description is null then description
                            else nullif(btrim(_description), '') end,
         priority    = coalesce(_priority, priority),
         due_date    = case when _clear_due then null else coalesce(_due_date, due_date) end
   where id = _task;

  -- Keep the request reading the same as the work, so the two heads are looking at one thing.
  update public.help_requests
     set title = coalesce(btrim(_title), title),
         description = case when _description is null then description else nullif(btrim(_description), '') end,
         priority = coalesce(_priority, priority),
         due_date = case when _clear_due then null else coalesce(_due_date, due_date) end
   where id = _r.id;

  -- The person holding it should hear that what they were asked for has changed.
  perform app.notify_user(
    (select e.user_id from public.employees e where e.id = _r.assigned_employee_id),
    'task', 'A task you were given has changed',
    '"' || coalesce(btrim(_title), _r.title) || '" was updated by the department that asked for it.',
    'tasks', _task);
end $$;

revoke all on function public.update_requested_task(uuid, text, text, text, date, boolean) from public, anon;
grant execute on function public.update_requested_task(uuid, text, text, text, date, boolean) to authenticated;

commit;
