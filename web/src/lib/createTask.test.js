import test from 'node:test';
import assert from 'node:assert/strict';
import { saveTaskDraft } from './createTask.js';
import { MAX_TASK_FILE_BYTES, normaliseTaskLink, prepareTaskAttachments } from './taskAttachments.js';

function database({ fail } = {}) {
  const writes = [], uploads = [], removals = [];
  const client = {
    from(table) {
      return { insert(value) {
        writes.push({ table, value });
        const result = () => ({ data: table === 'tasks' ? { id: 'created-task' } : null, error: fail?.(table, value) });
        const query = { select: () => query, single: async () => result(), then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject) };
        return query;
      } };
    },
    storage: { from(bucket) {
      assert.equal(bucket, 'task-files');
      return {
        async upload(path, file, options) {
          uploads.push({ path, file, options });
          return { error: fail?.('upload', file) };
        },
        async remove(paths) { removals.push(...paths); return { error: null }; },
      };
    } },
  };
  return { client, writes, uploads, removals };
}
const author = { employeeId: 'creator', userId: 'auth-user' };
const file = (name = 'instructions.pdf', size = 120) => ({ name, size, type: '' });
const draft = {
  title: 'Inspect the delivery', employee_id: 'primary', assigned_by: 'creator',
  assigneeIds: ['primary', 'secondary', 'secondary'], checklist: [' Check carton ', ''],
  attachments: { files: [file()], links: [{ url: 'drive.google.com/spec', label: 'Specification' }] },
};

test('creation saves multiple assignees, subtasks, files and links against one task with the authenticated author', async () => {
  const db = database();
  assert.deepEqual(await saveTaskDraft(db.client, draft, author, {}), { id: 'created-task' });
  assert.deepEqual(db.writes.map(({ table }) => table), ['tasks', 'task_assignees', 'task_checklist_items', 'task_attachments', 'task_attachments']);
  assert.deepEqual(db.writes[0].value, { title: draft.title, employee_id: 'primary', assigned_by: 'creator', status: 'To Do' });
  assert.deepEqual(db.writes[1].value.map((row) => row.employee_id), ['primary', 'secondary']);
  assert.deepEqual(db.writes[2].value, [{ task_id: 'created-task', title: 'Check carton', position: 0, created_by: 'creator' }]);
  assert.match(db.uploads[0].path, /^created-task\/[\w-]+-instructions.pdf$/);
  assert.equal(db.uploads[0].options.contentType, 'application/pdf');
  const attachments = db.writes.filter(({ table }) => table === 'task_attachments').map(({ value }) => value);
  for (const row of attachments) {
    assert.equal(row.task_id, 'created-task'); assert.equal(row.added_by, 'creator'); assert.equal(row.added_user, 'auth-user');
  }
  assert.equal(attachments[1].url, 'https://drive.google.com/spec');
});

test('retry after an attachment failure resumes the same task and does not repeat saved files or earlier writes', async () => {
  let refuse = true;
  const db = database({ fail: (table, row) => table === 'task_attachments' && row.kind === 'link' && refuse ? { message: 'Link unavailable' } : null });
  const progress = {};
  await assert.rejects(saveTaskDraft(db.client, draft, author, progress), (error) => {
    assert.equal(error.createdTaskId, 'created-task');
    assert.match(error.message, /task was created.*attachments.*Retry saving/);
    return true;
  });
  refuse = false;
  await saveTaskDraft(db.client, { ...draft, title: 'Unsaved edit' }, author, progress);
  for (const table of ['tasks', 'task_assignees', 'task_checklist_items']) assert.equal(db.writes.filter((row) => row.table === table).length, 1);
  assert.equal(db.uploads.length, 1);
  assert.equal(db.writes.filter((row) => row.table === 'task_attachments' && row.value.kind === 'file').length, 1);
  assert.equal(progress.attachmentIndex, 2);
});

