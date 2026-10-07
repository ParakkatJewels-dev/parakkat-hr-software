import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

// Exercise the actual editor's event handlers, including stale evidence, scope checks and retry
// identity. Network hooks and scheduling are isolated; the real IST time validator is retained.
const sourceUrl = new URL('./PunchCorrectionEditor.jsx', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const { code } = await transformWithOxc(source, sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: `export const useState=initial=>globalThis.punchEditor.state(initial); export const useRef=value=>globalThis.punchEditor.state({current:value})[0]; export const useEffect=()=>{};`,
  'lucide-react': 'export const Clock="clock";',
  '../auth/AuthContext': 'export const useAuth=()=>globalThis.punchEditor.auth;',
  '../auth/usePermissions': 'export const usePermissions=()=>globalThis.punchEditor.permissions;',
  '../data/attendance': 'export const todayIso=()=>"2026-10-07"; export const fmtTime=value=>value??"—";',
  '../data/punchCorrections': 'export const usePunchCorrectionContext=()=>globalThis.punchEditor.context; export const useSavePunchCorrection=()=>globalThis.punchEditor.save;',
  '../lib/regularizationTimes': `export * from ${JSON.stringify(new URL('../lib/regularizationTimes.js', import.meta.url).href)};`,
  '../lib/recordedPunches': `export * from ${JSON.stringify(new URL('../lib/recordedPunches.js', import.meta.url).href)};`,
  './ui/FormSection': 'export default "form-section"; export const FIELD="field";',
  './ui/ConfirmDialog': 'export default "confirm-dialog";',
  './ui/Btn': 'export const btnClass=()=>"button";',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL === sourceUrl.href && stubs[specifier]
      ? { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) { return url === sourceUrl.href ? { format: 'module', source: code, shortCircuit: true } : next(url, context); },
});
const { default: PunchCorrectionEditor } = await import(sourceUrl.href);
after(() => { loader.deregister(); delete globalThis.punchEditor; });
function find(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
}
function mount({ active, workDate = '2026-09-15' } = {}) {
  const slots = []; let cursor = 0;
  const harness = {
    person: { id: 'worker', full_name: 'Test Worker', employee_code: 'W01', branch_id: 'branch' },
    auth: { employee: { id: 'hr' } }, permissions: { viewingAsEmployee: false, can: (_perm, scope) => scope.branchId === 'branch' },
    context: { isSuccess: true, isFetching: false, error: null, refetchCount: 0, refetch() { this.refetchCount++; }, data: {
      employee_id: 'worker', work_date: workDate, source_revision: 'revision-1', can_correct: true, is_locked: false,
      active_correction: active, check_in: `${workDate}T09:00:00+05:30`, check_out: `${workDate}T18:00:00+05:30`,
      attendance: { status: 'Present', worked_minutes: 500, check_in: `${workDate}T09:00:00+05:30`, check_out: `${workDate}T18:00:00+05:30` }, raw_punches: [{ id: 'raw', punch_time: `${workDate}T09:00:00+05:30` }], history: [],
    } },
    save: { isPending: false, calls: [], error: null, reset() { this.error = null; }, fail: false,
      async mutateAsync(payload) { this.calls.push(payload); if (this.fail) { this.error = new Error('Network unavailable'); throw this.error; } return { correction_id: 'correction' }; } },
    closed: 0,
    state(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }]; },
    render() { cursor = 0; globalThis.punchEditor = this; return PunchCorrectionEditor({ employee: this.person, workDate, onClose: () => { this.closed++; } }); },
    field(label) { return find(this.render(), node => node.props['aria-label'] === label); },
    change(label, value) { const field = this.field(label); assert.ok(field, label); field.props.onChange({ target: { value, checked: value } }); },
    form() { return find(this.render(), node => node.type === 'form-section'); },
    submit() { return this.form().props.onSubmit(); },
    confirm() { const dialog = find(this.render(), node => node.type === 'confirm-dialog'); assert.ok(dialog); return dialog.props.onConfirm(); },
  };
  return harness;
}
const enter = form => { form.change('Punch corrected check-out', '18:00'); form.change('Punch correction reason', '  Missed check-out  '); };

test('scheduled attendance is context only; a prior correction is the only prefilled manual value', () => {
  const fresh = mount();
  assert.equal(fresh.field('Punch corrected check-in').props.value, '');
  assert.equal(fresh.field('Punch corrected check-out').props.value, '');
  const corrected = mount({ active: { status: 'Approved', check_in: '2026-09-15T22:00:00+05:30', check_out: '2026-09-16T06:00:00+05:30' } });
  assert.equal(corrected.field('Punch corrected check-in').props.value, '22:00');
  assert.equal(corrected.field('Punch corrected check-out').props.value, '06:00');
  assert.equal(corrected.field('Punch check-out is next day').props.checked, true);
  assert.equal(corrected.field('Punch correction reason').props.value, '');
});

