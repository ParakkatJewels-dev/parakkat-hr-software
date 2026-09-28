import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, DeletedTasks, DeletedTaskList, DeletedTaskRow, TaskManagement;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: DeletedTasks, DeletedTaskList, DeletedTaskRow } = await server.ssrLoadModule('/src/components/DeletedTasks.jsx'));
  ({ default: TaskManagement } = await server.ssrLoadModule('/src/components/TaskManagement.jsx'));
});
after(async () => { await server?.close(); });

const task = (id, changes = {}) => ({
  id: `task-${id}`, title: `Deleted task ${id}`, description: 'Keep the original instructions',
  employee_id: 'self', assigned_by: 'self', parent_task_id: null,
  assignee: { id: 'self', full_name: 'Employee One' },
  status: 'In Progress', due_date: '2026-09-20', deleted_at: '2026-09-20T18:31:00Z',
  can_restore: true, ...changes,
});
const markup = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

function render(Component, { rows = [], props = {}, auth = {} } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } });
  client.setQueryData(['tasks'], []);
  client.setQueryData(['deleted-tasks'], rows);
  const context = { user: { id: 'user-1' }, employee: { id: 'self' }, isSuperAdmin: false, assignments: [],
    permissions: [{ permission: 'task.read', scope_type: 'self' }], ...auth };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: context },
        React.createElement(MemoryRouter, { initialEntries: ['/tasks/deleted'] }, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

function findElement(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

test('deleted tasks retain useful recovery context and page a large collection', () => {
  const html = markup(DeletedTaskList, { rows: Array.from({ length: 24 }, (_, index) => task(index)), onRestore() {} });
  assert.equal((html.match(/aria-label="Restore Deleted task /g) ?? []).length, 10);
  assert.match(html, /Showing 1–10 of 24 deleted tasks/);
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /Search deleted tasks/);
  assert.match(html, /Saved status: In Progress/);
  assert.match(html, /Employee One/);
  assert.match(html, /Due 2026-09-20/);
  assert.match(html, /21 Sept 2026/);
  assert.doesNotMatch(html, />Deleted task 23</);
});

test('restore controls require explicit server permission as well as the selected view permission', () => {
  for (const changes of [{ can_restore: false }, { can_restore: undefined }]) {
    assert.doesNotMatch(markup(DeletedTaskRow, { task: task(1, changes), canRestore: true, onRestore() {} }), /Restore task/);
  }
  assert.doesNotMatch(markup(DeletedTaskRow, { task: task(1), onRestore() {} }), /Restore task/);
  const rows = [task(1), task(2, { can_restore: false }), task(3)];
  const html = render(DeletedTasks, { rows, props: { canRestore: (row) => row.id !== 'task-3' } });
  assert.match(html, />Deleted task 1</);
  assert.doesNotMatch(html, />Deleted task [23]</);
});

test('employees reach Deleted tasks and recover only their self-created root tasks', () => {
  const html = render(TaskManagement, { rows: [task(1), task(2, { assigned_by: 'manager' }),
    task(3, { employee_id: 'other' }), task(4, { parent_task_id: 'parent' })] });
  assert.match(html, /aria-current="page"[^>]*>.*?Deleted tasks/s);
  assert.match(html, /aria-label="Restore Deleted task 1"/);
  assert.doesNotMatch(html, /aria-label="Restore Deleted task [234]"/);
});

test('team restore access is limited to the task management scope', () => {
  const html = render(TaskManagement, {
    auth: { employee: null, permissions: [
      { permission: 'task.read', scope_type: 'branch', scope_id: 'managed-branch' },
      { permission: 'task.manage', scope_type: 'branch', scope_id: 'managed-branch' },
    ] }, rows: [task(1, { branch_id: 'managed-branch' }), task(2, { branch_id: 'other-branch' })],
  });
  assert.match(html, /aria-label="Restore Deleted task 1"/);
  assert.doesNotMatch(html, /aria-label="Restore Deleted task 2"/);
  const readOnly = render(TaskManagement, { auth: { employee: null,
    permissions: [{ permission: 'task.read', scope_type: 'global' }] }, rows: [task(1)] });
  assert.doesNotMatch(readOnly, /Deleted tasks|Restore task/);
});

test('restore writes the chosen task only and blocks duplicate actions while pending', () => {
  const restored = [];
  const row = task(1, { deleted_task_count: 3 });
  for (const busy of [false, true]) {
    const tree = DeletedTaskRow({ task: row, canRestore: true, busy, restoring: busy, onRestore: (value) => restored.push(value.id) });
    const button = findElement(tree, (element) => element.type === 'button');
    assert.equal(button.props.disabled, busy);
    button.props.onClick();
  }
  assert.deepEqual(restored, [row.id]);
  const html = markup(DeletedTaskRow, { task: row, canRestore: true, busy: true, restoring: true });
  assert.match(html, /Restoring…/);
  assert.match(html, /Restores 3 tasks together/);
});

test('failed loads offer retry without claiming deleted tasks are empty', () => {
  const html = markup(DeletedTaskList, { loadError: new Error('Connection unavailable'), onRetry() {} });
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load deleted tasks/);
  assert.match(html, /Connection unavailable/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /No deleted tasks to restore/);
});

test('restore errors retain the deleted row and show retryable recovery feedback', () => {
  const html = markup(DeletedTaskList, { rows: [task(1)], restoreError: new Error('Access changed'), onRestore() {} });
  assert.match(html, /role="alert"[^>]*>Access changed/);
  assert.match(html, /aria-label="Restore Deleted task 1"/);
  assert.doesNotMatch(html, /disabled="" aria-label="Restore/);
  const success = markup(DeletedTaskList, { rows: [], notice: 'The task was restored with its saved status.' });
  assert.match(success, /role="status"[^>]*>The task was restored/);
  assert.match(success, /No deleted tasks to restore/);
});
