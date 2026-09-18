import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

// A shallow hook driver runs the actual form handlers and retains state across renders.
// Data hooks are boundaries; no network requests or production mutations run in these tests.
const modules = new Map();
for (const name of ['TicketDesk', 'TicketCategories', 'Attendance', 'Leave']) {
  const url = new URL(`./${name}.jsx`, import.meta.url);
  modules.set(url.href, (await transformWithOxc(await readFile(url, 'utf8'), url.pathname,
    { jsx: { runtime: 'automatic' } })).code);
}
const queryStubs = names => names.map(name => `export const ${name} = () => globalThis.pendingFormTest.queries.${name};`).join('\n');
const mutationStubs = names => names.map(name => `export const ${name} = () => globalThis.pendingFormTest.mutation;`).join('\n');
const stubs = {
  react: `import React from ${JSON.stringify(import.meta.resolve('react'))}; export default React;
    export const useState = value => globalThis.pendingFormTest.useState(value);
    export const useRef = value => globalThis.pendingFormTest.useRef(value);
    export const useEffect = (fn, deps) => globalThis.pendingFormTest.useEffect(fn, deps);
    export const useMemo = fn => fn(); export const useCallback = fn => fn;`,
  'react-router-dom': `export const useLocation = () => globalThis.pendingFormTest.location;
    export const useSearchParams = () => [globalThis.pendingFormTest.params, globalThis.pendingFormTest.setParams];`,
  '../auth/AuthContext': 'export const useAuth = () => ({ employee: { id: "self" } });',
  '../auth/usePermissions': 'export const usePermissions = () => globalThis.pendingFormTest.permissions;',
  '../data/tickets': queryStubs(['useTickets']) + mutationStubs(['useAddTicket', 'useSetTicketStatus']),
  '../data/ticketCategories': queryStubs(['useTicketAccess', 'useTicketCategories']) + mutationStubs(['useSaveTicketCategory']),
  '../data/org': queryStubs(['useVisibleOrg']),
  '../data/leaves': queryStubs(['useLeaves']) + mutationStubs(['useApplyLeave']),
  '../data/leaveTypes': queryStubs(['useLeaveTypes', 'useLeaveBalances']),
  '../data/holidays': queryStubs(['useHolidays']),
  '../data/regularizations': queryStubs(['useRegularizations', 'useMyRegularizations']) + mutationStubs(['useCreateRegularization', 'useDecideRegularization']),
  '../data/attendance': queryStubs(['useAttendanceSummary', 'useMonthlyAttendance', 'useAttendanceExceptions', 'useRawPunches'])
    + 'export const todayIso=()=>"2026-09-15", STATUS_STYLES={}, STATUS_CODES={}, fmtTime=()=>"", fmtMinutes=()=>"";',
  '../data/syncStatus': 'export const useSyncHealth=()=>({}), DIAGNOSIS={}, forHumans=x=>x, useQueuedExport=()=>({}), useQueuedRecompute=()=>({});',
  '../lib/useFocusRow': 'export const useFocusRow = () => ({ focusId: null, rowProps: () => ({}) });',
  '../lib/useUrlTab': 'export const useUrlTab = () => ["regularizations", () => {}];',
  '../lib/useMineOnly': 'export const useMineOnly = () => [true, () => {}, false];',
  './ui/Pagination': 'export default "test-pagination"; export const usePagination = rows => ({ slice: rows, setPage() {} });',
  './ui/Skeleton': 'export const Skeleton="test-skeleton", SkeletonRows="test-rows", SkeletonTable="test-table", SkeletonCards="test-cards";',
  './ui/FormSection': 'export default "test-form-section";',
  './ui/QueryError': 'export default "test-query-error";',
  './LeaveReviewPanel': 'export default "test-leave-review";',
  './ui/Btn': 'export const btnClass=()=>"";',
  './ui/PunchTimeline': 'export default "test-punches"; export const BreakSummary="test-breaks";',
  './ui/PunchDetails': 'export default "test-punch-details";',
  './ui/DateRangeFilter': 'export default "test-dates"; export const useDateRange=()=>({});',
  './ui/FilterSelect': 'export default "test-filter";',
  './ui/ListSearch': 'export default "test-search";',
  './ui/EmployeeLink': 'export default "test-employee";',
  './EmployeeAttendanceDetail': 'export default "test-attendance-detail";',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (modules.has(context.parentURL)) {
      if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
      if (specifier.startsWith('.')) {
        const jsx = new URL(`${specifier}.jsx`, context.parentURL).href;
        return next(modules.has(jsx) ? jsx : new URL(`${specifier}.js`, context.parentURL).href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    return modules.has(url) ? { source: modules.get(url), format: 'module', shortCircuit: true } : next(url, context);
  },
});
const { default: TicketDesk } = await import(new URL('./TicketDesk.jsx', import.meta.url).href);
const { default: TicketCategories } = await import(new URL('./TicketCategories.jsx', import.meta.url).href);
const { RegularizationsView } = await import(new URL('./Attendance.jsx', import.meta.url).href);
const { default: Leave } = await import(new URL('./Leave.jsx', import.meta.url).href);
after(() => { loader.deregister(); delete globalThis.pendingFormTest; });

function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}
function textOf(element) {
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  return React.isValidElement(element) ? React.Children.toArray(element.props.children).map(textOf).join('') : '';
}
const department = { id: 'department', name: 'Support', is_active: true };
const category = { id: 'category', name: 'Help', department_id: department.id, department, is_active: true };
function mount(Component, props = {}) {
  const slots = []; let cursor = 0;
  const effects = []; let effectCursor = 0; let pendingEffects = [];
  const writes = [];
  const state = value => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value;
    return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
  };
  const harness = { useState: state, useRef: value => state({ current: value })[0],
    useEffect(fn, deps) {
      const index = effectCursor++;
      if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index][i]))) pendingEffects.push(fn);
      effects[index] = deps;
    },
    flushEffects() { const scheduled = pendingEffects; pendingEffects = []; scheduled.forEach(fn => fn()); },
    permissions: { can: () => true, canBeyondSelf: () => false, viewingAsEmployee: false },
    params: new URLSearchParams(), location: { key: 'initial' },
    setParams(next) { harness.params = typeof next === 'function' ? next(harness.params) : new URLSearchParams(next); harness.location = { key: `${harness.location.key}-next` }; },
    queries: Object.fromEntries(['useTickets', 'useRegularizations', 'useMyRegularizations'].map(name => [name, { data: [], isLoading: false }])),
    mutation: { isPending: false, reset() {}, mutate() {}, async mutateAsync(payload) { writes.push(payload); } },
  };
  Object.assign(harness.queries, {
    useTicketAccess: { data: { can_view_queue: false, can_manage_categories: false } },
    useTicketCategories: { data: [category], isLoading: false },
    useVisibleOrg: { data: { departments: [department], branches: [], entities: [] } },
    useLeaves: { data: [], isLoading: false }, useHolidays: { data: [] },
    useLeaveTypes: { data: [{ code: 'CL', name: 'Casual Leave', is_active: true }], isLoading: false, refetch() {} },
    useLeaveBalances: { data: [] },
  });
  const render = changes => {
    props = { ...props, ...changes }; cursor = 0; effectCursor = 0; globalThis.pendingFormTest = harness;
    return Component(props);
  };
  const field = label => {
    const wrapper = find(render(), element => element.type === 'label' && textOf(element).trim().startsWith(label));
    assert.ok(wrapper, label);
    return wrapper.props.htmlFor ? find(render(), element => element.props.id === wrapper.props.htmlFor)
      : find(wrapper, element => ['input', 'textarea', 'select'].includes(element.type));
  };
  return { harness, writes, render, field,
    fill: (label, value) => field(label).props.onChange({ target: { value } }),
    open: label => find(render(), element => element.type === 'button' && textOf(element).trim() === label).props.onClick(),
    form: () => find(render(), element => element.type === 'form' || element.type === 'test-form-section'),
  };
}
const submitEvent = () => ({ preventDefault() {} });

