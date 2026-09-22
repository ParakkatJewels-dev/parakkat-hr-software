import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

// Run the real queue handlers and row predicates with hook state retained between renders.
const modules = new Map();
for (const name of ['Leave', 'Expense', 'Onboarding', 'Recruitment']) {
  const url = new URL(`./${name}.jsx`, import.meta.url);
  modules.set(url.href, (await transformWithOxc(await readFile(url, 'utf8'), url.pathname,
    { jsx: { runtime: 'automatic' } })).code);
}
const queries = names => names.map(name => `export const ${name} = () => globalThis.reviewQueueTest.queries.${name};`).join('\n');
const mutations = names => names.map(name => `export const ${name} = () => ({reset() {}});`).join('\n');
const stubs = {
  react: `import React from ${JSON.stringify(import.meta.resolve('react'))}; export default React;
    export const useState = value => globalThis.reviewQueueTest.state(value);
    export const useMemo = fn => fn(), useCallback = fn => fn, useEffect = () => {};`,
  '../auth/AuthContext': 'export const useAuth = () => ({employee:{id:"self"}, user:{id:"self-user"}});',
  '../auth/usePermissions': 'export const usePermissions = () => globalThis.reviewQueueTest.permissions;',
  '../data/sectionCounts': `export const useSectionCounts = options => {
    globalThis.reviewQueueTest.countOptions = options;
    return globalThis.reviewQueueTest.countQuery;
  };`,
  '../data/leaves': queries(['useLeaves']) + mutations(['useApplyLeave']),
  '../data/expenses': queries(['useExpenses']) + mutations(['useAddExpense', 'useSetExpenseStatus']),
  '../data/onboarding': queries(['useOnboarding']) + mutations(['useUpdateOnboarding']),
  '../data/recruitment': queries(['useJobs', 'useCandidates']) + mutations(['useAddJob', 'useSetCandidateStage']),
  '../data/org': queries(['useVisibleOrg']),
  '../data/leaveTypes': queries(['useLeaveTypes', 'useLeaveBalances']),
  '../data/holidays': queries(['useHolidays']),
  '../data/attendance': 'export const todayIso=()=>"2026-09-22";',
  '../lib/useMineOnly': `export const useMineOnly = canSeeOthers => {
    const [preferMine, setPreferMine] = globalThis.reviewQueueTest.state(false);
    return [canSeeOthers ? preferMine : true, setPreferMine, canSeeOthers];
  };`,
  '../lib/useFocusRow': 'export const useFocusRow = () => ({focusId:null, rowProps:id=>({"data-row-id":id})});',
  './ui/Pagination': 'export default "test-pagination"; export const usePagination = rows => ({slice:rows});',
  './ui/Skeleton': 'export const Skeleton="test-skeleton", SkeletonRows="test-rows", SkeletonCards="test-cards";',
  './ui/FormSection': 'export default "test-form"; export const Field="test-field", FIELD="", FormError="test-error";',
  './ui/QueryError': 'export default "test-query-error";',
  './ui/Btn': 'export const btnClass=()=>"";',
  './ui/CountBadge': 'export const NavigationCountBadge="test-count-badge";',
  './LeaveReviewPanel': 'export default "test-review-panel";',
  './ui/PageHeader': 'export default "test-page-header";',
  './ui/ListSearch': 'export default "test-list-search";',
  './ui/PagedCollection': 'export default "test-paged-collection";',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (modules.has(context.parentURL)) {
      if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
      if (specifier.startsWith('.')) return next(new URL(`${specifier}.js`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    return modules.has(url) ? { source: modules.get(url), format: 'module', shortCircuit: true } : next(url, context);
  },
});
const { default: Leave } = await import(new URL('./Leave.jsx', import.meta.url).href);
const { default: Expense } = await import(new URL('./Expense.jsx', import.meta.url).href);
const { default: Onboarding } = await import(new URL('./Onboarding.jsx', import.meta.url).href);
const { default: Recruitment } = await import(new URL('./Recruitment.jsx', import.meta.url).href);
after(() => { loader.deregister(); delete globalThis.reviewQueueTest; });

function findAll(element, predicate) {
  if (!React.isValidElement(element)) return [];
  return [...(predicate(element) ? [element] : []),
    ...React.Children.toArray(element.props.children).flatMap(child => findAll(child, predicate))];
}
function textOf(element) {
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  return React.isValidElement(element) ? React.Children.toArray(element.props.children).map(textOf).join('') : '';
}
function mount(Component) {
  const slots = []; let cursor = 0;
  const harness = {
    countQuery: { data: { leave: 4, expense: 127, onboarding: 7, recruitment: 11 } },
    permissions: { can: (_permission, scope) => scope.branchId === 'allowed', canAny: () => true, canBeyondSelf: () => true, viewingAsEmployee: false },
    state(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = next; }];
    },
    queries: {
      useLeaves: { data: [] }, useExpenses: { data: [] }, useHolidays: { data: [] },
      useLeaveTypes: { data: [{code:'CL', name:'Casual Leave'}] }, useLeaveBalances: { data: [] },
      useOnboarding: { data: [] }, useJobs: { data: [] }, useCandidates: { data: [] }, useVisibleOrg: { data: {entities:[]} },
    },
  };
  const render = () => { cursor = 0; globalThis.reviewQueueTest = harness; return Component(); };
  const find = predicate => findAll(render(), predicate)[0];
  const button = label => find(node => node.type === 'button' && textOf(node).trim() === label);
  return { harness, render, find, button,
    rows: () => findAll(render(), node => Boolean(node.props['data-row-id'])).map(node => node.props['data-row-id']),
  };
}

