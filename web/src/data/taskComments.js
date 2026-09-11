// Talking on a task.
//
// No RPC and no permission of its own: task_comments' policies ask whether the TASK is visible, and
// that subquery runs under tasks' RLS for the caller (0105). So a plain query here inherits every
// rule the board already has, including the one from 0101 that lets the head who ASKED for a task
// read it. One boundary, not two.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchInCollection } from '../lib/fetchCollection';
import { useAuth } from '../auth/AuthContext';
import { withSchemaFallback } from '../lib/pendingMigration';

/** Comment counts for a page of tasks, in one query rather than one per card. */
export function useTaskCommentCounts(taskIds) {
  const ids = [...new Set(taskIds ?? [])].sort();
  return useQuery({
    enabled: ids.length > 0,
    queryKey: ['task-comment-counts', ids],
    queryFn: async () => {
      const data = await fetchInCollection((batch) => supabase
        .from('task_comments').select('id, task_id').in('task_id', batch).order('id'), ids);
      const counts = {};
      for (const row of data ?? []) counts[row.task_id] = (counts[row.task_id] ?? 0) + 1;
      return counts;
    },
  });
}

const COMMENT_FIELDS =
  'id, body, created_at, edited_at, author_user, author:employees!task_comments_author_id_fkey(id, full_name, employee_code)';

/**
 * The thread on one task. Only fetched once somebody opens it.
 *
 * parent_id arrives with 0110. Asking for a column the database does not have yet makes PostgREST
 * reject the WHOLE query, so before this fallback existed an unapplied migration did not merely
 * disable replies — it took the entire comment thread down with it. Now the thread loads flat and
 * the reply affordance is simply absent until the migration lands.
 */
export function useTaskComments(taskId, { enabled = true } = {}) {
  return useQuery({
    enabled: enabled && Boolean(taskId),
    queryKey: ['task-comments', taskId],
    queryFn: async () => {
      const read = (fields) => async () => {
        const { data, error } = await supabase
          .from('task_comments')
          .select(fields)
          .eq('task_id', taskId)
          .order('created_at', { ascending: true })
          .limit(500);
        if (error) throw error;
        return data ?? [];
      };
      return withSchemaFallback(
        read(`${COMMENT_FIELDS}, parent_id`),
        read(COMMENT_FIELDS)
      );
    },
  });
}

function useCommentCaches() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['task-comments'] });
    qc.invalidateQueries({ queryKey: ['task-comment-counts'] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
}

export function useAddTaskComment() {
  const { employee, user } = useAuth();
  const invalidate = useCommentCaches();
  return useMutation({
    mutationFn: async ({ taskId, body, parentId = null }) => {
      const text = (body ?? '').trim();
      if (!text) return;
      // author_user is what the policy checks; author_id is who to show. Both, because an employee
      // link can be removed later and the thread should still say who spoke.
      //
      // parentId is the comment being answered. Answering a REPLY is allowed and lands on that
      // reply's own parent — 0110's trigger does that, so the client never has to walk the chain
      // and cannot disagree with the database about where a reply belongs.
      const base = { task_id: taskId, body: text, author_id: employee?.id ?? null, author_user: user?.id };
      const write = (row) => async () => {
        const { data, error } = await supabase.from('task_comments').insert(row).select('id');
        if (error) throw error;
        if (!data?.length) {
          throw new Error('That comment could not be posted. Your access to the task may have changed.');
        }
        return data;
      };
      // Before 0110 there is no parent_id. Posting the remark as a top-level comment is a better
      // outcome than refusing it — the person typed something worth keeping, and losing it to
      // explain a migration they cannot run is the wrong trade.
      return withSchemaFallback(
        write({ ...base, parent_id: parentId }),
        write(base)
      );
    },
    onSuccess: invalidate,
  });
}

export function useDeleteTaskComment() {
  const invalidate = useCommentCaches();
  return useMutation({
    mutationFn: async (id) => {
      const { data, error } = await supabase.from('task_comments').delete().eq('id', id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('That comment could not be removed — it may already be gone.');
    },
    onSuccess: invalidate,
  });
}
