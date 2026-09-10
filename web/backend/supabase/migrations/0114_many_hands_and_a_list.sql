-- 0114 — Many hands on one task, and a list of what is left.
--
-- A task has had exactly one assignee since it was written: employee_id, NOT NULL, and the four
-- ancestry columns stamped from it by trg_tasks_ancestry. Every policy on the table scopes through
-- that one person. So "three of us are on this" could not be said at all, and "here are the six
-- steps, tick them off" was attempted with sub-tasks — which is why the tree view existed, and why
-- it earned so little: seven tasks in production, one of them nested.
--
-- Two tables replace both ideas. task_assignees says who is on a task. task_checklist_items says
-- what is left inside it, and records WHO ticked each line, which is the thing people actually
-- wanted from sub-tasks and never got.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * tasks.employee_id STAYS, and stays NOT NULL. It is the primary assignee and, more to the
--     point, it is what trg_tasks_ancestry reads to stamp entity/zone/branch/department. Those four
--     columns are how every manager's scope is decided. Dropping employee_id means rewriting four
--     policies, the ancestry trigger and the notify trigger in one migration, on a live system,
--     for nothing a user can see. The junction table carries the other assignees; the primary is
--     simply the one whose org path the row wears.
--   * parent_task_id stays too. app.is_own_task reads it (0113), new rows write null, and dropping
--     it would touch two more policies for no gain. A later migration can retire it.
--   * tasks_insert and tasks_delete are untouched. Being added to somebody's task lets you do it
--     and say it is done. It does not let you delete it out from under them.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Who is on a task
-- ---------------------------------------------------------------------------------------------

create table if not exists public.task_assignees (
  task_id     uuid not null references public.tasks(id)     on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  -- Who put them on it, for the notification's "added by" and for reading the row later.
  added_by    uuid references public.employees(id),
  added_at    timestamptz not null default now(),
  primary key (task_id, employee_id)
);

-- The board asks "what is on MY plate" on every load, which is a lookup by person, not by task.
create index if not exists task_assignees_employee_idx on public.task_assignees (employee_id);

alter table public.task_assignees enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 2. What is left inside a task
-- ---------------------------------------------------------------------------------------------

create table if not exists public.task_checklist_items (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  title        text not null check (length(btrim(title)) between 1 and 200),
  position     integer not null default 0,
  -- The pair IS the tick. completed_by is the name the screen shows against the line, which is the
  -- whole point of the feature: "three items, three ticked by me, show my name".
  completed_by uuid references public.employees(id),
  completed_at timestamptz,
  created_by   uuid references public.employees(id),
  created_at   timestamptz not null default now(),
  -- Half a tick is not a state. Either both are set or neither is, so no screen and no rollup has
  -- to decide what a row with a name but no time means.
  constraint checklist_done_is_whole
    check ((completed_by is null) = (completed_at is null))
);

create index if not exists task_checklist_task_idx
  on public.task_checklist_items (task_id, position);

alter table public.task_checklist_items enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 3. Helpers
--
-- SECURITY DEFINER, and that is not incidental. The two new tables must ask "may I see the parent
-- task", and tasks_select must ask "am I one of the assignees" — each table's policy consulting the
-- other. Left as plain subqueries inside the policies, Postgres re-enters RLS on the inner read and
-- the pair recurses. A definer function reads past RLS once and returns a boolean, which breaks the
-- cycle. Every one of them is scoped to a single task id, so nothing is widened.
-- ---------------------------------------------------------------------------------------------

