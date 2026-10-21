import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

let server, AuthContext, WorkLedger, shortcutFor, visibleTabs, ReportView, reportRows, LedgerSettings, Drawer, CampaignDetail, LedgerContext, dueItems, TeamLedgers, nextMoves;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: WorkLedger, shortcutFor, visibleTabs } = await server.ssrLoadModule('/src/components/WorkLedger.jsx'));
  ({ nextMoves } = await server.ssrLoadModule('/src/components/work/TaskWorkSections.jsx'));
  ({ CampaignDetail } = await server.ssrLoadModule('/src/components/ledger/LedgerCampaigns.jsx'));
  ({ LedgerContext } = await server.ssrLoadModule('/src/components/ledger/ui.jsx'));
  ({ dueItems } = await server.ssrLoadModule('/src/components/ledger/DueBanner.jsx'));
  ({ default: TeamLedgers } = await server.ssrLoadModule('/src/components/TeamLedgers.jsx'));
  ({ ReportView, reportRows } = await server.ssrLoadModule('/src/components/ledger/LedgerReports.jsx'));
  ({ default: LedgerSettings } = await server.ssrLoadModule('/src/components/ledger/LedgerSettings.jsx'));
  ({ default: Drawer } = await server.ssrLoadModule('/src/components/ledger/Drawer.jsx'));
});
after(async () => { await server?.close(); });

const boot = { owner: { user_id: 'viewer', name: 'Vivek Menon', designation: 'Creative Head' }, brands: [] };
const employeeAuth = { user: { id: 'viewer', email: 'viewer@example.test' }, isSuperAdmin: false, employee: { id: 'e1', full_name: 'Vivek Menon' }, assignments: [],
  permissions: ['task.read', 'task.update'].map((permission) => ({ permission, scope_type: 'self' })) };
const managerAuth = { ...employeeAuth, permissions: [...employeeAuth.permissions,
  ...['task.read', 'task.create', 'task.update', 'task.manage', 'task.request'].map((permission) => ({ permission, scope_type: 'department', scope_id: 'd1' }))] };
let auth = employeeAuth;

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

const card = (fields) => ({ id: fields.title, status: 'To Do', review_stage: null, lane: 'todo', step: 'To do', priority: 'Medium', due_date: null,
  pinned: false, focused: false, tags: [], stale: false, subtasks_total: 0, subtasks_done: 0, comments_count: 0, attachments_count: 0,
  depends_on_title: null, last_progress: null, can_edit: true, employee_id: 'e1', revision: 0, ...fields });
const home = {
  today: '2026-10-20', employee_id: 'e1',
  pending: [
    card({ title: 'Diwali hoarding v2', status: 'In Progress', review_stage: 'Internal Review', lane: 'review', step: 'In review', pinned: true, focused: true,
      subtasks_total: 2, subtasks_done: 1, due_date: '2026-10-18', revision: 1 }),
    ...['Reel one', 'Reel two', 'Reel three', 'Reel four'].map((title) => card({ title, status: 'In Progress', lane: 'progress', step: 'In progress' })),
    card({ title: 'Showroom signage', status: 'Blocked', lane: 'blocked', step: 'Blocked', waiting_on: 'Landlord approval', stale: true }),
    card({ title: 'Monsoon banner', depends_on_title: 'Diwali hoarding v2', depends_on_done: false }),
    card({ title: 'Someone else’s', can_edit: false, employee_id: 'e9', assignee_name: 'Priya Nair' }),
  ],
  completed_today: [card({ title: 'Staff ID cards', status: 'Done', lane: 'closed', step: 'Done', outcome: 'Handed over' })],
  done_this_week: 4, worked_on_today: 2, support_today: 1, support_minutes_today: 20, overdue: 1,
  schedule: [{ id: 'r1', text: 'Call the printer', due_at: '2026-10-20T11:30', repeat: null, overdue: false, task_id: 't1', task_title: 'Diwali hoarding v2' }],
  google: { connected: false, status: 'disconnected' },
};
const seeded = { '["work","home"]': home };