for (const [Component, key, count, description] of [[Leave, 'leave', 4, 'leave requests to review'], [Expense, 'expense', 127, 'expenses to review']]) {
  test(`${key} exposes the shared actionable count on its review queue`, () => {
    const page = mount(Component);
    const assertCount = () => {
      assert.equal(page.button('My review queue').props['aria-label'], `My review queue, ${count} ${description}`);
      assert.equal(page.find(node => node.type === 'test-count-badge').props.badge.count, count);
      assert.deepEqual(page.harness.countOptions, {selfOnly:false});
    };
    assertCount();
    page.button('My review queue').props.onClick();
    assert.equal(page.button('My review queue').props['aria-pressed'], true);
    assertCount();
    page.harness.countQuery.error = new Error('Refresh failed');
    assertCount();
    for (const data of [undefined, {[key]:0}, {[key]:-1}]) {
      page.harness.countQuery.data = data;
      assert.equal(page.button('My review queue').props['aria-label'], 'My review queue');
      assert.ok(!page.find(node => node.type === 'test-count-badge').props.badge.count);
    }
    page.harness.permissions = {can:()=>false, canBeyondSelf:()=>false, viewingAsEmployee:true};
    assert.equal(page.button('My review queue'), undefined);
    assert.deepEqual(page.harness.countOptions, {selfOnly:true});
    page.harness.permissions = {can:()=>false, canBeyondSelf:permission=>permission.endsWith('.read'), viewingAsEmployee:false};
    assert.equal(page.button('My review queue'), undefined, 'Read access alone does not expose an approval queue');
  });
}

test('leave review control and selector escape Mine scope and show only requests this viewer can review', () => {
  const page = mount(Leave);
  page.harness.queries.useLeaves.data = [
    {id:'pending', employee_id:'other', status:'Pending', can_decide:true},
    {id:'held', employee_id:'other', status:'On Hold', can_decide:true},
    {id:'mine', employee_id:'self', status:'Pending', can_decide:true},
    {id:'unavailable', employee_id:'other', status:'Pending', can_decide:false},
    {id:'approved', employee_id:'other', status:'Approved', can_decide:true},
  ];
  page.button('Mine').props.onClick();
  assert.deepEqual(page.rows(), ['mine']);
  const option = page.find(node => node.type === 'option' && node.props.value === 'My review queue');
  assert.equal(textOf(option), 'My review queue (4)');
  page.find(node => node.props['aria-label'] === 'Filter leave requests').props.onChange({target:{value:'My review queue'}});
  assert.deepEqual(page.rows(), ['pending', 'held']);
  page.button('Mine').props.onClick();
  assert.deepEqual(page.rows(), ['mine']);
  page.button('My review queue').props.onClick();
  assert.deepEqual(page.rows(), ['pending', 'held']);
});