create or replace function app.is_task_assignee(_task uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select _task is not null and exists (
    select 1 from public.task_assignees ta
     where ta.task_id = _task
       and ta.employee_id = app.current_employee_id()
  );
$$;

/*
 * May this person see this task at all?
 *
 * Mirrors tasks_select exactly, help-request branch included. If it did not, a department that
 * raised a request could open the task it asked for and find the checklist mysteriously empty —
 * visible parent, invisible children is a worse bug than no access at all.
 */
create or replace function app.can_read_task(_task uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (
    select 1 from public.tasks t
     where t.id = _task
       and (
            app.has_perm('task.read', t.entity_id, t.zone_id, t.branch_id, t.department_id, t.employee_id)
         or app.is_task_assignee(t.id)
         or exists (
              select 1 from public.help_requests hr
               where hr.task_id = t.id
                 and app.has_perm('task.request', hr.entity_id, null::uuid, hr.from_branch_id, hr.from_department_id, null::uuid)
            )
       )
  );
$$;

/*
 * May this person change this task's contents — its assignees, its checklist?
 *
 * Mirrors tasks_update, plus the assignee branch. Note this is NOT the tick test: adding and
 * removing checklist lines is editing the task, and a manager may do that. Ticking is narrower and
 * uses is_task_assignee directly. See the checklist update policy below.
 */
create or replace function app.can_write_task(_task uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (
    select 1 from public.tasks t
     where t.id = _task
       and (
            app.has_perm('task.update', t.entity_id, t.zone_id, t.branch_id, t.department_id, t.employee_id)
         or app.has_perm('task.manage', t.entity_id, t.zone_id, t.branch_id, t.department_id, t.employee_id)
         or app.is_task_assignee(t.id)
       )
  );
$$;

grant execute on function app.is_task_assignee(uuid) to authenticated;
grant execute on function app.can_read_task(uuid)    to authenticated;
grant execute on function app.can_write_task(uuid)   to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. tasks: the two policies that decide what a co-assignee gets
--
-- Additive. The has_perm arm is reproduced verbatim from 0113 and earlier so the manager ladder is
-- unchanged; all that is new is the OR that lets somebody on the task see it and move it along.
-- ---------------------------------------------------------------------------------------------

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (
       app.has_perm('task.read', entity_id, zone_id, branch_id, department_id, employee_id)
    or app.is_task_assignee(id)
    or exists (
         select 1 from public.help_requests hr
          where hr.task_id = tasks.id
            and app.has_perm('task.request', hr.entity_id, null::uuid, hr.from_branch_id, hr.from_department_id, null::uuid)
       )
  );

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (
       app.has_perm('task.update', entity_id, zone_id, branch_id, department_id, employee_id)
    or app.has_perm('task.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or app.is_task_assignee(id)
  )
  with check (
       app.has_perm('task.update', entity_id, zone_id, branch_id, department_id, employee_id)
    or app.has_perm('task.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    or app.is_task_assignee(id)
  );

-- ---------------------------------------------------------------------------------------------
-- 5. Policies on the two new tables
-- ---------------------------------------------------------------------------------------------

drop policy if exists task_assignees_select on public.task_assignees;
create policy task_assignees_select on public.task_assignees for select to authenticated
  using (app.can_read_task(task_id));

drop policy if exists task_assignees_insert on public.task_assignees;
create policy task_assignees_insert on public.task_assignees for insert to authenticated
  with check (app.can_write_task(task_id));

drop policy if exists task_assignees_delete on public.task_assignees;
create policy task_assignees_delete on public.task_assignees for delete to authenticated
  using (app.can_write_task(task_id));

drop policy if exists task_checklist_select on public.task_checklist_items;
create policy task_checklist_select on public.task_checklist_items for select to authenticated
  using (app.can_read_task(task_id));

drop policy if exists task_checklist_insert on public.task_checklist_items;
create policy task_checklist_insert on public.task_checklist_items for insert to authenticated
  with check (app.can_write_task(task_id));

drop policy if exists task_checklist_delete on public.task_checklist_items;
create policy task_checklist_delete on public.task_checklist_items for delete to authenticated
  using (app.can_write_task(task_id));

/*
 * The tick, and the one place this is deliberately narrower than "may edit the task".
 *
 * Only somebody actually on the task may tick its lines. A manager holding task.manage can add
 * items, remove them and close the task by hand — but ticking writes THEIR NAME onto the line as
 * the person who did the work, and a name is not something a policy should let you put on
 * somebody else's effort.
 */
drop policy if exists task_checklist_update on public.task_checklist_items;
create policy task_checklist_update on public.task_checklist_items for update to authenticated
  using (app.is_task_assignee(task_id))
  with check (app.is_task_assignee(task_id));

-- ---------------------------------------------------------------------------------------------
-- 6. The checklist drives the task's status
--
-- Decided deliberately, and it cuts both ways: if ticking the last line closes the task, then
-- adding a line to a closed task has to reopen it, and deleting the last unticked line has to
-- close it. Anything else means the list and the status can disagree, which is the state this was
-- meant to remove.
--
-- Two things it will not touch:
--   * A task with NO checklist. Most tasks are a single thing with no steps; those stay entirely
--     hand-driven, exactly as before this migration.
--   * A Cancelled task. Cancelled is a decision to stop, not a stage on the way anywhere, so no
--     amount of ticking reopens or completes it.
-- ---------------------------------------------------------------------------------------------

create or replace function app.tg_task_checklist_rollup()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _task uuid; _total int; _done int; _status text;
begin
  _task := coalesce(new.task_id, old.task_id);

  select count(*), count(completed_at) into _total, _done
    from public.task_checklist_items where task_id = _task;

  select status into _status from public.tasks where id = _task;

  if _total = 0 or _status is null or _status = 'Cancelled' then
    return coalesce(new, old);
  end if;

  if _done = _total and _status is distinct from 'Done' then
    update public.tasks set status = 'Done', completed_at = now() where id = _task;
  elsif _done < _total and _status = 'Done' then
    -- Back to In Progress rather than To Do: some of it demonstrably happened.
    update public.tasks set status = 'In Progress', completed_at = null where id = _task;
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists trg_task_checklist_rollup on public.task_checklist_items;
create trigger trg_task_checklist_rollup
  after insert or update or delete on public.task_checklist_items
  for each row execute function app.tg_task_checklist_rollup();

-- ---------------------------------------------------------------------------------------------
-- 7. Backfill — BEFORE the notify trigger exists
--
-- Order matters. Every existing task gets its assignee row here; if the trigger in section 8 were
-- already in place, this statement would post a "you were added to a task" notification for every
-- task in the company's history.
-- ---------------------------------------------------------------------------------------------

insert into public.task_assignees (task_id, employee_id, added_by, added_at)
select t.id, t.employee_id, t.assigned_by, t.created_at
  from public.tasks t
on conflict (task_id, employee_id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 8. Telling somebody they are on a task
--
-- trg_tasks_notify only ever knew about employee_id, so without this the second and third person
-- on a task are never told about it at all.
-- ---------------------------------------------------------------------------------------------

create or replace function app.tg_notify_task_assignee()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _user uuid; _title text; _due date; _primary uuid; _adder text;
begin
  select t.title, t.due_date, t.employee_id into _title, _due, _primary
    from public.tasks t where t.id = new.task_id;

  -- The primary assignee already hears about it from trg_tasks_notify on the task row itself.
  -- Without this guard, creating a task posts two notifications to the same person.
  if new.employee_id = _primary then return new; end if;

  select e.user_id   into _user  from public.employees e where e.id = new.employee_id;
  select e.full_name into _adder from public.employees e where e.id = new.added_by;

  -- notify_user drops it if _user is the actor, so adding yourself to a task stays silent.
  perform app.notify_user(_user, 'task',
    'You were added to a task',
    '"' || _title || '"'
      || case when _adder is not null then ' — added by ' || _adder else '' end
      || case when _due is not null then ' (due ' || to_char(_due, 'DD Mon') || ')' else '' end || '.',
    'tasks', new.task_id);

  return new;
end $$;

drop trigger if exists trg_task_assignee_notify on public.task_assignees;
create trigger trg_task_assignee_notify
  after insert on public.task_assignees
  for each row execute function app.tg_notify_task_assignee();

-- ---------------------------------------------------------------------------------------------
-- 9. The one nested task
--
-- Production holds a single row with a parent: "Change Music" under "Edit Insta Video". With the
-- tree view gone there is nothing to draw it, so it is unparented and becomes an ordinary task.
--
-- NOT converted into a checklist item on its parent and deleted, which was the tidier-looking
-- option: it carries 2 comments and 1 attachment, and a checklist line cannot hold either. Losing
-- somebody's conversation to make the data model neater is not a trade worth making.
--
-- To undo: set parent_task_id back to the id of 'Edit Insta Video'.
-- ---------------------------------------------------------------------------------------------

update public.tasks set parent_task_id = null where parent_task_id is not null;

commit;