test('the Ledger opens on Home with the app header, figures, schedule and my board', () => {
  auth = employeeAuth;
  const html = render(React.createElement(WorkLedger), { seed: seeded });
  assert.match(html, /class="page-shell[^"]*ledger-page"/, 'the app page shell and header card');
  assert.match(html, /<h1[^>]*>.*Work Ledger<\/h1>/);
  assert.match(html, /New task<\/button>/);
  assert.match(html, /Log help<\/button>/);
  const tabs = [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(tabs, ['Home', 'Routines', 'Reports', 'Insights', 'Deleted', 'Settings'], 'an employee gets no Team or Requests');
  assert.match(html, /1 open task is past the due date/);
  assert.match(html, /<dt>Open<\/dt><dd>8<\/dd>/);
  assert.match(html, /<dt>Help today<\/dt><dd>1<small> · 20m<\/small><\/dd>/);
  for (const lane of ['To do', 'In progress', 'In review', 'Approved', 'Blocked']) assert.match(html, new RegExp(`class="ledger-lane-head">${lane} `), lane);
  assert.match(html, /4 in progress — more than 3 at once/, 'WIP warning above three');
  assert.match(html, /Overdue · /);
  assert.match(html, /Round 2/, 'a task back from changes shows its round');
  assert.match(html, /aria-pressed="true" aria-label="Unpin"/, 'pinned cards offer Unpin');
  assert.match(html, />Stale</);
  assert.match(html, /Diwali hoarding v2<\/span>/, 'depends-on chip names the task');
  assert.match(html, /Call the printer/);
  assert.match(html, /Google Calendar is not connected/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /Move Reel one to/);
  assert.doesNotMatch(html, /Move Someone else’s to/, 'no moves on work you cannot change');
  assert.match(html, /Priya Nair/, 'work you are helping on names its owner');
});

test('a manager also gets Team and Requests, mounted from Task Management', () => {
  assert.deepEqual(visibleTabs({ canTeam: true, canRequests: true, canDeleted: true }).map((t) => t.id),
    ['home', 'team', 'requests', 'routines', 'reports', 'insights', 'deleted', 'settings']);
  assert.deepEqual(visibleTabs({ canTeam: false, canRequests: false, canDeleted: false }).map((t) => t.id),
    ['home', 'routines', 'reports', 'insights', 'settings']);
  auth = managerAuth;
  const html = render(React.createElement(WorkLedger), { path: '/ledger/team', seed: { ...seeded, '["tasks"]': [] } });
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>.*?Team<\/button>/);
  assert.match(html, /Assign a task<\/button>/, 'Task Management’s own composer button');
  assert.doesNotMatch(html, /Workspace \/ Tasks/, 'without Task Management’s own header');
  auth = employeeAuth;
});

test('the reports tab keeps its period picker, share draft and CSV', () => {
  const html = render(React.createElement(WorkLedger), { path: '/ledger/reports', seed: seeded });
  for (const label of ['Today', 'Pick a week', 'Pick a month', 'Overall to date', 'Custom period']) assert.ok(html.includes(label), label);
  assert.match(html, /role="radio" aria-checked="true"[^>]*>Today/);
  assert.match(html, /Prepare report to share/);
  assert.match(html, /CSV<\/button>/);
});

test('next moves follow the step, and only an approver may approve', () => {
  const labels = (task, approver) => nextMoves(task, { approver }).map((m) => m.label);
  assert.deepEqual(labels({ status: 'To Do', lane: 'todo' }, false), ['Start', 'Mark done']);
  assert.deepEqual(labels({ status: 'In Progress', lane: 'progress' }, false), ['Send for review', 'Send for approval', 'Blocked', 'Mark done']);
  assert.deepEqual(labels({ status: 'In Progress', lane: 'review', review_stage: 'Awaiting Approval' }, false), ['Mark done']);
  assert.deepEqual(labels({ status: 'In Progress', lane: 'review', review_stage: 'Awaiting Approval' }, true), ['Approve', 'Changes needed', 'Mark done']);
  assert.deepEqual(labels({ status: 'In Progress', lane: 'review', review_stage: 'Revisions' }, false), ['Send for review again', 'Send for approval', 'Mark done']);
  assert.deepEqual(labels({ status: 'Done', lane: 'closed' }, true), ['Reopen']);
  assert.deepEqual(labels({ status: 'Cancelled', lane: 'closed' }, true), []);
});

