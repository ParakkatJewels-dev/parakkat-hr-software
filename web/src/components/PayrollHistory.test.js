import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';
import { getPayrollSessionStateEntry } from '../lib/usePayrollSessionState.js';

const sourceUrl = new URL('./PayrollHistory.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: `export { default } from ${JSON.stringify(import.meta.resolve('react'))}; export const useState = initial => globalThis.payrollHistory.state(initial); export const useEffect = () => {}; export const useMemo = compute => compute();`,
  '@tanstack/react-query': 'export const useQueryClient = () => globalThis.payrollHistory.client; export const useIsMutating = filters => globalThis.payrollHistory.client.isMutating(filters);',
  'react-router-dom': 'export const Link = "a";',
  'lucide-react': 'export const AlertTriangle="icon", ArrowRight="icon", History="icon", Trash2="icon";',
  '../auth/usePermissions': 'export const usePermissions = () => ({ can: (_permission, scope) => globalThis.payrollHistory.allowedCompanies.has(scope.entityId) });',
  '../data/payroll': 'export const usePayrollRuns = () => globalThis.payrollHistory.query; export const useDeletePayrollRun = () => globalThis.payrollHistory.remove;',
  '../lib/usePayrollSessionState': `export { hasPayrollSessionChanges } from ${JSON.stringify(new URL('../lib/usePayrollSessionState.js', import.meta.url).href)};`,
  './ui/Btn': 'export const btnClass = () => "button";',
  './ui/ConfirmDialog': 'export default "confirm-dialog";',
  './ui/ListSearch': 'export default "list-search";',
  './ui/Pagination': 'export default "pagination"; export const usePagination = rows => ({ slice: rows, count: rows.length });',
  './ui/Skeleton': 'export const SkeletonRows = "loading-rows";',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourceUrl.href && stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) { return url === sourceUrl.href ? { format: 'module', source: code, shortCircuit: true } : next(url, context); },
});
const { default: PayrollHistory } = await import(sourceUrl.href);
after(() => { loader.deregister(); delete globalThis.payrollHistory; });

const draft = { id: 'draft-a', entity_id: 'company-a', period: '2026-09', status: 'Draft', employees: 20,
  total_net: 550000, source_fingerprint: 'source-a', entity: { code: 'AAA', name: 'Company A' } };
const nodeText = node => ['string', 'number'].includes(typeof node) ? String(node)
  : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(nodeText).join('') : '';
function findNodes(node, predicate) {
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => findNodes(child, predicate))];
}

