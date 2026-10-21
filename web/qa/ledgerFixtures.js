// Work Ledger demo (?qa-ledger): the Ledger on the demo's own task records. In memory only, reset on
// reload. The SQL suite owns the real rules; this copies just enough of them (review steps, rounds of
// changes, approved version, history, focus ≤ 3, first note starts the work) for the screens to behave.
import { addDays, weekStart } from '../src/lib/ledger/periods.js';
import { fixture, tables, today } from './fixtures';
import { fixtureAllows } from './roles.js';
import { brandLabel, campaignName, creativeRpc, creativeTableWrite, seedCreativeTasks, vendorName } from './creativeFixtures';

export const ledgerFixtures = new URL(window.location.href).searchParams.has('qa-ledger');

const me = fixture.employees[0];
const boss = fixture.employees[1];
const CLOSED = ['Done', 'Cancelled'];
let serial = 0;
const nextId = (prefix) => `qa-${prefix}-${(serial += 1)}`;
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const fail = (message, code = '22023') => ({ data: null, error: { code, message } });
const ist = (stamp) => (stamp ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(stamp)) : null);
const nameOf = (id) => fixture.employees.find((e) => e.id === id)?.full_name ?? null;

for (const name of ['task_progress', 'task_deliverables', 'task_marks', 'task_help_log', 'task_events', 'task_checklist_items']) tables[name] ??= [];
const reminders = [];

export function laneOf(status, review) {
  if (status === 'To Do') return 'todo';
  if (status === 'Blocked') return 'blocked';
  if (status === 'In Progress' && review === 'Approved') return 'approved';
  if (status === 'In Progress' && ['Internal Review', 'Awaiting Approval', 'Revisions'].includes(review)) return 'review';
  if (status === 'In Progress') return 'progress';
  return 'closed';
}
export function stepOf(status, review) {
  if (status === 'In Progress' && review === 'Internal Review') return 'In review';
  if (status === 'In Progress' && review === 'Awaiting Approval') return 'Waiting for approval';
  if (status === 'In Progress' && review === 'Revisions') return 'Changes needed';
  if (status === 'In Progress' && review === 'Approved') return 'Approved';
  return { 'To Do': 'To do', 'In Progress': 'In progress' }[status] ?? status;
}

