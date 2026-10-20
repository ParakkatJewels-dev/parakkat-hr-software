// Work Ledger demo data (?qa-ledger). In-memory only, reset on reload; the SQL suite owns privacy
// and the rules. This copies just enough of each rule for the screens to behave believably.
import { addDays, weekStart } from '../src/lib/ledger/periods.js';
import { today } from './fixtures';

export const ledgerFixtures = new URL(window.location.href).searchParams.has('qa-ledger');

const BRANDS = [['Parakkat Jewels', 'Jewels'], ['Parakkat Munnar Resort', 'Munnar'], ['Parakkat Riverscape', 'Riverscape'], ['Parakkat Adimali Retreat', 'Adimali'], ['General', 'General']];
const labelOf = (brand) => BRANDS.find(([name]) => name.toLowerCase() === String(brand ?? '').toLowerCase())?.[1] ?? brand;
const CLOSED = ['Delivered', 'Cancelled'];
const STAGES = ['Captured', 'Developing', 'Decision', 'Approved', 'Production', 'Live', 'Reviewed'];
let serial = 0;
const id = (prefix) => `qa-${prefix}-${(serial += 1)}`;
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const fail = (message, code = '22023') => ({ error: { code, message } });

function task(fields) {
  return { id: id('task'), brand: 'General', status: 'Brief', priority: 'Medium', deadline: null, start_date: null, end_date: null, last_updated: today, repeat: null,
    pinned: false, type: null, campaign_id: null, tags: [], revision: 0, status_since: today, waiting_on: null, focus_date: null, outcome: null, est_cost: null,
    actual_cost: null, vendor: null, brief: null, for_whom: null, minutes: null, entry_kind: null, depends_on: null, approved_version: null,
    logged_at: `${today}T09:00:00+05:30`, work_date: today, subtasks: [], deliverables: [], progress: [], attachments: [], log: [], ...fields };
}

