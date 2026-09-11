-- task.update and shared-task membership allow editing the work and its progress. They must not
-- let an assignee impersonate the delegator, turn assigned work into a deletable personal task,
-- move it into another manager's scope, or attach it under somebody else's parent task.
create or replace function app.tg_task_assignment_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public,app as $$
declare _parent public.tasks%rowtype;
begin
  -- Trusted owner/service writes include checked SECURITY DEFINER workflows and FK cleanup.
  -- Test the actual invoking database role, never the absence of a JWT (anonymous has none too).
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    return new;
  end if;
  if tg_op='INSERT' and new.assigned_by is distinct from app.current_employee_id()
     and not app.has_perm('task.manage',new.entity_id,new.zone_id,new.branch_id,new.department_id,new.employee_id)
  then
    raise exception 'A personal task must identify you as its author.' using errcode='42501';
  end if;
  if tg_op='UPDATE' and row(new.assigned_by,new.employee_id,new.parent_task_id,new.entity_id,new.zone_id,new.branch_id,new.department_id)
      is distinct from row(old.assigned_by,old.employee_id,old.parent_task_id,old.entity_id,old.zone_id,old.branch_id,old.department_id)
     and not (
       app.has_perm('task.manage',old.entity_id,old.zone_id,old.branch_id,old.department_id,old.employee_id)
       and app.has_perm('task.manage',new.entity_id,new.zone_id,new.branch_id,new.department_id,new.employee_id)
     ) then
    raise exception 'Only a manager with access to both assignments can change task ownership.' using errcode='42501';
  end if;
  if new.parent_task_id is not null
     and (tg_op='INSERT' or new.parent_task_id is distinct from old.parent_task_id) then
    select * into _parent from public.tasks where id=new.parent_task_id;
    if _parent.id is null or not (
      app.has_perm('task.create',_parent.entity_id,_parent.zone_id,_parent.branch_id,_parent.department_id,_parent.employee_id)
      or app.has_perm('task.manage',_parent.entity_id,_parent.zone_id,_parent.branch_id,_parent.department_id,_parent.employee_id)
    ) then
      raise exception 'You cannot add work under a task outside your management scope.' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
-- The caller never supplies authoritative ancestry. This trigger sorts before the assignment
-- guard and restores canonical scope even for attempts to patch only denormalized columns.
drop trigger if exists trg_tasks_ancestry on public.tasks;
create trigger trg_tasks_ancestry
  before insert or update of employee_id,entity_id,zone_id,branch_id,department_id on public.tasks
  for each row execute function app.tg_stamp_ancestry();
drop trigger if exists trg_tasks_assignment_guard on public.tasks;
create trigger trg_tasks_assignment_guard before insert or update on public.tasks
  for each row execute function app.tg_task_assignment_guard();
revoke all on function app.tg_task_assignment_guard() from public,anon;
