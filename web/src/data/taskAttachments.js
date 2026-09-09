// What a task is about: the photograph, the spec, the folder.
//
// Two kinds in one list (0106). A link costs nothing and covers most of it; a file matters when the
// thing does not live anywhere else. Visibility is the task's own — the policies ask about the
// task, so a plain query here inherits the board's rules with nothing to keep in step.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/AuthContext';

const BUCKET = 'task-files';

/** Matches the bucket's own limit in 0106. Checked here so the reader hears why before the upload. */
export const MAX_TASK_FILE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_TASK_FILES = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.csv,.txt,.xlsx,.docx';

/** Signed links live an hour: long enough to open, short enough not to become a public URL. */
const SIGNED_SECONDS = 3600;

export function useTaskAttachmentCounts(taskIds) {
  const ids = [...new Set(taskIds ?? [])].sort();
  return useQuery({
    enabled: ids.length > 0,
    queryKey: ['task-attachment-counts', ids],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('task_attachments').select('task_id').in('task_id', ids).limit(5000);
      if (error) throw error;
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
    queryFn: async () => {
      const { data, error } = await supabase
        .from('task_attachments')
        .select('id, kind, label, url, storage_path, size_bytes, content_type, created_at, added_user, added_by:employees!task_attachments_added_by_fkey(id, full_name)')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}

function useAttachmentCaches() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['task-attachments'] });
    qc.invalidateQueries({ queryKey: ['task-attachment-counts'] });
  };
}

/** A link. Nothing is uploaded, so this is just a row. */
export function useAddTaskLink() {
  const { employee, user } = useAuth();
  const invalidate = useAttachmentCaches();
  return useMutation({
    mutationFn: async ({ taskId, url, label }) => {
      const href = (url ?? '').trim();
      if (!href) throw new Error('Paste a link first.');
      // A bare "drive.google.com/…" is what people paste; without a scheme the browser treats it as
      // a relative path and the link goes nowhere.
      const normalised = /^https?:\/\//i.test(href) ? href : `https://${href}`;
      const { error } = await supabase.from('task_attachments').insert({
        task_id: taskId, kind: 'link', url: normalised,
        label: (label ?? '').trim() || null,
        added_by: employee?.id ?? null, added_user: user?.id,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

/**
 * A file: upload first, then the row.
 *
 * That order matters. The storage insert policy cannot ask whether the attachment row is visible —
 * it does not exist yet — so it checks the TASK id that leads the path instead (0106). Which is
 * also why the path must start with the task id.
 */
export function useAddTaskFile() {
  const { employee, user } = useAuth();
  const invalidate = useAttachmentCaches();
  return useMutation({
    mutationFn: async ({ taskId, file }) => {
      if (!file) return;
      if (file.size > MAX_TASK_FILE_BYTES) {
        throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 10 MB.`);
      }
      const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
      const path = `${taskId}/${crypto.randomUUID()}-${safe}`;

      const { error: upload } = await supabase.storage
        .from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (upload) throw upload;

      const { error } = await supabase.from('task_attachments').insert({
        task_id: taskId, kind: 'file', storage_path: path, label: file.name,
        size_bytes: file.size, content_type: file.type || null,
        added_by: employee?.id ?? null, added_user: user?.id,
      });
      if (error) {
        // Don't leave an orphan in the bucket that nothing points at and nobody can reach.
        await supabase.storage.from(BUCKET).remove([path]);
        throw error;
      }
    },
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