const state = {
  settings: { seeded_at: new Date().toISOString(), imported_at: null, import_locked_at: null, sound: false },
  google: { connected: false, status: 'disconnected' },
  campaigns: [
    { id: 'qa-camp-1', name: 'Diwali 2026', brand: 'Parakkat Jewels', stage: 'Production', priority: 'High', launch_date: addDays(today, 12), objective: 'Bring festive buyers to the showroom',
      next_action: 'Approve the hoarding', milestone: 'Print files to vendor', milestone_date: addDays(today, 4), blocker: null, decision: null, budget: '₹1,20,000', brief_link: null, notes: null,
      brief: { insight: 'Families plan Diwali gold a month ahead', idea: 'Light that lasts' }, measure: { primary: 'Showroom walk-ins', target: '+20%' }, results: {}, log: [{ at: addDays(today, -9), text: 'Created at Captured' }] },
    { id: 'qa-camp-2', name: 'Monsoon stays', brand: 'Parakkat Munnar Resort', stage: 'Decision', priority: 'Medium', launch_date: addDays(today, 30), objective: 'Fill weekday rooms in the rains',
      next_action: null, milestone: null, milestone_date: null, blocker: null, decision: 'Approve a 20% weekday offer?', budget: null, brief_link: null, notes: null,
      brief: {}, measure: {}, results: {}, log: [] },
  ],
  ideas: [
    { id: 'qa-idea-1', text: 'A reel series on resort mornings', original: 'A reel series on resort mornings', brand: 'Parakkat Munnar Resort', tags: ['reels'], links: null, status: 'Open',
      created_at: `${addDays(today, -2)}T10:00:00+05:30`, revisit_date: null, revisit_when: null, concept: {}, task_id: null, campaign_id: null },
    { id: 'qa-idea-2', text: 'Gold rate ticker on the showroom screen', original: 'Gold rate ticker on the showroom screen', brand: 'Parakkat Jewels', tags: [], links: null, status: 'Parked',
      created_at: `${addDays(today, -20)}T10:00:00+05:30`, revisit_date: addDays(today, 3), revisit_when: 'the new screen is installed', concept: { oneLine: 'Live gold rate' }, task_id: null, campaign_id: null },
  ],
  reminders: [
    { id: 'qa-rem-1', text: 'Call the printer about Diwali proofs', due_at: `${today}T11:30`, repeat: null, done: false, source: 'reminder', task_id: null },
    { id: 'qa-rem-2', text: 'Post the weekly reel', due_at: `${addDays(today, 1)}T10:00`, repeat: 'weekly', done: false, source: 'reminder', task_id: null },
  ],
  vendors: [{ id: 'qa-vendor-1', name: 'Sree Printers', role: 'Print', phone: '+91 98470 00000', email: null, rate: '₹12 per sq ft', rating: 4, notes: null, last_worked: addDays(today, -3) }],
  templates: [{ id: 'qa-template-1', name: 'Hoarding', type: 'Print', subtasks: ['Brief', 'Layout', 'MD review', 'Print file', 'Vendor proof'] },
    { id: 'qa-template-2', name: 'Instagram reel', type: 'Reel', subtasks: ['Script', 'Shoot', 'Edit', 'Caption', 'Schedule'] }],
  keyDates: [{ id: 'qa-kd-1', name: 'Diwali', date: '2026-11-08', brand: 'Parakkat Jewels', lead_days: 45, notes: null, starter: true },
    { id: 'qa-kd-2', name: 'Christmas', date: '2026-12-25', brand: null, lead_days: 30, notes: null, starter: true },
    { id: 'qa-kd-3', name: 'Wedding season peak', date: addDays(today, 60), brand: 'Parakkat Jewels', lead_days: 30, notes: null, starter: true }],
  foundations: {},
};
state.tasks = [
  task({ title: 'Diwali hoarding v2', brand: 'Parakkat Jewels', status: 'Internal Review', priority: 'High', deadline: addDays(today, 2), type: 'Print', campaign_id: 'qa-camp-1',
    revision: 1, status_since: today, focus_date: today, pinned: true, est_cost: 40000, vendor: 'Sree Printers',
    subtasks: [{ id: 'qa-st-1', text: 'Layout', done: true }, { id: 'qa-st-2', text: 'MD review', done: false }],
    deliverables: [{ id: 'qa-d-1', type: 'Hoarding 20x10', version: 'v2', link: 'https://example.test/hoarding-v2', used_where: 'MG Road', added_at: today }],
    progress: [{ id: 'qa-p-1', date: today, note: 'Shared the revised layout with the MD', minutes: 30 }], log: ['[Today] Status: In Progress → Internal Review'] }),
  task({ title: 'Resort mornings reel', brand: 'Parakkat Munnar Resort', status: 'In Progress', type: 'Reel', deadline: addDays(today, 5), status_since: addDays(today, -2),
    progress: [{ id: 'qa-p-2', date: addDays(today, -1), note: 'Rough cut of the first 30 seconds', minutes: 90 }] }),
  task({ title: 'Brochure reprint', brand: 'Parakkat Adimali Retreat', status: 'In Progress', type: 'Print', deadline: addDays(today, -5), status_since: addDays(today, -12) }),
  task({ title: 'Showroom signage', brand: 'Parakkat Jewels', status: 'Blocked', waiting_on: 'Landlord approval', type: 'Print', status_since: addDays(today, -3) }),
  task({ title: 'Monsoon offer banner', brand: 'Parakkat Riverscape', status: 'Brief', type: 'Social', priority: 'Low' }),
  task({ title: 'Menu card print', brand: 'Parakkat Riverscape', status: 'Approved', type: 'Print', approved_version: 'v3', status_since: addDays(today, -1) }),
  task({ title: 'Festive catalogue shoot', brand: 'Parakkat Jewels', status: 'In Progress', type: 'Photography', campaign_id: 'qa-camp-1', status_since: today }),
  task({ title: 'Website hero refresh', brand: 'General', status: 'In Progress', type: 'Website', status_since: today }),
  task({ title: 'Staff ID cards', brand: 'General', status: 'Delivered', outcome: 'Printed and handed over', status_since: today }),
  task({ title: 'Reviewed menu layout', brand: 'Parakkat Riverscape', status: 'Delivered', entry_kind: 'support', for_whom: 'Priya', minutes: 20, type: 'Review / Feedback' }),
];
state.tasks.find((t) => t.title === 'Monsoon offer banner').depends_on = state.tasks[0].id;

const campaignName = (campaignId) => state.campaigns.find((c) => c.id === campaignId)?.name ?? null;
function taskJson(t, detail = false) {
  const dependency = state.tasks.find((d) => d.id === t.depends_on);
  const latest = [...t.progress].sort((a, b) => b.date.localeCompare(a.date))[0];
  const base = { ...t, brand_label: labelOf(t.brand), campaign: campaignName(t.campaign_id), focused: t.focus_date === today,
    depends_on_title: dependency?.title ?? null, depends_on_done: dependency ? dependency.status === 'Delivered' : null,
    stale: !CLOSED.includes(t.status) && (t.status_since ?? t.work_date) < addDays(today, -7),
    subtasks_total: t.subtasks.length, subtasks_done: t.subtasks.filter((s) => s.done).length, deliverables_count: t.deliverables.length,
    attachments_count: t.attachments.length, last_progress: latest ? { date: latest.date, note: latest.note } : null };
  delete base.log;
  if (!detail) { delete base.subtasks; delete base.deliverables; delete base.progress; delete base.attachments; return base; }
  return { ...base, notes: t.log.join('\n') || null };
}
const live = () => state.tasks.filter((t) => !t.deleted);
const own = (taskId) => live().find((t) => t.id === taskId);

