// This deliberately small adapter tests rendering and controls, not Supabase/RLS semantics.
// Unknown mutations fail closed; fixtures never connect to a database or send email.
import { fixture, tables } from './fixtures.js';
import { qaRole, roleMode, qaAccess, fixtureAllows, qaVisibleEmployees } from './roles.js';
export const isSupabaseConfigured = true;
export const qaState = { failReads: new URL(window.location.href).searchParams.has('qa-fail'), reads: 0, mutations: 0 };
const user = { id: `qa-user-v2-${qaRole}${qaState.failReads ? '-offline' : ''}`, email: 'qa@example.test', user_metadata: {} };
let session = { user, access_token: 'synthetic-only', expires_at: 9999999999 };
const listeners = new Set();
const emit = (event) => listeners.forEach((cb) => cb(event, session));
const emptyChannel = { on() { return this; }, subscribe() { return this; }, unsubscribe() {} };
class Query {
  constructor(rows) { this.rows = rows; this.filters = []; this.orders = []; this.start = 0; this.size = Infinity; }
  select(_fields, options = {}) { this.head = options.head; return this; }
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
  insert() { this.write = true; return this; }
  update() { this.write = true; return this; }
  delete() { this.write = true; return this; }
  upsert() { this.write = true; return this; }
  then(resolve, reject) {
    qaState.reads += 1;
    if (this.write) qaState.mutations += 1;
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
    return new Query(rows);
  },
  rpc(name) {
    if (name === 'get_my_access') return Promise.resolve({ data: qaAccess, error: null });
    if (name === 'list_managed_users') return new Query(roleMode ? fixture.users.filter((user) => qaVisibleEmployees.some((e) => e.id === user.employee_id)) : fixture.users);
    if (name === 'my_departments') return new Query(roleMode ? fixture.org.departments.filter((d) => qaVisibleEmployees.some((e) => e.department_id === d.id)) : fixture.org.departments);
    if (name === 'report_attendance_exceptions') return new Query([{ absent: 105, late: 0, missing_punch: 0 }]);
    if (name === 'report_attendance_summary') return new Query([]);
    if (/^(list_|get_|department_|assignable_)/.test(name)) return new Query([]);
    qaState.mutations += 1;
    return Promise.resolve({ data: null, error: { message: `QA mode: ${name} is intentionally blocked.` } });
  },
  auth: {
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
  storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }),
    createSignedUrls: async () => ({ data: [], error: null }) }) },
  functions: { invoke: async () => ({ error: { message: 'QA mode: external functions are intentionally blocked.' } }) },
};
