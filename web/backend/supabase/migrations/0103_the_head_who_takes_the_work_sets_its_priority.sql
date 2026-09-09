-- 0103_the_head_who_takes_the_work_sets_its_priority.sql
--
-- In 0101 the priority travelled with the request: whatever the ASKING head typed became the
-- priority of the task. That is the wrong person to ask. "Urgent" means something different in the
-- department that has to do the work — they know what else is on their board this week, and the
-- requester does not. The requester's figure is still worth having, as a statement of how badly
-- they need it, so it stays on the request; it is now a suggestion rather than a decision.
--
-- Supersedes the function from 0101. A new argument changes the signature, so the old overload is
-- dropped first: left in place, a four-argument call would keep resolving to it and silently go on
-- using the requester's priority.
--
-- Idempotent: safe to re-run.

begin;

drop function if exists public.respond_to_help_request(uuid, boolean, uuid, text);

create or replace function public.respond_to_help_request(
  _request  uuid,
  _accept   boolean,
  _assignee uuid default null,
  _note     text default null,
  _priority text default null
) returns uuid
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  _r record; _me uuid; _task uuid; _assignee_dept uuid; _requester_user uuid; _final_priority text;
begin
  select * into _r from public.help_requests where id = _request;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = '42704';
  end if;
  if _r.status <> 'Pending' then
    raise exception 'That request has already been %.', lower(_r.status) using errcode = '22023';
  end if;
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
    _assignee := coalesce(_assignee, _r.preferred_employee_id);
    if _assignee is null then
      raise exception 'Choose who will do the work.' using errcode = '22023';
    end if;

    select department_id into _assignee_dept from public.employees
     where id = _assignee and status = 'Active';
    if _assignee_dept is distinct from _r.to_department_id then
      raise exception 'You can only assign this to somebody in your own department.' using errcode = '42501';
    end if;

    -- Theirs if they set one, otherwise what was asked for. Validated against the same list the
    -- task board uses, so a client cannot invent a priority the UI has no colour for.
    _final_priority := coalesce(nullif(btrim(coalesce(_priority,'')),''), _r.priority, 'Medium');
    if _final_priority not in ('Low','Medium','High','Urgent') then
      raise exception 'That is not a priority.' using errcode = '22023';
    end if;

    insert into public.tasks (employee_id, assigned_by, title, description, priority, due_date, status)
    values (_assignee, _r.requested_by, _r.title, _r.description, _final_priority, _r.due_date, 'To Do')
    returning id into _task;

    -- Keep the request showing what was actually agreed, so the requester sees the priority the
    -- work is really carrying rather than the one they asked for.
    update public.help_requests
       set status = 'Accepted', decided_by = _me, decided_at = now(),
           decision_note = nullif(btrim(coalesce(_note,'')),''),
           assigned_employee_id = _assignee, task_id = _task, priority = _final_priority
     where id = _request;
  end if;

  select e.user_id into _requester_user from public.employees e where e.id = _r.requested_by;
  perform app.notify_user(_requester_user, 'help',
    case when _accept then 'Your request was accepted' else 'Your request was declined' end,
    '"' || _r.title || '" — '
      || case when _accept
              then coalesce((select full_name from public.employees where id = _assignee), 'somebody') || ' is on it'
                   || case when _final_priority is distinct from _r.priority
                           then ' (' || lower(_final_priority) || ' priority)' else '' end || '.'
              else 'declined by ' || coalesce((select name from public.departments where id = _r.to_department_id), 'the other department') || '.'
         end
      || case when nullif(btrim(coalesce(_note,'')),'') is not null then ' Note: ' || btrim(_note) else '' end,
    'tasks/requests', _request);

  return _task;
end $$;

revoke all on function public.respond_to_help_request(uuid, boolean, uuid, text, text) from public, anon;
grant execute on function public.respond_to_help_request(uuid, boolean, uuid, text, text) to authenticated;

commit;
