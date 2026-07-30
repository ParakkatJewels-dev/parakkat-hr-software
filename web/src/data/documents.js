// Documents: the record, and now the file itself.
//
// Scoped by document.read to see, document.manage to add or remove. The file lives in a PRIVATE
// Supabase Storage bucket and is only ever reached through a short-lived signed URL — nothing here
// is readable by URL alone, which matters for what an HR document folder holds.
//
// Permission is not decided twice. Every object is stored at `<document_id>/<filename>` and the
// storage policies resolve that id back to its row and defer to the same app.has_perm the table
// uses (migrations 0064 and 0065). So a file is visible to exactly the people who can see its
// record, and there is a single place where that is decided.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

const BUCKET = 'documents';

/** How long a download link stays good. Long enough to click, short enough not to be worth sharing. */
const SIGNED_URL_SECONDS = 60;

export function useDocuments() {
  return useQuery({
    queryKey: ['documents'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('documents')
        .select(
          `id, title, category, url, signed, created_at,
           storage_path, file_name, mime_type, size_bytes, uploaded_at,
           employee:employees(full_name)`
        )
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * A filename that survives being the tail of an object path.
 *
 * The original is kept on the row for display and for the download filename; only the stored path
 * is sanitised. Characters outside this set are replaced rather than escaped, because a path that
 * needs escaping is one that will eventually meet something that forgets to.
 */
export function safeFileName(name) {
  const cleaned = String(name || 'file')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-120); // keep the extension end; drop an absurdly long head
  return cleaned.replace(/^[._]+/, '') || 'file';
}

/**
 * Add a document, with or without a file.
 *
 * THE ROW GOES FIRST, and it has to. The storage policy authorises an upload by resolving the
 * path's document id back to a row and checking it, so uploading first would be denied — correctly,
 * with nothing to point at.
 *
 * That leaves one failure to handle: row written, upload then fails. The row is deleted again
 * rather than left, because a record carrying a storage_path with no object behind it appears in
 * the list and fails when opened, which is worse than one that never appeared. The opposite orphan
 * cannot happen — nothing can be written to a path whose row does not exist.
 */
export function useAddDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, ...fields }) => {
      // Chosen here rather than by the database, because the upload path has to contain it.
      const id = crypto.randomUUID();
      const row = { id, ...fields };

      if (file) {
        row.storage_path = `${id}/${safeFileName(file.name)}`;
        row.file_name = file.name;
        row.mime_type = file.type || null;
        row.size_bytes = file.size;
        row.uploaded_at = new Date().toISOString();
        row.uploaded_by = (await supabase.auth.getUser()).data.user?.id ?? null;
      }

      const { error: insertError } = await supabase.from('documents').insert(row);
      if (insertError) throw new Error(insertError.message);

      if (!file) return id;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(row.storage_path, file, { contentType: file.type || undefined, upsert: false });

      if (uploadError) {
        // Best effort. If this also fails, the row survives with a path resolving to nothing and
        // opening it reports the missing file rather than pretending otherwise.
        await supabase.from('documents').delete().eq('id', id);
        throw new Error(`The file could not be uploaded: ${uploadError.message}`);
      }

      return id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  });
}

/**
 * A link that opens a stored file.
 *
 * Signed on demand and never cached: a cached URL would outlive the permission that produced it.
 * Records holding an external url instead just return it.
 */
export function useDocumentLink() {
  return useMutation({
    mutationFn: async (doc) => {
      if (!doc?.storage_path) {
        if (doc?.url) return doc.url;
        throw new Error('This record has no file attached.');
      }

      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(doc.storage_path, SIGNED_URL_SECONDS, {
          // Downloads under the name it was uploaded with, not the sanitised path tail.
          download: doc.file_name || true,
        });

      if (error) {
        // The row is visible but the object is not — it never uploaded, or it was removed
        // underneath us. Say which, because a bare "failed" sends somebody looking in the wrong
        // place.
        throw new Error(`The file is not in storage: ${error.message}`);
      }
      return data.signedUrl;
    },
  });
}

/**
 * Remove a document and its file.
 *
 * THE FILE GOES FIRST, and that ordering is the whole design. SQL cannot delete a storage object —
 * Supabase guards those tables and raises "Direct deletion from storage tables is not allowed" — so
 * this cannot be a database trigger, and the two deletes cannot be one transaction. Given that,
 * the order decides which way a half-finished delete fails:
 *
 *   file delete fails             -> stop. Nothing is removed and it can be retried.
 *   file gone, row delete fails   -> a record whose file is missing, which is VISIBLE: opening it
 *                                    says the file is not in storage, and deleting again finishes.
 *
 * The other order would leave a private object with no row. No row means no storage policy resolves
 * it, and a file nobody can see is a file nobody will ever clean up. A visible broken record beats
 * an invisible orphan.
 */
export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (doc) => {
      // Accepts a row or a bare id; only a row can carry a file to remove.
      const row = typeof doc === 'string' ? { id: doc } : doc;

      if (row.storage_path) {
        const { error: fileError } = await supabase.storage.from(BUCKET).remove([row.storage_path]);
        if (fileError) {
          throw new Error(`The file could not be deleted, so nothing was removed: ${fileError.message}`);
        }
      }

      const { error } = await supabase.from('documents').delete().eq('id', row.id);
      if (error) {
        throw new Error(
          `The file was deleted but the record could not be: ${error.message}. `
          + 'Try deleting it again.'
        );
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  });
}

/** "2.4 MB" — a hint, not a measurement. */
export function fileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What the picker accepts, mirroring the bucket's own allow-list so a reject happens before upload. */
export const ACCEPTED_FILES = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx,.xls,.xlsx';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
