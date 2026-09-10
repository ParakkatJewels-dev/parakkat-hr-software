import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, TaskListRow, Pagination;
before(async () => {
  // Vite transforms the actual JSX; no auth provider or database is involved in these row tests.
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ default: TaskListRow } = await server.ssrLoadModule('/src/components/TaskListRow.jsx'));
  ({ default: Pagination } = await server.ssrLoadModule('/src/components/ui/Pagination.jsx'));
});
after(async () => { await server?.close(); });

const task = {
  id: 'task-1', title: 'Review the branch handover',
  description: 'Read every instruction.\nReference: https://example.com/handover',
  status: 'In Progress', priority: 'High', due_date: '2026-09-09',
  employee_id: 'person-1', assignee: { id: 'person-1', full_name: 'Sample Person' },
};
const actions = {
  today: '2026-09-10', openDetail: null, canUpdate: () => true,
  canEdit: () => true, canManage: () => true, toggleDetail: () => {}, setStatus: () => {},
};
const render = (fields = {}, overrides = {}) => renderToStaticMarkup(
  React.createElement(TaskListRow, { task: { ...task, ...fields }, actions: { ...actions, ...overrides } },
    React.createElement('p', null, 'Task conversation content')),
);

test('the full task content is readable and URLs become safe clickable links', () => {
  const html = render();
  assert.match(html, /Review the branch handover/);
  assert.match(html, /Read every instruction\.\nReference:/);
  assert.match(html, /href="https:\/\/example.com\/handover" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Overdue/);
});

test('detail content mounts only when the row is open', () => {
  assert.doesNotMatch(render(), /Task conversation content/);
  const open = render({}, { openDetail: task.id });
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /Task conversation content/);
  assert.match(open, /Edit task/);
});

test('incomplete subtasks explain completion and do not offer Done', () => {
  const html = render({ checklist: [{ id: 'step-1', completed_at: null, completed_by: null }] });
  assert.match(html, /Open subtasks to complete/);
  assert.match(html, /0\/1 subtasks/);
  assert.doesNotMatch(html, /<option[^>]*>Done<\/option>/);
});

test('completed subtasks count correctly and allow task completion', () => {
  const html = render({ checklist: [{ id: 'step-1', completed_at: '2026-09-10T01:00:00Z', completed_by: 'person-1' }] });
  assert.match(html, /1\/1 subtasks/);
  assert.match(html, /<option[^>]*>Done<\/option>/);
});