function mount() {
  const slots = []; let cursor = 0;
  const harness = {
    activeKeys: [], allowedCompanies: new Set(['company-a']),
    query: { isSuccess: true, isLoading: false, isFetching: false, error: null, data: [
      { ...draft }, { ...draft, id: 'published-a', period: '2026-08', status: 'Published' },
      { ...draft, id: 'draft-b', entity_id: 'company-b', entity: { code: 'BBB', name: 'Company B' } },
    ] },
    remove: { isPending: false, error: null, failure: null, deferred: null, calls: [], reset() { this.error = null; },
      async mutateAsync(id) {
        this.isPending = true; this.calls.push(id);
        try {
          if (this.deferred) await this.deferred;
          if (this.failure) throw this.failure;
          harness.query.data = harness.query.data.filter(run => run.id !== id);
        } catch (error) { this.error = error; throw error; }
        finally { this.isPending = false; }
      },
    },
    client: { getQueryData: () => harness.query.data,
      isMutating: ({ predicate }) => harness.activeKeys.filter(key => predicate({ options: { mutationKey: [key] } })).length },
    state(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    render() { cursor = 0; globalThis.payrollHistory = this; return PayrollHistory({}); },
    button(label) { return findNodes(this.render(), node => node.type === 'button' && (node.props['aria-label'] || nodeText(node).trim()) === label)[0]; },
    deleteButton() { return findNodes(this.render(), node => node.type === 'button' && node.props['aria-label']?.startsWith('Delete '))[0]; },
    dialog() { return findNodes(this.render(), node => node.type === 'confirm-dialog')[0]; },
    change(label, value) { findNodes(this.render(), node => node.props['aria-label'] === label)[0].props.onChange({ target: { value } }); },
    retain(key, value) { getPayrollSessionStateEntry(this.client, key, value); },
  };
  return harness;
}

test('history filters by company, month, status and search while linking back to the selected review', () => {
  const history = mount();
  const rows = () => findNodes(history.render(), node => node.type === 'article');
  assert.equal(rows().length, 3);
  const links = findNodes(history.render(), node => node.type === 'a');
  assert.equal(links[0].props.to, '/payroll/run?entity=company-a&period=2026-09&step=review');
  assert.equal(nodeText(links[0]), 'Continue draft');
  assert.equal(nodeText(links[1]), 'View register');
  assert.equal(findNodes(history.render(), node => node.props['aria-label']?.startsWith('Delete ')).length, 1);
  assert.doesNotMatch(nodeText(history.render()), /Publish payroll|Calculate payroll/);
  history.change('Filter payroll history company', 'company-a');
  assert.equal(rows().length, 2);
  history.change('Filter payroll history month', '2026-09');
  assert.equal(rows().length, 1);
  history.change('Filter payroll history status', 'Published');
  assert.equal(rows().length, 0);
  history.button('Clear filters').props.onClick();
  findNodes(history.render(), node => node.type === 'list-search')[0].props.onChange('BBB');
  assert.equal(rows().length, 1);
  assert.match(nodeText(rows()[0]), /BBB/);
});

test('retained monthly, policy and salary edits protect their company draft from deletion', () => {
  for (const [key, value] of [
    [['inputs', draft.entity_id, draft.period], { worker: { draft: { incentive: '100' } } }],
    [['preview', draft.entity_id, draft.period], { rows: [] }],
    [['policy', draft.entity_id], { dirty: true }],
    [['salary-setup'], { entityId: draft.entity_id, form: { basic: '200' }, initialForm: { basic: '100' } }],
  ]) {
    const history = mount(); history.retain(key, value);
    assert.equal(history.deleteButton().props.disabled, true);
    history.deleteButton().props.onClick();
    assert.equal(history.dialog(), undefined);
  }
  const unrelated = mount();
  unrelated.retain(['inputs', 'company-b', draft.period], { worker: {} });
  assert.equal(unrelated.deleteButton().props.disabled, false);
});

test('live payroll mutations protect deletion even after its confirmation has opened', async () => {
  for (const key of ['save-payroll-monthly-inputs', 'save-payroll-policy', 'save-salary-structure', 'run-payroll', 'publish-payroll']) {
    const history = mount(); history.deleteButton().props.onClick();
    const confirm = history.dialog().props.onConfirm;
    history.activeKeys = [key];
    assert.equal(history.deleteButton().props.disabled, true);
    await assert.rejects(confirm(), /pending saves/);
    assert.equal(history.remove.calls.length, 0);
  }
});

test('confirmation rechecks current run status, permission and retained changes before deleting', async () => {
  for (const change of [
    history => { history.query.data[0].status = 'Published'; },
    history => { history.query.data = history.query.data.slice(1); },
    history => { history.allowedCompanies.clear(); },
    history => { history.retain(['inputs', draft.entity_id, draft.period], { worker: {} }); },
  ]) {
    const history = mount(); history.deleteButton().props.onClick();
    const confirm = history.dialog().props.onConfirm;
    change(history);
    await assert.rejects(confirm());
    assert.equal(history.remove.calls.length, 0);
  }
});

test('failed deletion keeps the confirmation available and a successful retry removes only its draft', async () => {
  const history = mount(); history.deleteButton().props.onClick();
  history.remove.failure = new Error('Delete failed');
  await history.dialog().props.onConfirm();
  assert.equal(history.dialog().props.error, 'Delete failed');
  assert.equal(history.query.data.length, 3);
  history.remove.failure = null;
  await history.dialog().props.onConfirm();
  assert.deepEqual(history.remove.calls, ['draft-a', 'draft-a']);
  assert.deepEqual(history.query.data.map(run => run.id), ['published-a', 'draft-b']);
  assert.equal(history.dialog(), undefined);
  assert.match(nodeText(history.render()), /2026-09 draft payroll deleted/);
});

test('loading failures expose no draft actions and pending deletion prevents navigation', async () => {
  const failed = mount(); failed.query.error = new Error('History unavailable');
  assert.equal(failed.deleteButton(), undefined);
  assert.match(nodeText(failed.render()), /History unavailable/);
  const refreshing = mount(); refreshing.query.isFetching = true;
  assert.equal(refreshing.deleteButton().props.disabled, true);
  const history = mount(); history.deleteButton().props.onClick();
  let resolveDelete;
  history.remove.deferred = new Promise(resolve => { resolveDelete = resolve; });
  const deleting = history.dialog().props.onConfirm();
  assert.equal(history.dialog().props.busy, true);
  assert.equal(history.deleteButton().props.disabled, true);
  for (const link of findNodes(history.render(), node => node.type === 'a')) {
    assert.equal(link.props['aria-disabled'], true);
    let prevented = false;
    link.props.onClick({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  resolveDelete(); await deleting;
  assert.equal(history.dialog(), undefined);
});
