import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

let server, AuthContext, WorkLedger, shortcutFor, ReportView, LedgerSettings, Drawer, CampaignDetail, LedgerContext, dueItems, TeamLedgers;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: WorkLedger, shortcutFor } = await server.ssrLoadModule('/src/components/WorkLedger.jsx'));
  ({ CampaignDetail } = await server.ssrLoadModule('/src/components/ledger/LedgerCampaigns.jsx'));
  ({ LedgerContext } = await server.ssrLoadModule('/src/components/ledger/ui.jsx'));
  ({ dueItems } = await server.ssrLoadModule('/src/components/ledger/DueBanner.jsx'));
  ({ default: TeamLedgers } = await server.ssrLoadModule('/src/components/TeamLedgers.jsx'));
  ({ ReportView } = await server.ssrLoadModule('/src/components/ledger/LedgerReports.jsx'));
  ({ default: LedgerSettings } = await server.ssrLoadModule('/src/components/ledger/LedgerSettings.jsx'));
  ({ default: Drawer } = await server.ssrLoadModule('/src/components/ledger/Drawer.jsx'));
});
after(async () => { await server?.close(); });

const boot = {
  owner: { user_id: 'viewer', name: 'Vivek Menon', designation: 'Creative Head' },
  settings: { seeded_at: '2026-10-20T00:00:00Z', imported_at: null, import_locked_at: null, sound: false },
  brands: [{ id: 'b1', name: 'Parakkat Jewels', label: 'Jewels', sort_order: 1, foundation: {} }],
  templates: [], vendors: [], campaigns: [], people: [], used_types: [], used_brands: [],
  counts: { tasks: 812, support: 140, progress: 960, subtasks: 300, deliverables: 120, campaigns: 18, ideas: 77, vendors: 12, templates: 4, key_dates: 20, reminders: 9 },
};
const auth = { user: { id: 'viewer', email: 'viewer@example.test' }, isSuperAdmin: false, employee: { id: 'e1' }, assignments: [], permissions: [{ permission: 'ledger.use', scope_type: 'self' }] };

function render(element, { path = '/ledger', seed = {} } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  for (const [key, value] of Object.entries(seed)) client.setQueryData(JSON.parse(key), value);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [path] }, element))));
  } finally { client.clear(); }
}

const report = {
  period: 'day', from: '2026-10-07', to: '2026-10-07', today: '2026-10-07', single_day: true,
  worked_on: [{ id: 't1', title: 'Diwali hoarding v2', brand_label: 'Jewels', event: 'Sent for internal review', is_new: true,
    notes: [{ date: '2026-10-07', note: 'Shared with MD', minutes: 15 }] }],
  delivered: [{ id: 't2', title: 'Menu card print', brand_label: 'Riverscape', outcome: 'Printed 200 cards', notes: [{ date: '2026-10-05', note: 'Proof approved' }] }],
  support: [{ id: 's1', title: 'Reviewed menu layout', for_whom: 'Priya', minutes: 20 }],
  support_by_person: [{ person: 'Priya', count: 1, minutes: 20 }], support_minutes: 20,
  pending_now: [{ id: 't1', title: 'Diwali hoarding v2', brand_label: 'Jewels', status: 'Internal Review', untouched: false },
    { id: 't3', title: 'Brochure reprint', brand_label: 'Adimali', status: 'In Progress', untouched: true }],
  overdue: [{ id: 't3', title: 'Brochure reprint', brand_label: 'Adimali', deadline: '2026-10-01' }],
  blocked: [{ id: 't1', title: 'Diwali hoarding v2', status: 'Internal Review', waiting_on: null, since: '2026-10-07' }],
  wins: [{ id: 't2', title: 'Menu card print', outcome: 'Printed 200 cards' }],
  by_brand: [{ brand: 'Parakkat Jewels', label: 'Jewels', items: 1, done: 0 }], by_campaign: [], by_type: [{ type: 'Print', items: 2, done: 1 }],
  cost: { est: 12000, actual: 15500 }, ideas_captured: [{ id: 'i1', text: 'Reel on resort mornings' }],
};

