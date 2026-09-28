// Data hooks for the Task module. RLS scopes what each user sees: an employee sees tasks assigned
// to them; a branch manager / HR sees their branch's; a zonal manager, their zone; and so on up the
// hierarchy. Ancestry columns are stamped automatically from the assignee (employee_id) by the DB.
import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';
import { openOrRecentlyClosedFilter, CLOSED_TASK_WINDOW_DAYS } from '../lib/taskBoard';
import { isMissingSchema, withSchemaFallback } from '../lib/pendingMigration';
import { useAuth } from '../auth/AuthContext';
import { saveTaskDraft } from '../lib/createTask';

export { CLOSED_TASK_WINDOW_DAYS };

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

export function useTasks({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['tasks'],
    queryFn: async () => {
      const read = (fields, activeOnly = true) => () => fetchCollection(() => {
        const query = supabase
          .from('tasks')
          .select(fields)
          // Everything still open, plus a year of what is finished — see openOrRecentlyClosedFilter.
          // Without it this was the only operational list with no bound at all, growing with the
          // company's whole history; Leave, Expenses and Tickets have each carried a window for as
          // long as they have existed.
          .or(openOrRecentlyClosedFilter(CLOSED_TASK_WINDOW_DAYS, { includeRestored: activeOnly }))
          .order('created_at', { ascending: false })
          .order('id');
        return activeOnly ? query.is('deleted_at', null) : query;
      });

      // 0114 ships separately from this client, and PostgREST rejects the WHOLE query when one
      // embed in it is unknown — which is how threading once took the entire comment thread down.
      // So the board asks for the assignee set, and falls back to the single-assignee shape it has
      // always had if the migration is not in yet. assigneeIds() treats a missing set as "just the
      // primary", so every screen keeps working; multi-assignee is simply absent until 0114 lands.
      const data = await withSchemaFallback(() => withSchemaFallback(
        read(TASK_FIELDS_WITH_ASSIGNEES), read(TASK_FIELDS)
      ), (error) => {
        // Old databases have no trash column. Keep reading their board until rollout; deletion
        // still fails closed below and never falls back to a permanent DELETE.
        if (!/\b(deleted_at|restored_at)\b/.test(`${error.message ?? ''} ${error.details ?? ''}`)) throw error;
        return withSchemaFallback(read(TASK_FIELDS_WITH_ASSIGNEES, false), read(TASK_FIELDS, false));
      });

      return data;
    },
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  const { employee, user } = useAuth();
  const progress = useRef({});
  const inFlight = useRef(null);
  const invalidate = () => {
    for (const key of ['tasks', 'section-counts', 'task-checklist', 'notification-ref-statuses', 'task-attachments', 'task-attachment-counts']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };
  const mutation = useMutation({
    mutationFn: (draft) => {
      // Also cover two submit events arriving before React can disable the button.
      if (!inFlight.current) {
        inFlight.current = saveTaskDraft(supabase, draft, {
          employeeId: employee?.id ?? null, userId: user?.id,
        }, progress.current).finally(() => { inFlight.current = null; });
      }
      return inFlight.current;
    },
    onSuccess: () => { progress.current = {}; invalidate(); },
    // A task may exist even though a later upload failed. Refresh the board immediately and keep
    // the same task ID for Retry saving; closing the composer explicitly abandons pending extras.
    onError: (error) => { if (error.createdTaskId) invalidate(); },
  });
  return { ...mutation, reset: () => { progress.current = {}; mutation.reset(); } };
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
      qc.invalidateQueries({ queryKey: ['section-counts'] }),
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
      qc.invalidateQueries({ queryKey: ['section-counts'] });
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
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['tasks'] }),
      qc.invalidateQueries({ queryKey: ['section-counts'] }),
    ]),
  });
}

export function useDeleteTask() {
  return useTaskTrashMutation('soft_delete_task');
}

export function useRestoreTask() {
  return useTaskTrashMutation('restore_task');
}

/** The RPC returns manageable deleted roots, their restore eligibility and their batch size. */
export function useDeletedTasks({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['deleted-tasks'],
    queryFn: async () => {
      try {
        return await fetchCollection(() => supabase.rpc('list_deleted_tasks')
          .order('deleted_at', { ascending: false }).order('id'));
      } catch (error) { throw taskTrashError(error); }
    },
  });
}

function taskTrashError(error) {
  return error?.code === 'PGRST202' || isMissingSchema(error)
    ? new Error('Task recovery is not available yet. Ask your administrator to apply the task recovery database update.')
    : error;
}

function useTaskTrashMutation(operation) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { data, error } = await supabase.rpc(operation, { _task_id: id });
      if (error) throw taskTrashError(error);
      if (!data) throw new Error('This task could not be changed. Refresh the list and check your access.');
      return data;
    },
    onSuccess: () => Promise.all(['tasks', 'deleted-tasks', 'section-counts', 'notifications', 'notification-ref-statuses',
      'task-comments', 'task-comment-counts', 'task-attachments', 'task-attachment-counts', 'task-checklist', 'help-requests']
      // Initial reads have no cached data, so invalidateQueries alone can join a pre-mutation
      // request. Cancel those snapshots too before refetching the current deletion state.
      .map((key) => qc.cancelQueries({ queryKey: [key], fetchStatus: 'fetching' })
        .then(() => qc.invalidateQueries({ queryKey: [key] }, { cancelRefetch: false })))),
  });
}
