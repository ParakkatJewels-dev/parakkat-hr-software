import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = x => x; export const useMutation = x => x; export const useQueryClient = () => ({ cancelQueries: async () => {}, invalidateQueries: ({queryKey}) => { globalThis.routineInvalidations.push(queryKey); } });',
  supabaseClient: 'export const supabase = { rpc: (...args) => globalThis.routineDb.rpc(...args), from: () => { throw new Error("Direct writes forbidden"); } };',
  AuthContext: 'export const useAuth = () => ({ employee: { id: "current-employee" } });',
};
registerHooks({ resolve(specifier, context, next) {
  const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.jsx?$/, '');
  if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.js`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const hooks = await import('./routines.js');

function mockPages(rows, cap, failAt = Infinity) {
  const calls = [];
  globalThis.routineDb = { rpc(name, args) {
    const order = [];
    return { order(column) { order.push(column); return this; }, range(start, end) {
      calls.push({ name, args, order, start });
      return Promise.resolve(start >= failAt ? { error: new Error('Routine access changed') }
        : { data: rows.slice(start, Math.min(end + 1, start + cap)) });
    } };
  } };
  return calls;
}

test('routine day, sets and stats retain all rows under tiny API caps with stable scoped requests', async () => {
  const rows = Array.from({ length: 32 }, (_, i) => ({ id: `row-${String(i).padStart(2, '0')}` }));
  for (const cap of [1, 7]) {
    for (const [query, name, args] of [
      [hooks.useRoutineDay('2026-10-02', { employeeId: 'self' }), 'routine_day', { _on_date: '2026-10-02', _employee_id: 'self' }],
      [hooks.useRoutineSets({ employeeId: 'self', includeRetired: true }), 'list_routine_sets', { _employee_id: 'self', _include_retired: true }],
      [hooks.useRoutineStats('2026-10-01', '2026-10-31', { employeeIds: ['b', 'a', 'a'] }), 'routine_completion_stats', { _from: '2026-10-01', _to: '2026-10-31', _employee_ids: ['a', 'b'] }],
    ]) {
      const calls = mockPages(rows, cap);
      assert.deepEqual(await query.queryFn(), rows);
      assert.ok(calls.length > 4);
      assert.ok(calls.every(call => call.name === name && call.order.join() === 'id'));
      assert.deepEqual(calls[0].args, args);
    }
  }
});

test('a failed later routine page rejects the whole result instead of publishing partial statistics', async () => {
  mockPages(Array.from({ length: 15 }, (_, i) => ({ id: `row-${i}` })), 3, 5);
  await assert.rejects(hooks.useRoutineStats('2026-10-01', '2026-10-31').queryFn(), /Routine access changed/);
});

test('routine completion never sends employee, actor or timestamp supplied by the caller', async () => {
  const calls = [];
  globalThis.routineDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: null }; } };
  for (const done of [true, false]) await hooks.useSetRoutineTick().mutationFn({ itemId: 'job-1', onDate: '2026-10-02', done,
    employeeId: 'forged-owner', done_by: 'forged-reviewer', done_at: '2020-01-01' });
  assert.deepEqual(calls, [true, false].map(done => ({ name: 'set_routine_job_tick', args: { _item_id: 'job-1', _on_date: '2026-10-02', _done: done } })));
});

test('bulk routine creation is one atomic RPC and all routine projections refresh after writes', async () => {
  const calls = [];
  globalThis.routineDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: { assigned_count: 2 } }; } };
  const jobs = [{ title: 'Unlock', sort_order: 0 }, { title: 'Inspect', sort_order: 1 }];
  const schedule = { frequency: 'weekly', weekdays: [1, 5], start_date: '2026-10-02' };
  await hooks.useCreateRoutineSet().mutationFn({ employeeIds: ['one', 'two', 'one'], title: ' Opening ', detail: ' ', jobs, schedule });
  assert.deepEqual(calls, [{ name: 'create_routine_set', args: { _employee_ids: ['one', 'two'], _title: 'Opening', _detail: null, _jobs: jobs, _schedule: schedule } }]);
  for (const hook of [hooks.useSetRoutineTick, hooks.useCreateRoutineSet, hooks.useReplaceRoutineSet, hooks.useRetireRoutineSet]) {
    globalThis.routineInvalidations = [];
    await hook().onSuccess();
    for (const key of ['routine-day', 'routine-sets', 'routine-stats']) assert.ok(globalThis.routineInvalidations.some(prefix => prefix[0] === key));
  }
});

test('routine permission and date refusals remain visible to the user', async () => {
  const error = { code: '42501', message: 'You cannot complete jobs for this employee.' };
  globalThis.routineDb = { rpc: async () => ({ error }) };
  await assert.rejects(hooks.useSetRoutineTick().mutationFn({ itemId: 'job', done: true }), result => result === error);
});

test('routine note history and audit reads page every record with bounded date and owner filters', async () => {
  const rows = Array.from({ length: 21 }, (_, id) => ({ id: `note-${id}`, body: 'Explanation' }));
  for (const [query, name, args] of [
    [hooks.useRoutineNotes('routine-1', '2026-09-28'), 'list_routine_notes', { _routine_id: 'routine-1', _on_date: '2026-09-28' }],
    [hooks.useRoutineNoteAudit('2026-09-01', '2026-09-28', { employeeId: 'self' }), 'list_routine_note_audit',
      { _from: '2026-09-01', _to: '2026-09-28', _employee_id: 'self' }],
  ]) {
    const calls = mockPages(rows, 3);
    assert.deepEqual(await query.queryFn(), rows);
    assert.deepEqual(calls[0].args, args);
    assert.ok(calls.every(call => call.name === name && call.order.at(-1) === 'id'));
  }
  mockPages(rows, 3, 5);
  await assert.rejects(hooks.useRoutineNotes('routine-1', '2026-09-28').queryFn(), /access changed/);
  assert.equal(hooks.useRoutineNotes(null, '2026-09-28').enabled, false);
  assert.equal(hooks.useRoutineNoteAudit('', '2026-09-28').enabled, false);
});

test('adding a note sends only text, date, routine and retry ID; completion and author are server-owned', async () => {
  const calls = [];
  globalThis.routineDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: 'saved-note' }; } };
  globalThis.routineInvalidations = [];
  const add = hooks.useAddRoutineNote();
  assert.equal(await add.mutationFn({ routineId: 'routine-1', onDate: '2026-09-28', body: ' Waiting for delivery ', clientId: 'retry-id',
    employeeId: 'other', author_user: 'forged', completed_jobs: 99, created_at: '2000-01-01' }), 'saved-note');
  assert.deepEqual(calls, [{ name: 'add_routine_note', args: { _routine_id: 'routine-1', _on_date: '2026-09-28', _body: 'Waiting for delivery', _client_id: 'retry-id' } }]);
  await add.onSuccess();
  assert.deepEqual(globalThis.routineInvalidations, [['routine-notes']], 'notes do not mark any job complete');
});

test('routine notes expose migration, permission and ambiguous-save failures without inventing a saved record', async () => {
  globalThis.routineDb = { rpc: async () => ({ error: { code: 'PGRST202' } }) };
  await assert.rejects(hooks.useAddRoutineNote().mutationFn({ body: 'Note' }), /routine notes database update/);
  const refused = { code: '42501', message: 'Only your own routine' };
  globalThis.routineDb.rpc = async () => ({ error: refused });
  await assert.rejects(hooks.useAddRoutineNote().mutationFn({ body: 'Note' }), error => error === refused);
  globalThis.routineDb.rpc = async () => ({ data: null });
  await assert.rejects(hooks.useAddRoutineNote().mutationFn({ body: 'Note' }), /could not be saved/);
});
