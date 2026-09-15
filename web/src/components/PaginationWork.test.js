import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../lib/dates.js';

let server, AuthContext, TaskDetail, TaskRoutine, Messages, Notifications;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: TaskDetail } = await server.ssrLoadModule('/src/components/TaskDetail.jsx'));
  ({ default: TaskRoutine } = await server.ssrLoadModule('/src/components/TaskRoutine.jsx'));
  ({ default: Messages } = await server.ssrLoadModule('/src/components/Messages.jsx'));
  ({ default: Notifications } = await server.ssrLoadModule('/src/components/Notifications.jsx'));
});
after(async () => { await server?.close(); });

function render(Component, seeds = [], props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } });
  seeds.forEach(([key, data]) => client.setQueryData(key, data));
  const auth = { user: { id: 'user-1' }, employee: { id: 'employee-1', full_name: 'Employee One' },
    isSuperAdmin: true, assignments: [], permissions: [], rank: 1000 };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, null, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

test('task detail bounds subtasks, root comment threads and files while preserving full totals and reply groups', () => {
  const task = { id: 'task-1' };
  const checklist = Array.from({ length: 35 }, (_, i) => ({ id: `step-${i}`, title: `Subtask ${i}`, position: i,
    completed_at: i < 15 ? '2026-01-01T00:00:00Z' : null, completed_by: i < 15 ? 'employee-1' : null }));
  const comments = Array.from({ length: 35 }, (_, i) => [
    { id: `comment-${i}`, parent_id: null, body: `Root comment ${i}`, created_at: '2026-01-01T00:00:00Z' },
    { id: `reply-${i}`, parent_id: `comment-${i}`, body: `Nested reply ${i}`, created_at: '2026-01-01T01:00:00Z' },
  ]).flat();
  const attachments = Array.from({ length: 35 }, (_, i) => ({ id: `attachment-${i}`, kind: 'link', label: `Shared link ${i}`, url: 'https://example.test' }));
  const html = render(TaskDetail, [[['task-checklist', task.id], checklist], [['task-comments', task.id], comments],
    [['task-attachments', task.id], attachments]], { task, open: true });
  assert.equal((html.match(/class="checklist-row /g) ?? []).length, 10);
  assert.match(html, /15 of 35/);
  assert.equal((html.match(/Root comment \d+/g) ?? []).length, 10);
  assert.equal((html.match(/View 1 reply/g) ?? []).length, 10);
  assert.doesNotMatch(html, /Nested reply/);
  assert.equal((html.match(/Shared link \d+/g) ?? []).length, 10);
  for (const label of ['of 35 subtasks', 'of 35 comment threads', 'of 35 shared files']) assert.ok(html.includes(label), label);
});

test('named routine pages jobs without changing full-routine progress or including another employee', () => {
  const items = ['employee-1', 'employee-2'].flatMap(employeeId => Array.from({ length: 35 }, (_, i) => ({
    id: `${employeeId}-duty-${i}`, employee_id: employeeId, title: `Duty ${employeeId} ${i}`, sort_order: i,
    routine_id: `routine-${employeeId}`, routine_name: `Opening ${employeeId}`, frequency: 'daily', done: i < 15, can_tick: true,
    employee: { full_name: employeeId, employee_code: employeeId },
  })));
  const html = render(TaskRoutine, [[['routine-day', istToday(), 'employee-1'], items]]);
  assert.equal((html.match(/aria-label="Untick Duty/g) ?? []).length, 10);
  assert.match(html, /15\/35/);
  assert.match(html, /of 35 jobs/);
  assert.doesNotMatch(html, /Duty employee-2/);
});

test('the inbox shows 25 conversations with every remaining conversation reachable', () => {
  const conversations = Array.from({ length: 65 }, (_, i) => ({ id: `chat-${String(i).padStart(3, '0')}`, kind: 'group',
    title: `Conversation ${i}`, members: [{ employee_id: 'employee-1' }], last_message_at: '2026-01-01T00:00:00Z' }));
  const html = render(Messages, [[['conversations'], { conversations }]]);
  assert.equal((html.match(/class="conversation-row-container /g) ?? []).length, 25);
  assert.match(html, /of 65 conversations/);
  assert.match(html, /Page 1 of 3/);
  assert.doesNotMatch(html, />Conversation 64</);
});

test('notification history uses server totals beyond the former 40-row preview limit', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `notification-${i}`, title: `History notification ${i}`,
    created_at: '2026-01-01T00:00:00Z', read_at: null }));
  const html = render(Notifications, [[['notifications', 'history', 1, 25], { rows, count: 675, unreadCount: 350 }]]);
  assert.match(html, /350 unread/);
  assert.match(html, /of 675 notifications/);
  assert.match(html, /Page 1 of 27/);
  assert.doesNotMatch(html, /Latest 40/);
});
