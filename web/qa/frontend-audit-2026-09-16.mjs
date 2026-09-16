// Read-only audit of real React components with synthetic cached query results.
// Run: cd web && node qa/frontend-audit-2026-09-16.mjs
// Assertions below verify reproduction observations, not that those behaviours are correct.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../src/lib/dates.js';

const output = new URL('../../docs/qa/2026-09-16/', import.meta.url);
await mkdir(output, { recursive: true });
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
const findings = [];
const cells = (html, label) => [...html.matchAll(new RegExp(`<td[^>]*data-label="${label}"[^>]*>(.*?)</td>`, 'g'))].map(match => match[1].replace(/<[^>]*>/g, ''));

function render(Component, path, seeds = [], authOverrides = {}) {
  const client = new QueryClient({ defaultOptions: { queries: {
    enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0,
  } } });
  for (const [key, data] of [
    [['org', 'all'], { entities: [], zones: [], branches: [], departments: [], designations: [] }],
    [['employees'], []], [['leaves-period', from, to], []], [['leave-types'], []],
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

async function record(id, name, html, expected, actual) {
  await writeFile(new URL(`${id}.html`, output), html);
  findings.push({ id, name, classification: id === 'FE-04' ? 'needs business clarification' : id === 'FE-09' ? 'confirmed visible workflow gap' : 'confirmed frontend reproduction', period, expected, actual, evidence: `${id}.html` });
}

try {
  for (const [tab, failedKey] of [
    ['leave', ['leaves-period', from, to]], ['expenses', ['expenses-period', from, to]], ['headcount', ['employees']],
  ]) {
    const html = render(Reports, `/reports/${tab}`, [[failedKey, new Error('QA report connection unavailable')]]);
    assert.match(html, /No data for this period in your scope/);
    assert.doesNotMatch(html, /QA report connection unavailable/);
    await record(`FE-01-${tab}`, 'Report read failure presented as successful empty data', html,
      'Visible failed-read state and exports unavailable until valid report data exists.',
      'No data for this period in your scope. No query error displayed; CSV export remains enabled.');
  }

  const leaveHtml = render(Reports, '/reports/leave', [
    [['leave-types'], [{ id: 'cl', code: 'CL', name: 'Casual Leave' }]],
    [['leaves-period', from, to], [{ id: 'cross-month', type: 'CL', status: 'Approved', days: 3,
      start_date: beforeMonth, end_date: `${period}-02`, employee: { branch_id: 'branch-one' } }]],
  ]);
  assert.deepEqual(cells(leaveHtml, 'Approved Days'), ['3']);
  await record('FE-02', 'Monthly leave totals include days outside selected month', leaveHtml,
    `2 approved days inside ${period} for a three-calendar-day leave starting ${beforeMonth}.`,
    'Approved Days = 3; report sums entire request days instead of the period overlap.');

  const duplicateBranchHtml = render(Reports, '/reports/headcount', [[['employees'], [
    { id: 'one', status: 'Active', branch_id: 'branch-one', entity_id: 'company-one', branch: { code: 'HQ' } },
    { id: 'two', status: 'Active', branch_id: 'branch-two', entity_id: 'company-two', branch: { code: 'HQ' } },
  ]]]);
  assert.deepEqual(cells(duplicateBranchHtml, 'Branch'), ['HQ']);
  assert.deepEqual(cells(duplicateBranchHtml, 'Active'), ['2']);
  await record('FE-03', 'Headcount merges distinct companies branches with identical codes', duplicateBranchHtml,
    'Two branch rows, one active employee each, identified by distinct branch IDs and companies.',
    'One HQ row reports Active = 2. Branch code is used as aggregation identity.');

  const futureHireHtml = render(Reports, '/reports/headcount', [[['employees'], [
    { id: 'future', status: 'Active', branch_id: 'branch-one', branch: { code: 'HQ' }, join_date: '2099-01-01' },
  ]]]);
  assert.deepEqual(cells(futureHireHtml, 'Active'), ['1']);
  await record('FE-04', 'Period headcount includes future joiners', futureHireHtml,
    `A person joining in 2099 contributes no active headcount for ${period}, or the screen explicitly labels Active as a current roster measure.`,
    `Headcount & Movement for ${period} shows Active = 1 for a 2099 hire because only current status is checked.`);

  const rejectedHtml = render(Recruitment, '/recruitment', [[['candidates'], [
    { id: 'rejected-one', name: 'QA Rejected Candidate', email: 'candidate@example.test', stage: 'Rejected', job: { title: 'QA Sales Associate' } },
  ]]]);
  assert.match(rejectedHtml, /1 matching profiles/);
  assert.doesNotMatch(rejectedHtml, /QA Rejected Candidate/);
  assert.equal((rejectedHtml.match(/No applicants/g) || []).length, 4);
  await record('FE-05', 'Rejected candidate remains counted but inaccessible in hiring UI', rejectedHtml,
    'Rejected candidates are accessible via a stage/filter/archive and matching count agrees with view.',
    'Candidates = 1 and 1 matching profiles; all four stages say No applicants; candidate name absent.');

  const failedRecruitment = render(Recruitment, '/recruitment', [[['jobs'], new Error('QA jobs unavailable')], [['candidates'], new Error('QA candidates unavailable')]]);
  assert.match(failedRecruitment, /QA candidates unavailable/);
  assert.match(failedRecruitment, /0 matching profiles/);
  assert.equal((failedRecruitment.match(/No applicants/g) || []).length, 4);
  await record('FE-06', 'Hiring failures also display definitive zero metrics', failedRecruitment,
    'Failed reads show unavailable metrics and an unavailable pipeline, preserving cached values only when present.',
    'Errors are displayed, alongside Candidates = 0, Open roles = 0, 0 matching profiles and four No applicants states.');

  const failedExit = render(HelpdeskExit, '/helpdesk', [[['exits'], new Error('QA exits unavailable')]], {
    employee: { id: 'self', full_name: 'QA Employee' },
  });
  assert.match(failedExit, /No exit records visible to you/);
  assert.doesNotMatch(failedExit, /QA exits unavailable/);
  assert.match(failedExit, /Request Exit/);
  await record('FE-07', 'Exit read failure masks existing requests and enables a new request', failedExit,
    'Failed-read state; do not assert there is no existing exit or enable creation until open-request lookup is trustworthy.',
    'No exit records visible to you and Request Exit button; query error invisible.');

  const matrix = JSON.parse(await readFile(new URL('../src/test/standardRolePermissions.json', import.meta.url), 'utf8'));
  const clearanceHtml = render(HelpdeskExit, '/helpdesk', [[['exits'], [{
    id: 'separation-one', last_day: `${period}-20`, status: 'Clearance in Progress',
    approvals: { IT: 'Pending', Admin: 'Pending', Finance: 'Pending', HR: 'Pending' },
    employee: { id: 'other-employee', full_name: 'QA Resigning Employee', department: { name: 'Sales' } },
  }]]], {
    isSuperAdmin: false, employee: { id: 'hr-employee', entity_id: 'qa-company' },
    assignments: [{ role_key: 'hr_manager', scope_type: 'entity', scope_id: 'qa-company' }],
    permissions: matrix.hr_manager.permissions.map(permission => ({ permission, scope_type: 'entity', scope_id: 'qa-company' })),
  });
  const clearanceSection = clearanceHtml.slice(clearanceHtml.indexOf('Exit Clearances'));
  assert.match(clearanceSection, /QA Resigning Employee/);
  assert.match(clearanceSection, /Clearance in Progress/);
  assert.equal((clearanceSection.match(/>Pending</g) || []).length, 4);
  assert.doesNotMatch(clearanceSection, /<(button|input|select|textarea)[\s>]/);
  await record('FE-09', 'HR cannot record separation clearances or complete an exit from the visible screen', clearanceHtml,
    'An exit manager can record authorized department clearance and complete or otherwise progress the exit workflow.',
    'HR manager sees the employee and four Pending clearances, but the entire Exit Clearances section contains no action controls.');

  await writeFile(new URL('frontend-reproductions.json', output), JSON.stringify({
    mode: 'Real React SSR with synthetic query-cache data; no network or database writes',
    date: '2026-09-16', results: findings,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ reproduced: findings.length, findings }, null, 2));
} finally { await server.close(); }
