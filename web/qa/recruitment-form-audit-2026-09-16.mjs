// Runs the real recruitment handlers with stubbed network boundaries and retained hook state.
// Run from web: node qa/recruitment-form-audit-2026-09-16.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

const target = new URL('../src/components/Recruitment.jsx', import.meta.url);
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
try {
  const initial = render();
  const reject = find(initial, element => element.type === 'button' && element.props['aria-label'] === 'Reject');
  assert.ok(reject, 'Reject action must exist for a visible Applied candidate');
  reject.props.onClick();
  assert.deepEqual(calls.pop(), { id: 'candidate', stage: 'Rejected' });

  find(initial, element => element.type === 'qa-page-header').props.actions.props.onClick();
  find(render(), element => element.type === 'select' && element.props.required).props.onChange({ target: { value: 'company' } });
  find(render(), element => element.type === 'input' && element.props.placeholder === 'e.g. Sales Executive').props.onChange({ target: { value: '   ' } });
  await find(render(), element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, '   ');
  const result = {
    mode: 'Real component event handlers; hook and mutation boundaries stubbed; no database writes',
    verifiedWorkflow: { action: 'Reject Applied candidate', payload: { id: 'candidate', stage: 'Rejected' }, result: 'The UI explicitly writes Rejected, which the SSR audit confirms is then inaccessible.' },
    finding: { id: 'FE-08', name: 'Publish opening accepts a whitespace-only job title',
      expected: 'No write for a whitespace-only required job title; show validation and retain form.',
      actual: { mutationCalls: calls.length, payload: calls[0], formStillOpen: Boolean(find(render(), element => element.type === 'form')) },
      boundary: 'Frontend write payload confirmed; persistence not tested by this audit.' },
  };
  await writeFile(new URL('../../docs/qa/2026-09-16/recruitment-form-reproductions.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { loader.deregister(); delete globalThis.recruitmentAudit; }
