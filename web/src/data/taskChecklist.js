// The list of steps inside one task.
//
// No permission of its own, and no RPC. task_checklist_items' policies ask about the TASK — can you
// read it, can you write it, are you one of the people on it — through the definer helpers 0114
// adds, so a plain query here inherits every rule the board already has. One boundary, not two.
//
// The one place the checklist is NARROWER than the task: ticking. Adding and removing lines is
// editing the task and a manager may do it; ticking writes YOUR NAME onto a line as the person who
// did the work, so task_checklist_update asks app.is_task_assignee and nothing else. A manager who
// is not on the task gets no checkbox here and would be refused by the database if they forged one.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/AuthContext';
import { nextPosition } from '../lib/checklist';

const ITEM_FIELDS =
  'id, task_id, title, position, completed_by, completed_at, created_by, created_at, ' +
  'completer:employees!task_checklist_items_completed_by_fkey(id, full_name, employee_code)';

/** The list for one task. Only fetched once somebody opens it. */
export function useChecklist(taskId, { enabled = true } = {}) {
  return useQuery({
    enabled: enabled && Boolean(taskId),
    queryKey: ['task-checklist', taskId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('task_checklist_items')
        .select(ITEM_FIELDS)
        .eq('task_id', taskId)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Every mutation below invalidates BOTH the checklist and the task board.
 *
 * Not belt and braces: app.tg_task_checklist_rollup can change the parent task's status on any of
 * these writes — ticking the last line closes the task, adding a line to a closed one reopens it,
 * deleting the last unticked line closes it. Refreshing only the checklist would leave the card
 * behind it, and the counts above it, describing a task that no longer exists in that state.
 */
function useChecklistMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ['task-checklist', variables?.taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
  });
}

export function useAddChecklistItem() {
  const { employee } = useAuth();
  return useChecklistMutation(async ({ taskId, title, items }) => {
    const clean = String(title ?? '').trim();
    if (!clean) throw new Error('Give the step a name.');
    const { error } = await supabase.from('task_checklist_items').insert({
      task_id: taskId,
      title: clean.slice(0, 200),
      position: nextPosition(items),
      created_by: employee?.id ?? null,
    });
    if (error) throw error;
  });
}

/**
 * Tick or untick, in one call.
 *
 * `done` is passed rather than read from the row so a double tap cannot toggle twice off one stale
 * render. Both columns move together because the schema's check constraint requires it: a name
 * without a time, or a time without a name, is rejected outright.
 */
export function useToggleChecklistItem() {
  const { employee } = useAuth();
  return useChecklistMutation(async ({ itemId, done }) => {
    const patch = done
      ? { completed_by: employee?.id ?? null, completed_at: new Date().toISOString() }
      : { completed_by: null, completed_at: null };

    if (done && !employee?.id) {
      // The constraint would refuse this anyway; saying so here is clearer than a 23514.
      throw new Error('Your account is not linked to an employee record, so it cannot sign for work.');
    }

    const { data, error } = await supabase
      .from('task_checklist_items')
      .update(patch)
      .eq('id', itemId)
      .select('id');
    if (error) throw error;
    if (!data?.length) {
      throw new Error('Only the people assigned to this task can tick its steps.');
    }
  });
}

export function useDeleteChecklistItem() {
  return useChecklistMutation(async ({ itemId }) => {
    const { data, error } = await supabase
      .from('task_checklist_items')
      .delete()
      .eq('id', itemId)
      .select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('That step could not be removed. Your access may have changed.');
  });
}
