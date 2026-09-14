// This deliberately small adapter tests rendering and controls, not Supabase/RLS semantics.
// Unknown mutations fail closed; fixtures never connect to a database or send email.
import { fixture, tables, mobileFixtures, chatFixtures, developerFixtures, developerFixture } from './fixtures.js';
import { qaRole, roleMode, qaAccess, fixtureAllows, qaVisibleEmployees } from './roles.js';
import { createPasswordRecoveryState, capturePasswordRecovery } from '../src/lib/passwordRecovery.js';
export const isSupabaseConfigured = true;
export const qaState = { failReads: new URL(window.location.href).searchParams.has('qa-fail'), reads: 0, mutations: 0 };
const user = { id: `qa-user-v3-${qaRole}${mobileFixtures ? '-mobile' : ''}${chatFixtures ? '-chat' : ''}${developerFixtures ? '-developer' : ''}${qaState.failReads ? '-offline' : ''}`, email: 'qa@example.test', user_metadata: {} };
let session = { user, access_token: 'synthetic-only', expires_at: 9999999999 };
const listeners = new Set();
const emit = (event) => listeners.forEach((cb) => cb(event, session));
const emptyChannel = { on() { return this; }, subscribe() { return this; }, unsubscribe() {} };
class Query {
  constructor(rows, table) { this.rows = rows; this.table = table; this.filters = []; this.orders = []; this.start = 0; this.size = Infinity; }
  select(_fields, options = {}) { this.head = options.head; return this; }
  abortSignal() { return this; }
  eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
  neq(k, v) { this.filters.push((r) => r[k] !== v); return this; }
  gte(k, v) { this.filters.push((r) => r[k] >= v); return this; }
  lte(k, v) { this.filters.push((r) => r[k] <= v); return this; }
  gt(k, v) { this.filters.push((r) => r[k] > v); return this; }
  lt(k, v) { this.filters.push((r) => r[k] < v); return this; }
  in(k, values) { this.filters.push((r) => values.includes(r[k])); return this; }
  is(k, v) { this.filters.push((r) => (r[k] ?? null) === v); return this; }
  not(k, _op, v) { this.filters.push((r) => (r[k] ?? null) !== v); return this; }
  ilike(k, v) { this.filters.push((r) => String(r[k] ?? '').toLowerCase().includes(v.replaceAll('%', '').toLowerCase())); return this; }
  or(expression) {
    const cursor = expression.match(/^created_at\.lt\."([^"]+)",and\(created_at\.eq\."[^"]+",id\.lt\."([^"]+)"\)$/);
    if (cursor) this.filters.push((r) => r.created_at < cursor[1] || (r.created_at === cursor[1] && r.id < cursor[2]));
    return this;
  }
  contains() { return this; }
  order(k, options = {}) { this.orders.push([k, options.ascending !== false ? 1 : -1]); return this; }
  range(from, to) { this.start = from; this.size = to - from + 1; return this; }
  limit(n) { this.size = n; return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.one = true; return this; }
  insert(payload) { this.write = true; this.operation = 'insert'; this.payload = payload; return this; }
  update() { this.write = true; return this; }
  delete() { this.write = true; this.operation = 'delete'; return this; }
  upsert(payload) { this.write = true; this.operation = 'upsert'; this.payload = payload; return this; }
  then(resolve, reject) {
    qaState.reads += 1;
    if (this.write) qaState.mutations += 1;
    if (this.write && chatFixtures && !qaState.failReads && this.table === 'messages' && this.operation === 'insert'
        && !new URL(window.location.href).searchParams.has('qa-block-write')) {
      const message = this.payload;
      const chat = tables.conversations.find((row) => row.id === message?.conversation_id);
      const validReply = !message?.reply_to || tables.messages.some((row) => row.id === message.reply_to && row.conversation_id === chat?.id);
      if (chat && message.sender_id === fixture.employees[0].id && message.kind === 'text'
          && typeof message.body === 'string' && message.body.trim() && message.body.length <= 4000 && validReply) {
        const created = { ...message, id: `qa-sent-${tables.messages.length + 1}`, sender: fixture.employees[0], created_at: new Date().toISOString() };
        tables.messages.push(created);
        Object.assign(chat, { last_message_at: created.created_at, last_message_created_at: created.created_at,
          last_body: created.body, last_kind: 'text', last_sender_id: created.sender_id, last_message_id: created.id });
        return Promise.resolve({ data: [created], error: null }).then(resolve, reject);
      }
    }
    // The explicit phone fixture may complete/reopen its own synthetic routines in memory.
    // This is only a UI state check; database permissions are covered by the SQL suite.
    if (this.write && mobileFixtures && !qaState.failReads && this.table === 'routine_ticks'
        && !new URL(window.location.href).searchParams.has('qa-block-write')) {
      let changed = [];
      if (this.operation === 'upsert' && this.payload.employee_id === fixture.employees[0].id) {
        const existing = tables.routine_ticks.find((row) => row.routine_item_id === this.payload.routine_item_id && row.on_date === this.payload.on_date);
        if (existing) changed = [existing];
        else {
          const row = { ...this.payload, id: `qa-tick-${tables.routine_ticks.length}`, done_at: new Date().toISOString() };
          tables.routine_ticks.push(row); changed = [row];
        }
      } else if (this.operation === 'delete') {
        changed = tables.routine_ticks.filter((row) => row.employee_id === fixture.employees[0].id && this.filters.every((filter) => filter(row)));
        tables.routine_ticks.splice(0, tables.routine_ticks.length, ...tables.routine_ticks.filter((row) => !changed.includes(row)));
      }
      return Promise.resolve({ data: changed, error: null }).then(resolve, reject);
    }
    if (this.write || qaState.failReads) return Promise.resolve({ data: null,
      error: { message: this.write ? 'QA mode: this write is intentionally blocked.' : 'QA simulated connection failure' } }).then(resolve, reject);
    const rows = this.rows.filter((r) => this.filters.every((f) => f(r))).sort((a, b) => {
      for (const [k, direction] of this.orders) {
        if (a[k] < b[k]) return -direction;
        if (a[k] > b[k]) return direction;
      }
      return 0;
    });
    const page = rows.slice(this.start, this.start + Math.min(this.size, 1000));
    return Promise.resolve({ data: this.head ? null : this.one ? page[0] ?? null : page,
      count: rows.length, error: null }).then(resolve, reject);
  }
}
const tablePermissions = { employees: 'employee.read', attendance: 'attendance.read', leaves: 'leave.read',
  attendance_regularizations: 'attendance.read', payslips: 'payslip.read', salary_structures: 'payroll.manage',
  goals: 'goal.read', tasks: 'task.read', leave_balances: 'leave.read' };
