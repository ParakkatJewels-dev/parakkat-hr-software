-- Compact navigation badges. Counts use current stored rows and the same scope/reviewer rules
-- as the destination screens; the client never submits a user, employee or organization scope.
begin;

create index if not exists expenses_pending_count_idx on public.expenses(id) where status = 'Pending';
create index if not exists leaves_review_count_idx on public.leaves(id) where status in ('Pending','On Hold');
create index if not exists tickets_unresolved_count_idx on public.tickets(id) where status in ('Open','In Progress','On Hold');

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
    where t.status not in ('Done','Cancelled') and app.can_read_task(t.id);
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

revoke all on function public.get_section_counts(boolean) from public, anon;
grant execute on function public.get_section_counts(boolean) to authenticated;
comment on function public.get_section_counts(boolean) is
  'Current caller navigation counts: own unfinished tasks, actionable leave/expense/correction reviews, and manageable unresolved tickets. Employee view suppresses management queues. No client-supplied scope or row payloads.';

-- A secondary assignment can be removed without updating its parent task or emitting a new
-- notification. Publish the junction so both task lists and their badges can invalidate.
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_assignees') then
    alter publication supabase_realtime add table public.task_assignees;
  end if;
end $$;
alter table public.task_assignees replica identity full;

notify pgrst, 'reload schema';
commit;