const card = (fields) => ({ id: fields.title, brand: 'Parakkat Jewels', brand_label: 'Jewels', status: 'Brief', priority: 'Medium', deadline: null, pinned: false,
  focused: false, tags: [], stale: false, subtasks_total: 0, subtasks_done: 0, depends_on_title: null, last_progress: null, ...fields });
const home = {
  today: '2026-10-20',
  pending: [
    card({ title: 'Diwali hoarding v2', status: 'Internal Review', pinned: true, focused: true, subtasks_total: 2, subtasks_done: 1, deadline: '2026-10-18', type: 'Print' }),
    ...['Reel one', 'Reel two', 'Reel three', 'Reel four'].map((title) => card({ title, status: 'In Progress', brand: 'Parakkat Munnar Resort', brand_label: 'Munnar' })),
    card({ title: 'Showroom signage', status: 'Blocked', waiting_on: 'Landlord approval', stale: true }),
    card({ title: 'Monsoon banner', depends_on_title: 'Diwali hoarding v2', depends_on_done: false }),
  ],
  completed_today: [card({ title: 'Staff ID cards', status: 'Delivered', outcome: 'Handed over' })],
  done_this_week: 4, worked_on_today: 2, support_today: 1, support_minutes_today: 20, overdue: 1, ideas_open: 3,
  ideas: [{ id: 'i1', text: 'Reel on resort mornings', status: 'Open' }],
  alerts: [{ kind: 'decision', campaign_id: 'c2', title: 'Monsoon stays', text: 'Approve the weekday offer?' }],
  campaigns: [{ id: 'c1', name: 'Diwali 2026', brand_label: 'Jewels', stage: 'Production', done: 3, total: 7, in_review: 1, blocked: 0, spend: 12000, launch_date: '2026-11-01', days_to_launch: 12 }],
  key_dates: [{ id: 'k1', name: 'Christmas', date: '2026-12-25', days_away: 66, has_campaign: false }],
  schedule: [{ id: 'r1', text: 'Call the printer', due_at: '2026-10-20T11:30', repeat: null, overdue: false }],
  google: { connected: false, status: 'disconnected' },
};
const seeded = { '["work-ledger","bootstrap","me"]': boot, '["work-ledger","home","me"]': home };

test('the ledger opens on Home with seven tabs, the figures and the board', () => {
  const html = render(React.createElement(WorkLedger), { seed: seeded });
  assert.match(html, /Vivek’s ledger/);
  assert.match(html, /Creative Head/);
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['Home', 'Campaigns', 'Reports', 'Insights', 'Ideas', 'Library', 'Settings']);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>Home</);
  assert.match(html, /1 open task is past the deadline/);
  assert.match(html, /<dt>Pending<\/dt><dd>7<\/dd>/);
  assert.match(html, /<dt>Help today<\/dt><dd>1<small> · 20m<\/small><\/dd>/);
  for (const lane of ['To do', 'In progress', 'In review', 'Approved', 'Blocked']) assert.match(html, new RegExp(`class="ledger-lane-head">${lane} `), lane);
  assert.match(html, /4 in progress — more than 3 at once/, 'WIP warning above three');
  assert.match(html, /Overdue · /);
  assert.match(html, /aria-pressed="true" aria-label="Unpin"/, "pinned cards offer Unpin");
  assert.match(html, />Stale</);
  assert.match(html, /Diwali hoarding v2<\/span>/, 'depends-on chip names the task');
  assert.match(html, /Decision needed<\/span>/);
  assert.match(html, /Call the printer/);
  assert.match(html, /Google Calendar is not connected/);
  assert.match(html, /Christmas/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /Move Reel one to/);
});

test('a team member’s ledger is read-only: no settings, no adding, no dragging, no schedule', () => {
  const html = render(React.createElement(WorkLedger, { owner: 'u-2', onBack() {} }), { path: '/team-ledgers/u-2',
    seed: { '["work-ledger","bootstrap","u-2"]': boot, '["work-ledger","home","u-2"]': { ...home, schedule: null, google: null } } });
  assert.match(html, /Vivek Menon’s ledger/);
  assert.match(html, /read only/);
  assert.doesNotMatch(html, />Settings</);
  assert.doesNotMatch(html, /New task|Add a task|Log help/);
  assert.doesNotMatch(html, /draggable="true"/);
  assert.doesNotMatch(html, /Schedule/);
  assert.match(html, /Only its owner can change it/);
  assert.match(html, /Team ledgers/);
});