function campaignJson(c, detail = false) {
  const tasks = live().filter((t) => t.campaign_id === c.id && !t.entry_kind);
  const base = { ...c, brand_label: labelOf(c.brand), status: ['Captured', 'Parked'].includes(c.stage) ? 'Planning' : ['Reviewed', 'Cancelled'].includes(c.stage) ? 'Done' : 'Active',
    days_to_launch: c.launch_date ? Math.round((Date.parse(c.launch_date) - Date.parse(today)) / 86400000) : null,
    total: tasks.filter((t) => t.status !== 'Cancelled').length, done: tasks.filter((t) => t.status === 'Delivered').length,
    in_review: tasks.filter((t) => ['Internal Review', 'Awaiting Approval', 'Revisions'].includes(t.status)).length, blocked: tasks.filter((t) => t.status === 'Blocked').length,
    spend: tasks.reduce((sum, t) => sum + (Number(t.actual_cost) || 0), 0) };
  delete base.log;
  if (!detail) return base;
  return { ...base, log: [...c.log].reverse(), tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, deadline: t.deadline, priority: t.priority, vendor: t.vendor,
    actual_cost: t.actual_cost, deliverables: t.deliverables })), ideas: state.ideas.filter((i) => i.campaign_id === c.id).map((i) => ({ id: i.id, text: i.text, links: i.links, status: i.status })) };
}
const ideaJson = (i) => ({ ...i, edited: i.text !== i.original, task_title: own(i.task_id)?.title ?? null, campaign_name: campaignName(i.campaign_id) });

function boot() {
  return {
    owner: { user_id: 'qa-ledger-owner', name: 'Vivek Menon', designation: 'Creative Head' },
    settings: { ...state.settings },
    brands: BRANDS.map(([name, label], i) => ({ id: `qa-brand-${i}`, name, label, sort_order: i + 1, foundation: state.foundations[name] ?? {} })),
    templates: state.templates, vendors: state.vendors.map(({ id: vendorId, name, role, last_worked }) => ({ id: vendorId, name, role, last_worked })),
    campaigns: state.campaigns.map((c) => ({ id: c.id, name: c.name, brand: c.brand, stage: c.stage })), people: ['Priya', 'Rahul'],
    used_types: [...new Set(live().map((t) => t.type).filter(Boolean))], used_brands: [...new Set(live().map((t) => t.brand))],
    counts: { tasks: live().filter((t) => !t.entry_kind).length, support: live().filter((t) => t.entry_kind).length, progress: live().reduce((n, t) => n + t.progress.length, 0),
      subtasks: live().reduce((n, t) => n + t.subtasks.length, 0), deliverables: live().reduce((n, t) => n + t.deliverables.length, 0), campaigns: state.campaigns.length,
      ideas: state.ideas.length, vendors: state.vendors.length, templates: state.templates.length, key_dates: state.keyDates.length, reminders: state.reminders.length },
  };
}

