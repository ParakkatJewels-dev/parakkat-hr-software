import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allScreenIds } from './navMap.js';
import { APP_TAB_PATHS, LEGACY_TAB_PATHS, DETAIL_SCREENS, DETAIL_ID_PATTERN, resolveAppRoute, appRouteDisposition } from './appRoutes.js';
import { normalizedHashRoute } from './passwordRecovery.js';
import { tabFromPath } from './urlTab.js';

test('all defined screens and real nested tabs remain routable', () => {
  for (const screen of allScreenIds()) assert.equal(resolveAppRoute(`/${screen}`).valid, true, screen);
  for (const catalog of [APP_TAB_PATHS, LEGACY_TAB_PATHS]) for (const [screen, tabs] of Object.entries(catalog)) {
    for (const tab of tabs) assert.equal(resolveAppRoute(`/${screen}/${tab}`).valid, true, `${screen}/${tab}`);
  }
  assert.equal(resolveAppRoute('/').screen, 'dashboard');
  assert.equal(resolveAppRoute('//attendance//overview/').valid, true);
});

test('invalid screens, tabs, excessive path segments and asset filenames are 404s', () => {
  for (const path of ['/does-not-exist', '/tasks/routnie', '/reports/payroll', '/dashboard/anything', '/settings/anything',
    '/tasks/routine/extra', '/directory/person-1/extra', '/assets/missing.js', '/directory/missing.css', '/api/missing', '/app-assets/missing.js']) {
    const route = resolveAppRoute(path);
    assert.equal(route.valid, false, path);
    assert.equal(appRouteDisposition(route, true), 'not-found', path);
  }
});

test('real restricted screens stay access denied, while unknown screens never impersonate an access error', () => {
  assert.equal(appRouteDisposition(resolveAppRoute('/administration'), false), 'access-denied');
  assert.equal(appRouteDisposition(resolveAppRoute('/admin-developer'), false), 'access-denied');
  assert.equal(appRouteDisposition(resolveAppRoute('/administration/missing'), false), 'access-denied');
  assert.equal(appRouteDisposition(resolveAppRoute('/missing'), false), 'not-found');
  assert.equal(appRouteDisposition(resolveAppRoute('/tasks/routine'), true), 'page');
});

test('employee and asset detail IDs retain valid deep links without absorbing static files', () => {
  for (const screen of DETAIL_SCREENS) for (const id of ['employee-7', 'record_7', 'bca0e5b3-7d67-41d1-82ed-41171196c29e']) {
    assert.equal(resolveAppRoute(`/${screen}/${id}`).valid, true);
  }
  for (const id of ['file.js', '..', 'bad%2Fsegment']) assert.equal(resolveAppRoute(`/directory/${id}`).valid, false);
});

test('known role-filtered tabs and explicit legacy task links retain the existing safe fallback', () => {
  assert.equal(resolveAppRoute('/payroll/run').valid, true);
  assert.equal(tabFromPath('/payroll/run', 'payslips', ['payslips']), 'payslips');
  for (const oldTab of LEGACY_TAB_PATHS.tasks) {
    assert.equal(tabFromPath(`/tasks/${oldTab}`, 'board', APP_TAB_PATHS.tasks), 'board');
  }
});

test('direct links keep query parameters during hash normalization and leave auth callbacks untouched', () => {
  for (const path of ['/messages?conversation=chat-1', '/tasks/routine?routineView=team', '/attendance/overview?focus=record-1', '/forgot-password']) {
    assert.equal(normalizedHashRoute(`https://hr.example.test${path}`), `/#${path}`);
  }
  assert.equal(normalizedHashRoute('https://hr.example.test/?auth=recovery'), null);
  assert.equal(normalizedHashRoute('https://hr.example.test/?code=example-code'), null);
  assert.equal(normalizedHashRoute('https://hr.example.test/#/tasks/routine'), null);
});

test('route tab catalog stays aligned with the page definitions that use useUrlTab', () => {
  for (const [screen, filename, variable] of [
    ['attendance', 'Attendance', 'TABS'], ['attendance-admin', 'AttendanceAdmin', 'TABS'], ['payroll', 'Payroll', 'TAB_DEFS'],
    ['documents', 'DocumentManagement', 'SCOPES'], ['reports', 'ReportsAnalytics', 'TABS'],
  ]) {
    const source = readFileSync(new URL(`../components/${filename}.jsx`, import.meta.url), 'utf8');
    const definition = source.match(new RegExp(`const ${variable} = \\[([\\s\\S]*?)\\n\\];`))?.[1];
    assert.ok(definition, `${filename} tab definition`);
    assert.deepEqual([...definition.matchAll(/id: '([^']+)'/g)].map(match => match[1]), APP_TAB_PATHS[screen]);
  }
  for (const [screen, filename] of [['tasks', 'TaskManagement'], ['performance', 'Performance']]) {
    const source = readFileSync(new URL(`../components/${filename}.jsx`, import.meta.url), 'utf8');
    const hook = source.match(/useUrlTab\([^;]+;/)?.[0];
    assert.ok(hook, `${filename} route tabs`);
    for (const tab of APP_TAB_PATHS[screen]) assert.ok(hook.includes(`'${tab}'`), `${filename}/${tab}`);
  }
});

const hosting = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
const shellRewrites = hosting.rewrites.filter(rule => rule.destination === '/index.html');
const servesShell = (pathname) => shellRewrites.some(rule => {
  const expression = rule.source.replace(`:id(${DETAIL_ID_PATTERN})`, `(${DETAIL_ID_PATTERN})`);
  return new RegExp(`^${expression}/?$`).test(pathname);
});

test('hosting explicitly serves every valid direct destination and auth page', () => {
  for (const screen of [...allScreenIds(), 'login', 'forgot-password']) assert.equal(servesShell(`/${screen}`), true, screen);
  for (const catalog of [APP_TAB_PATHS, LEGACY_TAB_PATHS]) for (const [screen, tabs] of Object.entries(catalog)) {
    for (const tab of tabs) assert.equal(servesShell(`/${screen}/${tab}`), true, `${screen}/${tab}`);
  }
  for (const screen of DETAIL_SCREENS) assert.equal(servesShell(`/${screen}/record-1`), true);
});

test('unknown direct pages and missing scripts or API endpoints cannot rewrite into the app shell', () => {
  for (const path of ['/does-not-exist', '/tasks/missing', '/profile/extra', '/assets/missing.js', '/directory/missing.css',
    '/tasks/missing.js', '/app-assets/index-missing.js', '/api/missing', '/api/v1/missing', '/404.html']) {
    assert.equal(servesShell(path), false, path);
  }
  assert.ok(hosting.rewrites.some(rule => rule.source === '/api/v1/:resource' && rule.destination === '/api/v1/[resource]?resource=:resource'));
  assert.match(hosting.headers.find(rule => rule.source === '/app-assets/(.*)').headers.find(header => header.key === 'Cache-Control').value, /immutable/);
});

test('the hosting 404 is standalone HTML with accessible recovery, dark mode, and no app bundle dependency', () => {
  const html = readFileSync(new URL('../../public/404.html', import.meta.url), 'utf8');
  assert.match(html, /<h1[^>]*>Page not found<\/h1>/);
  assert.match(html, /href="\/#\/dashboard">Go to Home/);
  assert.match(html, /name="robots" content="noindex"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /<script[^>]+src=|app-assets|http-equiv="refresh"/);
});