test('the reports tab keeps its period picker and share draft', () => {
  const html = render(React.createElement(WorkLedger), { path: '/ledger/reports', seed: seeded });
  for (const label of ['Today', 'Pick a week', 'Pick a month', 'Overall to date', 'Custom period']) assert.ok(html.includes(label), label);
  assert.match(html, /role="radio" aria-checked="true"[^>]*>Today/);
  assert.match(html, /Prepare report to share/);
});

test('shortcuts: keys map to actions, and nothing fires while typing', () => {
  const key = (k, extra = {}) => ({ key: k, target: {}, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...extra });
  assert.equal(shortcutFor(key('n')), 'task');
  assert.equal(shortcutFor(key('H')), 'help');
  assert.equal(shortcutFor(key('r')), 'remind');
  assert.equal(shortcutFor(key('/')), 'command');
  assert.equal(shortcutFor(key('k', { ctrlKey: true })), 'command');
  assert.equal(shortcutFor(key('3')), 'tab:2');
  assert.equal(shortcutFor(key('8')), null);
  assert.equal(shortcutFor(key('n', { metaKey: true })), null);
  assert.equal(shortcutFor(key('n', { target: { tagName: 'INPUT' } })), null);
  assert.equal(shortcutFor(key('/', { target: { tagName: 'TEXTAREA' } })), null);
  assert.equal(shortcutFor(key('h', { target: { isContentEditable: true } })), null);
  assert.equal(shortcutFor(key('n', { defaultPrevented: true })), null);
});

test('due banner: reminders at or past their time, meetings within ten minutes', () => {
  const now = Date.parse('2026-10-20T05:30:00Z'); // 11:00 in India
  const items = dueItems({ now,
    schedule: [{ id: 'a', text: 'Due', due_at: '2026-10-20T11:00' }, { id: 'b', text: 'Later', due_at: '2026-10-20T11:30' }, { id: 'c', text: 'Done', due_at: '2026-10-20T10:00', done: true }],
    events: [{ id: 'm1', summary: 'Standup', start: '2026-10-20T11:08:00+05:30' }, { id: 'm2', summary: 'Lunch', start: '2026-10-20T13:00:00+05:30' },
      { id: 'm3', summary: 'Holiday', start: '2026-10-20', all_day: true }] });
  assert.deepEqual(items.map((item) => [item.kind, item.text]), [['meeting', 'Standup'], ['reminder', 'Due']]);
  assert.equal(items[0].minutes, 8);
});

test('a campaign at Decision shows the stage bar and the decision panel', () => {
  const campaign = { id: 'c2', name: 'Monsoon stays', brand: 'Parakkat Munnar Resort', brand_label: 'Munnar', stage: 'Decision', status: 'Active', priority: 'Medium',
    decision: 'Approve a 20% weekday offer?', done: 0, total: 0, in_review: 0, blocked: 0, spend: 0, brief: {}, measure: {}, results: {}, tasks: [], ideas: [], log: [{ at: '2026-10-19', text: 'Created at Captured' }] };
  const value = { owner: null, readOnly: false, boot, today: '2026-10-20', open() {} };
  const html = render(React.createElement(LedgerContext.Provider, { value }, React.createElement(CampaignDetail, { id: 'c2', onBack() {} })),
    { seed: { '["work-ledger","campaign","me","c2"]': campaign } });
  const stages = [...html.matchAll(/<li data-state="([a-z]+)"><button[^>]*>([A-Za-z]+)</g)].map((match) => `${match[2]}:${match[1]}`);
  assert.deepEqual(stages, ['Captured:done', 'Developing:done', 'Decision:current', 'Approved:next', 'Production:next', 'Live:next', 'Reviewed:next']);
  assert.match(html, /Decision needed<\/h3>/);
  assert.match(html, />Approve</);
  assert.match(html, /Advance to Approved/);
  assert.match(html, /Campaign brief/);
  assert.match(html, /Created at Captured/);
});

