import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Execute the real hook query/mutation functions without a browser or credentials. Only the
// framework boundary is replaced; all application helpers and query construction stay real.
const stubs = {
  '@tanstack/react-query': `export const useQuery = x => globalThis.auditQueryResult?.(x) ?? x;
    export const useInfiniteQuery = x => x; export const useMutation = x => x;
    export const useQueryClient = () => ({ invalidateQueries() {} });`,
  react: `export const useMemo = f => f(); export const useCallback = f => f;`,
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.auditDb.from(...args), rpc: (...args) => globalThis.auditDb.rpc(...args) };',
  AuthContext: 'export const useAuth = () => ({ employee: { id: "employee-1" }, user: { id: "user-1" } });',
  timeFormat: 'export const getHour12 = () => false;',
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.(jsx?|tsx?)$/, '');
    if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(`${specifier}.js`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    return next(specifier, context);
  },
});

const attendance = await import('./attendance.js');
const employeeAttendance = await import('./employeeAttendance.js');
const routines = await import('./routines.js');
const goals = await import('./goals.js');
const leaves = await import('./leaveTypes.js');
const shifts = await import('./shifts.js');
const tasks = await import('./tasks.js');
const devices = await import('./devices.js');
const regularizations = await import('./regularizations.js');
const team = await import('./team.js');
const assets = await import('./assets.js');
const help = await import('./helpRequests.js');
const org = await import('./org.js');
const messages = await import('./messages.js');
const comments = await import('./taskComments.js');
const attachments = await import('./taskAttachments.js');
const notifications = await import('./notifications.js');
const documents = await import('./documents.js');
const exits = await import('./exits.js');
const checklist = await import('./taskChecklist.js');
const importer = await import('./employeeImport.js');

