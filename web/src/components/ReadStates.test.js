import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, Performance, Expense, Leave;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Performance } = await server.ssrLoadModule('/src/components/Performance.jsx'));
  ({ default: Expense } = await server.ssrLoadModule('/src/components/Expense.jsx'));
  ({ default: Leave } = await server.ssrLoadModule('/src/components/Leave.jsx'));
});
after(async () => { await server?.close(); });

function render(Component, key, { data, error, loading = false, extra = [] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0 } } });
  for (const item of [{ key: [key], data, error, loading }, ...extra]) {
    if (item.data !== undefined) client.setQueryData(item.key, item.data);
    if (item.error || item.loading) client.getQueryCache().build(client, { queryKey: item.key }).setState({
      status: item.error ? 'error' : 'pending', fetchStatus: item.loading ? 'fetching' : 'idle', error: item.error,
    });
  }
  const employee = { id: 'self', full_name: 'Self employee' };
  const auth = { employee, user: { id: 'viewer' }, isSuperAdmin: false, assignments: [],
    permissions: ['goal.read', 'goal.update', 'expense.read', 'expense.create', 'leave.read', 'leave.create'].map(permission => ({ permission, scope_type: 'self' })) };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, null, React.createElement(Component)))));
  } finally { client.clear(); }
}

test('failed goal reads offer retry without claiming that no goals exist', () => {
  const html = render(Performance, 'goals', { error: new Error('Failed to fetch') });
  assert.match(html, /Goals could not be loaded/);
  assert.match(html, /Try again/); assert.match(html, /Check your connection/);
  assert.doesNotMatch(html, /No goals set|No goals match/);
});

test('failed background goal refreshes retain known goals and identify them as cached', () => {
  const html = render(Performance, 'goals', { error: new Error('Failed to fetch'), data: [
    { id: 'goal', employee_id: 'self', title: 'Quarterly stock check', status: 'Active', progress: 25 },
  ] });
  assert.match(html, /Goals could not be refreshed/);
  assert.match(html, /Quarterly stock check/);
  assert.match(html, /Showing the last available data/);
});

test('initial expense failures do not fabricate zero totals or an empty history', () => {
  const html = render(Expense, 'expenses', { error: new Error('Failed to fetch') });
  assert.match(html, /Expense claims could not be loaded/); assert.match(html, /Try again/);
  assert.doesNotMatch(html, /Total Claims|Pending ₹|Approved ₹|No .*expense claims visible/);
});

test('failed expense refreshes keep the previous rows and totals visible with a warning', () => {
  const html = render(Expense, 'expenses', { error: new Error('Failed to fetch'), data: [
    { id: 'claim', employee_id: 'self', category: 'Travel Expenses', amount: 250, status: 'Pending' },
  ] });
  assert.match(html, /Expense claims could not be refreshed/);
  assert.match(html, /Showing the last available data/); assert.match(html, /Travel Expenses/);
  assert.match(html, /Total Claims/); assert.match(html, /250/);
});

test('initial reads announce loading and successful empty reads keep their true empty states', () => {
  const goals = render(Performance, 'goals', { loading: true });
  assert.match(goals, /aria-label="Loading goals"/); assert.doesNotMatch(goals, /No goals set/);
  const expenses = render(Expense, 'expenses', { loading: true });
  assert.match(expenses, /aria-label="Loading expense totals"/);
  assert.match(expenses, /aria-label="Loading expense claims"/); assert.doesNotMatch(expenses, /Total Claims/);
  assert.match(render(Performance, 'goals', { data: [] }), /No goals set for you yet/);
  assert.match(render(Expense, 'expenses', { data: [] }), /No expense claims visible to you yet/);
});

test('failed leave requests and lookups show retry states without inventing empty calendars or zero totals', () => {
  const year = new Date().getFullYear();
  const html = render(Leave, 'leaves', { error: new Error('Failed to fetch'), extra: [
    { key: ['leave-types'], error: new Error('Types unavailable') },
    { key: ['leave-balances', 'self', year], error: new Error('Balances unavailable') },
    { key: ['holidays', 'all', year], error: new Error('Calendar unavailable') },
  ] });
  for (const label of ['Leave requests could not be loaded', 'Leave types could not be loaded',
    'Leave balances could not be loaded', 'Holidays could not be loaded']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /Total Requests|No leave requests|No holidays set|day[s]? available/);
  assert.ok((html.match(/Try again/g) ?? []).length >= 4);
});