function home(owner) {
  const pending = live().filter((t) => !t.entry_kind && !CLOSED.includes(t.status))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.focus_date === today) - Number(a.focus_date === today));
  const reminderJson = (r) => ({ ...r, overdue: !r.done && `${r.due_at}` < new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 16),
    task_title: own(r.task_id)?.title ?? null, calendar_state: 'none' });
  const alerts = [
    ...state.campaigns.filter((c) => c.stage === 'Decision').map((c) => ({ kind: 'decision', campaign_id: c.id, title: c.name, text: c.decision || 'Decision needed is not written yet' })),
    ...state.campaigns.filter((c) => c.milestone_date && c.milestone_date <= addDays(today, 14) && !['Live', 'Reviewed', 'Parked', 'Cancelled'].includes(c.stage))
      .map((c) => ({ kind: 'milestone', campaign_id: c.id, title: c.name, date: c.milestone_date, text: c.milestone })),
    ...state.ideas.filter((i) => i.status === 'Parked' && i.revisit_date && i.revisit_date <= addDays(today, 7))
      .map((i) => ({ kind: 'idea', idea_id: i.id, title: i.text, date: i.revisit_date, text: `Revisit when ${i.revisit_when}` })),
  ];
  return {
    today, pending: pending.map((t) => taskJson(t)),
    completed_today: live().filter((t) => !t.entry_kind && t.status === 'Delivered' && t.status_since === today).map((t) => taskJson(t)),
    done_this_week: live().filter((t) => !t.entry_kind && t.status === 'Delivered' && t.status_since >= weekStart(today)).length,
    worked_on_today: live().filter((t) => t.progress.some((p) => p.date === today)).length,
    support_today: live().filter((t) => t.entry_kind && t.work_date === today).length,
    support_minutes_today: live().filter((t) => t.entry_kind && t.work_date === today).reduce((n, t) => n + (t.minutes ?? 0), 0),
    overdue: pending.filter((t) => t.deadline && t.deadline < today).length,
    ideas: state.ideas.filter((i) => ['Open', 'Developing'].includes(i.status)).slice(0, 6), ideas_open: state.ideas.filter((i) => i.status === 'Open').length,
    alerts, campaigns: state.campaigns.filter((c) => !['Parked', 'Cancelled', 'Reviewed'].includes(c.stage)).map((c) => campaignJson(c)),
    key_dates: state.keyDates.filter((k) => k.date >= today && k.date <= addDays(today, 150)).map((k) => ({ ...k,
      days_away: Math.round((Date.parse(k.date) - Date.parse(today)) / 86400000), has_campaign: k.name === 'Diwali' })),
    schedule: owner ? null : state.reminders.filter((r) => !r.done && !r.deleted && r.due_at < `${addDays(today, 2)}T00:00`).map(reminderJson),
    google: owner ? null : { ...state.google },
  };
}

