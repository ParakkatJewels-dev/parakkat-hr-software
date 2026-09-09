-- 0113 — Work you set yourself.
--
-- tasks_insert asks for task.create on the assignee, and task.create stops at dept_head. So a
-- plain employee cannot put a single item on their own list — not "cannot assign work to others",
-- which is right, but cannot write down their own. And tasks_delete asks for task.manage, which
-- they also do not hold, so even if one appeared they could not remove it.
--
-- Nobody needs permission to give themselves something to do. This adds the one clause that says
-- so, and it is also the answer to the error people hit when they pick their own name in the
-- assignee list: whatever their role, filing work on their own board now succeeds.
--
-- WHAT IT DOES NOT OPEN
--   * Only your own board. employee_id must be your own employee record — the ancestry columns are
--     stamped by trg_tasks_ancestry from that id, so a self-filed task cannot claim a scope its
--     author does not sit in.
--   * Only a root item. A personal to-do with a parent could be pinned underneath somebody else's
--     task, where it would show up in their tree and their counts. A self-filed task stands alone;
--     a sub-task is still delegation and still needs task.create.
--   * Deleting is narrower than creating: your own board AND you put it there. A task your head
--     assigned you is theirs to withdraw, not yours to make disappear — otherwise "delete" is how
--     you get out of work somebody gave you. Marking it Done is the honest way, and tasks_update
--     already allows that at self scope.
--
-- Idempotent: safe to re-run.

begin;

/*
 * Is this row a task the signed-in person is filing on their own board?
 *
 * Written as a helper so the insert policy and the delete policy cannot drift apart about what
 * "my own" means — the pair of them is exactly the kind of thing that gets edited singly.
 */
create or replace function app.is_own_task(_employee uuid, _parent uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select _employee is not null
     and _parent is null
     and _employee = app.current_employee_id();
$$;

grant execute on function app.is_own_task(uuid, uuid) to authenticated;

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (
       app.has_perm('task.create', entity_id, zone_id, branch_id, department_id, employee_id)
    or app.is_own_task(employee_id, parent_task_id)
  );

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (
       app.has_perm('task.manage', entity_id, zone_id, branch_id, department_id, employee_id)
    -- Yours to remove only if you also set it. `assigned_by` is the author; a task somebody else
    -- put on your board keeps their name there and stays theirs to withdraw.
    or (app.is_own_task(employee_id, parent_task_id)
        and assigned_by is not null
        and assigned_by = app.current_employee_id())
  );

commit;
