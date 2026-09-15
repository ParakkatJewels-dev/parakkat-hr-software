import test from 'node:test';
import assert from 'node:assert/strict';
import { availableTicketCategories, canManageTicket, filterTickets } from './ticketRouting.js';

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