function range(period, date) {
  if (period === 'day') return [date, date];
  if (period === 'week') { const start = weekStart(date); return [start, addDays(start, 6)]; }
  if (period === 'month') { const start = `${date}-01`; const next = new Date(`${start}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); return [start, addDays(next.toISOString().slice(0, 10), -1)]; }
  if (period === 'range') return date.split('|');
  return ['2000-01-01', today];
}

function report(period, date) {
  const [from, to] = range(period, date ?? today);
  const single = from === to;
  return {
    period, from, to, today, single_day: single,
    worked_on: [
      { id: 'qa-l1', title: 'Diwali hoarding v2', brand: 'Parakkat Jewels', brand_label: 'Jewels', status: 'Internal Review', event: 'Sent for internal review', is_new: false, group: 0,
        notes: [{ date: to, note: 'Shared the revised layout with the MD', minutes: 30 }] },
      { id: 'qa-l2', title: 'Resort mornings reel', brand: 'Parakkat Munnar Resort', brand_label: 'Munnar', status: 'In Progress', event: null, is_new: false, group: 2,
        notes: [{ date: from, note: 'Rough cut of the first 30 seconds', minutes: 90 }, ...(single ? [] : [{ date: to, note: 'Colour grade', minutes: 45 }])] },
      { id: 'qa-l3', title: 'Monsoon offer banner', brand: 'Parakkat Riverscape', brand_label: 'Riverscape', status: 'Brief', event: null, is_new: true, group: 2, notes: [] },
    ],
    delivered: [{ id: 'qa-l4', title: 'Menu card print', brand_label: 'Riverscape', outcome: 'Printed 200 cards for the restaurant', delivered_on: to, notes: [{ date: addDays(to, -2), note: 'Proof approved' }] }],
    support: [{ id: 'qa-s1', title: 'Reviewed menu layout', for_whom: 'Priya', minutes: 20, brand_label: 'Riverscape', type: 'Review / Feedback', date: to },
      { id: 'qa-s2', title: 'Unblocked the print vendor', for_whom: 'Rahul', minutes: 15, brand_label: 'General', type: 'Team support', date: to }],
    support_by_person: [{ person: 'Priya', count: 1, minutes: 20 }, { person: 'Rahul', count: 1, minutes: 15 }],
    support_minutes: 35,
    pending_now: single ? [
      { id: 'qa-l1', title: 'Diwali hoarding v2', brand_label: 'Jewels', status: 'Internal Review', untouched: false },
      { id: 'qa-l5', title: 'Brochure reprint', brand_label: 'Adimali', status: 'In Progress', untouched: true },
      { id: 'qa-l6', title: 'Showroom signage', brand_label: 'Jewels', status: 'Blocked', untouched: true },
    ] : [],
    overdue: [{ id: 'qa-l5', title: 'Brochure reprint', brand_label: 'Adimali', deadline: addDays(today, -5) }],
    blocked: [{ id: 'qa-l6', title: 'Showroom signage', status: 'Blocked', waiting_on: 'Landlord approval', since: addDays(today, -3) },
      { id: 'qa-l1', title: 'Diwali hoarding v2', status: 'Internal Review', waiting_on: null, since: to }],
    wins: [{ id: 'qa-l4', title: 'Menu card print', outcome: 'Printed 200 cards for the restaurant' }],
    by_brand: [{ brand: 'Parakkat Jewels', label: 'Jewels', items: 2, done: 0 }, { brand: 'Parakkat Munnar Resort', label: 'Munnar', items: 1, done: 0 },
      { brand: 'Parakkat Riverscape', label: 'Riverscape', items: 2, done: 1 }],
    by_campaign: [{ campaign: 'Diwali 2026', done: 3, total: 7, spend: 12000 }],
    by_type: [{ type: 'Print', items: 3, done: 1 }, { type: 'Reel', items: 1, done: 0 }],
    cost: { est: 18000, actual: 12000 },
    ideas_captured: [{ id: 'qa-i1', text: 'A reel series on resort mornings', brand: 'Parakkat Munnar Resort' }],
  };
}

function insights() {
  const months = [-5, -4, -3, -2, -1, 0].map((offset) => {
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + offset);
    const n = 6 + ((offset + 7) * 3) % 7;
    return { month: d.toISOString().slice(0, 7), label: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }), delivered: n, with_deadline: n - 1, on_time: n - 2,
      support: 4 + (offset + 5), support_minutes: 60 + 15 * (offset + 5), est: 20000 + 3000 * (offset + 5), actual: 18000 + 3500 * (offset + 5) };
  });
  return { from: months[0].month + '-01', to: today, months, by_brand: [{ brand: 'Jewels', delivered: 18 }, { brand: 'Munnar', delivered: 11 }, { brand: 'Riverscape', delivered: 9 }],
    turnaround_by_type: [{ type: 'Print', days: 6.5, count: 14 }, { type: 'Reel', days: 4.2, count: 9 }], average_revisions: 1.3,
    open_by_status: [{ status: 'Brief', count: 1 }, { status: 'In Progress', count: 4 }, { status: 'Internal Review', count: 1 }, { status: 'Blocked', count: 1 }],
    ageing: { week: 4, month: 2, quarter: 1, older: 0 }, vendors: [{ vendor: 'Sree Printers', tasks: 5, spend: 32000, last: addDays(today, -3) }] };
}

function finish(t, outcome) {
  t.status = 'Delivered'; t.status_since = today; t.focus_date = null;
  if (outcome) t.outcome = outcome;
  if (t.repeat && !t.recurrence_child) {
    const copy = task({ ...clone(t), id: id('task'), status: 'Brief', outcome: null, revision: 0, deadline: t.deadline ? addDays(t.deadline, t.repeat === 'daily' ? 1 : 7) : null,
      subtasks: t.subtasks.map((s) => ({ ...s, id: id('st'), done: false })), progress: [], log: [] });
    t.recurrence_child = copy.id; state.tasks.push(copy);
  }
}

function update(t, u) {
  const changes = [];
  for (const [key, value] of Object.entries(u)) {
    if (key === 'note') continue;
    if (key === 'title' && !String(value ?? '').trim()) return fail('A task needs a title.');
    if (key === 'tags') { t.tags = String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); continue; }
    if (key === 'campaign') {
      let campaign = state.campaigns.find((c) => c.name.toLowerCase() === String(value ?? '').toLowerCase());
      if (value && !campaign) { campaign = { id: id('camp'), name: value, brand: t.brand, stage: 'Captured', priority: 'Medium', brief: {}, measure: {}, results: {}, log: [] }; state.campaigns.push(campaign); }
      t.campaign_id = campaign?.id ?? null; continue;
    }
    if (key === 'status') {
      if (value === t.status) continue;
      changes.push(`Status: ${t.status} → ${value}`);
      if (value === 'Delivered') { finish(t, u.outcome); continue; }
      if (value === 'Revisions') t.revision += 1;
      if (value === 'Approved') t.approved_version = t.deliverables.at(-1)?.version ?? 'Work as reviewed';
      if (!['Blocked', 'Awaiting Approval'].includes(value) && !('waiting_on' in u)) t.waiting_on = null;
      t.status = value; t.status_since = today; continue;
    }
    if (String(t[key] ?? '') !== String(value ?? '')) changes.push(`${key}: ${t[key] ?? '—'} → ${value ?? '—'}`);
    t[key] = value;
  }
  if (u.note || changes.length) t.log.push(`[Today] ${[u.note, ...changes].filter(Boolean).join(' — ')}`);
  t.last_updated = today;
  return null;
}

function write(name, args) {
  if (name === 'ledger_add_task') {
    const e = args._entry ?? {};
    if (!String(e.task ?? '').trim()) return fail('A task needs a title.');
    const t = task({ id: args._id, title: e.task, brand: e.brand || 'General', status: e.status || 'Brief', priority: e.priority || 'Medium', deadline: e.deadline || null,
      start_date: e.start_date || null, end_date: e.end_date || null, repeat: e.repeat || null, type: e.type || null, vendor: e.vendor || null, est_cost: e.est_cost || null,
      waiting_on: e.waiting_on || null, brief: e.brief || null, tags: String(e.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      subtasks: (e.subtasks ?? []).map((text) => ({ id: id('st'), text, done: false })), deliverables: (e.deliverables ?? []).map((d) => ({ id: id('d'), ...d, added_at: today })),
      attachments: (e.links ?? []).map((l) => ({ id: id('a'), kind: 'link', name: l.name || l.url, url: l.url })), log: e.notes ? [`[Today] ${e.notes}`] : [] });
    if (e.campaign) update(t, { campaign: e.campaign });
    state.tasks.push(t);
    if (e.idea_id) { const idea = state.ideas.find((i) => i.id === e.idea_id); if (idea) { idea.status = 'Promoted'; idea.task_id = t.id; } }
    return taskJson(t, true);
  }
  if (name === 'ledger_log_support') {
    const e = args._entry ?? {};
    if (!String(e.what ?? '').trim()) return fail('Say what you did.');
    const t = task({ id: args._id, title: e.what, brand: e.brand || 'General', status: 'Delivered', entry_kind: 'support', for_whom: e.for_whom || null, minutes: e.minutes || null,
      type: e.type, work_date: e.date || today, status_since: e.date || today });
    state.tasks.push(t); return taskJson(t, true);
  }
  if (name === 'ledger_bulk_mark_done') { args._ids.forEach((taskId) => own(taskId) && finish(own(taskId))); return args._ids.length; }
  if (name === 'ledger_bulk_update') { args._ids.forEach((taskId) => own(taskId) && update(own(taskId), args._updates)); return args._ids.length; }
  const t = args._id && own(args._id);
  if (name === 'ledger_update_task') { if (!t) return fail('Task not found.', 'P0002'); return update(t, args._updates) ?? taskJson(t, true); }
  if (name === 'ledger_mark_done') { finish(t, args._outcome); return taskJson(t, true); }
  if (name === 'ledger_cancel_task') { update(t, { status: 'Cancelled' }); return taskJson(t, true); }
  if (name === 'ledger_set_focus') {
    if (args._on && live().filter((x) => x.focus_date === today && x.id !== t.id).length >= 3) return fail('Today’s focus already has 3 tasks. Remove one first.');
    t.focus_date = args._on ? today : null; return taskJson(t);
  }
  if (name === 'ledger_set_pin') { t.pinned = Boolean(args._pinned); return taskJson(t); }
  const parent = args._task && own(args._task);
  if (name === 'ledger_add_subtask') { parent.subtasks.push({ id: args._id, text: args._text, done: false }); return null; }
  if (name === 'ledger_add_deliverable') { parent.deliverables.push({ id: args._id, ...args._d, added_at: today }); return null; }
  if (name === 'ledger_log_progress') {
    parent.progress.push({ id: args._id, date: args._date || today, note: args._note, minutes: args._minutes });
    if (parent.status === 'Brief') { parent.status = 'In Progress'; parent.status_since = today; }
    return null;
  }
  if (name === 'ledger_add_link') { parent.attachments.push({ id: args._id, kind: 'link', name: args._name || args._url, url: args._url }); return null; }
  for (const [rpc, key] of [['ledger_set_subtask', 'subtasks'], ['ledger_delete_subtask', 'subtasks'], ['ledger_delete_deliverable', 'deliverables'],
    ['ledger_delete_progress', 'progress'], ['ledger_remove_attachment', 'attachments']]) {
    if (name !== rpc) continue;
    for (const item of live()) {
      const index = item[key].findIndex((child) => child.id === args._id);
      if (index < 0) continue;
      if (rpc === 'ledger_set_subtask') item[key][index].done = Boolean(args._done); else item[key].splice(index, 1);
    }
    return null;
  }
  if (name === 'ledger_add_reminder' || name === 'ledger_add_follow_up') {
    const r = name === 'ledger_add_reminder' ? args._r : { text: args._text, due_at: args._due_at, task_id: args._task, source: 'followup' };
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.due_at ?? '')) return fail('A reminder needs a time like 2026-10-08T10:00.');
    const row = { id: args._id, text: r.text || 'Reminder', due_at: r.due_at, repeat: r.repeat || null, done: false, source: r.source || 'reminder', task_id: r.task_id || null };
    state.reminders.push(row); return { reminder: row, calendar: state.google.connected };
  }
  const reminder = state.reminders.find((r) => r.id === args._id);
  if (name === 'ledger_complete_reminder') { if (reminder.repeat) reminder.due_at = `${addDays(reminder.due_at.slice(0, 10), reminder.repeat === 'daily' ? 1 : 7)}${reminder.due_at.slice(10)}`; else reminder.done = true; return reminder; }
  if (name === 'ledger_snooze_reminder') { if (reminder.repeat) return fail('Snooze works on one-off reminders. Mark this one done for today instead.'); reminder.due_at = args._due_at; return reminder; }
  if (name === 'ledger_delete_reminder') { reminder.deleted = true; return null; }
  if (name === 'ledger_set_sound') { state.settings.sound = Boolean(args._on); return state.settings; }
  if (name === 'ledger_save_campaign') {
    let c = state.campaigns.find((x) => x.id === args._id);
    const { log_text: logText, ...changes } = args._c ?? {};
    if (!c) {
      if (!String(changes.name ?? '').trim()) return fail('A campaign needs a name.');
      c = { id: args._id, stage: 'Captured', priority: 'Medium', brief: {}, measure: {}, results: {}, log: [], ...changes }; c.log.push({ at: today, text: `Created at ${c.stage}` }); state.campaigns.push(c);
    } else {
      if (changes.stage && changes.stage !== c.stage) c.log.push({ at: today, text: `Stage: ${c.stage} → ${changes.stage}` });
      Object.assign(c, changes);
    }
    if (logText) c.log.push({ at: today, text: logText });
    return campaignJson(c, true);
  }
  if (name === 'ledger_advance_campaign') {
    const c = state.campaigns.find((x) => x.id === args._id);
    const next = STAGES[STAGES.indexOf(c.stage) + 1];
    if (!next) return fail('This campaign has been reviewed; there is no next stage.');
    c.log.push({ at: today, text: `Stage: ${c.stage} → ${next}` }); c.stage = next; return campaignJson(c, true);
  }
  if (name === 'ledger_delete_campaign') { state.campaigns = state.campaigns.filter((c) => c.id !== args._id); return null; }
  if (name === 'ledger_add_idea') {
    const row = { id: args._id, text: args._text, original: args._text, brand: args._brand, tags: args._tags ?? [], links: null, status: 'Open', created_at: new Date().toISOString(),
      revisit_date: null, revisit_when: null, concept: {}, task_id: null, campaign_id: null };
    state.ideas.unshift(row); return ideaJson(row);
  }
  const idea = state.ideas.find((i) => i.id === (args._id ?? args._idea));
  if (name === 'ledger_update_idea') {
    const u = { ...args._u };
    if (u.tags !== undefined) u.tags = String(u.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (u.concept) { u.concept = { ...idea.concept, ...Object.fromEntries(Object.entries(u.concept).filter(([, v]) => v)) }; if (!u.status && idea.status === 'Open') u.status = 'Developing'; }
    Object.assign(idea, u); return ideaJson(idea);
  }
  if (name === 'ledger_idea_to_campaign') {
    const result = write('ledger_save_campaign', { _id: args._campaign, _c: { name: idea.concept?.oneLine || idea.text, brand: idea.brand, stage: 'Developing', log_text: `From idea: ${idea.text}` } });
    idea.status = 'Promoted'; idea.campaign_id = args._campaign; return result;
  }
  if (name === 'ledger_delete_idea') { state.ideas = state.ideas.filter((i) => i.id !== args._id); return null; }
  for (const [rpc, list, arg] of [['ledger_save_vendor', 'vendors', '_v'], ['ledger_save_template', 'templates', '_t'], ['ledger_save_key_date', 'keyDates', '_k']]) {
    if (name !== rpc) continue;
    const values = { ...args[arg] };
    if (rpc === 'ledger_save_template' && typeof values.subtasks === 'string') values.subtasks = values.subtasks.split('\n').map((s) => s.trim()).filter(Boolean);
    const existing = state[list].find((x) => x.id === args._id);
    if (existing) Object.assign(existing, values); else state[list].push({ id: args._id, ...values });
    return state[list];
  }
  if (name === 'ledger_save_brand') { state.foundations[args._name] = { ...state.foundations[args._name], ...args._f }; return null; }
  if (name === 'ledger_delete_library_item') {
    const list = { vendor: 'vendors', template: 'templates', key_date: 'keyDates' }[args._kind];
    state[list] = state[list].filter((x) => x.id !== args._id); return null;
  }
  if (name === 'ledger_refresh_key_dates') return state.keyDates.length;
  if (name === 'ledger_import_batch') {
    const rows = Array.isArray(args._rows) ? args._rows : [];
    state.settings.imported_at = new Date().toISOString();
    return { kind: args._kind, received: rows.length, inserted: args._kind === 'links' ? 0 : rows.length, updated: 0, saved_rows: rows.map((row) => row.legacy_row), unresolved_rows: [] };
  }
  if (name === 'ledger_import_lock') { state.settings.import_locked_at = args._locked ? new Date().toISOString() : null; return { ...state.settings }; }
  return undefined;
}

function read(name, args) {
  const owner = args._owner ?? null;
  if (name === 'ledger_open' || name === 'ledger_bootstrap') return boot();
  if (name === 'ledger_home') return home(owner);
  if (name === 'ledger_task') { const t = own(args._id); return t ? taskJson(t, true) : fail('Task not found.', 'P0002'); }
  if (name === 'ledger_search') {
    const q = String(args._query ?? '').toLowerCase();
    return { tasks: live().filter((t) => t.title.toLowerCase().includes(q)).map((t) => taskJson(t)),
      deliverables: live().flatMap((t) => t.deliverables.filter((d) => `${d.type} ${d.version} ${t.title}`.toLowerCase().includes(q))
        .map((d) => ({ ...d, task_id: t.id, task_title: t.title }))) };
  }
  if (name === 'ledger_report') return report(args._period ?? 'day', args._date);
  if (name === 'ledger_campaigns') return state.campaigns.map((c) => campaignJson(c));
  if (name === 'ledger_campaign') { const c = state.campaigns.find((x) => x.id === args._id); return c ? campaignJson(c, true) : fail('Campaign not found.', 'P0002'); }
  if (name === 'ledger_campaign_details') return state.campaigns.map((c) => campaignJson(c, true));
  if (name === 'ledger_ideas') return state.ideas.filter((i) => !args._status || i.status === args._status).map(ideaJson);
  if (name === 'ledger_library') {
    return { vendors: state.vendors.map((v) => ({ ...v, tasks: live().filter((t) => t.vendor === v.name).length })), templates: state.templates, key_dates: state.keyDates,
      brands: boot().brands };
  }
  if (name === 'ledger_insights') return insights();
  if (name === 'ledger_google_status') return { ...state.google };
  if (name === 'ledger_reminders') return state.reminders.filter((r) => !r.deleted && (args._include_done || !r.done));
  if (name === 'ledger_team_members') {
    return [{ user_id: '7d4f9a52-3c1b-4e8a-9f60-2b7d1c5e8a31', employee_id: 'qa-emp-team-1', name: 'Vivek Menon', code: 'PJ-0142', department: 'Marketing', designation: 'Creative Head' },
      { user_id: '0b8e2c64-91d7-4f35-a2c8-6e1f4d7b9c02', employee_id: 'qa-emp-team-2', name: 'Priya Nair', code: 'PJ-0188', department: 'Marketing', designation: 'Designer' }];
  }
  if (name === 'ledger_export_tasks') return [{ logged_at: `${today}T09:00`, work_date: today, brand: 'Parakkat Jewels', task: 'Diwali hoarding v2', status: 'Internal Review', priority: 'High', notes: '[7 Oct] Draft shared', pinned: false, revision: 1 }];
  if (name === 'ledger_import_preview') return { kind: args._kind, existing: 0, edited_rows: [] };
  return undefined;
}

const ARRAYS = new Set(['ledger_campaigns', 'ledger_campaign_details', 'ledger_ideas', 'ledger_reminders', 'ledger_team_members', 'ledger_export_tasks',
  'ledger_save_vendor', 'ledger_save_template', 'ledger_save_key_date']);

export function ledgerRpc(name, args, { canWrite }) {
  if (!ledgerFixtures || !name.startsWith('ledger_')) return undefined;
  const reading = read(name, args ?? {});
  if (reading !== undefined) {
    if (reading?.error) return reading;
    return ARRAYS.has(name) ? { rows: clone(reading) } : { rows: [clone(reading)], one: true };
  }
  if (!canWrite) return fail('Writes are blocked in this demo.', '42501');
  const result = write(name, args ?? {});
  if (result === undefined) return fail(`Demo has no ${name}.`, 'PGRST202');
  if (result?.error) return result;
  return ARRAYS.has(name) ? { mutated: true, rows: clone(result) } : { mutated: true, one: true, rows: [clone(result)] };
}