test('read-only rows do not offer edits, deletion or a status select', () => {
  const html = render({}, { openDetail: task.id, canUpdate: () => false, canEdit: () => false, canManage: () => false });
  assert.doesNotMatch(html, /<select|Edit task|>Delete</);
  assert.match(html, /disabled="" aria-label="In Progress\. Mark/);
});

test('multiple assignees and activity counts remain accessible', () => {
  const html = render({
    assignees: [
      { employee_id: 'person-1', employee: { id: 'person-1', full_name: 'Sample Person' } },
      { employee_id: 'person-2', employee: { id: 'person-2', full_name: 'Second Person' } },
    ],
  }, { openDetail: task.id, commentCounts: { [task.id]: 3 }, attachmentCounts: { [task.id]: 2 } });
  assert.match(html, /Sample Person, Second Person/);
  assert.match(html, /3 messages\. Open/);
  assert.match(html, /2 attachments\. Open/);
});

test('task pagination can retain the page-size selector when every task fits', () => {
  const props = {
    page: 1, totalPages: 1, pageSize: 25, count: 11, from: 1, to: 11,
    setPage: () => {}, setPageSize: () => {}, noun: 'tasks', sizes: [10, 25, 50, 100],
  };
  assert.equal(renderToStaticMarkup(React.createElement(Pagination, props)), '');
  const html = renderToStaticMarkup(React.createElement(Pagination, { ...props, keepVisible: true }));
  assert.match(html, /Rows per page/);
  assert.match(html, /<option value="10"[^>]*>10<\/option>/);
  assert.match(html, /disabled="" aria-label="Next page"/);
});

function findElement(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

test('the status box cycles in order while unfinished subtasks still guard Done', () => {
  const changes = [], opened = [];
  const handlers = {
    ...actions,
    setStatus: (...args) => changes.push(args),
    toggleDetail: (id) => opened.push(id),
  };
  const clickComplete = (row) => {
    const tree = TaskListRow({ task: row, actions: handlers });
    findElement(tree, (element) => element.props.className === 'work-complete').props.onClick();
  };
  clickComplete({ ...task, status: 'To Do' });
  clickComplete(task);
  clickComplete({ ...task, status: 'Done' });
  clickComplete({ ...task, status: 'Blocked' });
  clickComplete({ ...task, checklist: [{ id: 'unfinished', completed_at: null, completed_by: null }] });
  assert.deepEqual(changes, [[task.id, 'In Progress'], [task.id, 'Done'], [task.id, 'Blocked'], [task.id, 'In Progress']]);
  assert.deepEqual(opened, [task.id]);
});

test('a task with unfinished subtasks can start progress without being marked Done', () => {
  const changes = [];
  const tree = TaskListRow({
    task: { ...task, status: 'To Do', checklist: [{ id: 'unfinished', completed_at: null }] },
    actions: { ...actions, setStatus: (...args) => changes.push(args) },
  });
  findElement(tree, element => element.props.className === 'work-complete').props.onClick();
  assert.deepEqual(changes, [[task.id, 'In Progress']]);
});

test('dropdown and status box continue from the same saved status in either direction', () => {
  let current = { ...task, status: 'To Do' };
  const handlers = { ...actions, setStatus: (id, status) => { assert.equal(id, current.id); current = { ...current, status }; } };
  const tree = () => TaskListRow({ task: current, actions: handlers });
  const select = () => findElement(tree(), element => element.type === 'select');
  const box = () => findElement(tree(), element => element.props.className === 'work-complete');
  select().props.onChange({ target: { value: 'Done' } });
  assert.match(box().props['aria-label'], /Done\. Mark .* as Blocked/);
  box().props.onClick();
  assert.equal(select().props.value, 'Blocked');
  box().props.onClick();
  assert.equal(select().props.value, 'In Progress');
  select().props.onChange({ target: { value: 'To Do' } });
  box().props.onClick();
  assert.equal(select().props.value, 'In Progress');
});

test('both status controls block writes while pending or read-only', () => {
  for (const overrides of [{ busy: true }, { canUpdate: () => false }]) {
    const tree = TaskListRow({ task, actions: { ...actions, ...overrides, setStatus: () => assert.fail('Must not write') } });
    const box = findElement(tree, element => element.props.className === 'work-complete');
    assert.equal(box.props.disabled, true);
    box.props.onClick();
    const select = findElement(tree, element => element.type === 'select');
    if (select) {
      assert.equal(select.props.disabled, true);
      select.props.onChange({ target: { value: 'Blocked' } });
    }
  }
});

test('cancelled tasks do not cycle but can be explicitly reopened in the dropdown', () => {
  const changes = [];
  const tree = TaskListRow({ task: { ...task, status: 'Cancelled' }, actions: { ...actions, setStatus: (...args) => changes.push(args) } });
  const box = findElement(tree, element => element.props.className === 'work-complete');
  assert.equal(box.props.disabled, true);
  box.props.onClick();
  assert.deepEqual(changes, []);
  findElement(tree, element => element.type === 'select').props.onChange({ target: { value: 'In Progress' } });
  assert.deepEqual(changes, [[task.id, 'In Progress']]);
});

test('completion guard is shared with the dropdown and never closes already-open subtasks', () => {
  const tree = TaskListRow({
    task: { ...task, checklist: [{ id: 'unfinished' }] },
    actions: { ...actions, openDetail: task.id, setStatus: () => assert.fail('Must not complete'), toggleDetail: () => assert.fail('Must stay open') },
  });
  findElement(tree, element => element.props.className === 'work-complete').props.onClick();
  findElement(tree, element => element.type === 'select').props.onChange({ target: { value: 'Done' } });
});

test('each status exposes a label and consistent styling hooks on the row and dropdown', () => {
  for (const status of ['To Do', 'In Progress', 'Done', 'Blocked', 'Cancelled']) {
    const html = render({ status });
    const token = status.toLowerCase().replaceAll(' ', '-');
    assert.equal((html.match(new RegExp(`data-status="${token}"`, 'g')) ?? []).length, 2);
    assert.match(html, new RegExp(`aria-label="${status}\\.`));
    assert.match(html, new RegExp(`<option selected="">${status}</option>`));
    assert.match(html, /work-status-icon/);
  }
});

test('page-size changes reset to the first page', () => {
  const sizes = [], pages = [];
  const tree = Pagination({
    page: 2, totalPages: 3, pageSize: 10, count: 23, from: 11, to: 20,
    setPage: (page) => pages.push(page), setPageSize: (size) => sizes.push(size),
  });
  findElement(tree, (element) => element.type === 'select').props.onChange({ target: { value: '25' } });
  assert.deepEqual(sizes, [25]);
  assert.deepEqual(pages, [1]);
});