test('the report CSV lists notes, deliveries and help', () => {
  const rows = reportRows({ worked_on: [{ title: 'Reel', status: 'In progress', notes: [{ date: '2026-10-20', note: 'Cut', minutes: 30 }] }, { title: 'Quiet', status: 'To do', event: null }],
    delivered: [{ title: 'Menu', delivered_on: '2026-10-20', outcome: 'Printed' }], support: [{ title: 'Reviewed', date: '2026-10-20', type: 'Review / Feedback', minutes: 20, for_whom: 'Priya' }] });
  assert.deepEqual(rows.map((r) => r[0]), ['Worked on', 'Worked on', 'Delivered', 'Help given']);
  assert.deepEqual(rows[0], ['Worked on', '2026-10-20', 'Reel', 'In progress', 'Cut', 30, '', '']);
  assert.equal(rows[3][7], 'Priya');
});

test('shortcuts: keys map to actions, and nothing fires while typing', () => {
  const key = (k, extra = {}) => ({ key: k, target: {}, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...extra });
  assert.equal(shortcutFor(key('n')), 'task');
  assert.equal(shortcutFor(key('H')), 'help');
  assert.equal(shortcutFor(key('r')), 'remind');
  assert.equal(shortcutFor(key('/')), 'command');
  assert.equal(shortcutFor(key('k', { ctrlKey: true })), 'command');
  assert.equal(shortcutFor(key('3')), 'tab:2');
  assert.equal(shortcutFor(key('9')), 'tab:8');
  assert.equal(shortcutFor(key('0')), null);
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
  const value = { employeeId: 'e1', today: '2026-10-20', canTeam: false, creative: true, open() {} };
  const html = render(React.createElement(LedgerContext.Provider, { value }, React.createElement(CampaignDetail, { id: 'c2', onBack() {} })),
    { seed: { '["creative","campaign","c2"]': campaign } });
  const stages = [...html.matchAll(/<li data-state="([a-z]+)"><button[^>]*>([A-Za-z]+)</g)].map((match) => `${match[2]}:${match[1]}`);
  assert.deepEqual(stages, ['Captured:done', 'Developing:done', 'Decision:current', 'Approved:next', 'Production:next', 'Live:next', 'Reviewed:next']);
  assert.match(html, /Decision needed<\/h3>/);
  assert.match(html, />Approve</);
  assert.match(html, /Advance to Approved/);
  assert.match(html, /Campaign brief/);
  assert.match(html, /Created at Captured/);
  assert.match(html, /Add a task to this campaign/);
});

const creativeSettings = { member: true, can_configure: false, departments: [{ id: 'd1', name: 'Marketing' }] };
const creativeHome = {
  alerts: [{ kind: 'decision', campaign_id: 'c1', title: 'Diwali gold festival', text: 'Temple collection or lightweight range?' }],
  campaigns: [{ id: 'c1', name: 'Diwali gold festival', brand_label: 'Jewels', stage: 'Decision', done: 1, total: 3, launch_date: '2026-10-28' }],
  key_dates: [{ id: 'k1', name: 'Diwali', date: '2026-10-30', brand: 'Parakkat Jewels', brand_label: 'Jewels', lead_days: 30, days_away: 10, has_campaign: true },
    { id: 'k2', name: 'Christmas', date: '2026-12-25', brand: 'General', brand_label: 'General', lead_days: 30, days_away: 25, has_campaign: false }],
  ideas: [{ id: 'i1', text: 'Heirloom reel', by: 'Priya Nair' }], ideas_open: 4 };