test('retry after upload failure keeps the task and all assignees, then completes the pending upload', async () => {
  let refuse = true;
  const db = database({ fail: (table) => table === 'upload' && refuse ? { message: 'NetworkError' } : null });
  const progress = {};
  await assert.rejects(saveTaskDraft(db.client, draft, author, progress), /task was created.*attachments/);
  refuse = false;
  await saveTaskDraft(db.client, draft, author, progress);
  assert.equal(db.writes.filter((row) => row.table === 'tasks').length, 1);
  assert.equal(db.writes.filter((row) => row.table === 'task_assignees').length, 1);
  assert.equal(db.writes.filter((row) => row.table === 'task_attachments').length, 2);
});

test('assignee and checklist failures can also resume without creating another task', async () => {
  for (const phase of ['task_assignees', 'task_checklist_items']) {
    let refuse = true;
    const db = database({ fail: (table) => table === phase && refuse ? { message: 'Permission denied' } : null });
    const progress = {};
    await assert.rejects(saveTaskDraft(db.client, draft, author, progress), (error) => error.createdTaskId === 'created-task');
    assert.equal(db.uploads.length, 0);
    refuse = false;
    await saveTaskDraft(db.client, draft, author, progress);
    assert.equal(db.writes.filter((row) => row.table === 'tasks').length, 1);
    assert.equal(db.uploads.length, 1);
  }
});

test('invalid attachments are rejected before any task is inserted', async () => {
  for (const attachments of [
    { files: [file('too-big.pdf', MAX_TASK_FILE_BYTES + 1)] },
    { files: [file('unsafe.exe')] },
    { links: [{ url: 'javascript:alert(1)' }] },
    { links: [{ url: 'https://bad host.com' }] },
    { links: [{ url: '', label: 'Missing URL' }] },
  ]) {
    const db = database();
    await assert.rejects(saveTaskDraft(db.client, { ...draft, attachments }, author, {}));
    assert.equal(db.writes.length, 0);
  }
});

test('failed file metadata attempts storage cleanup and keeps the original failure', async () => {
  const db = database({ fail: (table, row) => table === 'task_attachments' && row.kind === 'file' ? { message: 'Attachment rejected' } : null });
  await assert.rejects(saveTaskDraft(db.client, draft, author, {}), /Attachment rejected/);
  assert.deepEqual(db.removals, [db.uploads[0].path]);
});

test('task creation preserves single-assignee fallback while an assignee/checklist migration is pending', async () => {
  const db = database({ fail: (table) => ['task_assignees', 'task_checklist_items'].includes(table) ? { code: '42P01' } : null });
  await saveTaskDraft(db.client, draft, { userId: 'admin-user' }, {});
  assert.equal(db.writes.filter((row) => row.table === 'task_attachments').length, 2);
  assert.equal(db.writes.at(-1).value.added_by, null);
});

test('task insert refusals leave no saved progress or attachment writes', async () => {
  const progress = {};
  const db = database({ fail: (table) => table === 'tasks' ? { message: 'Access denied' } : null });
  await assert.rejects(saveTaskDraft(db.client, draft, author, progress), (error) => !error.createdTaskId);
  assert.deepEqual(progress, {});
  assert.equal(db.writes.length, 1); assert.equal(db.uploads.length, 0);
});

test('links support pasted domains and http(s), and reject other protocols and relative paths', () => {
  assert.equal(normaliseTaskLink(' example.com/folder '), 'https://example.com/folder');
  assert.equal(normaliseTaskLink('http://example.com/a'), 'http://example.com/a');
  assert.equal(normaliseTaskLink('//example.com/a'), 'https://example.com/a');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/a', '/relative', 'https://user:pass@example.com']) {
    assert.throws(() => normaliseTaskLink(url), /valid http/);
  }
  assert.deepEqual(prepareTaskAttachments({ links: [{ url: ' ', label: '' }] }), []);
});
