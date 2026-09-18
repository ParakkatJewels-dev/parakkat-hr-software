// What a task is about: the photograph, the spec, the folder.
//
// Two kinds in one list (0106). A link costs nothing and covers most of it; a file matters when the
// thing does not live anywhere else. Visibility is the task's own — the policies ask about the
// task, so a plain query here inherits the board's rules with nothing to keep in step.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection, fetchInCollection } from '../lib/fetchCollection';
import { useAuth } from '../auth/AuthContext';

import { TASK_FILE_BUCKET as BUCKET, addTaskLink, addTaskFile } from '../lib/taskAttachments';
export { MAX_TASK_FILE_BYTES, ACCEPTED_TASK_FILES } from '../lib/taskAttachments';

/** Signed links live an hour: long enough to open, short enough not to become a public URL. */
const SIGNED_SECONDS = 3600;

export function useTaskAttachmentCounts(taskIds) {
  const ids = [...new Set(taskIds ?? [])].sort();
  return useQuery({
    enabled: ids.length > 0,
    queryKey: ['task-attachment-counts', ids],
    queryFn: async () => {
      const data = await fetchInCollection((batch) => supabase
        .from('task_attachments').select('id, task_id').in('task_id', batch).order('id'), ids);
      const counts = {};
      for (const row of data ?? []) counts[row.task_id] = (counts[row.task_id] ?? 0) + 1;
      return counts;
    },
  });
}

export function useTaskAttachments(taskId, { enabled = true } = {}) {
  return useQuery({
    enabled: enabled && Boolean(taskId),
    queryKey: ['task-attachments', taskId],
    queryFn: () => fetchCollection(() => supabase
        .from('task_attachments')
        .select('id, kind, label, url, storage_path, size_bytes, content_type, created_at, added_user, added_by:employees!task_attachments_added_by_fkey(id, full_name)')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })
        .order('id')),
  });
}

function useAttachmentCaches() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['task-attachments'] });
    qc.invalidateQueries({ queryKey: ['task-attachment-counts'] });
  };
}

/** Both creation and the open task use the same validated attachment writes. */
export function useAddTaskLink() {
  const { employee, user } = useAuth();
  const invalidate = useAttachmentCaches();
  return useMutation({
    mutationFn: (params) => addTaskLink(supabase, { ...params, employeeId: employee?.id, userId: user?.id }),
    onSuccess: invalidate,
  });
}

export function useAddTaskFile() {
  const { employee, user } = useAuth();
  const invalidate = useAttachmentCaches();
  return useMutation({
    mutationFn: (params) => addTaskFile(supabase, { ...params, employeeId: employee?.id, userId: user?.id }),
    onSuccess: invalidate,
  });
}

/** A short-lived URL, fetched on click rather than for every row in the list. */
export function useTaskFileUrl() {
  return useMutation({
    mutationFn: async (storagePath) => {
      const { data, error } = await supabase.storage
        .from(BUCKET).createSignedUrl(storagePath, SIGNED_SECONDS);
      if (error) throw error;
      return data?.signedUrl ?? null;
    },
  });
}

export function useRemoveTaskAttachment() {
  const invalidate = useAttachmentCaches();
  return useMutation({
    mutationFn: async (row) => {
      const { data, error } = await supabase
        .from('task_attachments').delete().eq('id', row.id).select('id, storage_path');
      if (error) throw error;
      if (!data?.length) throw new Error('That attachment could not be removed — it may already be gone.');
      // The row is the permission record; drop it first, then the bytes it was guarding.
      if (row.storage_path) await supabase.storage.from(BUCKET).remove([row.storage_path]);
    },
    onSuccess: invalidate,
  });
}