test('team ledgers lists the people a manager may read, by department', () => {
  const people = [{ user_id: '7d4f9a52-3c1b-4e8a-9f60-2b7d1c5e8a31', name: 'Vivek Menon', code: 'PJ-1', department: 'Marketing', designation: 'Creative Head' }];
  const html = render(React.createElement(TeamLedgers), { path: '/team-ledgers', seed: { '["work-ledger","team"]': people } });
  assert.match(html, /<h1>Team ledgers<\/h1>/);
  assert.match(html, /Marketing/);
  assert.match(html, /Vivek Menon/);
  assert.match(html, /never their reminders or calendar/);
});

test('the settings tab shows Google Calendar, sound, counts, export, import, the compare check and shortcuts', () => {
  const html = render(React.createElement(WorkLedger), { path: '/ledger/settings', seed: { ...seeded, '["work-ledger","google-status"]': { connected: false, status: 'disconnected' } } });
  assert.match(html, /Connect Google Calendar/);
  assert.match(html, /Play a short chime/);
  assert.match(html, /Keyboard shortcuts/);
  assert.match(html, /How alerts work/);
  assert.match(html, /<strong>812<\/strong> tasks/);
  assert.match(html, /<strong>140<\/strong> help entries/);
  assert.match(html, /Export everything as CSV/);
  assert.match(html, /File → Download → Microsoft Excel/);
  assert.match(html, /accept="\.xlsx,\.csv"/);
  assert.match(html, /Compare with the old app/);
});

test('a locked import says so and offers to unlock', () => {
  const html = render(React.createElement(LedgerSettings, { boot: { ...boot, settings: { ...boot.settings, import_locked_at: '2026-10-21T00:00:00Z' } } }));
  assert.match(html, /Import is locked for this ledger/);
  assert.doesNotMatch(html, /type="file"/);
});

test('the report view lists every section in reading order with brands, events and dated notes', () => {
  const html = render(React.createElement(ReportView, { report }));
  const order = ['Worked on', 'Support &amp; reviews', 'Delivered', 'Still open', 'Wins &amp; outcomes', 'By brand', 'By type', 'Spend', 'Blocked / in review', 'Overdue', 'Ideas captured'];
  const positions = order.map((title) => html.indexOf(`<h3>${title}`));
  assert.ok(positions.every((p) => p > 0), 'all sections present');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'sections in order');
  assert.match(html, /→ Sent for internal review/);
  assert.match(html, /class="ledger-tag">new</);
  assert.match(html, /<span class="ledger-date">10-05<\/span>Proof approved/, 'notes from other days are dated');
  assert.doesNotMatch(html, /<span class="ledger-date">10-07<\/span>/, 'notes from the day itself are not');
  assert.match(html, /data-untouched="true"[^>]*><span class="ledger-item-title">Brochure reprint/);
  assert.match(html, /Estimated ₹12,000 · actual ₹15,500/);
  assert.match(html, /1 worked on · 1 delivered · 1 support \(20m\) · 1 overdue · 1 ideas/);
});

test('an empty period says nothing was logged; multi-day reports have no backlog section', () => {
  const html = render(React.createElement(ReportView, { report: { period: 'week', from: '2026-10-05', to: '2026-10-11', single_day: false } }));
  assert.match(html, /Nothing logged in this period yet\./);
  assert.match(html, /5 Oct – 11 Oct 2026/);
  assert.doesNotMatch(html, /Still open/);
});

test('the drawer is a labelled modal dialog with a close button', () => {
  const html = render(React.createElement(Drawer, { title: 'Report draft', subtitle: 'Daily', onClose() {}, footer: React.createElement('button', null, 'Copy') }, 'Body'));
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/);
  const id = html.match(/aria-labelledby="([^"]+)"/)[1];
  assert.ok(html.includes(`id="${id}">Report draft</h2>`));
  assert.match(html, /aria-label="Close Report draft"/);
  assert.match(html, /<footer class="ledger-drawer-foot"><button>Copy<\/button>/);
});