function work(fields) {
  return { employee_id: me.id, assignee: me, entity_id: me.entity_id, zone_id: me.zone_id, branch_id: me.branch_id, department_id: me.department_id,
    assigned_by: boss.id, assigner: boss, description: 'Demo work', priority: 'Medium', status: 'To Do', review_stage: null, revision: 0,
    approved_version: null, waiting_on: null, outcome: null, status_since: today, depends_on_task_id: null, tags: [], due_date: null,
    created_at: `${today}T09:00:00+05:30`, completed_at: null, deleted_at: null, parent_task_id: null,
    assignees: [{ employee_id: me.id, employee: me }], checklist: [], ...fields };
}
if (ledgerFixtures) {
  tables.tasks.unshift(
    work({ id: 'qa-work-1', title: 'Diwali hoarding', status: 'In Progress', review_stage: 'Internal Review', priority: 'High', due_date: addDays(today, 2), revision: 1 }),
    work({ id: 'qa-work-2', title: 'Resort mornings reel', status: 'In Progress', due_date: addDays(today, 5) }),
    work({ id: 'qa-work-3', title: 'Brochure reprint', status: 'In Progress', due_date: addDays(today, -4), status_since: addDays(today, -12) }),
    work({ id: 'qa-work-4', title: 'Showroom signage', status: 'Blocked', waiting_on: 'Landlord approval', status_since: addDays(today, -3) }),
    work({ id: 'qa-work-5', title: 'Monsoon offer banner', priority: 'Low', depends_on_task_id: 'qa-work-1' }),
    work({ id: 'qa-work-6', title: 'Menu card print', status: 'In Progress', review_stage: 'Approved', approved_version: 'v3' }),
    work({ id: 'qa-work-7', title: 'Staff ID cards', status: 'Done', completed_at: new Date().toISOString(), outcome: 'Handed over' }),
    work({ id: 'qa-work-8', title: 'Festive catalogue shoot', status: 'In Progress', employee_id: boss.id, assignee: boss, assigned_by: boss.id,
      assignees: [{ employee_id: boss.id, employee: boss }, { employee_id: me.id, employee: me }] }),
  );
  tables.task_progress.push(
    { id: 'qa-p-1', task_id: 'qa-work-1', employee_id: me.id, author_user: 'me', on_date: today, note: 'Shared the revised layout with the MD', minutes: 30, created_at: new Date().toISOString(), deleted_at: null },
    { id: 'qa-p-2', task_id: 'qa-work-2', employee_id: me.id, author_user: 'me', on_date: addDays(today, -1), note: 'Rough cut of the first 30 seconds', minutes: 90, created_at: new Date().toISOString(), deleted_at: null });
  tables.task_deliverables.push({ id: 'qa-d-1', task_id: 'qa-work-1', type: 'Hoarding 20x10', version: 'v2', link: 'https://example.test/hoarding-v2',
    used_where: 'MG Road', added_at: new Date().toISOString(), deleted_at: null });
  tables.task_marks.push({ task_id: 'qa-work-1', pinned: true, focus_date: today });
  tables.task_help_log.push({ id: 'qa-h-1', employee_id: me.id, on_date: today, what: 'Reviewed menu layout', for_whom: 'Priya', minutes: 20,
    kind: 'Review / Feedback', created_at: new Date().toISOString(), deleted_at: null });
  tables.task_events.push({ task_id: 'qa-work-1', at: new Date().toISOString(), actor_employee: me.id, kind: 'step', from_value: 'In progress', to_value: 'In review' });
  reminders.push({ id: 'qa-rem-1', text: 'Call the printer about Diwali proofs', due_at: `${today}T11:30`, repeat: null, done: false, task_id: 'qa-work-1' },
    { id: 'qa-rem-2', text: 'Post the weekly reel', due_at: `${addDays(today, 1)}T10:00`, repeat: 'weekly', done: false, task_id: null });
  seedCreativeTasks();
}

const live = () => tables.tasks.filter((t) => !t.deleted_at);
const visible = () => live().filter((t) => isMine(t) || fixtureAllows('task.read', t));
function isMine(t, employee = me.id) { return t.employee_id === employee || (t.assignees ?? []).some((a) => a.employee_id === employee); }
const mark = (id) => tables.task_marks.find((m) => m.task_id === id);
const notes = (id) => tables.task_progress.filter((p) => p.task_id === id && !p.deleted_at);

function card(t) {
  const lastNote = [...notes(t.id)].sort((a, b) => b.on_date.localeCompare(a.on_date))[0];
  const dependency = tables.tasks.find((d) => d.id === t.depends_on_task_id);
  return {
    id: t.id, title: t.title, description: t.description, status: t.status, review_stage: t.review_stage, step: stepOf(t.status, t.review_stage),
    lane: laneOf(t.status, t.review_stage), priority: t.priority, due_date: t.due_date, status_since: t.status_since, created_at: t.created_at,
    completed_at: t.completed_at, stale: !CLOSED.includes(t.status) && (t.status_since ?? today) < addDays(today, -7),
    overdue: !CLOSED.includes(t.status) && Boolean(t.due_date) && t.due_date < today, waiting_on: t.waiting_on, revision: t.revision ?? 0,
    approved_version: t.approved_version, outcome: t.outcome, tags: t.tags ?? [], employee_id: t.employee_id, assignee_name: nameOf(t.employee_id),
    assigned_by: t.assigned_by, assigner_name: nameOf(t.assigned_by), helpers: (t.assignees ?? []).filter((a) => a.employee_id !== t.employee_id).length,
    depends_on_task_id: t.depends_on_task_id, depends_on_title: dependency?.title ?? null, depends_on_done: dependency ? dependency.status === 'Done' : null,
    subtasks_total: tables.task_checklist_items.filter((c) => c.task_id === t.id).length,
    subtasks_done: tables.task_checklist_items.filter((c) => c.task_id === t.id && c.completed_at).length,
    deliverables_count: tables.task_deliverables.filter((d) => d.task_id === t.id && !d.deleted_at).length, attachments_count: 0, comments_count: 0,
    last_progress: lastNote ? { date: lastNote.on_date, note: lastNote.note, minutes: lastNote.minutes } : null,
    pinned: Boolean(mark(t.id)?.pinned), focused: mark(t.id)?.focus_date === today, can_edit: isMine(t) || fixtureAllows('task.update', t),
    brand: t.brand ?? null, brand_label: brandLabel(t.brand), work_type: t.work_type ?? null, est_cost: t.est_cost ?? null, actual_cost: t.actual_cost ?? null,
    campaign_id: t.campaign_id ?? null, campaign: campaignName(t.campaign_id), vendor_id: t.vendor_id ?? null, vendor: vendorName(t.vendor_id),
  };
}
const reminderJson = (r) => ({ ...r, task_title: tables.tasks.find((t) => t.id === r.task_id)?.title ?? null,
  overdue: !r.done && r.due_at < new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 16), calendar_state: 'none' });