test('ticket submission blocks stale category errors and duplicate saves while retaining a failed draft', async () => {
  const form = mount(TicketDesk); form.open('Raise Ticket');
  form.fill('Category', category.id); form.fill('Subject', ' Network issue '); form.fill('Details', ' Keep these details ');
  form.harness.queries.useTicketCategories.error = new Error('Category refresh failed');
  await form.form().props.onSubmit(submitEvent()); assert.deepEqual(form.writes, []);
  form.harness.queries.useTicketCategories.error = null;
  let reject;
  form.harness.mutation.mutateAsync = payload => { form.writes.push(payload); return new Promise((_, fail) => { reject = fail; }); };
  const original = form.form(); const saving = original.props.onSubmit(submitEvent());
  await original.props.onSubmit(submitEvent());
  find(original, element => element.props['aria-label'] === 'Close ticket form').props.onClick();
  assert.equal(form.writes.length, 1); assert.ok(form.form());
  form.harness.mutation.isPending = true;
  assert.equal(form.form().props['aria-busy'], true);
  assert.equal(find(form.form(), element => element.type === 'fieldset').props.disabled, true);
  reject(new Error('Network unavailable')); await saving;
  form.harness.mutation.isPending = false;
  assert.equal(form.field('Subject').props.value, ' Network issue ');
  assert.equal(form.field('Details').props.value, ' Keep these details ');
});