test('the creative team gets Campaigns, Ideas and Library, and a creative block on Home', () => {
  assert.deepEqual(visibleTabs({ canTeam: false, canRequests: false, canDeleted: true, creative: true }).map((t) => t.id),
    ['home', 'routines', 'reports', 'insights', 'campaigns', 'ideas', 'library', 'deleted', 'settings']);
  auth = employeeAuth;
  const html = render(React.createElement(WorkLedger), { seed: { ...seeded, '["creative","settings"]': creativeSettings, '["creative","home"]': creativeHome } });
  const tabs = [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(tabs, ['Home', 'Routines', 'Reports', 'Insights', 'Campaigns', 'Ideas', 'Library', 'Deleted', 'Settings']);
  assert.match(html, /Creative team/);
  assert.match(html, /Temple collection or lightweight range\?/, 'a decision waiting is pointed out');
  assert.match(html, /Decision · 1\/3 done/);
  assert.match(html, /Christmas.*?no campaign yet/s, 'a coming date with no campaign is flagged');
  assert.doesNotMatch(html, /Diwali<span[^>]*>Jewels<\/span><span class="ledger-tag">/, 'a date with a campaign is not flagged');
  assert.match(html, /4 in the inbox/);
});

test('someone outside the creative team gets no creative tabs or Home block', () => {
  auth = employeeAuth;
  const html = render(React.createElement(WorkLedger), { seed: { ...seeded, '["creative","settings"]': { ...creativeSettings, member: false } } });
  assert.doesNotMatch(html, /Campaigns<\/button>|Ideas<\/button>|Library<\/button>/);
  assert.doesNotMatch(html, /Creative team/);
});

test('a super admin chooses the creative departments in Settings; members only see them', () => {
  const value = { employeeId: 'e1', today: '2026-10-20', canTeam: false, creative: true, open() {} };
  const departments = [{ id: 'd1', name: 'Marketing', code: 'MKT' }, { id: 'd2', name: 'Sales', code: 'SAL' }];
  let html = render(React.createElement(LedgerContext.Provider, { value }, React.createElement(LedgerSettings)),
    { seed: { '["creative","settings"]': { ...creativeSettings, can_configure: true }, '["org","departments"]': departments } });
  assert.match(html, /Save creative team/);
  assert.match(html, /<input type="checkbox" checked=""\/>Marketing/);
  assert.match(html, /<input type="checkbox"\/>Sales/);
  html = render(React.createElement(LedgerContext.Provider, { value }, React.createElement(LedgerSettings)),
    { seed: { '["creative","settings"]': creativeSettings } });
  assert.match(html, /Departments: Marketing\./);
  assert.doesNotMatch(html, /Save creative team/);
});

test('team ledgers lists the people a manager may read, by department', () => {
  const people = [{ user_id: '7d4f9a52-3c1b-4e8a-9f60-2b7d1c5e8a31', name: 'Vivek Menon', code: 'PJ-1', department: 'Marketing', designation: 'Creative Head' }];
  const html = render(React.createElement(TeamLedgers), { path: '/team-ledgers', seed: { '["work-ledger","team"]': people } });
  assert.match(html, /<h1[^>]*>.*Team ledgers<\/h1>/);
  assert.match(html, /Marketing/);
  assert.match(html, /Vivek Menon/);
  assert.match(html, /never their reminders or calendar/);
});

test('the settings tab shows Google Calendar, sound, what Home points out and shortcuts', () => {
  const html = render(React.createElement(WorkLedger), { path: '/ledger/settings', seed: { ...seeded, '["work-ledger","google-status"]': { connected: false, status: 'disconnected' } } });
  assert.match(html, /Connect Google Calendar/);
  assert.match(html, /Play a short chime/);
  assert.match(html, /What Home points out/);
  assert.match(html, /Keyboard shortcuts/);
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