function home() {
  const mine = live().filter((t) => isMine(t));
  const order = (a, b) => Number(Boolean(mark(b.id)?.pinned)) - Number(Boolean(mark(a.id)?.pinned))
    || Number(mark(b.id)?.focus_date === today) - Number(mark(a.id)?.focus_date === today) || String(a.due_date ?? '9').localeCompare(String(b.due_date ?? '9'));
  const help = tables.task_help_log.filter((h) => h.employee_id === me.id && !h.deleted_at && h.on_date === today);
  return {
    today, employee_id: me.id,
    pending: mine.filter((t) => !CLOSED.includes(t.status)).sort(order).map(card),
    completed_today: mine.filter((t) => t.status === 'Done' && ist(t.completed_at) === today).map(card),
    done_this_week: mine.filter((t) => t.status === 'Done' && (ist(t.completed_at) ?? '') >= weekStart(today)).length,
    worked_on_today: new Set(tables.task_progress.filter((p) => p.employee_id === me.id && !p.deleted_at && p.on_date === today).map((p) => p.task_id)).size,
    support_today: help.length, support_minutes_today: help.reduce((n, h) => n + (h.minutes ?? 0), 0),
    overdue: mine.filter((t) => !CLOSED.includes(t.status) && t.due_date && t.due_date < today).length,
    schedule: reminders.filter((r) => !r.done && !r.deleted && r.due_at < `${addDays(today, 2)}T00:00`).map(reminderJson),
    google: { connected: false, status: 'disconnected' },
  };
}

