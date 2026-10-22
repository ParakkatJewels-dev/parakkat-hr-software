// The 2026 redesign frame: the page header (breadcrumb, title, section tabs), the status colours,
// and the sidebar's group headings.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { OVERSIGHT_NAV, OVERSIGHT_GROUPS, ESS_NAV, groupSections } from '../../lib/navMap.js';
import { toneForStatus } from '../../lib/statusTone.js';

let server, PageHeader, ShellNavContext, StatusPill, StatCard, RoleWelcome;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: PageHeader } = await server.ssrLoadModule('/src/components/ui/PageHeader.jsx'));
  ({ ShellNavContext } = await server.ssrLoadModule('/src/components/shell/shellNavContext.js'));
  ({ default: StatusPill } = await server.ssrLoadModule('/src/components/ui/StatusPill.jsx'));
  ({ StatCard } = await server.ssrLoadModule('/src/components/ui/StatCard.jsx'));
  ({ default: RoleWelcome } = await server.ssrLoadModule('/src/components/shell/RoleWelcome.jsx'));
});
after(async () => { await server?.close(); });

const people = OVERSIGHT_NAV.find((section) => section.id === 'people');
const nav = (activeTab, section = people) => ({ section, activeTab, screenBadge: () => null, navTarget: (tab) => tab.id, select() {} });
const withNav = (value, element) => renderToStaticMarkup(React.createElement(ShellNavContext.Provider, { value }, element));

test('the page header prints the section and screen as a breadcrumb, then the title and section tabs', () => {
  const html = withNav(nav('directory'), React.createElement(PageHeader, { title: 'Employee Directory', subtitle: 'Everyone' }));
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.match(html, />People<\/button>/);
  assert.match(html, /aria-current="page">Directory<\/span>/);
  assert.match(html, /<h1 class="page-header-title">Employee Directory<\/h1>/);
  assert.ok(html.indexOf('page-header-title') < html.indexOf('section-tabbar'), 'tabs sit under the title');
  assert.match(html, /aria-label="People sections"/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 2, 'the breadcrumb leaf and the current tab');
});

