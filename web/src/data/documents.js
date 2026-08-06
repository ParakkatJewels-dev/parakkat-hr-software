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
          // employee_id as well as the embed: it is what says "this belongs to a person", and it
          // stays true even when RLS hides the employee row itself, where the embed comes back
          // null and would file a personal document under company-wide.
          // The ancestry columns let a Delete button be gated the way documents_write is.
          `id, title, category, url, signed, created_at, employee_id,
           entity_id, zone_id, branch_id, department_id,
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
 * The documents filed against one person.
 *
 * Filtered in the database rather than by pulling the whole folder and sieving it here: an HR
 * document list is exactly the thing not to over-fetch. The key sits under ['documents'] so the
 * add and delete mutations, which invalidate that prefix, refresh this too.
 */
export function useEmployeeDocuments(employeeId) {
  return useQuery({
    enabled: Boolean(employeeId),
    queryKey: ['documents', 'employee', employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('documents')
        .select(
          `id, title, category, url, signed, created_at,
           storage_path, file_name, mime_type, size_bytes, uploaded_at`
        )
        .eq('employee_id', employeeId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Photographs are filed under their own category.
 *
 * The alternative was to find the avatar by matching the document title against ' - Photograph',
 * which is a display string: it changes the first time somebody renames a document type or the
 * app is read in another language, and when it changes every avatar quietly turns back into
 * initials with nothing in the logs to say why. A category is data, and `category` is free text on
 * the table, so this needs no migration.
 */
export const PHOTO_CATEGORY = 'Photo';

/**
 * Long enough that a directory page of avatars does not re-sign while you read it, short enough
 * that a link found in a cache is no use to anybody. Deliberately not the 60s used for a click,
 * where the browser fetches immediately and nothing is held.
 */
const AVATAR_URL_SECONDS = 600;

/**
 * Signed avatar URLs for a set of employees, keyed by employee id.
 *
 * Batched on purpose. The directory shows a page of people at a time and signing one URL per row
 * would be a request per person; `createSignedUrls` does the page in one. Pass only the rows on
 * screen — signing all 242 to show 25 is the same mistake wearing a different hat.
 */
export function useEmployeeAvatars(employeeIds) {
  // Sorted and de-duplicated so the same page produces the same key regardless of row order.
  const ids = [...new Set((employeeIds ?? []).filter(Boolean))].sort();

  return useQuery({
    enabled: ids.length > 0,
    queryKey: ['employee-avatars', ids],
    // Comfortably inside the signature's life, so a cached URL is never a dead one.
    staleTime: (AVATAR_URL_SECONDS - 120) * 1000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('documents')
        .select('employee_id, storage_path, created_at')
        .in('employee_id', ids)
        .eq('category', PHOTO_CATEGORY)
        .not('storage_path', 'is', null)
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Newest photograph per person wins, so re-uploading replaces the avatar without anyone
      // having to delete the old one first.
      const newest = new Map();
      for (const row of rows ?? []) {
        if (!newest.has(row.employee_id)) newest.set(row.employee_id, row.storage_path);
      }
      if (newest.size === 0) return {};

      const { data: signed, error: signError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls([...newest.values()], AVATAR_URL_SECONDS);
      if (signError) throw signError;

      const urlByPath = new Map((signed ?? []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]));
      const byEmployee = {};
      for (const [employeeId, path] of newest) {
        const url = urlByPath.get(path);
        if (url) byEmployee[employeeId] = url;
      }
      return byEmployee;
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      // A photograph is also somebody's avatar, and that is cached under its own key — without
      // this, uploading a new photo leaves the old face on screen until a reload.
      qc.invalidateQueries({ queryKey: ['employee-avatars'] });
    },
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
    mutationFn: async (input) => {
      // A bare row still means "download", which is what every existing caller expects. Pass
      // `{ doc, download: false }` to open it in a tab instead.
      const { doc, download = true } = input?.doc ? input : { doc: input };

      if (!doc?.storage_path) {
        if (doc?.url) return doc.url;
        throw new Error('This record has no file attached.');
      }

      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(
          doc.storage_path,
          SIGNED_URL_SECONDS,
          // Downloads under the name it was uploaded with, not the sanitised path tail. Left off
          // entirely when viewing, or the browser saves the file instead of showing it.
          download ? { download: doc.file_name || true } : undefined,
        );

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      // A photograph is also somebody's avatar, and that is cached under its own key — without
      // this, uploading a new photo leaves the old face on screen until a reload.
      qc.invalidateQueries({ queryKey: ['employee-avatars'] });
    },
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
