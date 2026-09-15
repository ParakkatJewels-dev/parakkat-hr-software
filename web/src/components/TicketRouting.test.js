import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, TicketDesk, TicketCategories, HelpdeskExit;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: TicketDesk } = await server.ssrLoadModule('/src/components/TicketDesk.jsx'));
  ({ default: TicketCategories } = await server.ssrLoadModule('/src/components/TicketCategories.jsx'));
  ({ default: HelpdeskExit } = await server.ssrLoadModule('/src/components/HelpdeskExit.jsx'));
});
after(async () => { await server?.close(); });

const department = { id: 'department-hr', name: 'People support', is_active: true };
const category = { id: 'category-pay', name: 'Payroll Query', department_id: department.id, department, is_active: true, is_hr_queue: true, can_manage: true };
const rows = Array.from({ length: 65 }, (_, i) => ({ id: `ticket-${i}`, category: category.name, category_id: category.id,
  employee_id: i ? `employee-${i + 1}` : 'employee-1', employee: { id: `employee-${i + 1}`, full_name: `Person ${i}` },
  subject: `Support issue ${i}`, priority: 'Medium', status: 'Open', routed_department_id: department.id,
  routed_department: department, is_hr_queue: true, can_manage: i === 0 }));

function render(Component, { seeds = [], access = { can_view_queue: false, is_hr: false, can_manage_categories: false }, auth = {}, props = {} } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity } } });
  for (const [key, data] of [
    [['tickets'], rows], [['ticket-access'], access], [['ticket-categories'], [category]],
    [['org', 'all'], { entities: [], branches: [], departments: [department], zones: [], designations: [] }], ...seeds,
  ]) {
    if (data instanceof Error) client.getQueryCache().build(client, { queryKey: key }).setState({ status: 'error', fetchStatus: 'idle', error: data });
    else client.setQueryData(key, data);
  }
  const context = { user: { id: 'user-1' }, employee: { id: 'employee-1' }, isSuperAdmin: false,
    assignments: [{ role: 'employee', scope_type: 'self' }], permissions: [{ permission: 'ticket.read', scope_type: 'self' }], ...auth };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: context },
        React.createElement(MemoryRouter, null, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

test('HR receives scoped queue tabs, all filters and 25-row paging with full routed ticket totals', () => {
  const html = render(TicketDesk, { access: { can_view_queue: true, is_hr: true, can_manage_categories: false } });
  assert.equal((html.match(/aria-label="Ticket: Support issue /g) ?? []).length, 25);
  for (const label of ['All tickets', 'Tickets to HR', 'Search tickets', 'Ticket status', 'Ticket category', 'Assigned department', 'of 65 tickets', 'Page 1 of 3']) assert.ok(html.includes(label), label);
  assert.match(html, /Assigned to People support/);
  assert.equal((html.match(/aria-label="Update status for /g) ?? []).length, 1);
  assert.doesNotMatch(html, />Categories<\/button>/);
});

test('routing staff can see server-authorized department tickets even with only a self ticket-read grant', () => {
  const html = render(TicketDesk, { access: { can_view_queue: true, is_hr: false, can_manage_categories: false } });
  assert.match(html, /Support issue 24/);
  assert.match(html, /of 65 tickets/);
  assert.doesNotMatch(html, /Tickets to HR/);
});

test('self-only ticket access hides other requesters while admin category tools require the server capability', () => {
  const employee = render(TicketDesk);
  assert.match(employee, /Support issue 0/);
  assert.doesNotMatch(employee, /Support issue 1</);
  assert.doesNotMatch(employee, />Categories<\/button>/);
  const admin = render(TicketDesk, { access: { can_view_queue: true, can_manage_categories: true } });
  assert.match(admin, />Categories<\/button>/);
});

test('a missing management flag never exposes a status control', () => {
  const html = render(TicketDesk, { access: { can_view_queue: true }, auth: { isSuperAdmin: true },
    seeds: [[['tickets'], [{ ...rows[0], can_manage: undefined }]]] });
  assert.doesNotMatch(html, /aria-label="Update status for /);
});

test('ticket creation is offered only when the current view grants self ticket creation', () => {
  assert.doesNotMatch(render(TicketDesk), /Raise Ticket/);
  const html = render(TicketDesk, { auth: { permissions: [
    { permission: 'ticket.read', scope_type: 'self' }, { permission: 'ticket.create', scope_type: 'self' },
  ] } });
  assert.match(html, /Raise Ticket/);
});

test('category management pages large mappings and only offers editing for granted rows', () => {
  const categories = Array.from({ length: 65 }, (_, i) => ({ ...category, id: `category-${i}`, name: `Category ${i}`, can_manage: i % 2 === 0 }));
  const html = render(TicketCategories, { props: { categories, departments: [department] } });
  assert.match(html, /Add category/);
  assert.match(html, /of 65 categories/);
  assert.match(html, /Page 1 of 3/);
  assert.equal((html.match(/aria-label="Edit category /g) ?? []).length, 13);
  assert.doesNotMatch(html, />Category 25</);
  assert.match(html, /HR queue/);
});

test('read failures provide retry controls instead of empty ticket/category claims', () => {
  const tickets = render(TicketDesk, { seeds: [[['tickets'], new Error('Ticket connection unavailable')]] });
  assert.match(tickets, /Ticket connection unavailable/);
  assert.match(tickets, /Retry tickets/);
  assert.doesNotMatch(tickets, /No tickets visible/);
  const categories = render(TicketCategories, { props: { error: new Error('Category connection unavailable') } });
  assert.match(categories, /Category connection unavailable/);
  assert.match(categories, /Retry categories/);
});

test('ticket routing retains employee exit request and clearance history', () => {
  const html = render(HelpdeskExit, { auth: { permissions: [
    { permission: 'ticket.read', scope_type: 'self' }, { permission: 'exit.create', scope_type: 'self' },
  ] }, seeds: [[['exits'], [{ id: 'exit-1', employee: { id: 'employee-1', full_name: 'Own exit' }, status: 'Cleared', last_day: '2026-08-01', approvals: {} }]]] });
  assert.match(html, /Request Exit/);
  assert.match(html, /Exit Clearances/);
  assert.match(html, /Own exit/);
  assert.match(html, /Support Tickets/);
});