test('record pages can drop the section tabs, and a one-screen section has neither crumbs nor tabs', () => {
  const record = withNav(nav('directory'), React.createElement(PageHeader, { title: 'Aarav Menon', tabs: false, crumbs: ['People', 'Directory', 'Aarav Menon'] }));
  assert.doesNotMatch(record, /section-tabbar/);
  assert.match(record, /aria-current="page">Aarav Menon<\/span>/);
  const reports = OVERSIGHT_NAV.find((section) => section.id === 'insights');
  const single = withNav(nav('reports', reports), React.createElement(PageHeader, { title: 'Reports & Analytics' }));
  assert.doesNotMatch(single, /Breadcrumb|section-tabbar/);
  const outside = renderToStaticMarkup(React.createElement(PageHeader, { title: 'Plain', eyebrow: 'Section' }));
  assert.match(outside, /page-header-eyebrow">Section</);
});

test('a phone back arrow shows on screens outside the bottom bar\'s sections only', () => {
  const directory = withNav(nav('directory'), React.createElement(PageHeader, { title: 'Employee Directory' }));
  assert.match(directory, /class="page-header has-back /);
  assert.match(directory, /<button type="button" class="page-header-back" aria-label="Back">/);
  const time = OVERSIGHT_NAV.find((section) => section.id === 'time');
  for (const tab of ['attendance', 'leave']) {
    const html = withNav(nav(tab, time), React.createElement(PageHeader, { title: 'Time' }));
    assert.doesNotMatch(html, /page-header-back/, `${tab} sits under the Attendance button`);
  }
  const hidden = withNav(nav('directory'), React.createElement(PageHeader, { title: 'Record', back: false }));
  assert.doesNotMatch(hidden, /page-header-back/);
});

test('actions render on the right whether passed as a prop or as children', () => {
  const asProp = renderToStaticMarkup(React.createElement(PageHeader, { title: 'T', actions: React.createElement('button', null, 'Go') }));
  const asChild = renderToStaticMarkup(React.createElement(PageHeader, { title: 'T' }, React.createElement('button', null, 'Go')));
  for (const html of [asProp, asChild]) assert.match(html, /class="page-header-actions"><button>Go<\/button>/);
});

// Every screen in a multi-screen section must use PageHeader, or it loses its section tabs (they
// used to live in a strip under the top bar). A new tab must be added here, which is the point.
const SCREEN_FILES = {
  dashboard: 'Dashboard.jsx', approvals: 'Approvals.jsx',
  ledger: 'WorkLedger.jsx', performance: 'Performance.jsx',
  attendance: 'Attendance.jsx', 'attendance-person': 'EmployeeAttendanceDetail.jsx', leave: 'Leave.jsx', 'attendance-admin': 'AttendanceAdmin.jsx',
  team: 'Team.jsx', directory: 'Directory.jsx', 'employee-import': 'EmployeeImport.jsx', organization: 'Organization.jsx',
  recruitment: 'Recruitment.jsx', onboarding: 'Onboarding.jsx', documents: 'DocumentManagement.jsx',
  payroll: 'Payroll.jsx', expense: 'Expense.jsx',
  profile: 'UserProfile.jsx', notifications: 'Notifications.jsx', settings: 'SettingsPage.jsx',
  administration: 'Administration.jsx', 'admin-roles': 'Administration.jsx', 'admin-audit': 'Administration.jsx',
  'admin-developer': 'DeveloperSettings.jsx', 'admin-chats': 'ChatMonitor.jsx',
};

test('every screen in a multi-screen section renders the shared page header', () => {
  for (const section of OVERSIGHT_NAV) {
    const tabs = section.tabs.filter((tab) => !tab.retired);
    if (tabs.length < 2) continue;
    for (const tab of tabs) {
      const file = SCREEN_FILES[tab.id];
      assert.ok(file, `${section.id}/${tab.id} has no screen file listed in Shell.test.js`);
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      assert.match(source, /import PageHeader from '\.\/ui\/PageHeader'/, `${file} must use PageHeader`);
      assert.match(source, /<PageHeader\b/, `${file} must render PageHeader`);
    }
  }
});

test('the sidebar groups the oversight tree under four headings, in order, and lists every section', () => {
  assert.deepEqual(OVERSIGHT_GROUPS, ['Workspace', 'Organization', 'Resources', 'Account']);
  const groups = groupSections(OVERSIGHT_NAV, OVERSIGHT_GROUPS);
  assert.deepEqual(groups.map((group) => group.title), OVERSIGHT_GROUPS);
  assert.deepEqual(groups[0].sections.map((section) => section.id), ['home', 'work', 'time', 'messages']);
  assert.deepEqual(groups.flatMap((group) => group.sections).length, OVERSIGHT_NAV.length);
  const stray = groupSections([...OVERSIGHT_NAV, { id: 'new', label: 'New', tabs: [] }], OVERSIGHT_GROUPS);
  assert.equal(stray.at(-1).title, null, 'an ungrouped section is still listed');
  const ess = ESS_NAV.flatMap((group) => group.items.map((item) => ({ id: item.id, group: group.title, tabs: [item] })));
  assert.deepEqual(groupSections(ess, ESS_NAV.map((group) => group.title)).map((group) => group.title), ['Work', 'Me', 'Support']);
});

test('status words map to one colour language, unknown words stay neutral', () => {
  for (const word of ['Present', 'Active', 'approved', 'Done', 'Paid']) assert.equal(toneForStatus(word), 'success', word);
  for (const word of ['Late', 'Pending', 'On leave', 'in_review']) assert.equal(toneForStatus(word), 'warning', word);
  for (const word of ['Absent', 'Missing punch', 'Overdue', 'Rejected']) assert.equal(toneForStatus(word), 'danger', word);
  for (const word of ['Probation', 'In progress', 'On hold']) assert.equal(toneForStatus(word), 'info', word);
  for (const word of ['To do', 'Inactive', 'something new', '', null]) assert.equal(toneForStatus(word), 'neutral', String(word));
  const pill = renderToStaticMarkup(React.createElement(StatusPill, { status: 'Late' }));
  assert.match(pill, /class="state-pill " data-tone="warning"><span class="state-pill-dot" aria-hidden="true"><\/span>Late<\/span>/);
});

test('a number card is a button only when it does something', () => {
  const still = renderToStaticMarkup(React.createElement(StatCard, { label: 'Roster', value: 128, sub: 'Scheduled today' }));
  assert.match(still, /^<article class="stat-card/);
  assert.match(still, /stat-card-value">128</);
  const clickable = renderToStaticMarkup(React.createElement(StatCard, { label: 'Late', value: 6, onClick() {}, active: true, tone: 'amber' }));
  assert.match(clickable, /^<button type="button" aria-pressed="true"/);
  assert.match(clickable, /data-tone="amber"/);
});

test('switching role greets you with the view you are now in, announced politely', () => {
  const html = renderToStaticMarkup(React.createElement(RoleWelcome, { name: 'Asha', roleTitle: 'Dept Head', onDone() {} }));
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /Welcome, Asha/);
  assert.match(html, /Dept Head view/);
  assert.match(renderToStaticMarkup(React.createElement(RoleWelcome, { name: '', roleTitle: 'Employee', onDone() {} })), />Welcome</);
});
