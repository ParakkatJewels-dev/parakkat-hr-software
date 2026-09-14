-- 0130 — A subtask has an owner.
--
-- 0114 gave a checklist line `completed_by`: the name of whoever ticked it, recorded AFTER the
-- work. What a line never had was a name BEFORE the work — "here are the six steps, and Anand does
-- the third". People were writing it into the title instead ("Anand: call the vendor"), which no
-- screen can filter, count or notify on, and which says nothing once the name changes.
--
-- `assigned_to` is that name. Nullable, and most lines will stay that way: a step anybody on the
-- task can pick up is a perfectly good step, and a list where every line must be spoken for would
-- be a worse list, not a stricter one.
--
-- WHAT CHANGES ABOUT THE TICK
--
-- 0114's rule was "anyone on the task may tick any line". An OWNED line is now that person's
-- alone — a manager on the task cannot tick it for them. Unowned lines keep 0114's rule exactly,
-- so nothing that exists today behaves differently.
--
-- That needs an escape hatch, because a subtask owned by somebody on leave would otherwise hold
-- the whole task open indefinitely (the rollup in 0114 closes a task only when every line is
-- ticked). The hatch is that `assigned_to` is not itself protected: anybody who may write the task
-- may reassign the line or clear its owner, and it becomes tickable again. The asymmetry is the
-- point — reassigning leaves a visible owner on the row, ticking on somebody's behalf leaves a
-- lie in `completed_by`. One is allowed and the other is not.
--
-- WHY A TRIGGER AND NOT A POLICY
--
-- The rule is about which COLUMNS moved: ticking is narrow, editing the line is not. An RLS policy
-- sees OLD in `using` and NEW in `with check` but never both at once, so it cannot tell a tick from
-- a rename. 0125 hit the same wall on tasks and answered it the same way — a permissive policy with
-- a BEFORE trigger holding the real rule.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------

alter table public.task_checklist_items
  add column if not exists assigned_to uuid references public.employees(id) on delete set null;

comment on column public.task_checklist_items.assigned_to is
  'Who this step is FOR. Null means anyone on the task may do it. Distinct from completed_by, '
  'which records who actually ticked it.';

-- "Which steps are mine" is a lookup by person, exactly like task_assignees_employee_idx. Partial,
-- because most rows are null and none of them are ever the answer to that question.
create index if not exists task_checklist_assigned_idx
  on public.task_checklist_items (assigned_to) where assigned_to is not null;

-- ---------------------------------------------------------------------------------------------
-- 2. The owner is always on the task
--
-- An owner who is not on the task would be handed a line they cannot see (tasks_select) and could
-- not tick (below) — a name on a row that does nothing. So naming somebody puts them on the task.
--
-- This grants nothing that was not already available: task_assignees_insert checks
-- app.can_write_task on the TASK and never asks who is being added, so anyone who can assign a
-- subtask could already have added that person by hand. This makes it one act instead of two, and
-- makes the invariant true regardless of which client did the writing.
-- ---------------------------------------------------------------------------------------------

create or replace function app.tg_checklist_owner_joins_task()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare _user uuid; _title text; _joined boolean;
begin
  if new.assigned_to is null then return new; end if;
  -- `update of assigned_to` fires whenever the column is in the SET list, changed or not.
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then return new; end if;

  insert into public.task_assignees (task_id, employee_id, added_by)
  values (new.task_id, new.assigned_to, app.current_employee_id())
  on conflict (task_id, employee_id) do nothing;
  _joined := found;

  -- Exactly one notification per act. Somebody newly put on the task already hears "you were added
  -- to a task" from trg_task_assignee_notify, and that message names the task they should open;
  -- posting a second one for the same click is noise. Somebody already on the task hears nothing
  -- from that trigger, so the specific message is theirs.
  --
  -- notify_user drops it when the target is the actor, so giving yourself a step stays silent.
  if not _joined then
    select e.user_id into _user  from public.employees e where e.id = new.assigned_to;
    select t.title   into _title from public.tasks     t where t.id = new.task_id;
    perform app.notify_user(_user, 'task',
      'A subtask is yours',
      '"' || new.title || '" in "' || coalesce(_title, 'a task') || '".',
      'tasks', new.task_id);
  end if;

  return new;
end $$;

drop trigger if exists trg_checklist_owner_joins_task on public.task_checklist_items;
create trigger trg_checklist_owner_joins_task
  after insert or update of assigned_to on public.task_checklist_items
  for each row execute function app.tg_checklist_owner_joins_task();

-- ---------------------------------------------------------------------------------------------
-- 3. The tick
--
-- The policy widens to "may write the task", which is what reassigning a line needs, and the
-- trigger below re-narrows the tick itself. Ticking is NOT wider than it was in 0114: a manager who
-- is not on the task still cannot tick an unowned line, because the trigger asks is_task_assignee
-- for exactly that case.
-- ---------------------------------------------------------------------------------------------

drop policy if exists task_checklist_update on public.task_checklist_items;
create policy task_checklist_update on public.task_checklist_items for update to authenticated
  using (app.can_write_task(task_id))
  with check (app.can_write_task(task_id));

create or replace function app.tg_checklist_tick_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public, app as $$
declare _me uuid;
begin
  -- Trusted owner/service writes: checked SECURITY DEFINER workflows, FK cleanup, migrations.
  -- Test the invoking role, never the absence of a JWT — anonymous has none either (0125).
  if exists (select 1 from pg_catalog.pg_roles
              where rolname = current_user and (rolsuper or rolbypassrls)) then
    return new;
  end if;

  -- Only a tick or an untick is guarded here. Renaming a step, reordering it or changing who owns
  -- it is editing the task, and the policy above has already established this person may do that.
  if new.completed_by is not distinct from old.completed_by
     and new.completed_at is not distinct from old.completed_at then
    return new;
  end if;

  _me := app.current_employee_id();

  -- You sign your own work. 0114 left this to the client, and a name written onto somebody else's
  -- effort is precisely the thing the checklist exists to record truthfully.
  if new.completed_by is not null and new.completed_by is distinct from _me then
    raise exception 'A subtask records who ticked it, so you can only tick it as yourself.'
      using errcode = '42501';
  end if;

  -- OLD, deliberately. Reading NEW would let a single statement hand the line to yourself and tick
  -- it in the same breath — ticking on somebody's behalf with one extra column set. Reassigning
  -- first is allowed and leaves the new owner visible on the row; that is two acts, not one.
  if old.assigned_to is not null then
    if old.assigned_to is distinct from _me then
      raise exception 'That subtask belongs to somebody else. Reassign it first if it has to move.'
        using errcode = '42501';
    end if;
  elsif not app.is_task_assignee(old.task_id) then
    raise exception 'Only the people on this task can tick its subtasks.'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists trg_checklist_tick_guard on public.task_checklist_items;
create trigger trg_checklist_tick_guard before update on public.task_checklist_items
  for each row execute function app.tg_checklist_tick_guard();

revoke all on function app.tg_checklist_tick_guard()      from public, anon;
revoke all on function app.tg_checklist_owner_joins_task() from public, anon;

commit;
