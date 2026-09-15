import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { accountFixtures } from '../test/scaleFixtures.js';

let server, AuthContext, AssetDetail, EmployeePicker, MyAssets, Payroll, Leave;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: AssetDetail, EmployeePicker } = await server.ssrLoadModule('/src/components/AssetDetail.jsx'));
  ({ default: MyAssets } = await server.ssrLoadModule('/src/components/MyAssets.jsx'));
  ({ default: Payroll } = await server.ssrLoadModule('/src/components/Payroll.jsx'));
  ({ default: Leave } = await server.ssrLoadModule('/src/components/Leave.jsx'));
});
after(async () => { await server?.close(); });

function render(Component, seeds = [], props = {}, path = '/') {
  const fixture = accountFixtures(36);
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } });
  for (const [key, data] of [[['employees'], fixture.employees], [['org', 'all'], fixture.org], ...seeds]) {
    client.setQueryData(key, data);
  }
  const auth = { user: { id: 'viewer' }, employee: { id: 'self', entity_id: 'company-1' },
    isSuperAdmin: true, assignments: [], permissions: [], rank: 1000 };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

test('asset custody pages ten handovers while retaining the complete past-holder count', () => {
  const asset = { id: 'asset-1', name: 'Shared laptop', category: 'Hardware', status: 'Allocated' };
  const history = Array.from({ length: 31 }, (_, i) => ({ id: `handover-${i}`,
    assigned_at: '2026-09-01T00:00:00Z', returned_at: i ? '2026-09-02T00:00:00Z' : null,
    employee: { id: `person-${i}`, full_name: `Custodian ${i}` } }));
  const html = render(AssetDetail, [[['assets', asset.id], asset], [['asset-history', asset.id], history]], { assetId: asset.id });
  assert.equal((html.match(/class="asset-timeline-item/g) ?? []).length, 10);
  assert.match(html, /of 31 custody records/);
  assert.match(html, /Page 1 of 4/);
  assert.match(html, /<strong>30<\/strong><small>Past holders<\/small>/);
  assert.match(html, /Holding it now/);
  assert.doesNotMatch(html, /Custodian 30/);
});

test('asset recipient picker exposes pages beyond eight matches within the owning company', () => {
  const html = render(EmployeePicker, [], { ownerEntityId: 'company-1', onChange() {} });
  assert.equal((html.match(/<li>/g) ?? []).length, 8);
  assert.match(html, /of 12 employees/);
  assert.match(html, /Page 1 of 2/);
  assert.match(html, /aria-label="Last page"/);
  assert.doesNotMatch(html, /Sample Employee 0002|Sample Employee 0034/);
});

test('personal assets page the complete assignment list', () => {
  const assets = Array.from({ length: 27 }, (_, i) => ({ id: `asset-${i}`, name: `Assigned laptop ${i}`, category: 'Hardware' }));
  const html = render(MyAssets, [[['assets', 'employee', 'self'], assets]]);
  assert.equal((html.match(/>Assigned laptop \d+</g) ?? []).length, 10);
  assert.match(html, /of 27 assigned assets/);
  assert.doesNotMatch(html, /Assigned laptop 26/);
});

test('pay component administration pages allowances and deductions beyond 25 rows', () => {
  const components = Array.from({ length: 61 }, (_, i) => ({ id: `component-${i}`, name: `Allowance ${i}`,
    code: `AL${i}`, kind: 'earning', calc_type: 'fixed', amount: 100 }));
  const html = render(Payroll, [[['pay-components'], components]], {}, '/payroll/components');
  assert.equal((html.match(/>Edit<\/button>/g) ?? []).length, 25);
  assert.match(html, /of 61 pay components/);
  assert.match(html, /Page 1 of 3/);
  assert.doesNotMatch(html, /Allowance 60/);
});

test('leave holiday calendar keeps all current-year entries reachable in ten-row pages', () => {
  const year = new Date().getFullYear();
  const holidays = Array.from({ length: 21 }, (_, i) => ({ id: `holiday-${i}`, name: `Company holiday ${i}`,
    holiday_date: `${year}-09-${String(i + 1).padStart(2, '0')}` }));
  const html = render(Leave, [[['holidays', 'all', year], holidays], [['leaves'], []]]);
  assert.equal((html.match(/Company holiday \d+/g) ?? []).length, 10);
  assert.match(html, /of 21 holidays/);
  assert.match(html, /Page 1 of 3/);
  assert.doesNotMatch(html, /Company holiday 20/);
});
