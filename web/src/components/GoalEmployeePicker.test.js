import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, GoalEmployeePicker;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: GoalEmployeePicker } = await server.ssrLoadModule('/src/components/GoalEmployeePicker.jsx'));
});
after(async () => { await server?.close(); });

const person = (index, overrides = {}) => ({
  id: `employee-${index}`, full_name: `Person ${index}`, employee_code: `P${index}`,
  designation_id: index % 2 ? 'cashier' : 'sales', designation: { title: index % 2 ? 'Cashier' : 'Sales associate' },
  department_id: 'retail', department: { name: 'Retail' }, branch_id: 'main', branch: { code: 'MAIN' },
  ...overrides,
});
const render = (props = {}) => renderToStaticMarkup(React.createElement(GoalEmployeePicker, {
  employees: [], value: '', onChange() {}, ...props,
}));
const radioTags = (html) => (html.match(/<input\b[^>]*>/g) ?? []).filter((tag) => tag.includes('type="radio"'));

test('the goal employee picker pages a large roster with ten accessible choices per page', () => {
  const html = render({ employees: Array.from({ length: 675 }, (_, index) => person(index)) });
  assert.equal(radioTags(html).length, 10);
  for (const text of ['Employee for goal', 'Search employees', 'of 675 employees', 'Page 1 of 68']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /aria-label="Select Person 0 P0"/);
  assert.doesNotMatch(html, /aria-label="Select Person 10 P10"/);
  assert.match(html, /<option[^>]*value="10"[^>]*>10<\/option>/);
  assert.match(html, /<option[^>]*value="25"[^>]*>25<\/option>/);
  assert.match(html, /<option[^>]*value="50"[^>]*>50<\/option>/);
});

test('organization filters expose exact designation and organization choices only from the supplied roster', () => {
  const employees = [person(0), person(1, { status: 'Inactive' }), person(2, {
    designation_id: 'warehouse', designation: { title: 'Warehouse assistant' },
    department_id: 'logistics', department: { name: 'Logistics' }, branch_id: 'north', branch: { code: 'NORTH' },
  })];
  const html = render({ employees });
  for (const [id, label] of [['cashier', 'Cashier'], ['sales', 'Sales associate'], ['warehouse', 'Warehouse assistant'],
    ['retail', 'Retail'], ['logistics', 'Logistics'], ['main', 'MAIN'], ['north', 'NORTH']]) {
    assert.match(html, new RegExp(`<option[^>]*value="${id}"[^>]*>${label}</option>`));
  }
  for (const label of ['All designations', 'All departments', 'All branches']) assert.ok(html.includes(label), label);
  assert.equal(radioTags(html).length, employees.length);
  assert.match(html, /Inactive/);
  assert.doesNotMatch(radioTags(html).find((tag) => tag.includes('Select Person 1 P1')), /disabled=""/);
  assert.equal((html.match(/<option[^>]*value="retail"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /value="finance"/);
});

test('a valid selected employee displays a compact card without mounting the roster or filters', () => {
  const html = render({ employees: Array.from({ length: 675 }, (_, index) => person(index)), value: 'employee-674' });
  assert.match(html, /aria-label="Selected employee"/);
  assert.match(html, /Person 674/);
  assert.match(html, /P674/);
  assert.match(html, /Change employee/);
  assert.match(html, /Search other employees/);
  assert.equal(radioTags(html).length, 0);
  assert.doesNotMatch(html, /<input\b[^>]*type="search"|<select\b|aria-label="employees pagination"|aria-label="Employee search results"/);
  assert.doesNotMatch(html, /The selected employee is no longer available/);
});

test('a selected ID outside the available roster is invalid and cannot appear as a valid selection', () => {
  const html = render({ employees: [person(0)], value: 'employee-removed' });
  assert.match(html, /role="alert"/);
  assert.match(html, /The selected employee is no longer available for this goal\. Choose another employee\./);
  assert.doesNotMatch(html, /aria-label="Selected employee"/);
  assert.match(html, /Search employees/);
  assert.equal(radioTags(html).length, 1);
  assert.ok(radioTags(html).every((tag) => !tag.includes('checked=""')));
});

test('loading and roster errors explain the state without falsely reporting an empty or invalid selection', () => {
  const loading = render({ isLoading: true, value: 'employee-0' });
  assert.match(loading, /Loading employees/);
  assert.doesNotMatch(loading, /No employees|selected employee is no longer available/);
  assert.equal(radioTags(loading).length, 0);
  const error = render({ error: new Error('Employee roster unavailable'), value: 'employee-0', onRetry() {} });
  assert.match(error, /Employee roster unavailable/);
  assert.match(error, /Retry employees/);
  assert.doesNotMatch(error, /No employees|selected employee is no longer available/);
  assert.equal(radioTags(error).length, 0);
});

test('a known selection never hides a loading or failed roster refresh', () => {
  const props = { employees: [person(0)], value: 'employee-0' };
  const loading = render({ ...props, isLoading: true });
  assert.match(loading, /aria-label="Selected employee"/);
  assert.match(loading, /Loading employees/);
  assert.doesNotMatch(loading, /selected employee is no longer available/);
  const error = render({ ...props, error: new Error('Employee roster unavailable'), onRetry() {} });
  assert.match(error, /aria-label="Selected employee"/);
  assert.match(error, /role="alert"/);
  assert.match(error, /Employee roster unavailable/);
  assert.match(error, /Retry employees/);
  assert.doesNotMatch(error, /selected employee is no longer available/);
});

test('the compact selection card prevents changing or searching for an employee while saving', () => {
  const html = render({ employees: [person(0), person(1)], value: 'employee-1', disabled: true });
  assert.equal(radioTags(html).length, 0);
  assert.match(html, /aria-label="Selected employee"/);
  assert.match(html, /Person 1/);
  const fieldsetDisabled = /<fieldset\b[^>]*disabled=""/.test(html);
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  for (const label of ['Change employee', 'Search other employees']) {
    const button = buttons.find((candidate) => candidate.includes(label));
    assert.ok(button, label);
    assert.ok(fieldsetDisabled || /disabled=""/.test(button), `saving disables ${label}`);
  }
});