test('missing endpoint saves the selected day, scoped employee, reason and loaded evidence revision', async () => {
  const form = mount(); enter(form); await form.submit();
  const { requestId, ...payload } = form.save.calls[0];
  assert.match(requestId, /^[\da-f-]{36}$/);
  assert.deepEqual(payload, { employeeId: 'worker', workDate: '2026-09-15', checkIn: '', checkOut: '18:00', checkOutNextDay: false, reason: 'Missed check-out', sourceRevision: 'revision-1', endpointEvidence: { checkIn: null, checkOut: null } });
  assert.equal(form.form().props.disabled, true);
  assert.equal(form.closed, 0);
});

test('batched field edits preserve all values and overnight checkout must be explicit', async () => {
  const form = mount(); const rendered = form.render();
  for (const [label, value] of [['Punch corrected check-in', '22:00'], ['Punch corrected check-out', '06:00'], ['Punch correction reason', 'Night shift']]) {
    find(rendered, node => node.props['aria-label'] === label).props.onChange({ target: { value, checked: value } });
  }
  await form.submit(); assert.equal(form.save.calls.length, 0);
  assert.match(form.form().props.error, /next day/);
  form.change('Punch check-out is next day', true); await form.submit();
  assert.equal(form.save.calls[0].checkIn, '22:00'); assert.equal(form.save.calls[0].checkOutNextDay, true);
});

test('scope loss, self editing, employee lens, locked days and failed context reads block direct handlers', async () => {
  for (const mode of ['scope', 'self', 'lens', 'locked', 'error', 'fetching', 'cannot', 'wrong-day', 'wrong-person', 'no-revision', 'invalid-allow']) {
    const form = mount(); enter(form);
    if (mode === 'scope') form.person.branch_id = 'outside';
    if (mode === 'self') form.auth.employee.id = 'worker';
    if (mode === 'lens') form.permissions.viewingAsEmployee = true;
    if (mode === 'locked') form.context.data.is_locked = true;
    if (mode === 'error') form.context.error = new Error('Read failed');
    if (mode === 'fetching') form.context.isFetching = true;
    if (mode === 'cannot') form.context.data.can_correct = false;
    if (mode === 'wrong-day') form.context.data.work_date = '2026-09-16';
    if (mode === 'wrong-person') form.context.data.employee_id = 'outsider';
    if (mode === 'no-revision') form.context.data.source_revision = '';
    if (mode === 'invalid-allow') form.context.data.can_correct = 'false';
    assert.equal(form.form().props.disabled, true, mode); await form.submit(); assert.equal(form.save.calls.length, 0, mode);
  }
});

test('stale source keeps the draft and requires confirmed reload before saving', async () => {
  const form = mount(); enter(form); form.context.data.source_revision = 'revision-2';
  await form.submit(); assert.equal(form.save.calls.length, 0);
  assert.equal(form.field('Punch corrected check-out').props.value, '18:00');
  const reload = find(form.render(), node => node.type === 'button' && node.props.children === 'Reload current day');
  reload.props.onClick(); assert.equal(form.context.refetchCount, 0);
  form.confirm(); assert.equal(form.context.refetchCount, 1);
  assert.equal(form.field('Punch corrected check-out').props.value, '');
});

test('dirty close and date changes require discard; failed save retains its retry ID until payload changes', async () => {
  const form = mount(); enter(form); form.form().props.onClose();
  assert.equal(form.closed, 0); form.confirm(); assert.equal(form.closed, 1);
  const date = mount(); enter(date); date.change('Punch correction date', '2026-09-16');
  assert.equal(date.field('Punch correction date').props.value, '2026-09-15');
  date.confirm(); assert.equal(date.field('Punch correction date').props.value, '2026-09-16');
  assert.equal(date.field('Punch correction reason').props.value, '');
  const retry = mount(); enter(retry); retry.save.fail = true;
  await retry.submit(); await retry.submit();
  assert.equal(retry.save.calls[0].requestId, retry.save.calls[1].requestId);
  assert.equal(retry.field('Punch corrected check-out').props.value, '18:00');
  retry.change('Punch correction reason', 'Changed explanation'); await retry.submit();
  assert.notEqual(retry.save.calls[1].requestId, retry.save.calls[2].requestId);
});

test('future dates and short reasons cannot save and in-flight save cannot be discarded', async () => {
  const future = mount({ workDate: '2026-10-08' }); enter(future); await future.submit(); assert.equal(future.save.calls.length, 0);
  const short = mount(); enter(short); short.change('Punch correction reason', 'ab'); await short.submit(); assert.equal(short.save.calls.length, 0);
  const pending = mount(); enter(pending); pending.save.isPending = true; pending.form().props.onClose();
  assert.equal(pending.closed, 0); assert.equal(find(pending.render(), node => node.type === 'confirm-dialog'), null);
});