test('ticket action queue navigation clears conflicting filters while keeping unrelated URL state', () => {
  const desk = mount(TicketDesk);
  desk.harness.queries.useTicketAccess.data = { can_view_queue: true, is_hr: true };
  desk.harness.queries.useTickets.data = [
    { id: 'open', subject: 'Open issue', employee_id: 'self', status: 'Open', can_manage: true, is_hr_queue: true },
    { id: 'read-only', subject: 'Visible issue', status: 'Open', can_manage: false, is_hr_queue: true },
    { id: 'other', subject: 'IT issue', status: 'On Hold', can_manage: true, is_hr_queue: false },
    { id: 'resolved', subject: 'Resolved issue', status: 'Resolved', can_manage: true, is_hr_queue: true },
  ];
  desk.harness.params.set('tab', 'tickets');
  desk.open('Needs action'); desk.harness.flushEffects();
  assert.equal(desk.harness.params.get('ticketQueue'), 'needs-action');
  assert.equal(desk.harness.params.get('tab'), 'tickets');
  assert.ok(find(desk.render(), element => element.props['aria-label'] === 'Ticket: IT issue'));
  assert.equal(find(desk.render(), element => element.props['aria-label'] === 'Ticket: Visible issue'), null);
  desk.fill('Search tickets', 'nonexistent'); desk.fill('Ticket status', 'On Hold');
  desk.fill('Ticket category', 'unused'); desk.fill('Assigned department', 'unused');
  assert.match(textOf(desk.render()), /No tickets match these filters/);
  // A second click on the same Support link is a new router location, even if its query is identical.
  desk.harness.setParams(new URLSearchParams('tab=tickets&ticketQueue=needs-action'));
  desk.render(); desk.harness.flushEffects();
  for (const label of ['Search tickets', 'Ticket status', 'Ticket category', 'Assigned department']) assert.equal(desk.field(label).props.value, '');
  assert.ok(find(desk.render(), element => element.props['aria-label'] === 'Ticket: Open issue'));
  assert.ok(find(desk.render(), element => element.props['aria-label'] === 'Ticket: IT issue'));
  desk.open('Tickets to HR'); desk.harness.flushEffects();
  assert.equal(desk.harness.params.get('ticketQueue'), 'hr-needs-action');
  assert.equal(find(desk.render(), element => element.props['aria-label'] === 'Ticket: IT issue'), null);
  desk.open('All tickets'); desk.harness.flushEffects();
  assert.equal(desk.harness.params.has('ticketQueue'), false);
  assert.ok(find(desk.render(), element => element.props['aria-label'] === 'Ticket: Resolved issue'));
});

test('employee presentation ignores a managerial queue deep link and hides all queue counts', () => {
  const desk = mount(TicketDesk);
  desk.harness.params.set('ticketQueue', 'needs-action');
  desk.harness.queries.useTicketAccess.data = { can_view_queue: true, is_hr: true };
  desk.harness.permissions.viewingAsEmployee = true;
  desk.harness.queries.useTickets.data = [
    { id: 'own', employee_id: 'self', subject: 'Own resolved issue', status: 'Resolved', can_manage: true },
    { id: 'other', employee_id: 'other', subject: 'Someone else', status: 'Open', can_manage: true },
  ];
  const view = desk.render();
  assert.ok(find(view, element => element.props['aria-label'] === 'Ticket: Own resolved issue'));
  assert.equal(find(view, element => element.props['aria-label'] === 'Ticket: Someone else'), null);
  assert.equal(find(view, element => element.props['aria-label'] === 'Ticket queue'), null);
  assert.equal(find(view, element => element.props['aria-label']?.includes('ticket needing action')), null);
  assert.equal(find(view, element => element.props['aria-label']?.startsWith('Update status for')), null);
});

test('category lookup failures block writes and saving locks fields, close and duplicate submission', async () => {
  const form = mount(TicketCategories, { categories: [], departments: [department] }); form.open('Add category');
  form.fill('Category name', 'Network'); form.fill('Assigned department', department.id);
  form.render({ departmentsError: new Error('Department refresh failed') });
  await form.form().props.onSubmit(submitEvent()); assert.deepEqual(form.writes, []);
  form.render({ departmentsError: null });
  let finish;
  form.harness.mutation.mutateAsync = payload => { form.writes.push(payload); return new Promise(resolve => { finish = resolve; }); };
  const original = form.form(); const saving = original.props.onSubmit(submitEvent());
  await original.props.onSubmit(submitEvent());
  find(original, element => element.props['aria-label'] === 'Close category form').props.onClick();
  assert.equal(form.writes.length, 1); assert.ok(form.form());
  form.harness.mutation.isPending = true;
  assert.equal(find(form.form(), element => element.type === 'fieldset').props.disabled, true);
  finish(); await saving;
  assert.equal(form.form(), null);
});

