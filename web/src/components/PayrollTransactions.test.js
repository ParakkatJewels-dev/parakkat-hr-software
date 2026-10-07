import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

// Exercise the actual editor event handlers; isolate database effects and React scheduling.
const sourceUrl = new URL('./PayrollTransactions.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: `export { default } from ${JSON.stringify(import.meta.resolve('react'))}; export const useState = initial => globalThis.txUI.state(initial); export const useRef = initial => globalThis.txUI.state({current:initial})[0]; export const useEffect = () => {}; export const useMemo = compute => compute();`,
  '@tanstack/react-query': 'export const useQueryClient = () => globalThis.txUI.client; export const useIsMutating = () => globalThis.txUI.activeWrites;',
  'lucide-react': 'export const Banknote="icon", Check="icon", ChevronRight="icon", CreditCard="icon", Loader2="icon", LockKeyhole="icon", Pencil="icon", Plus="icon", Trash2="icon", Users="icon";',
  '../data/payrollTransactions': `export const usePayrollAdjustments = () => globalThis.txUI.adjustments;
    export const usePayrollAdvances = () => globalThis.txUI.advances;
    export const usePayrollAdvanceRecoveries = () => globalThis.txUI.recoveries;
    export const usePayrollPayments = () => globalThis.txUI.payments;
    export const useSavePayrollAdjustment = () => globalThis.txUI.mutations.entry;
    export const useDeletePayrollAdjustment = () => globalThis.txUI.mutations.remove;
    export const useCreatePayrollAdvance = () => globalThis.txUI.mutations.issue;
    export const useVoidPayrollAdvance = () => globalThis.txUI.mutations.void;
    export const useSavePayrollAdvanceRecovery = () => globalThis.txUI.mutations.recovery;
    export const useSetPayrollPaymentStatus = () => globalThis.txUI.mutations.payment;`,
  '../data/payrollWorksheet': 'export const usePayrollMonthlyInputs = () => globalThis.txUI.inputs;',
  '../data/attendance': 'export const todayIso = () => "2026-10-07";',
  '../lib/payrollTransactions': `export * from ${JSON.stringify(new URL('../lib/payrollTransactions.js', import.meta.url).href)};`,
  '../lib/usePayrollSessionState': 'export const usePayrollSessionState = (key, initial) => globalThis.txUI.sessionState(key, initial);',
  '../lib/useRevealOnOpen': 'export const useRevealOnOpen = () => ({current:null});',
  './ui/Btn': 'export const btnClass = () => "button";',
  './ui/FormSection': 'export const FormError="form-error";',
  './ui/ConfirmDialog': 'export default "confirm-dialog";',
  './ui/ListSearch': 'export default "list-search";',
  './ui/Pagination': 'export default "pagination"; export const usePagination = (rows, size) => ({slice:rows.slice(0,size),count:rows.length});',
  './payrollTransactions.css': 'export default {};',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourceUrl.href && stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) { return url === sourceUrl.href ? { format: 'module', source: code, shortCircuit: true } : next(url, context); },
});
const { default: PayrollTransactions, PayrollPayments } = await import(sourceUrl.href);
after(() => { loader.deregister(); delete globalThis.txUI; });

const text = node => ['string', 'number'].includes(typeof node) ? String(node) : React.isValidElement(node)
  ? React.Children.toArray(node.props.children).map(text).join('') : '';
const findAll = (node, predicate) => !React.isValidElement(node) ? []
  : [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => findAll(child, predicate))];
const matches = (value, expected) => expected instanceof RegExp ? expected.test(value) : value === expected;
const noEvent = { preventDefault() {} };
const entityId = 'company';
const period = '2026-10';
const people = Array.from({ length: 27 }, (_, i) => ({ id: `person-${i}`, full_name: `Person ${String(i + 1).padStart(2, '0')}`, employee_code: `EMP${i}`, entity_id: entityId }));
const advance = { id: 'advance-1', employee_id: people[0].id, entity_id: entityId, issued_on: '2026-08-15', amount: 10000, reason: 'Personal advance', updated_at: 'advance-v1' };
const adjustment = { id: 'entry-1', employee_id: people[0].id, entity_id: entityId, period, kind: 'bonus', amount: 300, reason: 'Sales bonus', updated_at: 'entry-v1' };
const recovery = { id: 'recovery-1', advance_id: advance.id, employee_id: people[0].id, entity_id: entityId, period, amount: 1000, updated_at: 'recovery-v1', posted: false };

