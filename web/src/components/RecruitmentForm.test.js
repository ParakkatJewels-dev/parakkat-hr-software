import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

const target = new URL('./Recruitment.jsx', import.meta.url);
const code = (await transformWithOxc(await readFile(target, 'utf8'), target.pathname, { jsx: { runtime: 'automatic' } })).code;
const calls = [];
const slots = [];
let cursor = 0;
const mutation = { isPending: false, error: null, mutate: payload => calls.push(payload),
  async mutateAsync(payload) { calls.push(payload); } };
const harness = {
  state(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  }, mutation,
  candidates: [{ id: 'candidate', name: 'QA applicant', stage: 'Applied', job: { title: 'QA Role' } }],
};
globalThis.recruitmentAudit = harness;
const stubs = {
  react: `import React from ${JSON.stringify(import.meta.resolve('react'))}; export default React; export const useState = value => globalThis.recruitmentAudit.state(value); export const useMemo = fn => fn();`,
  '../data/recruitment': `export const useJobs=()=>({data:[]}); export const useCandidates=()=>({data:globalThis.recruitmentAudit.candidates}); export const useAddJob=()=>globalThis.recruitmentAudit.mutation; export const useSetCandidateStage=()=>globalThis.recruitmentAudit.mutation;`,
  '../data/org': 'export const useVisibleOrg=()=>({data:{entities:[{id:"company",code:"QA",name:"QA Company"}]}});',
  '../auth/usePermissions': 'export const usePermissions=()=>({canAny:()=>true});',
  './ui/Skeleton': 'export const Skeleton="qa-skeleton",SkeletonRows="qa-skeleton-rows";',
  './ui/PageHeader': 'export default "qa-page-header";',
  './ui/PagedCollection': 'export default "qa-paged-collection";',
  './ui/QueryError': 'export default "qa-query-error";',
  './ui/ListSearch': 'export default "qa-list-search";',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === target.href && stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) { return url === target.href ? { source: code, format: 'module', shortCircuit: true } : next(url, context); },
});
const { default: Recruitment } = await import(target.href);
const render = () => { cursor = 0; return Recruitment(); };
function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  if (element.type === 'qa-paged-collection') return find(element.props.children(element.props.items), predicate);
  return null;
}
after(() => { loader.deregister(); delete globalThis.recruitmentAudit; });
test('FE-08: blank titles stay open without writes; retry trims a valid title and location', async () => {
  const initial = render();
  find(initial, element => element.type === 'qa-page-header').props.actions.props.onClick();
  find(render(), element => element.type === 'select' && element.props.required).props.onChange({ target: { value: 'company' } });
  const title = () => find(render(), element => element.type === 'input' && element.props.placeholder === 'e.g. Sales Executive');
  title().props.onChange({ target: { value: '   ' } });
  await find(render(), element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.ok(find(render(), element => element.props.role === 'alert'));
  assert.equal(title().props.value, '   ');
  title().props.onChange({ target: { value: '  QA Engineer  ' } });
  find(render(), element => element.type === 'input' && element.props.placeholder === 'Kochi').props.onChange({ target: { value: '  Kochi  ' } });
  await find(render(), element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'QA Engineer'); assert.equal(calls[0].location, 'Kochi');
  assert.equal(find(render(), element => element.type === 'form'), null);
});

test('FE-05: advancing an offered candidate records Hired, then removes terminal actions', () => {
  harness.candidates = [{ id: 'offer', name: 'Accepted applicant', stage: 'Offered' }];
  find(render(), element => element.type === 'button' && element.props['aria-label'] === 'Advance').props.onClick();
  assert.deepEqual(calls.at(-1), { id: 'offer', stage: 'Hired' });
  harness.candidates[0].stage = 'Hired';
  assert.equal(find(render(), element => element.type === 'button' && element.props['aria-label'] === 'Advance'), null);
  assert.equal(find(render(), element => element.type === 'button' && element.props['aria-label'] === 'Reject'), null);
});
