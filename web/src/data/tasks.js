// Data hooks for the Task module. RLS scopes what each user sees: an employee sees tasks assigned
// to them; a branch manager / HR sees their branch's; a zonal manager, their zone; and so on up the
// hierarchy. Ancestry columns are stamped automatically from the assignee (employee_id) by the DB.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { openOrRecentlyClosedFilter, CLOSED_TASK_WINDOW_DAYS } from '../lib/taskBoard';
import { withSchemaFallback, isMissingSchema } from '../lib/pendingMigration';

export { CLOSED_TASK_WINDOW_DAYS };

/**
 * A backstop, not the bound.
 *
 * The bound is the window below — open work plus a year of finished work — which is what actually
 * keeps this query from growing with the company's history. This cap only exists so that if the
 * window is ever widened or removed, the failure is a loud warning rather than a silently
 * truncated board.
 */
export const TASK_ROW_CAP = 5000;

// tasks has two FKs to employees (employee_id = the primary assignee, assigned_by = delegator).
// The ancestry columns are here so each row's controls can be gated the way tasks_update and
// tasks_delete check them, rather than from one blanket canAny.
const TASK_FIELDS = `id, title, description, priority, status, due_date, completed_at, created_at,
   parent_task_id, employee_id, assigned_by,
   entity_id, zone_id, branch_id, department_id,
   assignee:employees!tasks_employee_id_fkey(id, full_name, employee_code, branch:branches(code), department:departments(name)),
   assigner:employees!tasks_assigned_by_fkey(id, full_name, employee_code)`;

