-- Recoverable task deletion. Task rows remain readable in their original scope so realtime
-- delivers the removal to every participant; operational queries filter deleted_at. The
-- separate trash RPC exposes only tasks the caller can delete/restore. No task data is removed.
begin;

alter table public.tasks add column if not exists deleted_at timestamptz;
alter table public.tasks add column if not exists deleted_by uuid;
alter table public.tasks add column if not exists restored_at timestamptz;
alter table public.tasks add column if not exists delete_batch_id uuid;
create index if not exists tasks_deleted_idx on public.tasks(deleted_at desc,id) where deleted_at is not null;
create index if not exists tasks_delete_batch_idx on public.tasks(delete_batch_id) where delete_batch_id is not null;

create or replace function app.can_manage_task_trash(_task public.tasks)
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select app.session_is_active() and (
    app.has_perm('task.manage',_task.entity_id,_task.zone_id,_task.branch_id,_task.department_id,_task.employee_id)
    or (app.is_own_task(_task.employee_id,_task.parent_task_id)
      and _task.assigned_by is not null and _task.assigned_by=app.current_employee_id()))
$$;

-- The original scope remains intact. Every helper used by task content requires a live task.
create or replace function app.can_read_task(_task uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select app.session_is_active() and exists(select 1 from public.tasks t where t.id=_task
    and t.deleted_at is null and (
      app.has_perm('task.read',t.entity_id,t.zone_id,t.branch_id,t.department_id,t.employee_id)
      or app.is_task_assignee(t.id)
      or exists(select 1 from public.help_requests hr where hr.task_id=t.id
        and app.has_perm('task.request',hr.entity_id,null::uuid,hr.from_branch_id,hr.from_department_id,null::uuid))))
$$;
create or replace function app.can_write_task(_task uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select app.session_is_active() and exists(select 1 from public.tasks t where t.id=_task
    and t.deleted_at is null and (
      app.has_perm('task.update',t.entity_id,t.zone_id,t.branch_id,t.department_id,t.employee_id)
      or app.has_perm('task.manage',t.entity_id,t.zone_id,t.branch_id,t.department_id,t.employee_id)
      or app.is_task_assignee(t.id)))
$$;

-- Reject direct metadata forgery and protect legacy clients from permanent deletion.
create or replace function app.tg_task_trash_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public,app as $$
declare _parent public.tasks;
begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    return coalesce(new,old);
  end if;
  if tg_op='DELETE' then
    raise exception 'Use Move to deleted tasks so this task can be restored.' using errcode='42501';
  end if;
  if (tg_op='INSERT' and (new.deleted_at is not null or new.deleted_by is not null or new.delete_batch_id is not null or new.restored_at is not null))
     or (tg_op='UPDATE' and (old.deleted_at is not null or row(new.deleted_at,new.deleted_by,new.delete_batch_id,new.restored_at)
        is distinct from row(old.deleted_at,old.deleted_by,old.delete_batch_id,old.restored_at))) then
    raise exception 'Use the task delete and restore actions.' using errcode='42501';
  end if;
  if new.parent_task_id is not null and (tg_op='INSERT' or new.parent_task_id is distinct from old.parent_task_id) then
    -- A concurrent delete waits for additions already in flight; additions that wait for a
    -- delete re-read the locked parent and cannot attach work below a deleted task.
    select * into _parent from public.tasks where id=new.parent_task_id for share;
    if _parent.id is null or _parent.deleted_at is not null then
      raise exception 'Restore the parent task before adding or moving work under it.' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tasks_trash_guard on public.tasks;
create trigger trg_tasks_trash_guard before insert or update or delete on public.tasks
  for each row execute function app.tg_task_trash_guard();
drop policy if exists tasks_delete on public.tasks;
revoke delete on public.tasks from authenticated;

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (deleted_at is null and app.can_write_task(id))
  with check (deleted_at is null and app.can_write_task(id));

-- Lock every affected row before deciding scope/state. A second read discovers descendants
-- committed while locks were being acquired; once all parents are locked no new child can join.
create or replace function public.soft_delete_task(_task_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _task public.tasks; _ids uuid[]; _next uuid[]; _row public.tasks;
begin
  if not app.session_is_active() then raise exception 'Sign in with an active account.' using errcode='42501'; end if;
  select * into _task from public.tasks where id=_task_id for update;
  if _task.id is null or not app.can_manage_task_trash(_task) then
    raise exception 'You cannot delete this task.' using errcode='42501';
  end if;
  if _task.deleted_at is not null then raise exception 'This task is already deleted.' using errcode='22023'; end if;
  _ids:=array[]::uuid[];
  loop
    with recursive family as (
      select id from public.tasks where id=_task_id
      union select t.id from public.tasks t join family f on t.parent_task_id=f.id
    ) select array_agg(id order by id) into _next from family;
    exit when _ids=_next;
    _ids:=_next;
    perform 1 from public.tasks where id=any(_ids) order by id for update;
  end loop;
  for _row in select * from public.tasks where id=any(_ids) and deleted_at is null loop
    if not app.can_manage_task_trash(_row) then
      raise exception 'A child task is outside your management scope.' using errcode='42501';
    end if;
  end loop;
  update public.tasks set deleted_at=now(),deleted_by=auth.uid(),delete_batch_id=_task_id
    where id=any(_ids) and deleted_at is null;
  return _task_id;
end $$;

create or replace function public.restore_task(_task_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _task public.tasks; _row public.tasks; _batch uuid;
begin
  if not app.session_is_active() then raise exception 'Sign in with an active account.' using errcode='42501'; end if;
  select * into _task from public.tasks where id=_task_id for update;
  if _task.id is null or not app.can_manage_task_trash(_task) then
    raise exception 'You cannot restore this task.' using errcode='42501';
  end if;
  if _task.deleted_at is null then raise exception 'This task is not deleted.' using errcode='22023'; end if;
  _batch:=_task.delete_batch_id;
  if _batch is distinct from _task_id then
    raise exception 'Restore the parent task from Deleted tasks.' using errcode='22023';
  end if;
  perform 1 from public.tasks where delete_batch_id=_batch order by id for update;
  for _row in select * from public.tasks where delete_batch_id=_batch loop
    if not app.can_manage_task_trash(_row) then
      raise exception 'A child task is outside your management scope.' using errcode='42501';
    end if;
    if exists(select 1 from public.tasks p where p.id=_row.parent_task_id and p.deleted_at is not null
      and p.delete_batch_id is distinct from _batch) then
      raise exception 'Restore the deleted parent task first.' using errcode='22023';
    end if;
  end loop;
  update public.tasks set deleted_at=null,deleted_by=null,delete_batch_id=null,restored_at=now() where delete_batch_id=_batch;
  return _task_id;
end $$;

create or replace function public.list_deleted_tasks()
returns table(id uuid,title text,description text,priority text,status text,due_date date,completed_at timestamptz,
  created_at timestamptz,parent_task_id uuid,employee_id uuid,assigned_by uuid,entity_id uuid,zone_id uuid,
  branch_id uuid,department_id uuid,deleted_at timestamptz,deleted_by uuid,assignee jsonb,assigner jsonb,
  can_restore boolean,deleted_task_count bigint)
language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
begin
  if not app.session_is_active() then raise exception 'Sign in with an active account.' using errcode='42501'; end if;
  return query select t.id,t.title,t.description,t.priority,t.status,t.due_date,t.completed_at,t.created_at,
    t.parent_task_id,t.employee_id,t.assigned_by,t.entity_id,t.zone_id,t.branch_id,t.department_id,t.deleted_at,t.deleted_by,
    case when a.id is null then null else jsonb_build_object('id',a.id,'full_name',a.full_name,'employee_code',a.employee_code) end,
    case when b.id is null then null else jsonb_build_object('id',b.id,'full_name',b.full_name,'employee_code',b.employee_code) end,
    not exists(select 1 from public.tasks x where x.delete_batch_id=t.id and (
      not app.can_manage_task_trash(x) or exists(select 1 from public.tasks p where p.id=x.parent_task_id
        and p.deleted_at is not null and p.delete_batch_id is distinct from t.id))),
    (select count(*) from public.tasks x where x.delete_batch_id=t.id)
    from public.tasks t left join public.employees a on a.id=t.employee_id
      and app.has_perm('employee.read',a.entity_id,a.zone_id,a.branch_id,a.department_id,a.id)
    left join public.employees b on b.id=t.assigned_by
      and app.has_perm('employee.read',b.entity_id,b.zone_id,b.branch_id,b.department_id,b.id)
    where t.deleted_at is not null and t.delete_batch_id=t.id and app.can_manage_task_trash(t);
end $$;

-- All task content survives in place and becomes accessible again on restore. Prevent stale
-- clients from changing content while a delete is committing, including deletes of own comments.
create or replace function app.tg_task_content_live()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _task public.tasks; _task_id uuid;
begin
  -- A definer trigger changes current_user; inspect the original SET ROLE for trusted service
  -- cleanup while retaining protection for authenticated callers of definer workflows.
  if exists(select 1 from pg_catalog.pg_roles
    where rolname=coalesce(nullif(current_setting('role',true),'none'),session_user) and (rolsuper or rolbypassrls)) then
    return coalesce(new,old);
  end if;
  _task_id:=case when tg_op='DELETE' then old.task_id else new.task_id end;
  select * into _task from public.tasks where id=_task_id for no key update;
  -- FK cascades from a trusted physical employee/task cleanup see no remaining parent.
  if _task.id is not null and _task.deleted_at is not null then
    raise exception 'Restore this task before changing its contents.' using errcode='42501';
  end if;
  if tg_op='UPDATE' and old.task_id is distinct from new.task_id then
    select * into _task from public.tasks where id=old.task_id for no key update;
    if _task.deleted_at is not null then
      raise exception 'Restore this task before changing its contents.' using errcode='42501';
    end if;
  end if;
  return coalesce(new,old);
end $$;
do $$ declare _table text; begin
  foreach _table in array array['task_comments','task_checklist_items','task_assignees','task_attachments'] loop
    execute format('drop trigger if exists trg_task_content_live on public.%I',_table);
    execute format('create trigger trg_task_content_live before insert or update or delete on public.%I for each row execute function app.tg_task_content_live()',_table);
  end loop;
end $$;

drop policy if exists task_comments_select on public.task_comments;
create policy task_comments_select on public.task_comments for select to authenticated using(app.can_read_task(task_id));
drop policy if exists task_comments_insert on public.task_comments;
create policy task_comments_insert on public.task_comments for insert to authenticated
  with check(author_user=auth.uid() and app.can_read_task(task_id));
drop policy if exists task_comments_update on public.task_comments;
create policy task_comments_update on public.task_comments for update to authenticated
  using(author_user=auth.uid() and app.can_read_task(task_id))
  with check(author_user=auth.uid() and app.can_read_task(task_id));
drop policy if exists task_comments_delete on public.task_comments;
create policy task_comments_delete on public.task_comments for delete to authenticated
  using(author_user=auth.uid() and app.can_read_task(task_id));
drop policy if exists task_attachments_select on public.task_attachments;
create policy task_attachments_select on public.task_attachments for select to authenticated using(app.can_read_task(task_id));
drop policy if exists task_attachments_insert on public.task_attachments;
create policy task_attachments_insert on public.task_attachments for insert to authenticated
  with check(added_user=auth.uid() and app.can_read_task(task_id));
drop policy if exists task_attachments_delete on public.task_attachments;
create policy task_attachments_delete on public.task_attachments for delete to authenticated
  using(app.can_read_task(task_id) and (added_user=auth.uid() or exists(select 1 from public.tasks t
    where t.id=task_id and app.has_perm('task.manage',t.entity_id,t.zone_id,t.branch_id,t.department_id,t.employee_id))));
drop policy if exists task_files_object_insert on storage.objects;
create policy task_files_object_insert on storage.objects for insert to authenticated
  with check(bucket_id='task-files' and app.can_read_task(nullif(split_part(name,'/',1),'')::uuid));

-- Hide old notification links while the work is in trash; restore brings back the same history.
create or replace function app.task_notification_live(_table text,_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select _table is distinct from 'tasks' or not exists(select 1 from public.tasks t where t.id=_id and t.deleted_at is not null)
$$;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using(user_id=auth.uid() and app.task_notification_live(tab,ref_id));

create or replace function public.get_section_counts(_self_only boolean default false)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, app as $$
declare
  _user uuid := auth.uid();
  _employee uuid := app.current_employee_id();
  _tasks bigint := 0;
  _leaves bigint := 0;
  _expenses bigint := 0;
  _attendance bigint := 0;
  _tickets bigint := 0;
begin
  if not app.ticket_actor_active(_user) then
    raise exception 'Sign in with an active account.' using errcode = '42501';
  end if;
  if _self_only is null then
    raise exception 'Choose a valid employee view.' using errcode = '22023';
  end if;

  if _employee is not null then
    -- UNION deduplicates a primary assignee also present in the junction table. Both candidate
    -- lookups use existing employee indexes, rather than loading the company's whole task list.
    select count(*) into _tasks from public.tasks t join (
      select id from public.tasks where employee_id = _employee and status not in ('Done','Cancelled')
      union
      select task_id from public.task_assignees where employee_id = _employee
    ) assigned on assigned.id = t.id
    where t.deleted_at is null and t.status not in ('Done','Cancelled') and app.can_read_task(t.id);
  end if;

  if not _self_only then
    -- Broad guards save a scan for ordinary employees; every counted row still has its exact
    -- permission check. A read grant alone must never become an approval/action badge.
    if app.has_perm_any_scope('leave.approve') and app.has_perm_any_scope('leave.read') then
      select count(*) into _leaves from public.leaves l
        where l.status in ('Pending','On Hold') and public.leave_can_decide(l);
    end if;
    if app.has_perm_any_scope('expense.approve') and app.has_perm_any_scope('expense.read') then
      select count(*) into _expenses from public.expenses e
        where e.status = 'Pending' and e.employee_id is distinct from _employee
          and e.created_by is distinct from _user
          and app.has_perm('expense.read',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.employee_id)
          and app.has_perm('expense.approve',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.employee_id);
    end if;
    if app.has_perm_any_scope('regularization.approve') and app.has_perm_any_scope('attendance.read') then
      select count(*) into _attendance from public.attendance_regularizations r
        where r.status = 'Pending' and r.employee_id is distinct from _employee
          and app.has_perm('attendance.read',r.entity_id,r.zone_id,r.branch_id,r.department_id,r.employee_id)
          and app.has_perm('regularization.approve',r.entity_id,r.zone_id,r.branch_id,r.department_id,r.employee_id);
    end if;
    if app.has_perm_any_scope('ticket.manage') or (
      app.has_perm_any_scope('ticket.read') and exists (
        select 1 from public.role_assignments ra join public.roles role on role.id = ra.role_id
        where ra.user_id = _user and role.key = 'dept_head'
      )
    ) then
      select count(*) into _tickets from public.tickets t
        where t.status in ('Open','In Progress','On Hold') and app.ticket_manage_for(_user,t);
    end if;
  end if;

  return jsonb_build_object('tasks',_tasks,'leave',_leaves,'expense',_expenses,
    'attendance',_attendance,'helpdesk',_tickets);
end;
$$;

create or replace function public.get_navigation_counts(_self_only boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare
  _base jsonb;
  _user uuid:=auth.uid();
  _employee uuid:=app.current_employee_id();
  _today date:=(now() at time zone 'Asia/Kolkata')::date;
  _requests bigint:=0;
  _routine bigint:=0;
  _mine bigint:=0;
  _team bigint:=0;
  _payroll bigint:=0;
  _onboarding bigint:=0;
  _recruitment bigint:=0;
  _exits bigint:=0;
  _notifications bigint:=0;
  _mapping bigint:=0;
begin
  -- Validates the active account and non-null view before any new data can be counted.
  _base:=public.get_section_counts(_self_only);

  select count(*) into _notifications from public.notifications n
    where n.user_id=_user and n.read_at is null and app.task_notification_live(n.tab,n.ref_id);

  if _employee is not null then
    select count(*) into _routine from public.routine_sets s
      join public.routine_items i on i.routine_id=s.id and i.is_active
      where s.employee_id=_employee and app.routine_can_tick(s,_today)
        and not exists(select 1 from public.routine_ticks t
          where t.routine_item_id=i.id and t.employee_id=s.employee_id and t.on_date=_today);
    select count(*) into _mine from public.goals g
      where g.employee_id=_employee and g.status='Active'
        and app.has_perm('goal.read',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id)
        and (app.has_perm('goal.update',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id)
          or app.has_perm('performance.manage',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id));
  end if;

  if not _self_only then
    if app.has_perm_any_scope('task.request') and app.has_perm_any_scope('employee.assign') then
      -- my_departments() supplies the same active department list used by Team Requests. Being
      -- the sender alone never makes a request actionable; the receiving permission is required.
      select count(*) into _requests from public.help_requests r
        join public.my_departments() d on d.id=r.to_department_id
        where r.status='Pending'
          and app.has_perm('task.request',r.entity_id,null,r.to_branch_id,r.to_department_id,null);
    end if;
    if app.has_perm_any_scope('performance.manage') and app.has_perm_any_scope('goal.read') then
      select count(*) into _team from public.goals g
        where g.employee_id is distinct from _employee and g.status='Active'
          and app.has_perm('goal.read',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id)
          and app.has_perm('performance.manage',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id);
    end if;
    if app.has_perm_any_scope('payroll.manage') then
      select count(*) into _payroll from public.payroll_runs r
        where r.status='Draft' and r.entity_id is not null
          and app.has_perm('payroll.manage',r.entity_id,null,null,null,null);
    end if;
    if app.has_perm_any_scope('onboarding.manage') then
      select count(*) into _onboarding from public.onboarding o
        where coalesce(o.progress,0)<100
          and app.has_perm('onboarding.manage',o.entity_id,o.zone_id,o.branch_id,o.department_id,null);
    end if;
    if app.has_perm_any_scope('recruitment.manage') then
      select count(*) into _recruitment from public.candidates c
        where c.stage in ('Applied','Shortlisted','Interview','Offered')
          and app.has_perm('recruitment.manage',c.entity_id,c.zone_id,c.branch_id,c.department_id,null);
    end if;
    if app.has_perm_any_scope('exit.manage') then
      select count(*) into _exits from public.exits e
        where e.status in ('Clearance in Progress','Cleared')
          and e.employee_id is distinct from _employee and e.created_by is distinct from _user
          and app.has_perm('exit.manage',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.employee_id);
    end if;
    -- The pre-organization roster is deliberately shared with entity/global device managers.
    -- Match its SELECT policy and the link_device_code entry gate, not a wider any-scope grant.
    if app.has_perm_org_wide('device.manage') then
      select count(*) into _mapping from public.biotime_employees b
        where b.link_status in ('unmatched','ambiguous')
          and (b.employee_id is null or exists(select 1 from public.employees e
            where e.id=b.employee_id and app.has_perm('device.manage',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.id)));
    end if;
  end if;

  return _base||jsonb_build_object('task_requests',_requests,'task_routine',_routine,
    'performance_mine',_mine,'performance_team',_team,'payroll',_payroll,'onboarding',_onboarding,
    'recruitment',_recruitment,'exits',_exits,'notifications',_notifications,'attendance_mapping',_mapping);
end;
$$;

create or replace function public.update_requested_task(
  _task        uuid,
  _title       text default null,
  _description text default null,
  _priority    text default null,
  _due_date    date default null,
  _clear_due   boolean default false
) returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare _r record; _active_task public.tasks;
begin
  if not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select hr.* into _r from public.help_requests hr where hr.task_id = _task;
  if _r.id is null then
    raise exception 'That task did not come from a request.' using errcode = '42704';
  end if;
  if not app.has_perm('task.request', _r.entity_id, null, _r.from_branch_id, _r.from_department_id, null) then
    raise exception 'You did not ask for that work.' using errcode = '42501';
  end if;
  select * into _active_task from public.tasks where id=_task for update;
  if _active_task.id is null or _active_task.deleted_at is not null then
    raise exception 'Restore this task before editing it.' using errcode='42501';
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

revoke all on function app.can_manage_task_trash(public.tasks),app.tg_task_trash_guard(),app.tg_task_content_live(),
  app.task_notification_live(text,uuid) from public,anon;
grant execute on function app.task_notification_live(text,uuid) to authenticated;
revoke all on function public.soft_delete_task(uuid),public.restore_task(uuid),public.list_deleted_tasks() from public,anon;
grant execute on function public.soft_delete_task(uuid),public.restore_task(uuid),public.list_deleted_tasks() to authenticated;
notify pgrst,'reload schema';
commit;