function range(period, date) {
  if (period === 'day') return [date || today, date || today];
  if (period === 'week') { const start = weekStart(date || today); return [start, addDays(start, 6)]; }
  if (period === 'month') {
    const start = `${date || today.slice(0, 7)}-01`; const next = new Date(`${start}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    return [start, addDays(next.toISOString().slice(0, 10), -1)];
  }
  if (period === 'range') return String(date).split('|');
  return ['2000-01-01', today];
}
function report(period, date, employee) {
  const [from, to] = range(period, date);
  const single = from === to;
  const emp = employee ?? me.id;
  const mine = live().filter((t) => isMine(t, emp));
  const within = (day) => day && day >= from && day <= to;
  const noteFor = (t) => notes(t.id).filter((n) => n.employee_id === emp);
  const moved = (t) => tables.task_events.some((e) => e.task_id === t.id && e.actor_employee === emp && e.kind === 'step' && within(ist(e.at)));
  const worked = mine.filter((t) => !CLOSED.includes(t.status) && (moved(t) || within(ist(t.created_at)) || noteFor(t).some((n) => within(n.on_date))));
  const delivered = mine.filter((t) => t.status === 'Done' && within(ist(t.completed_at)));
  const support = tables.task_help_log.filter((h) => h.employee_id === emp && !h.deleted_at && within(h.on_date));
  const open = mine.filter((t) => !CLOSED.includes(t.status));
  const event = { 'Internal Review': 'Sent for internal review', 'Awaiting Approval': 'Sent for approval', Revisions: 'Back for revisions', Approved: 'Approved',
    Blocked: 'Blocked', 'In Progress': 'In progress' };
  return {
    period, from, to, today, single_day: single, employee_id: emp, employee_name: nameOf(emp),
    worked_on: worked.map((t) => ({ id: t.id, title: t.title, brand_label: '', status: stepOf(t.status, t.review_stage),
      event: moved(t) ? event[t.review_stage ?? t.status] ?? null : null, is_new: within(ist(t.created_at)),
      notes: noteFor(t).filter((n) => within(n.on_date)).map((n) => ({ date: n.on_date, note: n.note, minutes: n.minutes })) })),
    delivered: delivered.map((t) => ({ id: t.id, title: t.title, brand_label: '', outcome: t.outcome, delivered_on: ist(t.completed_at),
      notes: noteFor(t).map((n) => ({ date: n.on_date, note: n.note, minutes: n.minutes })) })),
    support: support.map((h) => ({ id: h.id, title: h.what, for_whom: h.for_whom, minutes: h.minutes, brand_label: '', type: h.kind, date: h.on_date })),
    support_by_person: Object.values(support.reduce((acc, h) => {
      const person = h.for_whom || 'Unnamed'; acc[person] ??= { person, count: 0, minutes: 0 };
      acc[person].count += 1; acc[person].minutes += h.minutes ?? 0; return acc;
    }, {})),
    support_minutes: support.reduce((n, h) => n + (h.minutes ?? 0), 0),
    pending_now: single ? open.map((t) => ({ id: t.id, title: t.title, brand_label: '', status: stepOf(t.status, t.review_stage), deadline: t.due_date,
      untouched: !worked.includes(t) })) : [],
    overdue: open.filter((t) => t.due_date && t.due_date < today).map((t) => ({ id: t.id, title: t.title, brand_label: '', deadline: t.due_date })),
    blocked: open.filter((t) => t.status === 'Blocked' || ['Awaiting Approval', 'Internal Review'].includes(t.review_stage))
      .map((t) => ({ id: t.id, title: t.title, status: stepOf(t.status, t.review_stage), waiting_on: t.waiting_on, since: t.status_since })),
    wins: delivered.filter((t) => t.outcome).map((t) => ({ id: t.id, title: t.title, brand_label: '', outcome: t.outcome })),
    by_brand: [], by_campaign: [], by_type: [], cost: { est: 0, actual: 0 }, ideas_captured: [],
  };
}
function insights() {
  const months = [-5, -4, -3, -2, -1, 0].map((offset) => {
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + offset);
    const n = 4 + ((offset + 7) * 3) % 6;
    return { month: d.toISOString().slice(0, 7), label: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }), delivered: n, with_deadline: n - 1,
      on_time: Math.max(0, n - 2), support: 3 + (offset + 5), support_minutes: 45 + 10 * (offset + 5), est: 0, actual: 0 };
  });
  const open = live().filter((t) => isMine(t) && !CLOSED.includes(t.status));
  return { from: `${months[0].month}-01`, to: today, months, by_brand: [], turnaround_by_type: [{ type: 'All tasks', days: 4.5, count: 21 }],
    average_revisions: 0.8, open_by_status: Object.values(open.reduce((acc, t) => { const s = stepOf(t.status, t.review_stage); acc[s] ??= { status: s, count: 0 }; acc[s].count += 1; return acc; }, {})),
    ageing: { week: open.length - 1, month: 1, quarter: 0, older: 0 },
    vendors: Object.values(visible().filter((t) => t.vendor_id).reduce((acc, t) => {
      const name = vendorName(t.vendor_id);
      acc[name] ??= { vendor: name, tasks: 0, spend: 0, last: today };
      acc[name].tasks += 1; acc[name].spend += Number(t.actual_cost) || 0;
      return acc;
    }, {})) };
}

function read(name, args) {
  if (name === 'work_home') return home();
  if (name === 'work_task') {
    const t = live().find((x) => x.id === args._id);
    if (!t) return { error: { code: 'P0002', message: 'Task not found.' } };
    return { ...card(t), description: t.description,
      progress: [...notes(t.id)].sort((a, b) => b.on_date.localeCompare(a.on_date)).map((p) => ({ id: p.id, date: p.on_date, note: p.note, minutes: p.minutes, author: nameOf(p.employee_id), mine: p.employee_id === me.id })),
      deliverables: tables.task_deliverables.filter((d) => d.task_id === t.id && !d.deleted_at),
      history: tables.task_events.filter((e) => e.task_id === t.id).reverse().map((e) => ({ at: e.at, kind: e.kind, from: e.from_value, to: e.to_value, by: nameOf(e.actor_employee) })) };
  }
  if (name === 'work_report') return report(args._period ?? 'day', args._date, args._employee);
  if (name === 'work_insights') return insights();
  if (name === 'work_search') {
    const q = String(args._query ?? '').toLowerCase();
    return { tasks: visible().filter((t) => t.title.toLowerCase().includes(q)).slice(0, 20).map(card),
      deliverables: tables.task_deliverables.filter((d) => !d.deleted_at && `${d.type} ${d.version}`.toLowerCase().includes(q))
        .map((d) => ({ ...d, task_title: tables.tasks.find((t) => t.id === d.task_id)?.title })) };
  }
  if (name === 'ledger_google_status') return { connected: false, status: 'disconnected' };
  return undefined;
}

function remind(name, args) {
  if (name === 'ledger_add_reminder') {
    const r = args._r ?? {};
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.due_at ?? '')) return { error: { code: '22023', message: 'A reminder needs a time like 2026-10-08T10:00.' } };
    const row = { id: args._id, text: r.text || 'Reminder', due_at: r.due_at, repeat: r.repeat || null, done: false, task_id: r.task_id || null };
    reminders.push(row);
    return { reminder: reminderJson(row), calendar: false };
  }
  const row = reminders.find((r) => r.id === args._id);
  if (!row) return undefined;
  if (name === 'ledger_complete_reminder') { if (row.repeat) row.due_at = `${addDays(row.due_at.slice(0, 10), 7)}${row.due_at.slice(10)}`; else row.done = true; return reminderJson(row); }
  if (name === 'ledger_snooze_reminder') { row.due_at = args._due_at; return reminderJson(row); }
  if (name === 'ledger_delete_reminder') { row.deleted = true; return null; }
  return undefined;
}

export function ledgerRpc(name, args, { canWrite }) {
  if (!ledgerFixtures) return undefined;
  const creative = creativeRpc(name, args, { canWrite });
  if (creative) return creative;
  if (!(name.startsWith('work_') || name.startsWith('ledger_'))) return undefined;
  const value = read(name, args ?? {});
  if (value !== undefined) return value?.error ? value : { rows: [clone(value)], one: true };
  if (!canWrite) return { error: { code: '42501', message: 'Writes are blocked in this demo.' } };
  const written = remind(name, args ?? {});
  if (written === undefined) return { error: { code: 'PGRST202', message: `Demo has no ${name}.` } };
  if (written?.error) return written;
  return { mutated: true, one: true, rows: [clone(written)] };
}

// The task rules this demo copies from 0173.
function applyTaskUpdate(task, patch) {
  const before = { status: task.status, review: task.review_stage, waiting: task.waiting_on };
  const allowed = ['status', 'review_stage', 'waiting_on', 'outcome', 'depends_on_task_id', 'tags', 'completed_at', 'title', 'description', 'priority', 'due_date', 'employee_id',
    'brand', 'work_type', 'est_cost', 'actual_cost', 'campaign_id', 'vendor_id'];
  for (const [key, value] of Object.entries(patch)) if (allowed.includes(key)) task[key] = value;
  if (task.status !== 'In Progress') task.review_stage = null;
  if (task.status !== before.status || task.review_stage !== before.review) {
    task.status_since = today;
    if (task.review_stage === 'Revisions' && before.review !== 'Revisions') task.revision = (task.revision ?? 0) + 1;
    if (task.review_stage === 'Approved' && before.review !== 'Approved') {
      const latest = tables.task_deliverables.filter((d) => d.task_id === task.id && !d.deleted_at).at(-1);
      task.approved_version = latest?.version || latest?.type || 'Work as reviewed';
    }
    if (task.status !== 'Blocked' && task.review_stage !== 'Awaiting Approval' && task.waiting_on === before.waiting) task.waiting_on = null;
    tables.task_events.push({ task_id: task.id, at: new Date().toISOString(), actor_employee: me.id, kind: 'step',
      from_value: stepOf(before.status, before.review), to_value: stepOf(task.status, task.review_stage) });
  }
}

/** Writes the Ledger and Task Management make, kept in memory for the demo. Returns undefined when not ours. */
export function ledgerWrite(query) {
  if (!ledgerFixtures || !query.write) return undefined;
  const { table, operation, payload } = query;
  const creative = creativeTableWrite(query);
  if (creative) return creative;
  const matching = () => (tables[table] ?? []).filter((row) => query.filters.every((f) => f(row)));
  const result = (rows) => ({ data: clone(query.one ? rows[0] ?? null : rows), error: null });
  if (table === 'tasks' && operation === 'update') {
    const rows = matching().filter((t) => isMine(t) || fixtureAllows('task.update', t));
    rows.forEach((t) => applyTaskUpdate(t, payload));
    return result(rows);
  }
  if (table === 'tasks' && operation === 'insert') {
    const person = fixture.employees.find((e) => e.id === payload.employee_id) ?? me;
    const task = work({ ...payload, id: nextId('task'), employee_id: person.id, assignee: person, assigner: fixture.employees.find((e) => e.id === payload.assigned_by) ?? me,
      entity_id: person.entity_id, branch_id: person.branch_id, department_id: person.department_id, status: 'To Do', created_at: new Date().toISOString(), assignees: [] });
    tables.tasks.unshift(task);
    tables.task_events.push({ task_id: task.id, at: task.created_at, actor_employee: me.id, kind: 'created', to_value: 'To do' });
    return result([task]);
  }
  if (table === 'task_assignees' && operation === 'insert') {
    for (const row of [payload].flat()) {
      const task = tables.tasks.find((t) => t.id === row.task_id);
      const person = fixture.employees.find((e) => e.id === row.employee_id);
      if (task && person && !(task.assignees ?? []).some((a) => a.employee_id === person.id)) task.assignees = [...(task.assignees ?? []), { employee_id: person.id, employee: person }];
    }
    return result([payload].flat());
  }
  if (table === 'task_checklist_items' && operation === 'insert') {
    const rows = [payload].flat().map((row) => ({ ...row, id: nextId('step'), completed_at: null, completed_by: null, created_at: new Date().toISOString() }));
    tables.task_checklist_items.push(...rows);
    return result(rows);
  }
  if (table === 'task_progress' && operation === 'insert') {
    if (!String(payload.note ?? '').trim()) return fail('Write what you did.');
    if (payload.on_date > today) return fail('A progress note cannot be dated in the future.');
    const row = { ...payload, id: nextId('note'), employee_id: me.id, author_user: 'me', created_at: new Date().toISOString(), deleted_at: null };
    tables.task_progress.push(row);
    const task = tables.tasks.find((t) => t.id === payload.task_id);
    if (task?.status === 'To Do') applyTaskUpdate(task, { status: 'In Progress' });
    return result([row]);
  }
  if (table === 'task_deliverables' && operation === 'insert') {
    const row = { ...payload, id: nextId('deliverable'), added_at: new Date().toISOString(), deleted_at: null };
    tables.task_deliverables.push(row);
    return result([row]);
  }
  if (table === 'task_help_log' && operation === 'insert') {
    if (!String(payload.what ?? '').trim()) return fail('Say what you did.');
    const row = { ...payload, id: nextId('help'), employee_id: me.id, created_at: new Date().toISOString(), deleted_at: null };
    tables.task_help_log.push(row);
    return result([row]);
  }
  if (['task_progress', 'task_deliverables', 'task_help_log'].includes(table) && operation === 'update') {
    const rows = matching();
    rows.forEach((row) => Object.assign(row, payload));
    return result(rows);
  }
  if (table === 'task_marks' && operation === 'upsert') {
    if (payload.focus_date && !tables.task_marks.some((m) => m.task_id === payload.task_id && m.focus_date === today)
        && tables.task_marks.filter((m) => m.focus_date === today).length >= 3) {
      return fail('Today’s focus already has 3 tasks. Remove one first.');
    }
    const existing = tables.task_marks.find((m) => m.task_id === payload.task_id);
    if (existing) Object.assign(existing, payload); else tables.task_marks.push({ ...payload });
    return result([payload]);
  }
  return undefined;
}
