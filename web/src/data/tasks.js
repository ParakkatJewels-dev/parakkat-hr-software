// Data hooks for the Task module. RLS scopes what each user sees: an employee sees tasks assigned
// to them; a branch manager / HR sees their branch's; a zonal manager, their zone; and so on up the
// hierarchy. Ancestry columns are stamped automatically from the assignee (employee_id) by the DB.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { openOrRecentlyClosedFilter, CLOSED_TASK_WINDOW_DAYS } from '../lib/taskBoard';

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

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select(
          // tasks has two FKs to employees (employee_id = assignee, assigned_by = delegator).
          // The ancestry columns are here so each row's controls can be gated the way tasks_update
          // and tasks_delete check them, rather than from one blanket canAny.
          `id, title, description, priority, status, due_date, completed_at, created_at,
           parent_task_id, employee_id, assigned_by,
           entity_id, zone_id, branch_id, department_id,
           assignee:employees!tasks_employee_id_fkey(id, full_name, employee_code, branch:branches(code), department:departments(name)),
           assigner:employees!tasks_assigned_by_fkey(id, full_name, employee_code)`
        )
        // Everything still open, plus a year of what is finished — see openOrRecentlyClosedFilter.
        // Without it this was the only operational list with no bound at all, growing with the
        // company's whole history; Leave, Expenses and Tickets have each carried a window for as
        // long as they have existed.
        .or(openOrRecentlyClosedFilter())
        .order('created_at', { ascending: false })
        // Explicit, so the ceiling is visible here rather than PostgREST's silent 1000-row default
        // — the same reason useEmployees and useLeaveBalances state theirs. It matters more here
        // than on a flat list: the board nests tasks under their parents and counts them in the
        // chips, so a truncated read does not merely hide old rows, it orphans sub-tasks whose
        // parent fell off the end and quietly under-reports every total on the screen.
        .limit(TASK_ROW_CAP);
      if (error) throw error;
      if ((data?.length ?? 0) === TASK_ROW_CAP) {
        console.warn(`[tasks] hit the ${TASK_ROW_CAP}-row cap despite the ${CLOSED_TASK_WINDOW_DAYS}-day window — the board is truncated; move search server-side`);
      }
      return data ?? [];
    },
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      // ancestry is stamped by the DB trigger from employee_id (the assignee)
      const { error } = await supabase.from('tasks').insert({ ...payload, status: 'To Do' });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
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