test('expense review queue counts claims separately from money and excludes self, filed, settled, and out-of-scope claims', () => {
  const page = mount(Expense);
  const claim = {employee_id:'other', branch_id:'allowed', created_by:'another-user', status:'Pending', amount:50};
  page.harness.queries.useExpenses.data = [
    {...claim, id:'review'}, {...claim, id:'mine', employee_id:'self'},
    {...claim, id:'filed', created_by:'self-user'}, {...claim, id:'out-of-scope', branch_id:'other'},
    {...claim, id:'approved', status:'Approved'}, {...claim, id:'paid', status:'Paid'},
  ];
  assert.equal(page.find(node => node.props.label === 'Pending ₹').props.value, '200');
  page.button('Mine').props.onClick();
  assert.deepEqual(page.rows(), ['mine']);
  page.button('My review queue').props.onClick();
  assert.deepEqual(page.rows(), ['review']);
  assert.equal(page.button('My review queue').props['aria-label'], 'My review queue, 127 expenses to review');
  page.button('Mine').props.onClick();
  assert.deepEqual(page.rows(), ['mine']);
  assert.equal(page.button('My review queue').props['aria-pressed'], false);
});

test('onboarding incomplete counts stay visible while search and checklist filters change', () => {
  const page = mount(Onboarding);
  page.harness.queries.useOnboarding.data = [
    {id:'started', name:'Started hire', progress:50}, {id:'waiting', name:'Waiting hire', progress:null},
    {id:'ready', name:'Ready hire', progress:100},
  ];
  const hires = () => findAll(page.render(), node => node.props.className?.startsWith('onboarding-hire-card'));
  assert.equal(page.button('In progress').props['aria-label'], 'In progress, 7 onboarding checklists to finish');
  assert.ok(page.find(node => node.props['aria-label'] === 'Incoming hires, 7 onboarding checklists to finish'));
  page.find(node => node.type === 'test-list-search').props.onChange('Ready');
  assert.equal(hires().length, 1);
  page.button('In progress').props.onClick();
  assert.equal(page.find(node => node.type === 'test-list-search').props.value, '');
  assert.deepEqual(hires().map(textOf).map(text => text.split('—')[0]), ['Started hire', 'Waiting hire']);
  assert.equal(page.button('In progress').props['aria-pressed'], true);
  page.harness.countQuery.error = new Error('Refresh failed');
  assert.equal(page.button('In progress').props['aria-label'], 'In progress, 7 onboarding checklists to finish');
  page.button('All hires').props.onClick();
  assert.equal(hires().length, 3);
  page.harness.countQuery.data = undefined;
  assert.equal(page.button('In progress').props['aria-label'], 'In progress');
});

test('hiring shares the active total and retains stage counts when search or company narrows candidates', () => {
  const page = mount(Recruitment);
  page.harness.queries.useCandidates.data = [
    {id:'a', name:'Alice', stage:'Applied', job:{entity_id:'one'}},
    {id:'b', name:'Bob', stage:'Applied', job:{entity_id:'two'}},
    {id:'c', name:'Cara', stage:'Offered', job:{entity_id:'one'}},
    {id:'d', name:'Dora', stage:'Hired', job:{entity_id:'one'}},
    {id:'e', name:'Erin', stage:'Rejected', job:{entity_id:'one'}},
  ];
  const assertBadges = () => {
    assert.ok(page.find(node => node.props['aria-label'] === 'Candidate pipeline, 11 candidates in progress'));
    assert.ok(page.find(node => node.props['aria-label'] === 'Applied, 2 candidates in progress'));
    assert.ok(page.find(node => node.props['aria-label'] === 'Offered, 1 candidate in progress'));
    for (const stage of ['Hired', 'Rejected']) {
      const header = page.find(node => node.props['aria-label'] === stage);
      assert.equal(findAll(header, node => node.type === 'test-count-badge').length, 0);
    }
  };
  assertBadges();
  page.find(node => node.type === 'test-list-search').props.onChange('Alice');
  assertBadges();
  assert.equal(page.find(node => node.props.noun === 'applied candidates').props.items.length, 1);
  page.find(node => node.type === 'test-list-search').props.onChange('');
  page.find(node => node.props['aria-label'] === 'Hiring company').props.onChange({target:{value:'one'}});
  assertBadges();
  assert.equal(page.find(node => node.props.noun === 'applied candidates').props.items.length, 1);
  page.harness.countQuery.error = new Error('Refresh failed');
  assertBadges();
  page.harness.countQuery.data = undefined;
  assert.ok(page.find(node => node.props['aria-label'] === 'Candidate pipeline'));
  page.harness.permissions.viewingAsEmployee = true;
  page.render();
  assert.deepEqual(page.harness.countOptions, {selfOnly:true});
  assert.equal(page.find(node => node.props['aria-label'] === 'Applied, 2 candidates in progress'), undefined);
});
