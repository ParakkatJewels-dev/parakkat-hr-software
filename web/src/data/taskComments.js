// Talking on a task.
//
// No RPC and no permission of its own: task_comments' policies ask whether the TASK is visible, and
// that subquery runs under tasks' RLS for the caller (0105). So a plain query here inherits every
// rule the board already has, including the one from 0101 that lets the head who ASKED for a task
// read it. One boundary, not two.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/AuthContext';

/** Comment counts for a page of tasks, in one query rather than one per card. */
export function useTaskCommentCounts(taskIds) {
  const ids = [...new Set(taskIds ?? [])].sort();
  return useQuery({
    enabled: ids.length > 0,
    queryKey: ['task-comment-counts', ids],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('task_comments')
        .select('task_id')
        .in('task_id', ids)
        .limit(5000);
      if (error) throw error;
      const counts = {};
      for (const row of data ?? []) counts[row.task_id] = (counts[row.task_id] ?? 0) + 1;
      return counts;
    },
  });
}

/** The thread on one task. Only fetched once somebody opens it. */
export function useTaskComments(taskId, { enabled = true } = {}) {
  return useQuery({
    enabled: enabled && Boolean(taskId),
    queryKey: ['task-comments', taskId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('task_comments')
        .select('id, body, created_at, edited_at, author_user, parent_id, author:employees!task_comments_author_id_fkey(id, full_name, employee_code)')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })
        .limit(500);
      if (error) throw error;
      return data ?? [];
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
      const { data, error } = await supabase
        .from('task_comments')
        .insert({
          task_id: taskId, body: text, parent_id: parentId,
          author_id: employee?.id ?? null, author_user: user?.id,
        })
        .select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('That comment could not be posted. Your access to the task may have changed.');
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