function fixtureDb(tables, { serverCap = 97, rejectAtOffset = null, beforeRead } = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const conditions = []; const ordering = [];
      let from = 0; let end = Infinity; let limit = Infinity; let single = false;
      const q = {
        select() { return q; },
        order(column, options = {}) { ordering.push([column, options.ascending !== false]); return q; },
        eq(column, value) { conditions.push(r => r[column] === value); return q; },
        gte(column, value) { conditions.push(r => r[column] >= value); return q; },
        lte(column, value) { conditions.push(r => r[column] <= value); return q; },
        or(expression) {
          // Cursor comparison must account for identical timestamps across page boundaries.
          const cursor = expression.match(/^created_at\.lt\."([^"]+)",and\(created_at\.eq\."[^"]+",id\.lt\."([^"]+)"\)$/);
          if (cursor) conditions.push(r => r.created_at < cursor[1] || (r.created_at === cursor[1] && r.id < cursor[2]));
          return q;
        },
        in(column, values) { assert.ok(values.length <= 100, 'UUID query filter exceeds safe batch'); conditions.push(r => values.includes(r[column])); return q; },
        limit(value) { limit = value; return q; },
        range(start, finish) { from = start; end = finish; return q; },
        single() { single = true; return q; },
        update() { return q; }, delete() { return q; }, insert() { return q; },
        then(resolve, reject) {
          calls.push({ table, from, ordering });
          beforeRead?.({ table, request: calls.length });
          if (rejectAtOffset != null && from >= rejectAtOffset) {
            return Promise.resolve({ data: null, error: new Error('Access was revoked') }).then(resolve, reject);
          }
          const all = (tables[table] ?? []).filter(row => conditions.every(f => f(row))).sort((a, b) => {
            for (const [column, asc] of ordering) {
              if (a[column] === b[column]) continue;
              return (a[column] < b[column] ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
          const data = all.slice(from, Math.min(end + 1, from + serverCap, from + limit));
          const result = single ? data.length === 1 ? { data: data[0] }
            : { error: new Error('Expected one affected row') } : { data };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return q;
    },
  };
  globalThis.auditDb = db;
  return db;
}

test('675 employees and three daily duties each remain complete despite a 97-row API cap', async () => {
  const rows = Array.from({ length: 2025 }, (_, i) => ({
    id: `row-${String(i).padStart(5, '0')}`, employee_id: `employee-${i % 675}`,
    is_active: true, sort_order: i % 3, on_date: '2026-09-11', status: 'Active',
    work_date: '2026-09-11', check_in: '2026-09-11T04:00:00Z', year: 2026,
    department_id: 'dept-1', entity_id: 'company-1', link_status: i % 2 ? 'manual' : 'unmatched',
  }));
  const cases = [
    ['routine_items', () => routines.useRoutineItems()],
    ['routine_ticks', () => routines.useRoutineTicks('2026-09-11')],
    ['attendance', () => attendance.useDayAttendance('2026-09-11')],
    ['attendance', () => attendance.useAttendanceExceptions('2026-09-01', '2026-09-30')],
    ['goals', () => goals.useGoals()],
    ['leave_balances', () => leaves.useLeaveBalances(null, 2026, { all: true })],
    ['employee_shift_assignments', () => shifts.useShiftAssignments()],
    ['tasks', () => tasks.useTasks()],
    ['biotime_employees', () => devices.useDeviceMappings()],
    ['attendance_regularizations', () => regularizations.useRegularizations()],
    ['employees', () => team.useDepartmentMembers('dept-1')],
    ['assets', () => assets.useAssets()],
    ['help_requests', () => help.useHelpRequests()],
    ['documents', () => documents.useDocuments()],
    ['exits', () => exits.useExits()],
    ['department_moves', () => team.useDepartmentMoves('dept-1')],
  ];
  for (const [table, makeHook] of cases) {
    const db = fixtureDb({ [table]: rows });
    const result = await makeHook().queryFn();
    assert.equal(result.length, 2025, table);
    assert.equal(new Set(result.map(r => r.id)).size, 2025, `${table} duplicated rows`);
    assert.ok(db.calls.length > 20, `${table} did not page`);
    assert.ok(db.calls.every(c => c.ordering.at(-1)?.[0] === 'id'), `${table} has unstable ordering`);
  }
});

test('employee, status, date and year filters apply on every page', async () => {
  const rows = Array.from({ length: 675 }, (_, i) => ({
    id: i, employee_id: i % 3 ? 'other' : 'employee-1', status: i % 2 ? 'Pending' : 'Approved',
    work_date: '2026-09-11', year: 2026,
  }));
  fixtureDb({ attendance_regularizations: rows });
  const pending = await regularizations.useRegularizations('Pending', 'employee-1').queryFn();
  assert.equal(pending.length, 112);
  assert.ok(pending.every(r => r.employee_id === 'employee-1' && r.status === 'Pending'));
  const mine = await regularizations.useMyRegularizations('employee-1').queryFn();
  assert.equal(mine.length, 225);
  fixtureDb({ attendance: [...rows, { id: 999, employee_id: 'employee-1', work_date: '2025-01-01' }] });
  const days = await employeeAttendance.useEmployeeAttendance('employee-1', '2026-09-01', '2026-09-30').queryFn();
  assert.equal(days.length, 225);
  assert.equal(regularizations.useMyRegularizations(null).enabled, false);
  assert.equal(regularizations.useRegularizations(undefined, undefined, { enabled: false }).enabled, false);
  assert.equal(leaves.useLeaveBalances(undefined).enabled, false);
});

test('mapping counters and the complete org hierarchy reconcile above the server cap', async () => {
  const rows = Array.from({ length: 1350 }, (_, id) => ({ id, link_status: id % 2 ? 'manual' : 'unmatched' }));
  fixtureDb({ biotime_employees: rows });
  assert.deepEqual(await devices.useMappingCounts().queryFn(), {
    total: 1350, unmatched: 675, manual: 675, auto: 0, ambiguous: 0, ignored: 0,
  });
  fixtureDb(Object.fromEntries(['entities', 'zones', 'branches', 'departments', 'designations'].map(t => [t, rows])));
  const hierarchy = await org.useOrgAll().queryFn();
  assert.deepEqual(Object.values(hierarchy).map(r => r.length), [1350, 1350, 1350, 1350, 1350]);
});

test('later-page permission failures cannot turn into a successful partial roster', async () => {
  fixtureDb({ routine_items: Array.from({ length: 675 }, (_, id) => ({ id, is_active: true })) }, { rejectAtOffset: 97 });
  await assert.rejects(routines.useRoutineItems().queryFn(), /Access was revoked/);
});

test('RLS-filtered and stale decisions fail instead of closing the form as saved', async () => {
  fixtureDb({ goals: [], attendance_regularizations: [] });
  await assert.rejects(goals.useSaveGoal().mutationFn({ id: 'gone', title: 'New title' }), /affected row/);
  await assert.rejects(goals.useDeleteGoal().mutationFn('gone'), /affected row/);
  await assert.rejects(regularizations.useDecideRegularization().mutationFn({ id: 'gone', decision: 'Approved' }), /affected row/);
  fixtureDb({ attendance_regularizations: [{ id: 'decided', status: 'Approved' }] });
  await assert.rejects(regularizations.useDecideRegularization().mutationFn({ id: 'decided', decision: 'Rejected' }), /affected row/);
});

test('shift replacement is one atomic RPC and never closes assignments on an RPC failure', async () => {
  const calls = [];
  globalThis.auditDb = {
    from() { assert.fail('Shift replacement must not issue separate table writes'); },
    async rpc(name, params) { calls.push({ name, params }); return { data: 'assignment-1' }; },
  };
  const input = { employeeId: 'employee-1', shiftId: 'shift-1', effectiveFrom: '2026-09-11' };
  assert.equal(await shifts.useAssignShift().mutationFn(input), 'assignment-1');
  assert.deepEqual(calls, [{ name: 'assign_employee_shift', params: {
    _employee_id: 'employee-1', _shift_id: 'shift-1', _effective_from: '2026-09-11', _effective_to: null, _note: null,
  } }]);
  globalThis.auditDb.rpc = async () => ({ error: { code: 'PGRST202', message: 'Missing RPC' } });
  await assert.rejects(shifts.useAssignShift().mutationFn(input), /migration 0121/);
});

test('675 group members remain visible alongside 675 direct conversations', async () => {
  const conversations = Array.from({ length: 675 }, (_, i) => ({ id: `room-${i}`, last_message_at: '2026-09-11T00:00:00Z' }));
  const members = conversations.flatMap(c => [
    { conversation_id: c.id, employee_id: 'employee-1' },
    { conversation_id: c.id, employee_id: `colleague-${c.id}` },
  ]);
  members.push(...Array.from({ length: 675 }, (_, i) => ({ conversation_id: 'group', employee_id: `staff-${i}` })));
  fixtureDb({ my_conversations: [...conversations, { id: 'group' }], conversation_members: members });
  const result = await messages.useConversations().queryFn();
  assert.equal(result.conversations.length, 676);
  assert.equal(result.conversations.find(c => c.id === 'group').members.length, 675);
  assert.ok(result.conversations.filter(c => c.id !== 'group').every(c => c.members.length === 2));
});

test('task comment and attachment counters count every related row with bounded UUID filters', async () => {
  const ids = Array.from({ length: 225 }, (_, i) => `task-${i}`);
  const related = ids.flatMap((task_id, i) => Array.from({ length: 12 }, (_, j) => ({ id: `${i}-${j}`, task_id })));
  fixtureDb({ task_comments: related, task_attachments: related });
  for (const hook of [comments.useTaskCommentCounts, attachments.useTaskAttachmentCounts]) {
    const counts = await hook(ids).queryFn();
    assert.equal(Object.keys(counts).length, 225);
    assert.ok(Object.values(counts).every(n => n === 12));
  }
  fixtureDb({ task_attachments: related, task_checklist_items: related });
  assert.equal((await attachments.useTaskAttachments('task-224').queryFn()).length, 12);
  assert.equal((await checklist.useChecklist('task-224').queryFn()).length, 12);
});

test('all 675 messages are reachable exactly once, including timestamp ties and a 97-row server cap', async () => {
  const input = Array.from({ length: 675 }, (_, i) => ({
    id: `message-${String(i).padStart(4, '0')}`, conversation_id: 'room-1',
    created_at: '2026-09-11T09:00:00Z', body: `Message ${i}`,
  }));
  fixtureDb({ messages: [...input, { id: 'other-room', conversation_id: 'room-2', created_at: '2026-09-12T09:00:00Z' }] });
  const hook = messages.useMessages('room-1');
  const pages = [];
  let pageParam = null;
  do {
    const page = await hook.queryFn({ pageParam });
    pages.push(page);
    pageParam = hook.getNextPageParam(page);
  } while (pageParam);
  assert.deepEqual(pages.map(p => p.messages.length), [200, 200, 200, 75]);
  const actual = pages.flatMap(p => p.messages).reverse();
  assert.deepEqual(actual, input);
  assert.equal(new Set(actual.map(r => r.id)).size, 675);
});

test('new messages arriving during a capped page refill do not duplicate or shift older messages', async () => {
  const input = Array.from({ length: 675 }, (_, i) => ({
    id: `message-${String(i).padStart(4, '0')}`, conversation_id: 'room-1',
    created_at: '2026-09-11T09:00:00Z', body: `Message ${i}`,
  }));
  const expected = input.slice(-200).reverse();
  const db = fixtureDb({ messages: input }, { beforeRead: ({ request }) => {
    if (request === 2) input.push({ id: 'message-9999', conversation_id: 'room-1', created_at: '2026-09-11T10:00:00Z' });
  } });
  const page = await messages.useMessages('room-1').queryFn({ pageParam: null });
  assert.deepEqual(page.messages, expected);
  assert.ok(page.nextCursor);
  assert.ok(db.calls.every(call => call.from === 0), 'refills use the last received cursor, never offsets');
});

test('a failed notification-status lookup keeps the actionable notification visible', () => {
  const notification = { id: 'n1', type: 'leave', ref_id: 'leave-1', title: 'Leave requested', read_at: null };
  globalThis.auditQueryResult = (options) => options.queryKey[0] === 'notifications'
    ? { data: [notification] } : { isFetched: true, isSuccess: false, error: new Error('Network offline') };
  try {
    assert.deepEqual(notifications.useActionableNotifications().data, [notification]);
  } finally {
    delete globalThis.auditQueryResult;
  }
});

test('imported calendar dates retain their day in IST and invalid dates name the spreadsheet row', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    const rows = [['Employee Name', 'Join Date', 'DOB'], ['Person', new Date(2026, 8, 1), '29/02/2000']];
    const [person] = importer.extractPeople(rows, importer.detectLayout(rows));
    assert.equal(person.join_date, '2026-09-01');
    assert.equal(person.date_of_birth, '2000-02-29');
    for (const bad of ['31/02/2026', '2026-02-29', '00/10/2026', '2026-13-01', 'garbage']) {
      rows[1][1] = bad;
      assert.throws(() => importer.extractPeople(rows, importer.detectLayout(rows)), /Invalid join date on spreadsheet row 2/);
    }
    rows[1][1] = '';
    assert.equal(importer.extractPeople(rows, importer.detectLayout(rows))[0].join_date, null);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