test('an ambiguous committed save retries its exact request after evidence changes; a definite conflict must reload', async () => {
  const form = mount(); enter(form); form.save.fail = true;
  await form.submit(); form.context.data.source_revision = 'revision-2';
  assert.equal(form.form().props.submitLabel, 'Retry save');
  await form.submit();
  assert.equal(form.save.calls.length, 2);
  assert.deepEqual(form.save.calls[0], form.save.calls[1]);
  form.save.error.code = '40001';
  await form.submit(); assert.equal(form.save.calls.length, 2);
  assert.equal(form.form().props.disabled, true);
});

test('the draft freezes exact endpoint evidence through context refresh and an ambiguous save retry', async () => {
  const form = mount({ workDate: '2026-09-02' });
  const checkIn = '2026-09-02T09:22:09+05:30';
  form.context.data.attendance.check_in = checkIn;
  form.context.data.attendance.first_punch_at = checkIn;
  form.context.data.raw_punches = [{ id: 'raw', punch_time: checkIn }];
  form.change('Punch corrected check-in', '09:22'); enter(form);
  form.save.fail = true;
  await form.submit();
  assert.equal(form.save.calls[0].endpointEvidence.checkIn, checkIn);
  form.context.data = { ...form.context.data, source_revision: 'revision-2',
    active_correction: { status: 'Approved', check_in: '2026-09-02T09:22:50+05:30', check_out: null } };
  assert.equal(form.form().props.submitLabel, 'Retry save');
  await form.submit();
  assert.deepEqual(form.save.calls[1], form.save.calls[0]);
});

test('editing a previous approved correction passes its original second precision to the save', async () => {
  const active = { status: 'Approved', check_in: '2026-09-15T22:00:17+05:30', check_out: '2026-09-16T06:00:41+05:30' };
  const form = mount({ active });
  form.change('Punch correction reason', 'Verified the existing overnight times');
  await form.submit();
  assert.deepEqual(form.save.calls[0].endpointEvidence, { checkIn: active.check_in, checkOut: active.check_out });
  assert.equal(form.save.calls[0].checkOutNextDay, true);
});


test('pending request values are not prefilled as approved punches', () => {
  const form = mount({ active: { status: 'Pending', check_in: '2026-09-15T09:00:00+05:30', check_out: '2026-09-15T18:00:00+05:30' } });
  assert.equal(form.field('Punch corrected check-in').props.value, '');
  assert.equal(form.field('Punch corrected check-out').props.value, '');
});

test('a definite source or authorization rejection requires reload even before refreshed data arrives', async () => {
  for (const code of ['40001', '42501', '55000']) {
    const form = mount(); enter(form); form.save.error = Object.assign(new Error('Server refused save'), { code });
    await form.submit(); assert.equal(form.save.calls.length, 0);
    assert.equal(form.form().props.disabled, true);
  }
});

test('saved feedback waits for the recompute result before reporting attendance processed', async () => {
  const form = mount(); enter(form); form.context.data.pending_recompute = true;
  await form.submit();
  const message = () => find(form.render(), node => node.props.role === 'status' && String(node.props.children).startsWith('Saved to Supabase.')).props.children;
  assert.match(message(), /will update after/);
  form.context.data.pending_recompute = false;
  assert.match(message(), /has been processed/);
});

test('one correction history combines HR audit timestamps with request history without duplicate reasons', () => {
  const form = mount();
  form.context.data.history = [
    { id: 'direct', check_in: null, check_out: '2026-09-15T18:00:00+05:30', status: 'Approved', reason: 'Missed check-out', created_at: '2026-09-16T01:00:00Z' },
    { id: 'request', check_in: '2026-09-15T09:00:00+05:30', check_out: null, status: 'Cancelled', reason: 'Earlier request', created_at: '2026-09-15T03:30:00Z', decided_at: '2026-09-15T04:00:00Z' },
  ];
  form.context.data.correction_history = [{ correction_id: 'direct', changed_at: '2026-09-16T02:00:00Z', reason: 'Missed check-out', after_state: { id: 'direct', reason: 'Missed check-out' } }];
  const all = (node, predicate) => !React.isValidElement(node) ? [] : [
    ...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => all(child, predicate)),
  ];
  const rendered = form.render();
  assert.equal(all(rendered, node => node.type === 'details').length, 1);
  assert.equal(all(rendered, node => node.type === 'p' && node.props.children === 'Missed check-out').length, 1);
  assert.deepEqual(all(rendered, node => node.type === 'time').map(node => node.props.dateTime), ['2026-09-16T02:00:00Z', '2026-09-15T04:00:00Z']);
  assert.equal(all(find(rendered, node => node.type === 'details'), node => node.type === 'li').length, 2);
});
