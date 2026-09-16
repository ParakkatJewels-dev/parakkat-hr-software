import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../lib/dates.js';

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx');
const { default: Reports } = await server.ssrLoadModule('/src/components/ReportsAnalytics.jsx');
const { default: Recruitment } = await server.ssrLoadModule('/src/components/Recruitment.jsx');
const { default: HelpdeskExit } = await server.ssrLoadModule('/src/components/HelpdeskExit.jsx');
const { monthRange } = await server.ssrLoadModule('/src/data/attendance.js');
const period = istToday().slice(0, 7);
const { from, to } = monthRange(Number(period.slice(0, 4)), Number(period.slice(5)));
const priorDay = new Date(`${from}T00:00:00Z`); priorDay.setUTCDate(priorDay.getUTCDate() - 1);
const beforeMonth = priorDay.toISOString().slice(0, 10);
const cells = (html, label) => [...html.matchAll(new RegExp(`<td[^>]*data-label="${label}"[^>]*>(.*?)</td>`, 'g'))].map(match => match[1].replace(/<[^>]*>/g, ''));

function render(Component, path, seeds = [], authOverrides = {}) {
  const client = new QueryClient({ defaultOptions: { queries: {
    enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0,
  } } });
  for (const [key, data] of [
    [['org', 'all'], { entities: [], zones: [], branches: [], departments: [], designations: [] }],
    [['employees'], []], [['leaves-period-days', from, to], []], [['leaves-period', from, to], []], [['leave-types'], []],
    [['leave-balances', 'all', Number(period.slice(0, 4))], []],
    [['expenses-period', from, to], []], [['exits'], []],
    [['report', 'attendance-summary', from, to], []], [['jobs'], []], [['candidates'], []], ...seeds,
  ]) {
    if (data instanceof Error) {
      client.removeQueries({ queryKey: key, exact: true });
      client.getQueryCache().build(client, { queryKey: key }).setState({ status: 'error', fetchStatus: 'idle', error: data });
    } else client.setQueryData(key, data);
  }
  const auth = { user: { id: 'qa-reviewer' }, employee: null, isSuperAdmin: true,
    permissions: [], assignments: [], rank: 1000, ...authOverrides };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component)))));
  } finally { client.clear(); }
}


after(() => server.close());

const exportButton = (html, label) => [...html.matchAll(/<button\b[^>]*>.*?<\/button>/gs)].map(match => match[0]).find(button => button.includes(label));
for (const [tab, failedKey, button] of [
  ['leave', ['leaves-period', from, to], 'Requests (CSV)'],
  ['leave', ['leaves-period-days', from, to], 'Requests (CSV)'],
  ['expenses', ['expenses-period', from, to], 'Claims (CSV)'],
  ['headcount', ['employees'], 'Headcount (CSV)'],
  ['attendance', ['report', 'attendance-summary', from, to], 'Summary (CSV)'],
]) test(`FE-01: ${failedKey[0]} failure shows a retryable error and blocks unverified CSV`, () => {
  const html = render(Reports, `/reports/${tab}`, [[failedKey, new Error('QA report connection unavailable')]]);
  assert.match(html, /could not be loaded/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /No data for this period in your scope/);
  assert.match(exportButton(html, button) ?? '', /disabled=""/);
});

test('FE-02: monthly approved totals use server allocation instead of whole request days', () => {
  const leaves = [{ id: 'cross-month', type: 'CL', status: 'Approved', days: 3,
    start_date: beforeMonth, end_date: `${period}-02`, employee: { branch_id: 'branch-one' } },
    { id: 'half-day', type: 'Other', status: 'Approved', days: 1.5, start_date: from, end_date: `${period}-03` }];
  const seeds = [[['leave-types'], [{ id: 'cl', code: 'CL', name: 'Casual Leave' }]],
    [['leaves-period', from, to], leaves],
    [['leaves-period-days', from, to], [{ leave_id: 'cross-month', period_days: 2 }, { leave_id: 'half-day', period_days: 0.5 }]]];
  const html = render(Reports, '/reports/leave', seeds);
  assert.deepEqual(cells(html, 'Approved Days'), ['2', '0.5']);
  assert.doesNotMatch(exportButton(html, 'Requests (CSV)'), /disabled=""/);
  const incomplete = render(Reports, '/reports/leave', [...seeds, [['leaves-period-days', from, to], []]]);
  assert.match(incomplete, /Leave requests changed/);
  assert.match(exportButton(incomplete, 'Requests (CSV)'), /disabled=""/);
  assert.deepEqual(cells(incomplete, 'Approved Days'), []);
});