test('attendance correction keeps entered times after failure and resets only after a successful retry', async () => {
  const form = mount(RegularizationsView, { employee: { id: 'self' }, canApprove: false });
  form.fill('Check in', '09:00'); form.fill('Reason', ' Missed entry punch ');
  let reject;
  form.harness.mutation.mutateAsync = payload => { form.writes.push(payload); return new Promise((_, fail) => { reject = fail; }); };
  const original = form.form(); const saving = original.props.onSubmit(submitEvent());
  await original.props.onSubmit(submitEvent()); assert.equal(form.writes.length, 1);
  assert.equal(form.writes[0].reason, 'Missed entry punch');
  form.harness.mutation.isPending = true;
  assert.equal(find(form.form(), element => element.type === 'fieldset').props.disabled, true);
  reject(new Error('Failed to fetch')); await saving;
  form.harness.mutation.isPending = false;
  assert.equal(form.field('Check in').props.value, '09:00');
  assert.equal(form.field('Reason').props.value, ' Missed entry punch ');
  form.harness.mutation.mutateAsync = async payload => { form.writes.push(payload); };
  await form.form().props.onSubmit(submitEvent());
  assert.equal(form.field('Check in').props.value, ''); assert.equal(form.field('Reason').props.value, '');
  assert.deepEqual(form.writes[1], form.writes[0]);
});

test('ATT-05: correction form requires an explicit next-day exit and supports checkout-only requests', async () => {
  const form = mount(RegularizationsView, { employee: { id: 'self' }, canApprove: false });
  form.fill('Check in', '22:00'); form.fill('Check out', '06:00'); form.fill('Reason', 'Missing night exit');
  await form.form().props.onSubmit(submitEvent());
  assert.equal(form.writes.length, 0);
  assert.match(textOf(find(form.render(), element => element.props.role === 'alert')), /next day/);
  form.field('Check-out is next day').props.onChange({ target: { checked: true } });
  await form.form().props.onSubmit(submitEvent());
  assert.equal(form.writes[0].checkOutNextDay, true);
  assert.equal(form.writes[0].checkIn, '22:00');
  assert.equal(form.field('Check-out is next day').props.checked, false, 'success resets the date choice');
  form.fill('Check out', '06:00'); form.fill('Reason', 'Only exit was missed');
  form.field('Check-out is next day').props.onChange({ target: { checked: true } });
  await form.form().props.onSubmit(submitEvent());
  assert.equal(form.writes[1].checkIn, '');
  assert.equal(form.writes[1].checkOutNextDay, true);
});

test('leave applications require a successfully loaded active type and preserve details after refusal', async () => {
  const form = mount(Leave); form.open('Apply Leave');
  form.fill('Start', '2026-10-01'); form.fill('End', '2026-10-02'); form.fill('Reason', ' Family event ');
  for (const unavailable of [{ error: new Error('Types unavailable') }, { isLoading: true }, { data: [] }]) {
    const original = form.harness.queries.useLeaveTypes;
    form.harness.queries.useLeaveTypes = { ...original, ...unavailable };
    assert.equal(form.form().props.disabled, true);
    if (unavailable.error) {
      const failure = find(form.form(), element => element.type === 'test-query-error' && element.props.error);
      assert.equal(failure.props.title, 'Leave types could not be loaded.');
      assert.equal(failure.props.onRetry, original.refetch);
    }
    await form.form().props.onSubmit(submitEvent());
    form.harness.queries.useLeaveTypes = original;
  }
  assert.deepEqual(form.writes, []);
  form.harness.mutation.isPending = true;
  await form.form().props.onSubmit(submitEvent()); assert.deepEqual(form.writes, []);
  assert.equal(form.form().props.busy, true);
  form.harness.mutation.isPending = false;
  form.harness.mutation.mutateAsync = async payload => { form.writes.push(payload); throw new Error('Leave balance changed'); };
  await form.form().props.onSubmit(submitEvent());
  assert.equal(form.writes[0].type, 'CL'); assert.equal(form.writes[0].days, 2);
  assert.equal(form.writes[0].reason, 'Family event');
  assert.equal(form.field('Start').props.value, '2026-10-01');
  assert.equal(form.field('End').props.value, '2026-10-02');
  assert.equal(form.field('Reason').props.value, ' Family event ');
});
