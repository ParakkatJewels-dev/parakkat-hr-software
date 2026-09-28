import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, TaskComposer;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ TaskComposer } = await server.ssrLoadModule('/src/components/TaskManagement.jsx'));
});
after(async () => { await server?.close(); });

const person = { id: 'employee-1', full_name: 'Anita Menon', employee_code: 'P001' };
function render(props = {}) {
  return renderToStaticMarkup(React.createElement(TaskComposer, {
    employees: [person], currentEmployeeId: person.id, onClose() {}, onSubmit() {}, ...props,
  }));
}

test('task editor exposes a named form, a focusable heading and associated field labels', () => {
  const html = render();
  const inputs = html.match(/<(?:input|textarea|select)\b[^>]*>/g) ?? [];
  const labels = [...html.matchAll(/<label\b[^>]*for="([^"]+)"/g)].map((match) => match[1]);
  for (const field of inputs) {
    const id = field.match(/\bid="([^"]+)"/)?.[1];
    assert.ok(/aria-label(?:ledby)?=/.test(field) || (id && labels.includes(id)), `Unlabelled field: ${field}`);
  }
  assert.match(html, /<form[^>]*aria-labelledby="[^"]+"/);
  assert.match(html, /<h2[^>]*tabindex="-1"[^>]*>New task<\/h2>/);
  assert.match(html, /Task title.*\(required\)/);
  assert.doesNotMatch(html, /autofocus=/i);
  assert.match(html, /Close New task/);
  assert.match(html, />Cancel<\/button>/);
});

test('editing keeps permission-restricted assignees and the existing task details visible', () => {
  const html = render({ canReassign: false, task: {
    id: 'task-1', title: 'Check closing stock', description: 'Record the totals',
    employee_id: person.id, priority: 'High', due_date: '2026-10-01',
  } });
  assert.match(html, /<h2[^>]*tabindex="-1"[^>]*>Edit task<\/h2>/);
  assert.match(html, /value="Check closing stock"/);
  assert.match(html, /Record the totals/);
  assert.match(html, /value="2026-10-01"/);
  assert.match(html, /Anita Menon/);
  assert.match(html, /You can edit this task but not change who is on it/);
  assert.doesNotMatch(html, /Search task assignees/);
  assert.match(html, />Save changes<\/button>/);
});
