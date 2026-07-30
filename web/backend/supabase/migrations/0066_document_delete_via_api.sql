-- The file cannot be deleted from SQL, so stop trying to.
--
-- 0064 added an AFTER DELETE trigger on public.documents that removed the matching row from
-- storage.objects, so the file would go with the record. Supabase does not permit that:
--
--   Direct deletion from storage tables is not allowed. Use the Storage API instead.
--
-- There is a guard trigger on storage.objects that raises. Because ours ran AFTER DELETE inside the
-- same transaction, the raise propagated and rolled the whole thing back — meaning the trigger
-- written to tidy up after a delete would instead have made every document delete fail. Nobody
-- could have removed a document at all.
--
-- Caught by testing the cascade rather than reading it: the insert I used to stand in for an upload
-- was accepted, and only the delete refused.
--
-- SO THE ORDER MOVES TO THE CLIENT, AND THE ORDER IS THE FILE FIRST.
-- Deleting the object before the row means the two failure cases land on the better side:
--
--   object delete fails            -> stop, nothing is removed, the person can retry
--   object gone, row delete fails  -> a record whose file is missing, which is VISIBLE: opening it
--                                     reports "the file is not in storage" and deleting it again
--                                     finishes the job
--
-- The reverse order would leave a private object with no row, and no row means no policy resolves
-- it, and nothing that cannot be seen ever gets cleaned up. A visible broken record beats an
-- invisible orphaned file.

drop trigger if exists trg_documents_delete_object on public.documents;
drop function if exists public.delete_document_object();

comment on table public.documents is
  'Document records. A row either carries storage_path (a file in the private `documents` bucket at '
  '<document_id>/<filename>) or url (something held elsewhere) — the documents_has_content_check '
  'constraint requires one. Deleting a stored document means deleting the object through the '
  'Storage API FIRST and then the row; SQL cannot remove storage objects. See migration 0066.';
