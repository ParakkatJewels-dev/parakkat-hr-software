import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const modules = new Map();
for (const name of ['FormSection', 'Btn', 'QueryError', 'ConfirmDialog', 'InlineRowForm']) {
  const url = new URL(`./${name}.jsx`, import.meta.url);
  modules.set(url.href, (await transformWithOxc(await readFile(url, 'utf8'), url.pathname,
    { jsx: { runtime: 'automatic' } })).code);
}
const formUrl = new URL('./FormSection.jsx', import.meta.url).href;
const hookModules = new Set(['FormSection', 'ConfirmDialog', 'InlineRowForm'].map(name => new URL(`./${name}.jsx`, import.meta.url).href));
const reactHooks = `import React from ${JSON.stringify(import.meta.resolve('react'))}; export default React;
  export const useId = () => 'form-error';
  export const useRef = value => globalThis.formSectionTest.useRef(value);
  export const useState = value => globalThis.formSectionTest.useState(value);
  export const useEffect = (effect, deps) => globalThis.formSectionTest.useEffect(effect, deps);`;
const loader = registerHooks({
  resolve(specifier, context, next) {
    const stub = hookModules.has(context.parentURL) && (specifier === 'react' ? reactHooks
      : specifier === '../../lib/useRevealOnOpen' ? 'export const useRevealOnOpen = () => ({ current: null });' : null);
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    if (modules.has(context.parentURL) && specifier.startsWith('.')) {
      const jsx = new URL(`${specifier}.jsx`, context.parentURL).href;
      return next(modules.has(jsx) ? jsx : new URL(`${specifier}.js`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    return modules.has(url) ? { source: modules.get(url), format: 'module', shortCircuit: true } : next(url, context);
  },
});
const { default: FormSection, FormError } = await import(formUrl);
const { default: Btn } = await import(new URL('./Btn.jsx', import.meta.url).href);
const { default: QueryError } = await import(new URL('./QueryError.jsx', import.meta.url).href);
const { default: ConfirmDialog } = await import(new URL('./ConfirmDialog.jsx', import.meta.url).href);
const { default: InlineRowForm } = await import(new URL('./InlineRowForm.jsx', import.meta.url).href);
const originalDocument = globalThis.document;
after(() => {
  loader.deregister(); delete globalThis.formSectionTest;
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
});

function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function mount(props, Component = FormSection) {
  const slots = [], effects = [], listeners = new Map();
  let cursor = 0;
  globalThis.document = { addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name) };
  const state = initial => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
  };
  const harness = { useState: state, useRef: initial => state({ current: initial })[0],
    useEffect(effect, deps) {
      const i = cursor++, previous = slots[i];
      if (!previous || !deps || deps.some((value, index) => value !== previous.deps?.[index])) {
        effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
      }
    } };
  return {
    render(changes = {}) {
      props = { ...props, ...changes }; cursor = 0; globalThis.formSectionTest = harness;
      const tree = Component(props);
      effects.splice(0).forEach(effect => effect());
      return tree;
    },
    escape() { listeners.get('keydown')?.({ key: 'Escape' }); },
  };
}
const event = () => ({ preventDefault() {} });

test('async saves lock immediately, announce pending and block duplicate submits and dismissal', async () => {
  let finish, saves = 0, closes = 0;
  const form = mount({ title: 'New goal', onClose: () => closes++, onSubmit: () => {
    saves++; return new Promise(resolve => { finish = resolve; });
  }, children: React.createElement('input', { defaultValue: 'Keep my draft' }) });
  const first = form.render();
  const saving = first.props.onSubmit(event());
  await first.props.onSubmit(event());
  find(first, element => element.props['aria-label'] === 'Close New goal').props.onClick();
  form.escape();
  assert.equal(saves, 1); assert.equal(closes, 0);
  const pending = form.render();
  assert.equal(pending.props['aria-busy'], true);
  assert.equal(find(pending, element => element.type === 'fieldset').props.disabled, true);
  assert.match(renderToStaticMarkup(pending), /Saving…/);
  assert.equal(find(pending, element => element.props.type === 'submit').props.disabled, true);
  finish(); await saving;
  const ready = form.render();
  assert.equal(ready.props['aria-busy'], false);
  assert.equal(find(ready, element => element.type === 'fieldset').props.disabled, false);
  form.escape(); assert.equal(closes, 1);
});

test('externally busy or invalid forms do not call the submit handler', async () => {
  let calls = 0, closes = 0;
  const form = mount({ title: 'Claim', onSubmit: () => calls++, onClose: () => closes++, busy: true });
  await form.render().props.onSubmit(event()); form.escape();
  assert.equal(calls, 0); assert.equal(closes, 0);
  await form.render({ busy: false, disabled: true }).props.onSubmit(event());
  assert.equal(calls, 0);
});

test('rejected saves show a readable error, retain fields and allow retry without reloading', async () => {
  const draft = React.createElement('textarea', { defaultValue: 'Entered details' });
  let saves = 0, closes = 0;
  const form = mount({ title: 'Claim', onClose: () => closes++, children: draft, onSubmit: async () => {
    if (++saves === 1) throw new Error('Failed to fetch');
  } });
  await form.render().props.onSubmit(event());
  const failed = form.render();
  const html = renderToStaticMarkup(failed);
  assert.match(html, /Couldn&#x27;t reach the server|Couldn't reach the server/);
  assert.match(html, /Check your connection and try again/);
  assert.match(html, /aria-describedby="form-error"/);
  assert.equal(find(failed, element => element.type === 'textarea').props.defaultValue, 'Entered details');
  assert.equal(closes, 0);
  await failed.props.onSubmit(event());
  assert.equal(saves, 2);
  assert.equal(form.render().props['aria-describedby'], undefined);
});

test('a handler that already catches its own failure keeps the supplied mutation error', async () => {
  const form = mount({ title: 'Claim', onSubmit: async () => { try { throw new Error('Handled'); } catch {} } });
  await form.render().props.onSubmit(event());
  const ready = form.render({ error: new Error('Your claim is already being reviewed.') });
  assert.equal(ready.props['aria-busy'], false);
  assert.match(renderToStaticMarkup(ready), /Your claim is already being reviewed/);
});

test('shared errors translate database objects and busy buttons cannot be enabled by disabled=false', () => {
  const html = renderToStaticMarkup(FormError({ message: { code: 'PT429' } }));
  assert.match(html, /Too many requests/); assert.match(html, /role="alert"/);
  const button = Btn({ busy: true, disabled: false, children: 'Save' });
  assert.equal(button.props.disabled, true);
  assert.equal(button.props['aria-busy'], true);
});

test('query errors retain cached-data context and retry only through the supplied read', async () => {
  let retries = 0;
  const props = { title: 'Goals could not be refreshed.', error: new Error('Failed to fetch'),
    hasData: true, onRetry: () => { retries++; } };
  const tree = QueryError(props);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Showing the last available data/);
  assert.match(html, /Check your connection/);
  find(tree, element => element.type === Btn).props.onClick();
  await Promise.resolve(); assert.equal(retries, 1);
  find(QueryError({ ...props, retrying: true }), element => element.type === Btn).props.onClick();
  await Promise.resolve(); assert.equal(retries, 1);
  assert.equal(QueryError({}), null);
});

test('confirmation blocks repeat clicks, backdrop, cancel and Escape until the action settles', async () => {
  let finish, calls = 0, cancelled = 0;
  const dialog = mount({ title: 'Delete item', onCancel: () => cancelled++, onConfirm: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } }, ConfirmDialog);
  const tree = dialog.render();
  const confirm = find(tree, element => element.type === 'button' && element.props.children?.includes?.('Confirm'));
  const saving = confirm.props.onClick();
  await confirm.props.onClick(); tree.props.onClick(); dialog.escape();
  find(tree, element => element.type === 'button' && element.props.children === 'Cancel').props.onClick();
  assert.equal(calls, 1); assert.equal(cancelled, 0);
  const pending = dialog.render();
  assert.equal(find(pending, element => element.props.role === 'alertdialog').props['aria-busy'], true);
  assert.equal(find(pending, element => element.type === 'button' && element.props.children === 'Cancel').props.disabled, true);
  finish(); await saving; dialog.render(); dialog.escape();
  assert.equal(cancelled, 1);
});

