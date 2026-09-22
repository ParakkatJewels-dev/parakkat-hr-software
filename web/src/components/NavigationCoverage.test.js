import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { NAVIGATION_COUNT_KEYS } from '../lib/navigationCounts.js';

let server, AuthContext;
const components = {};
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  for (const name of ['Payroll', 'Performance', 'AttendanceAdmin', 'HelpdeskExit']) {
    components[name] = (await server.ssrLoadModule(`/src/components/${name}.jsx`)).default;
  }
});
after(async () => { await server?.close(); });

const counts = { ...Object.fromEntries(NAVIGATION_COUNT_KEYS.map(key => [key, 0])),
  payroll: 4, performance_mine: 5, performance_team: 6, attendance_mapping: 7, exits: 8 };
function render(name, path, data = counts, permitted = true) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity, gcTime: 0 } } });
  if (data) client.setQueryData(['section-counts', 'viewer', false, 'navigation-v2'], data);
  const actor = { user: { id: 'viewer' }, employee: { id: 'self' }, assignments: [],
    isSuperAdmin: permitted, permissions: permitted ? [] : ['payslip.read', 'goal.read', 'exit.create'].map(permission => ({ permission, scope_type: 'self' })) };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: actor },
        React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(components[name])))));
  } finally { client.clear(); }
}

test('payroll and device setup carry their pending count to the owning submenu on any selected view', () => {
  for (const path of ['/payroll/payslips', '/payroll/run']) {
    const html = render('Payroll', path);
    assert.match(html, /aria-label="Run Payroll, 4 draft payroll runs"/);
    assert.doesNotMatch(html, /aria-label="(?:Payslips|Salary Structures|Deductions &amp; Allowances), \d/);
  }
  for (const path of ['/attendance-admin/shifts', '/attendance-admin/mapping']) {
    const html = render('AttendanceAdmin', path);
    assert.match(html, /aria-label="Devices &amp; mapping, 7 device employees to link"/);
    assert.doesNotMatch(html, /aria-label="(?:Shifts|Holidays|Leave types|Sync status), \d/);
  }
});

test('goal ownership splits the shared total and exit clearance work remains visible inside Support', () => {
  for (const path of ['/performance/mine', '/performance/team']) {
    const html = render('Performance', path);
    assert.match(html, /aria-label="My goals, 5 active goals"/);
    assert.match(html, /aria-label="Team goals, 6 active goals"/);
  }
  assert.match(render('HelpdeskExit', '/helpdesk'), /aria-label="Exit Clearances, 8 exit clearances to review"/);
});

test('unknown and zero queues have no badges and read-only viewers do not see management badges', () => {
  for (const [name, path] of [['Payroll', '/payroll/payslips'], ['Performance', '/performance/mine'],
    ['AttendanceAdmin', '/attendance-admin/mapping'], ['HelpdeskExit', '/helpdesk']]) {
    for (const data of [null, Object.fromEntries(NAVIGATION_COUNT_KEYS.map(key => [key, 0]))]) {
      assert.doesNotMatch(render(name, path, data), /class="count-badge/);
    }
    assert.doesNotMatch(render(name, path, counts, false), /class="count-badge/);
  }
});
