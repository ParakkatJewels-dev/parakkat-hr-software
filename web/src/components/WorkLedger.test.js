import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

let server, AuthContext, WorkLedger, ReportView, LedgerSettings, Drawer;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: WorkLedger } = await server.ssrLoadModule('/src/components/WorkLedger.jsx'));
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

test('the ledger opens on Reports with the owner name and two tabs', () => {
  const html = render(React.createElement(WorkLedger), { seed: { '["work-ledger","bootstrap","me"]': boot } });
  assert.match(html, /Vivek’s ledger/);
  assert.match(html, /Creative Head/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>Reports</);
  assert.match(html, />Settings</);
  for (const label of ['Today', 'Pick a week', 'Pick a month', 'Overall to date', 'Custom period']) assert.ok(html.includes(label), label);
  assert.match(html, /role="radio" aria-checked="true"[^>]*>Today/);
  assert.match(html, /Prepare report to share/);
});

test('the settings tab shows counts, export, import and the compare check', () => {
  const html = render(React.createElement(WorkLedger), { path: '/ledger/settings', seed: { '["work-ledger","bootstrap","me"]': boot } });
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