export const supabase = {
  from(name) {
    let rows = tables[name] ?? [];
    if (roleMode && tablePermissions[name]) rows = rows.filter((row) => fixtureAllows(tablePermissions[name], row));
    return new Query(rows, name);
  },
  rpc(name, args = {}) {
    if (name === 'get_my_access') return Promise.resolve({ data: qaAccess, error: null });
    if (qaRole === 'super_admin' && name === 'get_developer_settings') return new Query([{ ...developerFixture.settings }]).single();
    if (qaRole === 'super_admin' && name === 'list_developer_api_keys') return new Query(developerFixture.keys.map(key => ({ ...key })));
    if (developerFixtures && qaRole === 'super_admin' && !qaState.failReads && !new URL(window.location.href).searchParams.has('qa-block-write')) {
      if (name === 'set_developer_settings' && typeof args._enabled === 'boolean') {
        Object.assign(developerFixture.settings, { enabled: args._enabled, updated_at: new Date().toISOString() });
        qaState.mutations += 1;
        return new Query([{ ...developerFixture.settings }]).single();
      }
      if (name === 'create_developer_api_key' && typeof args._name === 'string' && args._name.trim() && args._name.length <= 80
          && Array.isArray(args._scopes) && args._scopes.length && args._scopes.every(scope => ['employees:read', 'organization:read', 'attendance:read'].includes(scope))
          && (!args._entity_id || fixture.org.entities.some(entity => entity.id === args._entity_id)) && [30, 90, 365].includes(args._expires_in_days)) {
        const key = { id: `qa-key-created-${developerFixture.keys.length}`, name: args._name.trim(), key_prefix: 'qa_nonfunctional_',
          scopes: [...args._scopes], entity_id: args._entity_id ?? null, created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + args._expires_in_days * 86400000).toISOString(), last_used_at: null, revoked_at: null };
        developerFixture.keys.unshift(key); qaState.mutations += 1;
        // This synthetic string is deliberately unusable by the real API. Only metadata is retained.
        return new Query([{ api_key: `qa_nonfunctional_${key.id}_synthetic_only`, key: { ...key } }]).single();
      }
      if (name === 'revoke_developer_api_key') {
        const key = developerFixture.keys.find(key => key.id === args._key_id);
        if (key) { key.revoked_at = new Date().toISOString(); qaState.mutations += 1; return new Query([]).single(); }
      }
    }
    if (chatFixtures && !qaState.failReads && !new URL(window.location.href).searchParams.has('qa-block-write')) {
      const chat = tables.conversations.find((row) => row.id === args._conversation_id);
      const ownMember = chat && tables.conversation_members.some((member) => member.conversation_id === chat.id && member.employee_id === fixture.employees[0].id);
      if (name === 'set_chat_preference' && ownMember) {
        const saved = tables.chat_preferences.find((row) => row.conversation_id === chat.id)
          ?? { conversation_id: chat.id, is_pinned: false, is_favourite: false };
        for (const [arg, field] of [['_is_pinned', 'is_pinned'], ['_is_favourite', 'is_favourite']]) {
          if (typeof args[arg] === 'boolean') saved[field] = args[arg];
        }
        if (!tables.chat_preferences.includes(saved)) tables.chat_preferences.push(saved);
        qaState.mutations += 1;
        return Promise.resolve({ data: [{ ...saved }], error: null });
      }
      if (name === 'search_chat_messages' && ownMember) {
        const query = String(args._query ?? '').trim().toLowerCase();
        const cursor = args._before_at && args._before_id;
        if (Boolean(args._before_at) !== Boolean(args._before_id)) return Promise.resolve({ data: null, error: { message: 'Both search cursor fields are required.' } });
        const found = query ? tables.messages.filter((row) => row.conversation_id === chat.id && !row.deleted_at
          && String(row.body ?? '').toLowerCase().includes(query)
          && (!cursor || row.created_at < args._before_at || (row.created_at === args._before_at && row.id < args._before_id)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
          .slice(0, Math.max(1, Math.min(51, args._limit ?? 51))) : [];
        qaState.reads += 1;
        return Promise.resolve({ data: found, error: null });
      }
      if (name === 'set_chat_typing' && ownMember && typeof args._typing === 'boolean') {
        const own = tables.chat_typing.find((row) => row.conversation_id === chat.id && row.employee_id === fixture.employees[0].id)
          ?? { id: `qa-typing-${chat.id}`, conversation_id: chat.id, employee_id: fixture.employees[0].id };
        Object.assign(own, { is_typing: args._typing, updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + (args._typing ? 6000 : 0)).toISOString() });
        if (!tables.chat_typing.includes(own)) tables.chat_typing.push(own);
        qaState.mutations += 1;
        return Promise.resolve({ data: null, error: null });
      }
    }
    if (name === 'messaging_directory') {
      const query = String(args._query ?? '').trim().toLowerCase();
      return new Query(fixture.employees.filter((employee) => employee.id !== fixture.employees[0].id)
        .map(({ id, full_name, employee_code, branch_id, branch }) => ({ id, full_name, employee_code, branch_id, branch_code: branch?.code }))
        .filter((person) => !query || [person.full_name, person.employee_code, person.branch_code].some((value) => String(value ?? '').toLowerCase().includes(query))));
    }
    if (name === 'messaging_members') {
      return new Query(tables.conversation_members.filter((member) => args._conversation_ids?.includes(member.conversation_id)));
    }
    if (name === 'list_managed_users') return new Query(roleMode ? fixture.users.filter((user) => qaVisibleEmployees.some((e) => e.id === user.employee_id)) : fixture.users);
    if (name === 'my_departments') return new Query(roleMode ? fixture.org.departments.filter((d) => qaVisibleEmployees.some((e) => e.department_id === d.id)) : fixture.org.departments);
    if (name === 'report_attendance_exceptions') return new Query([{ absent: 105, late: 0, missing_punch: 0 }]);
    if (name === 'report_attendance_summary') return new Query([]);
    if (/^(list_|get_|department_|assignable_)/.test(name)) return new Query([]);
    qaState.mutations += 1;
    return Promise.resolve({ data: null, error: { message: `QA mode: ${name} is intentionally blocked.` } });
  },
  auth: {
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    onAuthStateChange(cb) { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
    async signOut() { session = null; emit('SIGNED_OUT'); return { error: null }; },
    async signInWithPassword({ email, password }) {
      if (email !== 'qa@example.test' || password !== 'SyntheticQA123!') return { error: { message: 'Invalid login credentials' } };
      session = { user, access_token: 'synthetic-only' }; emit('SIGNED_IN'); return { data: { session }, error: null };
    },
    resetPasswordForEmail: async () => ({ error: { message: 'QA mode: email delivery is intentionally blocked.' } }),
    updateUser: async () => ({ error: { message: 'QA mode: password writes are intentionally blocked.' } }),
  },
  realtime: { setAuth() {} }, channel: () => emptyChannel, removeChannel() {},
  storage: { from: (bucket) => ({ createSignedUrl: async (path) => chatFixtures && bucket === 'chat-media' && path === 'qa-media/sample-shift-roster.pdf'
    ? { data: { signedUrl: 'data:text/plain;charset=utf-8,Synthetic%20QA%20shift%20roster.%20No%20employee%20data.' }, error: null }
    : { data: null, error: null },
    createSignedUrls: async () => ({ data: [], error: null }) }) },
  functions: { invoke: async () => ({ error: { message: 'QA mode: external functions are intentionally blocked.' } }) },
};

export const passwordRecoveryCapture = capturePasswordRecovery(supabase.auth,
  createPasswordRecoveryState({ href: window.location.href }));