function mount({ mode = 'entries', published = false, sessionStore = new Map(), entries = [adjustment], advanceRows = [advance], recoveryRows = [recovery], paymentRows = [] } = {}) {
  const slots = []; let cursor = 0;
  const query = data => ({ data: structuredClone(data), isSuccess: true, isLoading: false, isFetching: false, error: null });
  const harness = { activeWrites: 0, sessionStore, adjustments: query(entries), advances: query(advanceRows), recoveries: query(recoveryRows), inputs: query([]), payments: query(paymentRows),
    props: { entityId, period, employees: people, published, run: { id: 'run-1', entity_id: entityId, period, status: published ? 'Published' : 'Draft' },
      registerRows: people.slice(0, 3).map((person, index) => ({ id: `slip-${index}`, employee_id: person.id, net: 25000 + index, employee: { full_name: person.full_name, employee_code: person.employee_code }, payroll_register: null })), disabled: false },
    state(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    sessionState(key, initial) { const serialized = JSON.stringify(key); if (!sessionStore.has(serialized)) sessionStore.set(serialized, typeof initial === 'function' ? initial() : initial);
      return [sessionStore.get(serialized), next => { sessionStore.set(serialized, typeof next === 'function' ? next(sessionStore.get(serialized)) : next); }]; },
    get retained() { return sessionStore.get(JSON.stringify(['transactions', entityId, period])); },
    render() { cursor = 0; globalThis.txUI = this; return mode === 'payments' ? PayrollPayments(this.props) : PayrollTransactions(this.props); },
    all(type) { return findAll(this.render(), node => node.type === type); },
    button(label) { return this.all('button').find(node => matches(node.props['aria-label'] || text(node).trim(), label)); },
    click(label) { const button = this.button(label); assert.ok(button, `Button ${label}`); assert.ok(!button.props.disabled, `${label} enabled`); return button.props.onClick(); },
    field(label) { const field = findAll(this.render(), node => node.type?.name === 'Field' && matches(node.props.label, label))[0];
      return field ? findAll(field, node => ['input', 'select', 'textarea'].includes(node.type))[0] : this.all('input').find(node => matches(node.props['aria-label'] || '', label)); },
    change(label, value) { const field = this.field(label); assert.ok(field, `Field ${label}`); assert.ok(!field.props.disabled, `${label} enabled`); return field.props.onChange({ target: { value } }); },
    submit(label) { const form = this.all('form').find(node => findAll(node, button => button.type === 'button' && matches(text(button).trim(), label)).length); assert.ok(form, `Form ${label}`); return form.props.onSubmit(noEvent); },
    dialog(title) { return this.all('confirm-dialog').find(node => matches(node.props.title, title)); },
    error() { return this.all('form-error').map(node => node.props.message?.message || String(node.props.message || '')).filter(Boolean).join(' '); },
  };
  const queries = { 'payroll-adjustments': harness.adjustments, 'payroll-advances': harness.advances, 'payroll-advance-recoveries': harness.recoveries, 'payroll-monthly-inputs': harness.inputs, 'payroll-payments': harness.payments };
  harness.client = { isMutating: () => harness.activeWrites,
    getQueryData: key => queries[key[0]]?.data,
    getQueryState: key => { const read = queries[key[0]]; return read ? { status: read.error ? 'error' : read.isSuccess ? 'success' : 'pending', fetchStatus: read.isFetching ? 'fetching' : 'idle', error: read.error } : undefined; } };
  const mutation = apply => ({ isPending: false, error: null, calls: [], failure: null,
    reset() { this.error = null; }, async mutateAsync(payload) { this.calls.push(structuredClone(payload)); if (this.failure) { this.error = this.failure; throw this.failure; } return apply(payload); } });
  harness.mutations = {
    entry: mutation(payload => { const row = { id: payload.id, employee_id: payload.employeeId, entity_id: entityId, period, ...payload.adjustment, updated_at: 'entry-saved' }; harness.adjustments.data = [...harness.adjustments.data.filter(item => item.id !== payload.id), row]; return row; }),
    remove: mutation(payload => { harness.adjustments.data = harness.adjustments.data.filter(row => row.id !== payload.id); }),
    issue: mutation(payload => { const row = { id: 'issued-advance', employee_id: payload.employeeId, entity_id: entityId, issued_on: payload.issuedOn, amount: payload.amount, reason: payload.reason, request_id: payload.requestId, updated_at: 'issue-saved' }; harness.advances.data.push(row); return row; }),
    void: mutation(payload => { const row = harness.advances.data.find(item => item.id === payload.id); Object.assign(row, { voided_at: '2026-10-07T12:00:00Z', void_reason: payload.reason, updated_at: 'void-saved' }); return row; }),
    recovery: mutation(payload => { harness.recoveries.data = harness.recoveries.data.filter(row => row.advance_id !== payload.advanceId || row.period !== payload.period); if (payload.amount) harness.recoveries.data.push({ ...recovery, amount: payload.amount, updated_at: 'recovery-saved' }); }),
    payment: mutation(payload => { const row = { run_id: payload.runId, employee_id: payload.employeeId, entity_id: entityId, status: payload.status, hold_reason: payload.reason, payment_reference: payload.reference, updated_at: 'payment-saved' }; harness.payments.data = [...harness.payments.data.filter(item => item.employee_id !== payload.employeeId), row]; return row; }),
  };
  harness.render(); return harness;
}

function chooseFirst(flow) { flow.click(/^Person 01/); }

test('employee chooser is searchable, paginated, and has no large employee select', () => {
  const flow = mount();
  assert.equal(flow.all('button').filter(node => node.props.className === 'ptx-person').length, 10);
  assert.equal(flow.all('pagination')[0].props.count, 27);
  assert.equal(flow.all('select').length, 0);
  flow.all('list-search')[0].props.onChange('EMP26');
  assert.equal(flow.all('button').filter(node => node.props.className === 'ptx-person').length, 1);
  flow.click(/^Person 27/);
  assert.equal(flow.retained.selectedId, 'person-26');
});

test('itemized entry requires a reason, retries with the same UUID, and retains dirty input until saved', async () => {
  const flow = mount(); chooseFirst(flow);
  flow.change('Amount (₹)', '1500');
  await flow.submit('Save entry');
  assert.match(flow.error(), /Reason/);
  assert.equal(flow.mutations.entry.calls.length, 0);
  flow.change('Reason', 'Festival bonus');
  flow.mutations.entry.failure = new Error('Connection interrupted');
  await flow.submit('Save entry');
  const firstId = flow.mutations.entry.calls[0].id;
  assert.match(firstId, /^[0-9a-f-]{36}$/);
  assert.equal(flow.retained.dirty, true);
  flow.mutations.entry.failure = null;
  await flow.submit('Save entry');
  assert.equal(flow.mutations.entry.calls[1].id, firstId);
  assert.deepEqual(flow.mutations.entry.calls[1].adjustment, { kind: 'bonus', amount: 1500, reason: 'Festival bonus' });
  assert.equal(flow.retained.dirty, false);
});

test('saved item editing and deletion carry the original concurrency token', async () => {
  const flow = mount(); chooseFirst(flow);
  flow.click('Edit Bonus: Sales bonus');
  assert.equal(flow.retained.dirty, false);
  flow.change('Amount (₹)', '350');
  await flow.submit('Save entry');
  assert.equal(flow.mutations.entry.calls[0].expectedUpdatedAt, 'entry-v1');
  flow.click('Delete Bonus: Sales bonus');
  assert.equal(flow.mutations.remove.calls.length, 0);
  await flow.dialog('Delete payroll entry?').props.onConfirm();
  assert.deepEqual(flow.mutations.remove.calls[0], { id: 'entry-1', expectedUpdatedAt: 'entry-saved' });
});

test('stale saved entries cannot be overwritten or deleted, and failed reads disable saves', async () => {
  const flow = mount(); chooseFirst(flow);
  flow.click('Edit Bonus: Sales bonus'); flow.change('Amount (₹)', '400');
  flow.adjustments.data[0].updated_at = 'changed-elsewhere';
  assert.equal(flow.button('Save entry').props.disabled, true);
  await flow.submit('Save entry');
  assert.equal(flow.mutations.entry.calls.length, 0);
  flow.click('Discard edit');
  flow.click('Delete Bonus: Sales bonus');
  const confirm = flow.dialog('Delete payroll entry?').props.onConfirm;
  flow.adjustments.data = flow.adjustments.data.map(row => ({ ...row, updated_at: 'changed-again' }));
  await assert.rejects(confirm(), /changed or was removed/);
  assert.equal(flow.mutations.remove.calls.length, 0);
  flow.adjustments.isFetching = true;
  assert.equal(flow.button('Save entry').props.disabled, true);
});

test('employee drafts survive remount and switching people asks before discarding them', () => {
  const store = new Map(); const first = mount({ sessionStore: store }); chooseFirst(first);
  first.change('Amount (₹)', '200'); first.change('Reason', 'Retention payment');
  const remounted = mount({ sessionStore: store });
  assert.equal(remounted.field('Amount (₹)').props.value, '200');
  assert.equal(remounted.retained.dirty, true);
  remounted.click(/^Person 02/);
  assert.equal(remounted.retained.selectedId, people[0].id);
  remounted.dialog('Discard employee entry changes?').props.onConfirm();
  assert.equal(remounted.retained.selectedId, people[1].id);
  assert.equal(remounted.retained.dirty, false);
});

test('advance issuance uses explicit confirmation and a stable request ID', async () => {
  const flow = mount(); chooseFirst(flow); flow.click('Advances & recovery');
  flow.change('Advance amount (₹)', '5000'); flow.change('Reason', 'Emergency advance');
  await flow.submit('Review advance');
  assert.equal(flow.mutations.issue.calls.length, 0);
  const id = flow.retained.advance.requestId;
  await flow.dialog('Record this issued advance?').props.onConfirm();
  assert.equal(flow.mutations.issue.calls[0].requestId, id);
  assert.equal(flow.mutations.issue.calls[0].issuedOn, '2026-10-07');
  assert.equal(flow.retained.dirty, false);
});

test('positive recovery is blocked by manual recovery while zero removes an existing plan', async () => {
  const flow = mount(); chooseFirst(flow); flow.click('Advances & recovery');
  flow.inputs.data = [{ employee_id: people[0].id, advance_recovery: 250 }];
  flow.change(/Recovery in 2026-10/, '1500');
  assert.equal(flow.button('Save recovery').props.disabled, true);
  await flow.button('Save recovery').props.onClick();
  assert.equal(flow.mutations.recovery.calls.length, 0);
  assert.match(flow.error(), /Clear the manual/);
  flow.change(/Recovery in 2026-10/, '0');
  assert.equal(flow.button('Save recovery').props.disabled, false);
  await flow.click('Save recovery');
  assert.deepEqual(flow.mutations.recovery.calls[0], { advanceId: advance.id, period, amount: 0, expectedUpdatedAt: 'recovery-v1' });
  assert.equal(flow.retained.dirty, false);
});

test('advance balances distinguish posted from planned and reject overcommitted or stale recovery', async () => {
  const flow = mount({ recoveryRows: [recovery, { ...recovery, id: 'earlier', period: '2026-09', amount: 3000, posted: true }] });
  chooseFirst(flow); flow.click('Advances & recovery');
  assert.match(text(flow.render()), /Remaining₹7,000.00/);
  assert.match(text(flow.render()), /Planned · all months₹1,000.00/);
  flow.change(/Recovery in 2026-10/, '8000');
  await flow.click('Save recovery');
  assert.match(flow.error(), /exceeds the balance/);
  assert.equal(flow.mutations.recovery.calls.length, 0);
  flow.change(/Recovery in 2026-10/, '1500');
  flow.recoveries.data[0].updated_at = 'different';
  assert.equal(flow.button('Save recovery').props.disabled, true);
  flow.click('Reload saved amount');
  assert.equal(flow.retained.dirty, false);
});

test('published recoveries are read-only while issuance and unused advance correction remain available', async () => {
  const flow = mount({ published: true, recoveryRows: [] }); chooseFirst(flow); flow.click('Advances & recovery');
  flow.change('Advance amount (₹)', '500'); flow.change('Reason', 'Post payroll advance');
  assert.equal(flow.button('Review advance').props.disabled, false);
  flow.click('Discard advance');
  flow.click('Void unused advance');
  await assert.rejects(flow.dialog('Void unused advance?').props.onConfirm(), /Enter a reason/);
  flow.change('Reason for voiding', 'Recorded in error; money was not issued');
  await flow.dialog('Void unused advance?').props.onConfirm();
  assert.deepEqual(flow.mutations.void.calls[0], { id: advance.id, reason: 'Recorded in error; money was not issued', expectedUpdatedAt: 'advance-v1' });
  assert.match(text(flow.render()), /Voided/);
  assert.equal(flow.button('Void unused advance'), undefined);
  const posted = mount({ recoveryRows: [{ ...recovery, posted: true }] }); chooseFirst(posted); posted.click('Advances & recovery');
  assert.equal(posted.button('Save recovery'), undefined);
  assert.equal(posted.button('Void unused advance'), undefined);
});

test('payment list uses published register employees and supports legacy payslip amounts', () => {
  const flow = mount({ mode: 'payments', published: true });
  assert.match(text(flow.render()), /₹25,000.00/);
  assert.equal(flow.all('tr').length, 4);
  assert.equal(flow.all('button').filter(node => text(node) === 'Record paid').length, 3);
  flow.props.employees = [];
  assert.match(text(flow.render()), /Person 01EMP0/);
});

test('hold requires a reason, release precedes paid, and recording payment requires confirmation/reference', async () => {
  const flow = mount({ mode: 'payments', published: true });
  flow.click('Hold'); flow.change('Hold reason', 'Bank details need correction');
  await flow.submit('Save payment hold');
  assert.equal(flow.mutations.payment.calls[0].status, 'held');
  assert.equal(flow.mutations.payment.calls[0].reason, 'Bank details need correction');
  await flow.click('Release hold');
  assert.equal(flow.mutations.payment.calls[1].status, 'unpaid');
  assert.equal(flow.mutations.payment.calls[1].expectedUpdatedAt, 'payment-saved');
  flow.click('Record paid');
  assert.equal(flow.field('Payment reference').props.maxLength, 200);
  flow.change('Payment reference', 'BANK-2026-1007');
  await flow.submit('Review payment record');
  assert.equal(flow.mutations.payment.calls.length, 2);
  await flow.dialog('Record this salary as paid?').props.onConfirm();
  assert.deepEqual(flow.mutations.payment.calls[2], { runId: 'run-1', employeeId: people[0].id, status: 'paid', reason: '', reference: 'BANK-2026-1007', expectedUpdatedAt: 'payment-saved' });
  assert.equal(flow.retained.dirty, false);
  const firstRow = flow.all('tr')[1];
  assert.equal(findAll(firstRow, node => node.type === 'button').length, 0);
});

test('payment confirmation rechecks latest tokens and active writes without dropping typed reference', async () => {
  const flow = mount({ mode: 'payments', published: true });
  flow.click('Record paid'); flow.change('Payment reference', 'BANK-RETAIN'); await flow.submit('Review payment record');
  const confirm = flow.dialog('Record this salary as paid?').props.onConfirm;
  flow.activeWrites = 1;
  await confirm();
  assert.equal(flow.mutations.payment.calls.length, 0);
  flow.activeWrites = 0;
  flow.payments.data = [{ employee_id: people[0].id, status: 'held', updated_at: 'other-v1' }];
  await confirm();
  assert.equal(flow.mutations.payment.calls.length, 0);
  assert.match(flow.error(), /Payment status changed/);
  assert.equal(flow.retained.payment.draft.reference, 'BANK-RETAIN');
  assert.equal(flow.retained.dirty, true);
});

test('missing or refreshing transaction reads fail closed before financial mutations', async () => {
  const flow = mount(); chooseFirst(flow); flow.change('Amount (₹)', '250'); flow.change('Reason', 'Bonus');
  const submit = flow.all('form')[0].props.onSubmit;
  flow.adjustments.isFetching = true;
  await submit(noEvent);
  assert.equal(flow.mutations.entry.calls.length, 0);
  const payment = mount({ mode: 'payments', published: true });
  payment.payments.isFetching = true;
  assert.equal(payment.button('Record paid').props.disabled, true);
  payment.payments.isFetching = false; payment.payments.error = new Error('Read failed');
  assert.equal(payment.button('Record paid'), undefined);
});
