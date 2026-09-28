import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const sourceUrl = new URL('./RoutineNotes.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: 'export const useState = value => globalThis.routineNotesTest.state(value); export const useRef = value => globalThis.routineNotesTest.state({current:value})[0]; export const useId = () => "routine-note-input";',
  'lucide-react': 'export const MessageSquarePlus="icon";',
  '../data/routines': 'export const useRoutineNotes = (...args) => { globalThis.routineNotesTest.reads.push(args); return globalThis.routineNotesTest.query; }; export const useAddRoutineNote = () => globalThis.routineNotesTest.mutation;',
  '../lib/dbErrors': `export { humanDbError } from ${JSON.stringify(new URL('../lib/dbErrors.js', import.meta.url).href)};`,
  './ui/FormSection': 'export default "routine-note-form"; export const FIELD="field";',
  './ui/Btn': 'export const btnClass = () => "button";',
  './ui/Pagination': 'export default "routine-note-pagination"; export const usePagination = (...args) => globalThis.routineNotesTest.paginate(...args);',
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
const { default: RoutineNotes, RoutineNoteEntry } = await import(sourceUrl.href);
after(() => { loader.deregister(); delete globalThis.routineNotesTest; });

function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
function text(element) {
  if (element == null || typeof element === 'boolean') return '';
  if (Array.isArray(element)) return element.map(text).join('');
  if (!React.isValidElement(element)) return String(element);
  return text(element.props.children);
}
const today = '2026-09-28';
const note = {
  id: 'note-1', routine_id: 'routine-1', on_date: today, body: 'Stock check complete.\nWaiting for the delivery.',
  author_name: 'Asha', created_at: '2026-09-28T06:30:00Z', completed_jobs: 1, total_jobs: 3,
  routine_name: 'Opening checks', employee: { full_name: 'Asha Nair', employee_code: 'EMP012' },
};

function mount(options = {}) {
  const slots = []; let cursor = 0;
  let props = { routineId: 'routine-1', onDate: today, today, canAdd: true, routineName: 'Opening checks', ...options.props };
  const writes = [], reads = [], pages = [], paginations = [];
  const query = { data: options.notes ?? [], isLoading: false, isFetching: false, error: null, refetch: () => { query.retries++; }, retries: 0, ...options.query };
  const mutation = { isPending: false, mutateAsync: async (payload) => { writes.push(payload); return options.save?.(payload); } };
  const harness = {
    query, mutation, reads,
    state(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    paginate(rows, size, focus, key) {
      paginations.push({ size, focus, key });
      return { slice: rows.slice(0, size), count: rows.length, setPage: page => pages.push(page) };
    },
  };
  const render = (changes = {}) => { props = { ...props, ...changes }; cursor = 0; globalThis.routineNotesTest = harness; return RoutineNotes(props); };
  const form = () => find(render(), element => element.type === 'routine-note-form');
  const button = label => find(render(), element => element.type === 'button' && text(element) === label);
  const input = () => find(render(), element => element.type === 'textarea');
  return { render, form, button, input, query, mutation, writes, reads, pages, paginations,
    open() { const control = button('Add note'); assert.ok(control); control.props.onClick(); },
    change(value) { const field = input(); assert.ok(field); field.props.onChange({ target: { value } }); },
    submit() { return form().props.onSubmit({ preventDefault() {} }); },
  };
}

test('employees save a trimmed note for the displayed occurrence and start a fresh draft after success', async () => {
  const view = mount();
  view.open(); view.change('  Delivery is delayed.\nOnly the stock check is done.  ');
  assert.equal(view.form().props.submitLabel, 'Save note');
  assert.equal(view.input().props.maxLength, 4000);
  await view.submit();
  assert.equal(view.writes.length, 1);
  assert.deepEqual(view.writes[0], { routineId: 'routine-1', onDate: today,
    body: 'Delivery is delayed.\nOnly the stock check is done.', clientId: view.writes[0].clientId });
  assert.match(view.writes[0].clientId, /^[a-f\d-]{36}$/i);
  assert.equal(view.form(), null);
  assert.match(text(view.render()), /Note saved\. Routine completion is unchanged\./);
  assert.deepEqual(view.pages, [1]);
  assert.deepEqual(view.reads[0], ['routine-1', today, { enabled: true }]);
  view.open(); assert.equal(view.input().props.value, '');
});

test('blank and overlong drafts cannot be saved; ordinary past-date explanations are allowed', async () => {
  const view = mount({ props: { onDate: '2026-09-27' } });
  view.open();
  for (const body of ['   \n ', 'a'.repeat(4001)]) {
    view.change(body); assert.equal(view.form().props.disabled, true);
    await view.submit();
  }
  assert.equal(view.writes.length, 0);
  view.change('Reason recorded after the shift.');
  await view.submit();
  assert.equal(view.writes[0].onDate, '2026-09-27');
});

test('immediate repeated submission, cancel and field edits cannot interrupt an in-flight note', async () => {
  let finish;
  const view = mount({ save: () => new Promise(resolve => { finish = resolve; }) });
  view.open(); view.change('Waiting for a replacement.');
  const form = view.form();
  const pending = form.props.onSubmit({ preventDefault() {} });
  await form.props.onSubmit({ preventDefault() {} });
  form.props.onClose();
  view.change('Changed while saving');
  assert.equal(view.writes.length, 1);
  assert.equal(view.input().props.value, 'Waiting for a replacement.');
  assert.ok(view.form());
  finish(); await pending;
  assert.equal(view.form(), null);
});

test('an unchanged draft retains its request ID across failures and a retry clears it only after success', async () => {
  let count = 0;
  const failure = new Error('Failed to fetch');
  const view = mount({ save: async () => { if (++count === 1) throw failure; } });
  view.open(); view.change('One job is awaiting a part.');
  await view.submit();
  assert.equal(view.input().props.value, 'One job is awaiting a part.');
  assert.equal(view.form().props.error, failure);
  assert.doesNotMatch(text(view.render()), /Note saved/);
  await view.submit();
  assert.equal(view.writes.length, 2);
  assert.equal(view.writes[0].clientId, view.writes[1].clientId);
  assert.equal(view.form(), null);
});

test('editing after a failed attempt creates a new ID, so a correction cannot collide with an accepted request', async () => {
  const view = mount({ save: async () => { throw new Error('Failed to fetch'); } });
  view.open(); view.change('Waiting for a part.'); await view.submit();
  view.change('Update: the part has arrived.'); await view.submit();
  assert.notEqual(view.writes[0].clientId, view.writes[1].clientId);
  assert.equal(view.writes[1].body, 'Update: the part has arrived.');
  assert.equal(view.input().props.value, 'Update: the part has arrived.');
});

test('whitespace-only edits and reverted drafts retain the retry ID after an uncertain response', async () => {
  const view = mount({ save: async () => { throw new Error('Failed to fetch'); } });
  view.open(); view.change('Waiting for a part.'); await view.submit();
  view.change('  Waiting for a part.\n'); await view.submit();
  view.change('A different explanation.');
  view.change('Waiting for a part.'); await view.submit();
  assert.equal(view.writes.length, 3);
  assert.ok(view.writes.every(write => write.body === 'Waiting for a part.'));
  assert.ok(view.writes.every(write => write.clientId === view.writes[0].clientId));
});

test('read-only managers and future occurrences cannot compose; saved notes remain visible', () => {
  for (const props of [{ canAdd: false }, { onDate: '2026-09-29' }, { routineId: null }]) {
    const view = mount({ notes: [note], props });
    assert.equal(view.button('Add note'), null);
    assert.equal(view.form(), null);
    assert.ok(find(view.render(), element => element.type === RoutineNoteEntry));
  }
});

test('read errors never claim an empty history and retry only refetches the selected notes', () => {
  const view = mount({ query: { error: new Error('Routine notes are not available yet. Ask your administrator to apply the database update.') } });
  assert.match(text(view.render()), /Notes could not be loaded.*database update/);
  assert.doesNotMatch(text(view.render()), /No notes for/);
  view.button('Try again').props.onClick();
  assert.equal(view.query.retries, 1);
  assert.equal(view.writes.length, 0);
  view.query.data = [note];
  assert.match(text(view.render()), /The notes may be out of date/);
  assert.ok(find(view.render(), element => element.type === RoutineNoteEntry));
  view.query.isFetching = true;
  assert.equal(view.button('Try again').props.disabled, true);
});

test('loading notes does not display a misleading empty state and history is limited to five rows initially', () => {
  const loading = mount({ query: { isLoading: true } });
  assert.match(text(loading.render()), /Loading notes/);
  assert.doesNotMatch(text(loading.render()), /No notes for/);
  const view = mount({ notes: Array.from({ length: 12 }, (_, index) => ({ ...note, id: `note-${index}` })) });
  const tree = view.render();
  const history = find(tree, element => element.props['aria-label'] === 'Saved routine notes');
  assert.equal(React.Children.toArray(history.props.children).length, 5);
  const pager = find(tree, element => element.type === 'routine-note-pagination');
  assert.deepEqual(pager.props.sizes, [5, 10]);
  assert.equal(pager.props.count, 12);
  assert.equal(view.paginations[0].key, `routine-1:${today}`);
});

test('audit entries show immutable server time, occurrence date, author and completion snapshot with escaped multiline text', () => {
  const html = renderToStaticMarkup(RoutineNoteEntry({ note: { ...note, body: '<script>bad()</script>\nPending delivery.' }, showEmployee: true, showRoutine: true }));
  assert.match(html, /Opening checks/);
  assert.match(html, /Asha Nair.*EMP012/);
  assert.match(html, /Asha/);
  assert.match(html, /dateTime="2026-09-28T06:30:00Z"/);
  assert.match(html, /12:00 pm IST/i);
  assert.match(html, /For 2026-09-28.*1 of 3 jobs complete when noted/);
  assert.match(html, /whitespace-pre-wrap/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;\nPending delivery/);
  assert.doesNotMatch(html, /<script>|<button|contenteditable/);
});