test('an inline row keeps edits on failure and blocks Enter, Escape and Cancel during the save', async () => {
  let reject, calls = 0, cancelled = 0;
  const row = mount({ fields: [{ key: 'name', label: 'Name', required: true }], colSpan: 2,
    initial: { name: 'Original' }, onCancel: () => cancelled++, onSave: values => {
      assert.equal(values.name, 'Edited name'); calls++; return new Promise((_, fail) => { reject = fail; });
    } }, InlineRowForm);
  find(row.render(), element => element.type === 'input').props.onChange({ target: { value: 'Edited name' } });
  const tree = row.render();
  const saving = find(tree, element => element.props['aria-label'] === 'Save').props.onClick();
  const keyboard = find(tree, element => element.props.onKeyDown).props.onKeyDown;
  keyboard({ key: 'Enter', preventDefault() {} }); keyboard({ key: 'Escape', preventDefault() {} });
  find(tree, element => element.props['aria-label'] === 'Cancel').props.onClick();
  assert.equal(calls, 1); assert.equal(cancelled, 0);
  assert.equal(find(row.render(), element => element.type === 'input').props.disabled, true);
  reject(new Error('Failed to fetch')); await saving;
  const failed = row.render();
  assert.equal(find(failed, element => element.type === 'input').props.value, 'Edited name');
  assert.match(renderToStaticMarkup(failed), /Check your connection and try again/);
  assert.equal(find(failed, element => element.type === 'input').props.disabled, false);
});
