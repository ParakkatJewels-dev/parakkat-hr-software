// Work Ledger demo data (?qa-ledger). In-memory only; the SQL suite owns privacy and rules.
import { addDays, weekStart } from '../src/lib/ledger/periods.js';
import { today } from './fixtures';

export const ledgerFixtures = new URL(window.location.href).searchParams.has('qa-ledger');

const state = {
  settings: { seeded_at: new Date().toISOString(), imported_at: null, import_locked_at: null, sound: false },
  counts: { tasks: 42, support: 11, progress: 63, subtasks: 58, deliverables: 19, campaigns: 4, ideas: 9, vendors: 6, templates: 4, key_dates: 12, reminders: 3 },
};
const boot = () => ({
  owner: { user_id: 'qa-ledger-owner', name: 'Vivek Menon', designation: 'Creative Head' },
  settings: { ...state.settings },
  brands: ['Jewels', 'Munnar', 'Riverscape', 'Adimali', 'General'].map((label, i) => ({ id: `qa-brand-${i}`, name: label === 'General' ? 'General' : `Parakkat ${label}`, label, sort_order: i + 1, foundation: {} })),
  templates: [], vendors: [], campaigns: [{ id: 'qa-camp-1', name: 'Diwali 2026', brand: 'Parakkat Jewels', stage: 'Production', status: 'Active' }],
  people: ['Priya', 'Rahul'], used_types: ['Print', 'Reel'], used_brands: ['General', 'Parakkat Jewels'], counts: { ...state.counts },
});

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

export function ledgerRpc(name, args, { canWrite }) {
  if (!ledgerFixtures || !name.startsWith('ledger_')) return undefined;
  if (name === 'ledger_open' || name === 'ledger_bootstrap') return { rows: [boot()], one: true };
  if (name === 'ledger_report') return { rows: [report(args._period ?? 'day', args._date)], one: true };
  if (name === 'ledger_export_tasks') return { rows: [{ logged_at: `${today}T09:00`, work_date: today, brand: 'Parakkat Jewels', task: 'Diwali hoarding v2', status: 'Internal Review', priority: 'High', notes: '[7 Oct] Draft shared', pinned: false, revision: 1 }] };
  if (name === 'ledger_import_preview') return { rows: [{ kind: args._kind, existing: 0, edited_rows: [] }], one: true };
  if (!canWrite) return { error: { code: '42501', message: 'Writes are blocked in this demo.' } };
  if (name === 'ledger_import_batch') {
    const rows = Array.isArray(args._rows) ? args._rows : [];
    if (['tasks', 'ideas', 'campaigns'].includes(args._kind)) state.counts[args._kind] += rows.length;
    state.settings.imported_at = new Date().toISOString();
    return { mutated: true, one: true, rows: [{ kind: args._kind, received: rows.length, inserted: args._kind === 'links' ? 0 : rows.length, updated: 0,
      saved_rows: rows.map((row) => row.legacy_row), unresolved_rows: [] }] };
  }
  if (name === 'ledger_import_lock') {
    state.settings.import_locked_at = args._locked ? new Date().toISOString() : null;
    return { mutated: true, one: true, rows: [{ ...state.settings }] };
  }
  return { error: { code: 'PGRST202', message: `Demo has no ${name}.` } };
}
