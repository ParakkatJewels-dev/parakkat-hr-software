import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONABLE_TICKET_STATUSES, availableTicketCategories, canManageTicket, filterTickets, ticketNeedsAction, ticketQueueCounts } from './ticketRouting.js';

const rows = [
  { id: 'hr', category_id: 'pay', category: 'Payroll Query', routed_department_id: 'hr-dept', routed_department: { name: 'People support' },
    is_hr_queue: true, status: 'Open', subject: 'Missing payslip', employee: { full_name: 'Ada Nair', employee_code: 'E001' } },
  { id: 'it', category_id: 'tech', category: 'IT Support', routed_department_id: 'it-dept', routed_department: { name: 'HR software support' },
    is_hr_queue: false, status: 'In Progress', subject: 'Laptop setup', description: 'VPN connection', employee: { full_name: 'Ben Roy', employee_code: 'E002' } },
  { id: 'resolved', category_id: 'pay', category: 'Previous category name', routed_department_id: 'old-dept', routed_department: { name: 'Archived department' },
    is_hr_queue: true, status: 'Resolved', subject: 'Old payslip' },
];

test('ticket filters combine status, category, routing department and trimmed search', () => {
  assert.deepEqual(filterTickets(rows, { status: 'Open', categoryId: 'pay', departmentId: 'hr-dept', search: '  ada  ' }).map(row => row.id), ['hr']);
  assert.deepEqual(filterTickets(rows, { status: 'Resolved', categoryId: 'pay', departmentId: 'old-dept' }).map(row => row.id), ['resolved']);
  assert.deepEqual(filterTickets(rows, { categoryId: 'pay', departmentId: 'it-dept' }), []);
});

test('HR queue uses the explicit routing snapshot rather than department names', () => {
  assert.deepEqual(filterTickets(rows, { hrOnly: true }).map(row => row.id), ['hr', 'resolved']);
  assert.deepEqual(filterTickets(rows, { hrOnly: true, status: 'Open' }).map(row => row.id), ['hr']);
  assert.deepEqual(filterTickets(rows, { search: 'HR software' }).map(row => row.id), ['it']);
  assert.deepEqual(filterTickets(rows, { search: 'vpn' }).map(row => row.id), ['it']);
  assert.deepEqual(filterTickets(rows, { search: 'e001' }).map(row => row.id), ['hr']);
});

test('only an explicit server management grant enables status controls', () => {
  for (const can_manage of [undefined, null, false, 1, 'true']) assert.equal(canManageTicket({ can_manage }), false);
  assert.equal(canManageTicket({ can_manage: true }), true);
  assert.equal(canManageTicket({ can_manage: true }, { viewingAsEmployee: true }), false);
});

test('action queues include every unresolved manageable status, including older open tickets', () => {
  const tickets = [
    ...ACTIONABLE_TICKET_STATUSES.map((status, index) => ({ ...rows[index], id: status, status, can_manage: true, created_at: '2020-01-01' })),
    { ...rows[0], id: 'read-only', can_manage: false },
    { ...rows[0], id: 'missing-grant' },
    { ...rows[0], id: 'string-grant', can_manage: 'true' },
    { ...rows[0], id: 'unknown-status', status: 'Closed', can_manage: true },
    { ...rows[2], can_manage: true },
  ];
  assert.deepEqual(filterTickets(tickets, { needsAction: true }).map(row => row.id), ACTIONABLE_TICKET_STATUSES);
  assert.deepEqual(ticketQueueCounts(tickets, { canViewQueue: true }), { all: 3, hr: 2 });
  assert.equal(ticketNeedsAction({ status: 'Resolved', can_manage: true }), false);
  assert.equal(ticketNeedsAction(null), false);
});

test('action counts stay independent of search filters and use the explicit HR destination', () => {
  const tickets = rows.map(row => ({ ...row, can_manage: true }));
  assert.deepEqual(filterTickets(tickets, { needsAction: true, categoryId: 'pay', departmentId: 'hr-dept', search: '  ada  ', hrOnly: true }).map(row => row.id), ['hr']);
  assert.deepEqual(filterTickets(tickets, { needsAction: true, status: 'Resolved' }), []);
  assert.deepEqual(ticketQueueCounts(tickets, { canViewQueue: true }), { all: 2, hr: 1 });
  assert.deepEqual(ticketQueueCounts(tickets, { canViewQueue: true }), ticketQueueCounts([...tickets].reverse(), { canViewQueue: true }));
});

test('self-only and explicit employee presentation never receive managerial queue counts', () => {
  const tickets = [{ ...rows[0], can_manage: true }];
  for (const options of [{}, { canViewQueue: false }, { canViewQueue: true, viewingAsEmployee: true }]) {
    assert.deepEqual(ticketQueueCounts(tickets, options), { all: 0, hr: 0 });
  }
  assert.deepEqual(filterTickets(tickets, { needsAction: true, viewingAsEmployee: true }), []);
  assert.deepEqual(ticketQueueCounts(undefined, { canViewQueue: true }), { all: 0, hr: 0 });
});

test('new tickets only offer active categories with an available routing department', () => {
  const categories = [
    { id: 'ready', is_active: true, department_id: 'd1', department: { is_active: true } },
    { id: 'inactive-category', is_active: false, department_id: 'd1' },
    { id: 'inactive-department', is_active: true, department_id: 'd2', department: { is_active: false } },
    { id: 'unassigned', is_active: true, department_id: null },
  ];
  assert.deepEqual(availableTicketCategories(categories).map(row => row.id), ['ready']);
  assert.deepEqual(availableTicketCategories(undefined), []);
});