test('FE-03/04: duplicate branch codes remain separate and Active is explicitly current', () => {
  const html = render(Reports, '/reports/headcount', [[['employees'], [
    { id: 'one', status: 'Active', branch_id: 'branch-one', entity_id: 'company-one', branch: { code: 'HQ' }, join_date: '2099-01-01' },
    { id: 'two', status: 'Active', branch_id: 'branch-two', entity_id: 'company-two', branch: { code: 'HQ' } },
  ]]]);
  assert.deepEqual(cells(html, 'Branch'), ['HQ (branch-one)', 'HQ (branch-two)', 'Total']);
  assert.deepEqual(cells(html, 'Current Active'), ['1', '1', '2']);
  assert.match(html, /Current active employees reflect today/);
});

test('FE-05: rejected and hired candidates remain visible and counted', () => {
  const html = render(Recruitment, '/recruitment', [[['candidates'], [
    { id: 'rejected-one', name: 'QA Rejected Candidate', stage: 'Rejected' },
    { id: 'hired-one', name: 'QA Hired Candidate', stage: 'Hired' },
  ]]]);
  assert.match(html, /2 matching profiles/);
  assert.match(html, /QA Rejected Candidate/); assert.match(html, /QA Hired Candidate/);
  assert.doesNotMatch(html, /aria-label="(Advance|Reject)"/);
});

test('FE-06: failed hiring reads show unavailable metrics without invented empty lists', () => {
  const html = render(Recruitment, '/recruitment', [[['jobs'], new Error('Jobs unavailable')], [['candidates'], new Error('Candidates unavailable')]]);
  assert.match(html, /Unavailable/);
  assert.match(html, /Candidates could not be loaded/);
  assert.doesNotMatch(html, /0 matching profiles|No applicants|No matching openings/);
});

test('FE-07: exit lookup failure blocks new requests and avoids false empty state', () => {
  const html = render(HelpdeskExit, '/helpdesk', [[['exits'], new Error('Exits unavailable')]], { employee: { id: 'self' } });
  assert.match(html, /Exit records could not be loaded/);
  assert.doesNotMatch(html, /No exit records visible to you/);
  const request = exportButton(html, 'Request Exit');
  assert.ok(!request || request.includes('disabled=""'));
});

test('FE-07: an existing own exit blocks duplicates even when its employee relation is hidden', () => {
  const html = render(HelpdeskExit, '/helpdesk', [[['exits'], [{ id: 'own', employee_id: 'self', employee: null,
    status: 'Clearance in Progress', approvals: {} }]]], { employee: { id: 'self' } });
  assert.match(html, /Your exit request is already in progress/);
  assert.doesNotMatch(html, /Request Exit|No exit records visible to you/);
});

const separation = { id: 'exit-one', employee_id: 'other', entity_id: 'company', created_by: 'other-user', status: 'Clearance in Progress',
  approvals: { IT: 'Pending', Admin: 'Pending', Finance: 'Pending', HR: 'Pending' },
  employee: { id: 'other', full_name: 'QA Resigning Employee', entity_id: 'company' } };
const matrix = JSON.parse(await readFile(new URL('../test/standardRolePermissions.json', import.meta.url), 'utf8'));
const hr = { isSuperAdmin: false, user: { id: 'reviewer' }, employee: { id: 'hr', entity_id: 'company' },
  assignments: [{ role_key: 'hr_manager', scope_type: 'entity', scope_id: 'company' }],
  permissions: matrix.hr_manager.permissions.map(permission => ({ permission, scope_type: 'entity', scope_id: 'company' })) };
test('FE-09: scoped HR has four clearance controls and completion only after all departments approve', () => {
  const pending = render(HelpdeskExit, '/helpdesk', [[['exits'], [separation]]], hr);
  assert.equal((pending.match(/aria-label="[^"]* clearance for QA Resigning Employee"/g) ?? []).length, 4);
  assert.doesNotMatch(pending, /Complete exit/);
  const cleared = { ...separation, status: 'Cleared', approvals: Object.fromEntries(['IT', 'Admin', 'Finance', 'HR'].map(d => [d, 'Approved'])) };
  assert.match(render(HelpdeskExit, '/helpdesk', [[['exits'], [cleared]]], hr), /Complete exit/);
  for (const exit of [{ ...cleared, employee_id: 'hr' }, { ...cleared, created_by: 'reviewer' }, { ...cleared, entity_id: 'other-company' }, { ...cleared, status: 'Completed' }, { ...cleared, status: 'Cancelled' }]) {
    const html = render(HelpdeskExit, '/helpdesk', [[['exits'], [exit]]], hr);
    assert.doesNotMatch(html, /clearance for QA Resigning Employee|Complete exit/);
  }
});
