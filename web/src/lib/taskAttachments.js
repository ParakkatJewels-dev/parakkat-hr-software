// Shared by the task composer and the existing task attachment controls.
export const TASK_FILE_BUCKET = 'task-files';
export const MAX_TASK_FILE_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', csv: 'text/csv', txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export const ACCEPTED_TASK_FILES = Object.keys(FILE_TYPES).map((extension) => `.${extension}`).join(',');

export function normaliseTaskLink(url) {
  const value = String(url ?? '').trim();
  if (!value) throw new Error('Paste a link first.');
  // Accept a pasted domain, but never turn a script/data/file URL into an attachment.
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)
      && !/^[\w.-]+:\d+(?:\/|$)/.test(value)) {
    throw new Error('Use a valid http:// or https:// link.');
  }
  try {
    if (/^\/(?!\/)/.test(value)) throw new Error();
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : value.startsWith('//') ? `https:${value}` : `https://${value}`);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error();
    return parsed.href;
  } catch {
    throw new Error('Use a valid http:// or https:// link.');
  }
}

export function taskFileContentType(file) {
  if (!file) throw new Error('Choose a file first.');
  if (file.size > MAX_TASK_FILE_BYTES) {
    throw new Error(`“${file.name}” is ${(file.size / 1048576).toFixed(1)} MB. The limit is 10 MB per file.`);
  }
  const extension = String(file.name ?? '').split('.').at(-1).toLowerCase();
  const contentType = FILE_TYPES[extension];
  if (!contentType) throw new Error('Choose a PDF, image (JPG, PNG, WebP, HEIC), CSV, TXT, XLSX or DOCX file.');
  // Phones and desktop browsers sometimes report an empty or generic MIME type for Office files.
  return contentType;
}

/** Validate every draft before creating its task, so bad input cannot leave a partial task. */
export function prepareTaskAttachments(draft = {}) {
  const files = (draft.files ?? []).map((file) => ({ kind: 'file', file, contentType: taskFileContentType(file) }));
  const links = (draft.links ?? []).filter((link) => link.url?.trim() || link.label?.trim()).map((link) => ({
    kind: 'link', url: normaliseTaskLink(link.url), label: link.label?.trim() || null,
  }));
  return [...files, ...links];
}

export async function addTaskLink(client, { taskId, url, label, employeeId, userId }) {
  const { error } = await client.from('task_attachments').insert({
    task_id: taskId, kind: 'link', url: normaliseTaskLink(url), label: label?.trim() || null,
    added_by: employeeId ?? null, added_user: userId,
  });
  if (error) throw error;
}

export async function addTaskFile(client, { taskId, file, employeeId, userId }) {
  const contentType = taskFileContentType(file);
  const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-80);
  const path = `${taskId}/${crypto.randomUUID()}-${safe}`;
  const { error: upload } = await client.storage.from(TASK_FILE_BUCKET)
    .upload(path, file, { contentType, upsert: false });
  if (upload) throw upload;
  const { error } = await client.from('task_attachments').insert({
    task_id: taskId, kind: 'file', storage_path: path, label: file.name,
    size_bytes: file.size, content_type: contentType,
    added_by: employeeId ?? null, added_user: userId,
  });
  if (error) {
    // Best-effort cleanup must not hide the original attachment failure.
    try { await client.storage.from(TASK_FILE_BUCKET).remove([path]); } catch { /* preserve original error */ }
    throw error;
  }
}
