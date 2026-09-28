import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

// Exercise the actual restore form and payload, with only UI primitives and React state stubbed.
const sourceUrl = new URL('./RestoreRoutineDialog.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: 'export const useState = value => globalThis.restoreRoutineForm.state(value); export const useRef = value => globalThis.restoreRoutineForm.state({current:value})[0];',
  'lucide-react': 'export const Undo2="icon", RotateCcw="icon";',
  '../lib/routineSchedule': `export { routineEditStartDate } from ${JSON.stringify(new URL('../lib/routineSchedule.js', import.meta.url).href)};`,
  '../lib/routines': `export { routineScheduleLabel } from ${JSON.stringify(new URL('../lib/routines.js', import.meta.url).href)};`,
  './ui/FormSection': 'export default "restore-form-section";',
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
const { default: RestoreRoutineDialog } = await import(sourceUrl.href);
after(() => { hooks.deregister(); delete globalThis.restoreRoutineForm; });

const today = '2026-09-28';
const activeJobs = [{ id: 'job-1', title: 'Count stock', detail: 'Every shelf', sort_order: 0 },
  { id: 'job-2', title: 'Prepare report', detail: null, sort_order: 1 }];
const routine = { id: 'routine-id', employee_id: 'original-assignee', employee: { full_name: 'Original assignee' },
  title: 'Opening checks', detail: 'Saved instructions', frequency: 'daily', start_date: '2026-09-20', retired_on: '2026-09-25', can_manage: true,
  end_date: null, jobs: [...activeJobs, { id: 'deleted-job', title: 'Deleted check', is_active: false, deleted_at: `${today}T00:00:00Z` }] };

function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function mount(changes = {}, overrides = {}) {
  const slots = []; let cursor = 0;
  const writes = [];
  const props = { routine: { ...routine, ...changes }, today, onRestore: async payload => writes.push(payload), onClose() {}, ...overrides };
  const harness = { state(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  } };
  const render = () => { cursor = 0; globalThis.restoreRoutineForm = harness; return RestoreRoutineDialog(props); };
  const date = required => find(render(), element => element.type === 'input' && element.props.type === 'date' && Boolean(element.props.required) === required);
  return { writes, props, render, date,
    setStart(value) { const input = date(true); assert.ok(input, 'Restore start-date input exists'); input.props.onChange({ target: { value } }); },
    setEnd(value) { const input = date(false); assert.ok(input, 'Optional end-date input exists'); input.props.onChange({ target: { value } }); },
    async submit() { await render().props.onSubmit({ preventDefault() {} }); },
  };
}

test('restore keeps the original routine identity and active job IDs without changing the assignee', async () => {
  const form = mount();
  await form.submit();
  assert.equal(form.writes.length, 1);
  const payload = form.writes[0];
  assert.equal(payload.id, routine.id);
  assert.equal(payload.title, routine.title);
  assert.equal(payload.detail, routine.detail);
  assert.deepEqual(payload.jobs, activeJobs);
  assert.equal(payload.jobs.some(job => job.id === 'deleted-job'), false);
  assert.deepEqual(Object.keys(payload).sort(), ['detail', 'id', 'jobs', 'schedule', 'title']);
  assert.equal(form.date(true).props.min, today);
});

test('restoring weekly, monthly, and interval schedules keeps their recurrence configuration', async () => {
  for (const original of [
    { frequency: 'weekly', weekdays: [2, 5] },
    { frequency: 'monthly', month_day: 31 },
    { frequency: 'interval', interval_days: 7, start_date: '2026-09-20' },
  ]) {
    const form = mount(original);
    form.setStart('2026-10-05');
    form.setEnd('2026-12-31');
    await form.submit();
    assert.equal(form.writes.length, 1);
    const schedule = form.writes[0].schedule;
    assert.equal(schedule.frequency, original.frequency);
    assert.equal(schedule.start_date, '2026-10-05');
    assert.equal(schedule.end_date, '2026-12-31');
    for (const field of ['weekdays', 'month_day', 'interval_days']) {
      if (original[field] !== undefined) assert.deepEqual(schedule[field], original[field]);
    }
  }
});

test('restoring an interval routine suggests its next occurrence without shifting cadence', () => {
  const form = mount({ frequency: 'interval', interval_days: 3, start_date: '2026-09-26' });
  assert.equal(form.date(true).props.value, '2026-09-29');
});

test('a one-time routine is restored on the selected day with matching end date', async () => {
  const form = mount({ frequency: 'once', start_date: '2026-09-20', end_date: '2026-09-20' });
  form.setStart('2026-10-02');
  await form.submit();
  assert.equal(form.writes[0].schedule.start_date, '2026-10-02');
  assert.equal(form.writes[0].schedule.end_date, '2026-10-02');
});

test('expired end dates are cleared while future end dates can be retained', () => {
  assert.equal(mount({ end_date: '2026-09-25' }).date(false).props.value, '');
  assert.equal(mount({ end_date: '2026-12-31' }).date(false).props.value, '2026-12-31');
});

test('invalid, missing, or past dates cannot submit a restore request', async () => {
  for (const invalid of ['', '2026-09-27', '2026-13-01', '2027-02-30']) {
    const form = mount();
    form.setStart(invalid);
    assert.equal(form.render().props.disabled, true, invalid || 'blank date');
    await form.submit();
    assert.deepEqual(form.writes, []);
  }
  for (const invalid of ['2026-09-27', '2027-02-30']) {
    const form = mount();
    form.setEnd(invalid);
    assert.equal(form.render().props.disabled, true);
    await form.submit();
    assert.deepEqual(form.writes, []);
  }
});

test('a routine with no active jobs requires editing before it can be restored', async () => {
  const form = mount({ jobs: routine.jobs.filter(job => job.is_active === false) });
  assert.equal(form.render().props.disabled, true);
  await form.submit();
  assert.deepEqual(form.writes, []);
});

test('restoration requires server management authority and the latest retired definition', async () => {
  for (const changes of [{ can_manage: false }, { can_manage: undefined }, { retired_on: null }, { replaced_by: 'newer-definition' }]) {
    const form = mount(changes);
    assert.equal(form.render().props.disabled, true);
    await form.submit();
    assert.deepEqual(form.writes, []);
  }
});

test('pending saves disable the form and cannot submit repeated restore requests', async () => {
  const form = mount();
  await form.submit();
  form.props.busy = true;
  const tree = form.render();
  assert.equal(tree.props.busy, true);
  assert.equal(find(tree, element => element.type === 'fieldset').props.disabled, true);
  await form.submit();
  assert.equal(form.writes.length, 1);
});

test('server refusals preserve the selected dates and remain visible for retry', async () => {
  const error = 'This routine has a newer version. Reload its latest schedule.';
  const form = mount({}, { onRestore: async () => { throw new Error(error); } });
  form.setStart('2026-10-04');
  // Shared FormSection handles the rejected submit and displays it; the wrapper must not swallow it.
  await assert.rejects(form.submit(), { message: error });
  form.props.error = error;
  assert.equal(form.render().props.error, error);
  assert.equal(form.date(true).props.value, '2026-10-04');
  assert.deepEqual(form.writes, []);
});
