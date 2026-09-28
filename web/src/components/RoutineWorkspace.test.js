import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

// Exercise the workspace's actual open, cancel and save handlers. Child forms and data hooks
// are isolated here; their validation and persistence payloads have separate coverage.
const sourceUrl = new URL('./TaskRoutine.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: `export const useState = value => globalThis.routineWorkspace.state(value);
    export const useRef = value => globalThis.routineWorkspace.state({current:value})[0];
    export const useMemo = compute => compute(); export const useEffect = () => {};`,
  'react-router-dom': `export const useSearchParams = () => [globalThis.routineWorkspace.params, update => {
    globalThis.routineWorkspace.params = update(globalThis.routineWorkspace.params);
  }];`,
  'lucide-react': 'export const AlertTriangle="icon", ArrowLeft="icon", CheckSquare="icon", Plus="icon", Square="icon", PenLine="icon", Archive="icon", Undo2="icon";',
  '../data/routines': `const h = () => globalThis.routineWorkspace;
    export const useRoutineSets = ({includeRetired}) => ({data:h().routines.filter(row => includeRetired || !row.retired_on)});
    export const useRoutineDay = () => ({data:[]}); export const useRoutineStats = () => ({data:[]});
    export const useCreateRoutineSet = () => h().mutations.create;
    export const useReplaceRoutineSet = () => h().mutations[h().replaceCursor++ ? 'restore' : 'edit'];
    export const useSetRoutineTick = () => ({}); export const useRetireRoutineSet = () => ({});`,
  '../lib/routines': `export { filterRoutineGroups, groupRoutineDay, routineScheduleLabel } from ${JSON.stringify(new URL('../lib/routines.js', import.meta.url).href)};`,
  '../lib/dateRange': `export { addDays, startOfMonth } from ${JSON.stringify(new URL('../lib/dateRange.js', import.meta.url).href)};`,
  '../lib/useIstToday': 'export const useIstToday = () => "2026-09-28";',
  '../lib/dbErrors': 'export const humanDbError = error => error?.message || error || "";',
  '../auth/usePermissions': 'export const usePermissions = () => ({canAny:()=>true,can:()=>true,canBeyondSelf:()=>true,viewingAsEmployee:false});',
  '../auth/AuthContext': 'export const useAuth = () => ({employee:null,assignments:[],isSuperAdmin:true});',
  '../lib/viewRole': 'export const setChosenRole = () => {};',
  './ui/Btn': 'export const btnClass = () => "button";',
  './ui/Pagination': 'export default "routine-pagination"; export const usePagination = rows => ({slice:rows,count:rows.length});',
  './ui/Skeleton': 'export const SkeletonRows="routine-skeleton";',
  './ui/ConfirmDialog': 'export default "routine-confirm";',
  './RoutineForm': 'export default "routine-form";',
  './RestoreRoutineDialog': 'export default "routine-restore-form";',
  './RoutineNotes': 'export default "routine-notes";',
  './RoutineNoteAudit': 'export default "routine-audit";',
  './RoutineStatistics': 'export default "routine-statistics";',
  './RoutineOrgFilters': 'export default "routine-org-filters";',
  '../data/sectionCounts': 'export const useSectionCounts = () => ({data:{}});',
  '../lib/navigationCounts': 'export const navigationCountLabel = label => label; export const navigationScreenCount = () => null;',
  './ui/CountBadge': 'export const NavigationCountBadge="routine-count";',
  './routines.css': 'export default {};',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourceUrl.href && stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    return url === sourceUrl.href ? { format: 'module', source: code, shortCircuit: true } : next(url, context);
  },
});
const { default: TaskRoutine } = await import(sourceUrl.href);
const originalDocument = globalThis.document;
after(() => {
  loader.deregister(); delete globalThis.routineWorkspace;
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
});

const text = node => typeof node === 'string' ? node : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : '';
function find(node, predicate, visibleOnly = false) {
  if (!React.isValidElement(node) || (visibleOnly && node.props.hidden)) return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const found = find(child, predicate, visibleOnly);
    if (found) return found;
  }
  return null;
}
function mount() {
  const slots = []; let cursor = 0;
  const employee = { id: 'employee-1', full_name: 'Alex', employee_code: 'E001', branch_id: 'branch-1' };
  const routine = { id: 'active', title: 'Opening checks', employee_id: employee.id, employee,
    frequency: 'daily', start_date: '2026-09-01', can_manage: true, jobs: [{ id: 'job-1', title: 'Count stock' }] };
  const mutation = () => ({ isPending: false, error: null, failure: null, writes: [],
    reset() { this.error = null; },
    async mutateAsync(payload) {
      if (this.failure) { this.error = this.failure; throw this.failure; }
      this.error = null; this.writes.push(payload);
    },
  });
  const harness = { params: new URLSearchParams(), replaceCursor: 0,
    routines: [routine, { ...routine, id: 'retired', title: 'Retired opening', frequency: 'weekly', weekdays: [1], retired_on: '2026-09-20' }],
    mutations: { create: mutation(), edit: mutation(), restore: mutation() },
    state(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
  };
  globalThis.document = { activeElement: { isConnected: true } };
  const render = () => { cursor = 0; harness.replaceCursor = 0; globalThis.routineWorkspace = harness; return TaskRoutine({}); };
  const button = label => find(render(), node => node.type === 'button' && text(node) === label, true);
  const field = label => find(find(render(), node => node.type === 'label' && text(node).startsWith(label)), node => node.type === 'input' || node.type === 'select');
  return { ...harness, render, field,
    click(label) { const node = button(label); assert.ok(node, `Visible ${label} button`); assert.ok(!node.props.disabled); node.props.onClick(); },
    change(label, value) { field(label).props.onChange({ target: { value } }); },
    editor() { return find(render(), node => node.type === 'routine-form' || node.type === 'routine-restore-form'); },
    browse() { return find(render(), node => node.props.className?.includes('routine-browser')); },
  };
}
const open = (workspace, mode) => {
  if (mode === 'restore') workspace.change('Schedule status', 'retired');
  workspace.click({ create: 'Create routine', edit: 'Edit routine', restore: 'Restore routine' }[mode]);
};
const save = (workspace, payload) => {
  const { props } = workspace.editor();
  return (props.onSave || props.onRestore)(payload);
};

test('create, edit and restore open a focused editor with browsing controls hidden', () => {
  for (const mode of ['create', 'edit', 'restore']) {
    const workspace = mount(); open(workspace, mode);
    assert.equal(workspace.browse().props.hidden, true, mode);
    assert.ok(find(workspace.render(), node => node.props['aria-label'] === 'Routine editor', true));
    assert.equal(find(workspace.render(), node => node.props['aria-label'] === 'Manage routine assignments', true), null);
    assert.equal(find(workspace.render(), node => node.props.type === 'search', true), null);
    assert.ok(workspace.editor());
    workspace.click('Back to routines');
    assert.equal(workspace.browse().props.hidden, false);
    assert.equal(workspace.editor(), null);
  }
});

test('cancel preserves management search, frequency, status and employee filters', () => {
  for (const label of ['Create routine', 'Edit routine', 'Restore routine']) {
    const workspace = mount();
    workspace.change('Schedule status', 'retired');
    workspace.change('Search assigned routines', 'Retired opening');
    workspace.change('Frequency', 'weekly');
    find(workspace.render(), node => node.type === 'routine-org-filters').props.onChange({ branchId: 'branch-1' });
    workspace.click(label); workspace.editor().props.onClose();
    assert.equal(workspace.browse().props.hidden, false);
    assert.equal(workspace.field('Search assigned routines').props.value, 'Retired opening');
    assert.equal(workspace.field('Frequency').props.value, 'weekly');
    assert.equal(workspace.field('Schedule status').props.value, 'retired');
    assert.deepEqual(find(workspace.render(), node => node.type === 'routine-org-filters').props.value, { branchId: 'branch-1' });
    assert.ok(find(workspace.render(), node => node.type === 'h4' && text(node) === 'Retired opening', true));
  }
});

test('failed create, edit and restore remain in the editor and successful retries return to browsing', async () => {
  for (const mode of ['create', 'edit', 'restore']) {
    const workspace = mount(); open(workspace, mode);
    const mutation = workspace.mutations[mode];
    mutation.failure = new Error('Save failed');
    const initial = workspace.editor().props.initial ?? workspace.editor().props.routine;
    const payload = { id: initial?.id, employeeIds: ['employee-1'], schedule: { start_date: '2026-09-28' } };
    await assert.rejects(save(workspace, payload), /Save failed/);
    assert.equal(workspace.browse().props.hidden, true);
    assert.equal(workspace.editor().props.initial ?? workspace.editor().props.routine, initial);
    assert.match(String(workspace.editor().props.error), /Save failed/);
    mutation.failure = null;
    await save(workspace, payload);
    assert.equal(mutation.writes.length, 1);
    assert.equal(workspace.editor(), null);
    assert.equal(workspace.browse().props.hidden, false);
    assert.ok(find(workspace.render(), node => node.props.role === 'status' && /Routine (assigned|saved|restored)/.test(text(node)), true));
    if (mode === 'restore') assert.equal(workspace.field('Schedule status').props.value, 'active');
  }
});