// Everything 0114 adds: who else is on the task, and how much of its checklist is ticked. The
// checklist embed only includes completion fields — the row needs "2 of 3", and pulling every
// title for every row on the board to render a counter would be a much larger read for nothing.
const TASK_FIELDS_WITH_ASSIGNEES = `${TASK_FIELDS},
   assignees:task_assignees(employee_id, employee:employees!task_assignees_employee_id_fkey(id, full_name, employee_code, branch:branches(code))),
   checklist:task_checklist_items(id, completed_at, completed_by)`;

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => {
      const read = (fields) => async () => {
        const { data, error } = await supabase
          .from('tasks')
          .select(fields)
          // Everything still open, plus a year of what is finished — see openOrRecentlyClosedFilter.
          // Without it this was the only operational list with no bound at all, growing with the
          // company's whole history; Leave, Expenses and Tickets have each carried a window for as
          // long as they have existed.
          .or(openOrRecentlyClosedFilter())
          .order('created_at', { ascending: false })
          // Explicit, so the ceiling is visible here rather than PostgREST's silent 1000-row
          // default — the same reason useEmployees and useLeaveBalances state theirs.
          .limit(TASK_ROW_CAP);
        if (error) throw error;
        return data ?? [];
      };

      // 0114 ships separately from this client, and PostgREST rejects the WHOLE query when one
      // embed in it is unknown — which is how threading once took the entire comment thread down.
      // So the board asks for the assignee set, and falls back to the single-assignee shape it has
      // always had if the migration is not in yet. assigneeIds() treats a missing set as "just the
      // primary", so every screen keeps working; multi-assignee is simply absent until 0114 lands.
      const data = await withSchemaFallback(
        read(TASK_FIELDS_WITH_ASSIGNEES),
        read(TASK_FIELDS)
      );

      if (data.length === TASK_ROW_CAP) {
        console.warn(`[tasks] hit the ${TASK_ROW_CAP}-row cap despite the ${CLOSED_TASK_WINDOW_DAYS}-day window — the board is truncated; move search server-side`);
      }
      return data;
    },
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ assigneeIds = [], checklist = [], ...payload }) => {
      // ancestry is stamped by the DB trigger from employee_id — the PRIMARY assignee, which is
      // what decides the task's branch and department and therefore which managers can see it.
      const { data, error } = await supabase
        .from('tasks')
        .insert({ ...payload, status: 'To Do' })
        .select('id')
        .single();
      if (error) throw error;

      // Everyone on the task, primary included, so `task_assignees` is the one place that answers
      // "who is on this" and no reader has to remember to also check employee_id.
      const rows = [...new Set([payload.employee_id, ...assigneeIds])].filter(Boolean).map((id) => ({
        task_id: data.id,
        employee_id: id,
        added_by: payload.assigned_by ?? null,
      }));
      const { error: linkError } = await supabase.from('task_assignees').insert(rows);
      // A pending 0114 is not a failure: the task is filed and has its primary assignee, which is
      // exactly the behaviour this screen had before multi-assignee existed. Anything else IS a
      // failure, and the task exists by then — so the message says what is actually true (the work
      // was filed, the people were not all attached) rather than letting the caller believe
      // nothing happened and file it a second time.
      if (linkError && !isMissingSchema(linkError)) {
        throw new Error(
          `The task was created, but the people could not all be added to it (${linkError.message}). Open the task and add them.`
        );
      }

      /*
       * The steps, written on the same form as the task.
       *
       * Last, after the assignee rows. That order is a preference and not a requirement, which is
       * worth stating because the reverse looks like it should matter and does not: an earlier
       * version of this comment claimed writing the steps first would be refused for somebody
       * filing work on their own board, and a test against the real policies showed it succeeds.
       * task_checklist_items' insert policy asks app.can_write_task, and its task.update arm
       * matches at SELF scope — every employee holds task.update on their own row (0096), so the
       * junction row is not what earns them the right to write the list.
       *
       * Kept in this order anyway: it means every row that references the task exists before
       * anything hangs off it, which is the arrangement that stays correct if can_write_task is
       * ever narrowed to membership alone.
       *
       * Positions are handed out here rather than left to default, so the list reads back in the
       * order it was typed instead of the order the rows happen to come off disk.
       */
      const steps = (checklist ?? [])
        .map((title) => String(title ?? '').trim())
        .filter(Boolean)
        .slice(0, 50);

      if (steps.length > 0) {
        const { error: stepError } = await supabase.from('task_checklist_items').insert(
          steps.map((title, index) => ({
            task_id: data.id,
            title: title.slice(0, 200),
            position: index,
            created_by: payload.assigned_by ?? null,
          }))
        );
        // Same reasoning as the assignees above: the task exists, so say what actually happened.
        if (stepError && !isMissingSchema(stepError)) {
          throw new Error(
            `The task was created, but its checklist could not be saved (${stepError.message}). Open the task and add the steps.`
          );
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task-checklist'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }) => {
      // keep completed_at in sync with the Done status
      if (patch.status === 'Done') patch.completed_at = new Date().toISOString();
      else if ('status' in patch) patch.completed_at = null;
      const { data, error } = await supabase.from('tasks').update(patch).eq('id', id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('This task could not be updated. Your access may have changed, or the task was deleted.');
    },
    // Keep both status controls disabled until their shared row has refreshed. Otherwise a second
    // click can advance from the old status while the successful write is still being refetched.
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['tasks'] }),
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] }),
    ]),
  });
}

/**
 * Put somebody on a task, or take them off it.
 *
 * The primary assignee cannot be removed here: `tasks.employee_id` is NOT NULL and is what the
 * ancestry columns are stamped from, so dropping their junction row would leave the task scoped to
 * somebody the board no longer lists as being on it. Changing who the primary is means editing the
 * task itself, which is what the composer's assignee field does.
 */
export function useAddAssignee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, employeeId, addedBy }) => {
      const { error } = await supabase
        .from('task_assignees')
        .insert({ task_id: taskId, employee_id: employeeId, added_by: addedBy ?? null });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
  });
}

export function useRemoveAssignee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, employeeId, primaryId }) => {
      if (employeeId === primaryId) {
        throw new Error('This is the task\u2019s main assignee. Edit the task to hand it to somebody else.');
      }
      const { data, error } = await supabase
        .from('task_assignees')
        .delete()
        .eq('task_id', taskId)
        .eq('employee_id', employeeId)
        .select('task_id');
      if (error) throw error;
      if (!data?.length) throw new Error('They could not be removed. Your access may have changed.');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { data, error } = await supabase.from('tasks').delete().eq('id', id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('This task could not be deleted. Your access may have changed, or the task was already deleted.');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
  });
}
