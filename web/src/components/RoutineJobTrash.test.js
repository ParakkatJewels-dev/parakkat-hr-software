import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

// Run the actual form's delete/restore handlers and validate the saved API payload.
const sourceUrl = new URL('./RoutineForm.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: 'export const useState = value => globalThis.routineTrashForm.state(value); export const useRef = value => globalThis.routineTrashForm.state({current:value})[0];',
  'lucide-react': 'export const ArrowDown="icon", ArrowUp="icon", CheckSquare="icon", Plus="icon", Trash2="icon", Undo2="icon";',
  '../lib/routineSchedule': `export { routineEditStartDate } from ${JSON.stringify(new URL('../lib/routineSchedule.js', import.meta.url).href)};`,
  './ui/FormSection': 'export default "routine-form-section";',
  './ui/Btn': 'export const btnClass = () => "button";',
  './RoutinePeoplePicker': 'export default "routine-people";',
  './ui/QueryError': 'export default "routine-query-error";',
  './ui/Skeleton': 'export const SkeletonRows="routine-skeleton";',
  './ui/Pagination': 'export default "routine-pagination"; export const usePagination = rows => ({slice:rows,count:rows.length});',
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourceUrl.href && stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === sourceUrl.href) return { format: 'module', source: code, shortCircuit: true };
    return next(url, context);
  },
});
const { default: RoutineForm } = await import(sourceUrl.href);
after(() => { hooks.deregister(); delete globalThis.routineTrashForm; });
const today = '2026-09-28';
const active = [{ id: 'kept', title: 'Keep', detail: 'Keep instructions' }, { id: 'deleted', title: 'Stock check', detail: 'Count each shelf' }];
const archived = { id: 'archived', title: 'Archived check', detail: 'Preserved instructions', is_active: false, deleted_at: `${today}T01:00:00Z` };
function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}
function mount(jobs = [...active], overrides = {}) {
  const slots = []; let cursor = 0;
  const writes = [];
  const props = { today, initial: { id: 'routine', employee_id: 'employee', title: 'Opening', frequency: 'daily', start_date: today, jobs },
    onSave: async payload => { writes.push(payload); }, onClose() {}, ...overrides };
  const harness = { state(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  } };
  const render = () => { cursor = 0; globalThis.routineTrashForm = harness; return RoutineForm(props); };
  const button = label => find(render(), element => element.type === 'button' && element.props['aria-label'] === label);
  return { writes, props, render, button,
    click(label) { const control = button(label); assert.ok(control, `Missing ${label}`); assert.ok(!control.props.disabled, `${label} is disabled`); control.props.onClick(); },
    async submit() { await render().props.onSubmit({ preventDefault() {} }); },
  };
}

test('deleting a saved job removes only that ID from the save and permits undo before saving', async () => {
  const form = mount();
  form.click('Delete job 2');
  assert.ok(form.button('Restore job Stock check'));
  await form.submit();
  assert.deepEqual(form.writes[0].jobs, [{ id: 'kept', title: 'Keep', detail: 'Keep instructions', sort_order: 0 }]);
  form.click('Restore job Stock check');
  assert.equal(form.button('Restore job Stock check'), null);
  await form.submit();
  assert.deepEqual(form.writes[1].jobs, active.map((job, sort_order) => ({ ...job, sort_order })));
});

test('saved deleted jobs retain their IDs and instructions when restored for the selected date', async () => {
  const form = mount([active[0], archived]);
  form.click('Restore job Archived check');
  const date = find(form.render(), element => element.type === 'input' && element.props.type === 'date' && element.props.required);
  date.props.onChange({ target: { value: '2026-09-29' } });
  await form.submit();
  assert.deepEqual(form.writes[0].jobs[1], { id: archived.id, title: archived.title, detail: archived.detail, sort_order: 1 });
  assert.equal(form.writes[0].schedule.start_date, '2026-09-29');
  assert.equal(form.writes[0].id, 'routine');
});

test('restoring then deleting a job again keeps one recoverable entry', async () => {
  const form = mount([active[0], archived]);
  form.click('Restore job Archived check');
  form.click('Delete job 2');
  assert.ok(form.button('Restore job Archived check'));
  await form.submit();
  assert.equal(form.writes[0].jobs.length, 1);
  form.click('Restore job Archived check');
  await form.submit();
  assert.equal(form.writes[1].jobs.filter(job => job.id === archived.id).length, 1);
});

test('an empty unsaved row is removed without filling deleted jobs with blank entries', async () => {
  const form = mount([active[0]], { initial: { id: 'routine', employee_id: 'employee', title: 'Opening', frequency: 'daily', start_date: today, jobs: [active[0]], addJob: true } });
  form.click('Remove job 2');
  assert.equal(find(form.render(), element => element.props['aria-label'] === 'Deleted jobs'), null);
  await form.submit();
  assert.equal(form.writes[0].jobs.length, 1);
});

test('legacy inactive jobs are history rather than recoverable deletions', () => {
  const form = mount([active[0], { id: 'legacy', title: 'Legacy retired job', is_active: false }]);
  assert.equal(form.button('Restore job Legacy retired job'), null);
  assert.equal(find(form.render(), element => element.props['aria-label'] === 'Deleted jobs'), null);
});

test('job limits prevent removing the entire schedule or restoring past 100 active jobs', () => {
  const single = mount([active[0], archived]);
  assert.equal(single.button('Delete job 1').props.disabled, true);
  const full = mount([...Array.from({ length: 100 }, (_, index) => ({ id: `job-${index}`, title: `Job ${index}` })), archived]);
  assert.equal(full.button('Restore job Archived check').props.disabled, true);
  full.click('Delete job 100');
  assert.equal(full.button('Restore job Archived check').props.disabled, false);
});

test('failed save retains the restored job and pending saves block repeated submission', async () => {
  const form = mount([active[0], archived], { onSave: async () => { throw new Error('Failed to fetch'); } });
  form.click('Restore job Archived check');
  await form.submit();
  assert.equal(form.button('Restore job Archived check'), null);
  assert.ok(form.button('Delete job 2'));
  form.props.busy = true;
  assert.equal(find(form.render(), element => element.type === 'fieldset').props.disabled, true);
  form.props.onSave = async payload => form.writes.push(payload);
  await form.submit();
  assert.deepEqual(form.writes, []);
});
