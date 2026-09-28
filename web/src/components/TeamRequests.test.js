import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, TeamRequests;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: TeamRequests } = await server.ssrLoadModule('/src/components/TeamRequests.jsx'));
});
after(async () => { await server?.close(); });

const request = (id, outgoing, changes = {}) => ({
  id, status: 'Accepted', title: `Request ${id}`, created_at: '2026-09-01T09:00:00Z',
  from_department_id: outgoing ? 'mine' : 'other', to_department_id: outgoing ? 'other' : 'mine',
  assignee: { id: 'employee-1', full_name: 'Assigned Person' },
  task: { id: `task-${id}`, status: 'In Progress', deleted_at: '2026-09-28T09:00:00Z' },
  ...changes,
});

function render(rows) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } });
  client.setQueryData(['help-requests'], rows);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(TeamRequests, { myDepartments: [{ id: 'mine' }] })));
  } finally { client.clear(); }
}

test('both sides of an accepted request show deleted task state instead of active work', () => {
  const html = render([request('incoming', false), request('outgoing', true)]);
  assert.equal((html.match(/>Task deleted</g) ?? []).length, 2);
  assert.doesNotMatch(html, /is on it|In Progress|now /);
  assert.match(html, /Given to/);
});

test('restored tasks show their current status again without changing request history', () => {
  const html = render([request('incoming', false), request('outgoing', true)].map(row => ({
    ...row, task: { ...row.task, deleted_at: null },
  })));
  assert.doesNotMatch(html, /Task deleted/);
  assert.equal((html.match(/In Progress/g) ?? []).length, 2);
  assert.match(html, /is on it/);
  assert.equal((html.match(/>Accepted</g) ?? []).length, 2);
});

test('task deletion remains visible when the assigned employee is outside directory access', () => {
  const html = render([request('incoming', false, { assignee: null }), request('outgoing', true, { assignee: null })]);
  assert.equal((html.match(/>Task deleted</g) ?? []).length, 2);
  assert.doesNotMatch(html, /is on it|In Progress/);
});

test('legacy embedded tasks keep their normal status before task recovery migration', () => {
  const html = render([request('outgoing', true, { task: { id: 'task-legacy', status: 'Done' } })]);
  assert.doesNotMatch(html, /Task deleted/);
  assert.match(html, /Done/);
});
