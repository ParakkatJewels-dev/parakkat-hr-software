import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

// Exercise actual form handlers. Network hooks and React scheduling are isolated, while the
// real IST/overnight validator is retained. The SSR companion covers routing and permissions.
const sourceUrl = new URL('./Attendance.jsx', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const { code } = await transformWithOxc(source, sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {};
for (const [, clause, specifier] of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g)) {
  const named = clause.match(/\{([^}]+)\}/)?.[1].split(',').map(name => name.trim()).filter(Boolean) ?? [];
  stubs[specifier] = `${clause.trim().startsWith('{') ? '' : 'export default "component";'} ${named.map(name => `export const ${name} = () => null;`).join(' ')}`;
}
Object.assign(stubs, {
  react: `export {default} from ${JSON.stringify(import.meta.resolve('react'))}; export const useState = initial => globalThis.correctionForm.state(initial);
    export const useRef = value => globalThis.correctionForm.state({current:value})[0]; export const useMemo = calculate => calculate();`,
  'react-router-dom': 'export const Link="link"; export const useNavigate=()=>()=>{}; export const useSearchParams=()=>[globalThis.correctionForm.params,()=>{}];',
  '../auth/AuthContext': 'export const useAuth=()=>globalThis.correctionForm.auth;',
  '../auth/usePermissions': 'export const usePermissions=()=>globalThis.correctionForm.permissions;',
  '../data/employees': 'export const useEmployees=()=>({data:globalThis.correctionForm.people,isLoading:false,error:null});',
  '../data/attendance': `export const todayIso=()=>"2026-10-06"; export const STATUS_STYLES={}; export const STATUS_CODES={};
    export const fmtTime=value=>value??"—"; export const fmtMinutes=()=>"";
    export const useAttendanceSummary=()=>({}); export const useAttendanceExceptions=()=>({}); export const useRawPunches=()=>({});
    export const useMonthlyAttendance=id=>({...globalThis.correctionForm.dayQuery,data:id?globalThis.correctionForm.dayQuery.data:[]});`,
  '../data/regularizations': `export const useRegularizations=()=>({data:[]}); export const useMyRegularizations=()=>({data:[]});
    export const useCreateRegularization=()=>globalThis.correctionForm.create; export const useDecideRegularization=()=>({});`,
  '../lib/useFocusRow': 'export const useFocusRow=()=>({focusId:null,rowProps:()=>({})});',
  './ui/Pagination': 'export default "pagination"; export const usePagination=rows=>({slice:rows});',
  '../lib/regularizationTimes': `export * from ${JSON.stringify(new URL('../lib/regularizationTimes.js', import.meta.url).href)};`,
  '../lib/recordedPunches': `export * from ${JSON.stringify(new URL('../lib/recordedPunches.js', import.meta.url).href)};`,
});
const loader = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL === sourceUrl.href && stubs[specifier]
      ? { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === sourceUrl.href ? { format: 'module', source: code, shortCircuit: true } : next(url, context);
  },
});
const { RegularizationsView } = await import(sourceUrl.href);
after(() => { loader.deregister(); delete globalThis.correctionForm; });

function find(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
}
function mount({ self = false, target = 'worker', locked = false } = {}) {
  const slots = []; let cursor = 0;
  const me = { id: 'manager', branch_id: 'branch' };
  const person = { id: 'worker', branch_id: 'branch', full_name: 'Worker' };
  const harness = {
    auth: { user: { id: 'operator' }, employee: self ? person : me }, people: [person, me],
    params: new URLSearchParams({ employee: target, date: '2026-07-15' }),
    dayQuery: { isSuccess: true, isFetching: false, error: null, data: [{ employee_id: 'worker', work_date: '2026-07-15', is_locked: locked }] },
    permissions: { viewingAsEmployee: self, canBeyondSelf: () => !self,
      can: (_permission, scope) => self ? scope.employeeId === person.id : scope.branchId === 'branch' },
    create: { isPending: false, calls: [], reset() {}, async mutateAsync(payload) { this.calls.push(payload); } },
    state(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }]; },
    render() { cursor = 0; globalThis.correctionForm = this; return RegularizationsView({ employee: this.auth.employee, canApprove: !self }); },
    field(label) { return find(this.render(), node => node.props['aria-label'] === label); },
    change(label, value) { const field = this.field(label); assert.ok(field, label); field.props.onChange({ target: { value, checked: value } }); },
    submit() { return find(this.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
  };
  return harness;
}

test('HR correction submits the selected employee, keeps overnight choice and trims the approval reason', async () => {
  const form = mount();
  form.change('Corrected check-in', '22:00'); form.change('Corrected check-out', '06:00');
  form.change('Check-out is next day', true); form.change('Correction reason', '  Device missed checkout  ');
  await form.submit();
  assert.deepEqual(form.create.calls, [{ employeeId: 'worker', workDate: '2026-07-15', checkIn: '22:00', checkOut: '06:00', checkOutNextDay: true, reason: 'Device missed checkout' }]);
});

test('changes from one rendered correction form preserve every field when React batches callbacks', async () => {
  const form = mount();
  const rendered = form.render();
  for (const [label, value] of [['Correction date', '2026-07-16'], ['Corrected check-in', '22:00'],
    ['Corrected check-out', '06:00'], ['Check-out is next day', true], ['Correction reason', '  Night shift correction  ']]) {
    const field = find(rendered, node => node.props['aria-label'] === label);
    assert.ok(field, label);
    field.props.onChange({ target: { value, checked: value } });
  }
  await form.submit();
  assert.deepEqual(form.create.calls, [{ employeeId: 'worker', workDate: '2026-07-16', checkIn: '22:00',
    checkOut: '06:00', checkOutNextDay: true, reason: 'Night shift correction' }]);
});

test('self correction ignores another employee in the URL and still submits only the signed-in employee', async () => {
  const form = mount({ self: true, target: 'manager' });
  form.change('Corrected check-out', '18:00'); form.change('Correction reason', 'Device missed checkout');
  await form.submit();
  assert.equal(form.create.calls[0].employeeId, 'worker');
});

test('locked days, failed attendance reads and employee scope loss prevent even direct handler submission', async () => {
  for (const mode of ['locked', 'error', 'scope']) {
    const form = mount({ locked: mode === 'locked' });
    form.change('Corrected check-out', '18:00'); form.change('Correction reason', 'Device missed checkout');
    if (mode === 'error') form.dayQuery.error = new Error('Failed attendance read');
    if (mode === 'scope') form.people = [];
    await form.submit();
    assert.equal(form.create.calls.length, 0, mode);
  }
});

test('invalid overnight time or future work date does not submit and switching employee clears typed times', async () => {
  const form = mount();
  form.change('Corrected check-in', '22:00'); form.change('Corrected check-out', '06:00'); form.change('Correction reason', 'Reason');
  await form.submit(); assert.equal(form.create.calls.length, 0);
  form.change('Check-out is next day', true); form.change('Correction date', '2026-10-07');
  await form.submit(); assert.equal(form.create.calls.length, 0);
  form.change('Correction employee', 'manager');
  assert.equal(form.field('Corrected check-in').props.value, '');
  assert.equal(form.field('Corrected check-out').props.value, '');
  assert.equal(form.field('Correction reason').props.value, '');
});
