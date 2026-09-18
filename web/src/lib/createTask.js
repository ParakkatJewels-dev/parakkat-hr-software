import { addTaskFile, addTaskLink, prepareTaskAttachments } from './taskAttachments.js';
import { isMissingSchema } from './pendingMigration.js';
import { humanDbError } from './dbErrors.js';

/**
 * A composer owns one progress object until it succeeds or is explicitly closed. Once the task
 * exists, retry resumes its remaining writes; already saved files and links are not added twice.
 */
export async function saveTaskDraft(client, draft, author, progress) {
  let phase = 'task';
  try {
    if (!progress.taskId) {
      const { assigneeIds = [], checklist = [], attachments, ...payload } = draft;
      const prepared = prepareTaskAttachments(attachments);
      const people = [...new Set([payload.employee_id, ...(assigneeIds ?? [])])].filter(Boolean);
      const steps = (checklist ?? []).map((title) => String(title ?? '').trim()).filter(Boolean).slice(0, 50);
      const { data, error } = await client.from('tasks').insert({ ...payload, status: 'To Do' }).select('id').single();
      if (error) throw error;
      Object.assign(progress, {
        taskId: data.id, payload, author: { ...author },
        assigneeIds: people, checklist: steps,
        attachments: prepared, attachmentIndex: 0,
      });
    }

    // Use the original snapshot on a retry: its task row has already been committed.
    phase = 'assignees';
    if (!progress.assigneesSaved) {
      const { error } = await client.from('task_assignees').insert(progress.assigneeIds.map((employeeId) => ({
        task_id: progress.taskId, employee_id: employeeId, added_by: progress.payload.assigned_by ?? null,
      })));
      if (error && !isMissingSchema(error)) throw error;
      progress.assigneesSaved = true;
    }

    phase = 'subtasks';
    if (!progress.checklistSaved && progress.checklist.length) {
      const { error } = await client.from('task_checklist_items').insert(progress.checklist.map((title, position) => ({
        task_id: progress.taskId, title: title.slice(0, 200), position,
        created_by: progress.payload.assigned_by ?? null,
      })));
      if (error && !isMissingSchema(error)) throw error;
    }
    progress.checklistSaved = true;

    phase = 'attachments';
    while (progress.attachmentIndex < progress.attachments.length) {
      const attachment = progress.attachments[progress.attachmentIndex];
      const params = { ...attachment, ...progress.author, taskId: progress.taskId };
      if (attachment.kind === 'file') await addTaskFile(client, params);
      else await addTaskLink(client, params);
      progress.attachmentIndex += 1;
    }
    return { id: progress.taskId };
  } catch (cause) {
    if (!progress.taskId) throw cause;
    const error = new Error(`The task was created, but its ${phase} could not all be saved. ${humanDbError(cause)} Retry saving to finish this same task.`);
    error.createdTaskId = progress.taskId;
    error.cause = cause;
    throw error;
  }
}
