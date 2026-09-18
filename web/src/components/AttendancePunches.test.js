import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../lib/dates.js';
import { rangeFor } from '../lib/dateRange.js';

let server, Attendance, ExceptionsView, EmployeeAttendanceDetail, PunchDetails, PunchTimeline, AuthContext;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Attendance, ExceptionsView } = await server.ssrLoadModule('/src/components/Attendance.jsx'));
  ({ default: EmployeeAttendanceDetail } = await server.ssrLoadModule('/src/components/EmployeeAttendanceDetail.jsx'));
  ({ default: PunchDetails } = await server.ssrLoadModule('/src/components/ui/PunchDetails.jsx'));
  ({ default: PunchTimeline } = await server.ssrLoadModule('/src/components/ui/PunchTimeline.jsx'));
});
after(async () => { await server?.close(); });

const employee = { id: 'employee-1', full_name: 'Attendance Test Worker', employee_code: 'ATT-1' };
const at = (clock, date = istToday()) => `${date}T${clock}:00+05:30`;
const makeRow = (count = 3) => ({
  id: 'attendance-1', employee_id: employee.id, employee, work_date: istToday(), status: 'Present',
  // The displayed first punch must come from the device history even when an approved time differs.
  check_in: at('10:10'), check_out: at('18:00'), regularization_id: 'correction-1',
  punches: (count === 3 ? ['10:10', '09:00', '10:00'] : ['10:10', '18:00', '09:00', '10:00']).map(clock => at(clock)),
  punch_count: count, first_punch_at: at('09:00'), last_punch_at: at(count === 3 ? '10:10' : '18:00'),
  worked_minutes: count === 3 ? 70 : 540, break_minutes: count === 3 ? 0 : 10,
  breaks_incomplete: count === 3, is_missing_punch: count === 3, day_fraction: 1,
  shift: { code: 'GEN', start_time: '09:00', end_time: '18:00', full_day_minutes: 510, break_minutes: 40 },
});

function renderView(view, row) {
  const today = istToday();
  const month = rangeFor('month', today);
  const week = rangeFor('week', today);
  const localMonthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
  const client = new QueryClient({ defaultOptions: { queries: {
    enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0,
  } } });
  for (const [key, value] of [
    [['employees'], [employee]],
    [['attendance', 'day', today], [row]],
    [['attendance', 'month', employee.id, month.from], [row]],
    [['attendance', 'month', employee.id, localMonthStart], [row]],
    [['attendance', 'employee', employee.id, month.from, month.to], [row]],
    [['attendance', 'exceptions', week.from, week.to], [row]],
  ]) client.setQueryData(key, value);

  const self = view === 'monthly';
  const auth = { user: { id: 'viewer' }, employee, isSuperAdmin: !self, assignments: [],
    permissions: self ? [{ permission: 'attendance.read', scope_type: 'self', scope_id: null }] : [] };
  const Component = view === 'person' ? EmployeeAttendanceDetail : view === 'exceptions' ? ExceptionsView : Attendance;
  const path = `/attendance/${self ? 'calendar' : 'today'}`;
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [path] },
          React.createElement(Component, view === 'person' ? { employee } : {})))));
  } finally { client.clear(); }
}

for (const view of ['daily', 'monthly', 'person', 'exceptions']) {
  for (const count of [3, 4]) {
    test(`${view} attendance retains the first 09:00 punch and exposes all ${count} recorded times`, () => {
      const html = renderView(view, makeRow(count));
      assert.match(html, /<th[^>]*>First punch<\/th>/);
      assert.match(html, /<th[^>]*>Latest punch<\/th>/);
      assert.match(html, /<td data-label="First punch"[^>]*>09:00<\/td>/);
      assert.match(html, count === 3
        ? /<td data-label="Latest punch"[^>]*>10:10<\/td>/
        : /<td data-label="Latest punch"[^>]*>18:00<\/td>/);
      const detail = html.match(/<td data-label="Punches">([\s\S]*?)<\/td>/)?.[1];
      assert.ok(detail, 'the table provides its own accessible punch details');
      assert.match(detail, new RegExp(`${count} punches · Details`));
      const times = [...detail.matchAll(/<time dateTime="([^"]+)"[^>]*>([^<]+)<\/time>/g)];
      assert.deepEqual(times.map(match => match[2]), count === 3
        ? ['09:00', '10:00', '10:10'] : ['09:00', '10:00', '10:10', '18:00']);
      assert.match(detail, /Approved attendance: 10:10 – 18:00/);
      assert.match(detail, /The latest punch may be a return from a break/);
      assert.doesNotMatch(detail, /Checked out|>Left</);
    });
  }
}

test('overnight punch details retain chronological order and show the following IST date', () => {
  const html = renderToStaticMarkup(React.createElement(PunchDetails, {
    expanded: true,
    row: { work_date: '2026-09-18', punches: ['2026-09-19T00:30:00Z', '2026-09-18T16:30:00Z'] },
  }));
  assert.match(html, /<details open=""/);
  assert.match(html, />22:00<\/time>/);
  assert.match(html, />06:00 \(2026-09-19\)<\/time>/);
  assert.ok(html.indexOf('>22:00</time>') < html.indexOf('>06:00 (2026-09-19)</time>'));
  assert.match(html, /Latest punch · 480 min after previous/);
});

test('three-punch detail labels stay neutral and expose the exact 10-minute interval', () => {
  const html = renderToStaticMarkup(React.createElement(PunchDetails, { row: makeRow(3) }));
  const labels = [...html.matchAll(/<span class="text-neutral-500">([^<]+)<\/span>/g)]
    .map(match => match[1]).filter(text => !/^\d+\.$/.test(text));
  assert.deepEqual(labels, ['First punch', 'Punch · 60 min after previous', 'Latest punch · 10 min after previous']);
});

test('missing history does not display approved attendance as recorded punches', () => {
  const html = renderToStaticMarkup(React.createElement(PunchDetails, {
    row: { punches: [], check_in: at('09:00'), check_out: at('18:00'), regularization_id: 'approved' },
  }));
  assert.match(html, /No recorded punches/);
  assert.doesNotMatch(html, /<time|09:00|18:00/);
});

test('the timeline labels its ambiguous last event as latest punch instead of a departure', () => {
  const html = renderToStaticMarkup(React.createElement(PunchTimeline, {
    punches: ['09:00', '10:00', '10:10'].map(clock => at(clock)), incomplete: true,
  }));
  assert.match(html, /title="First punch"[^>]*>09:00/);
  assert.match(html, /title="Latest punch"[^>]*>10:10/);
  assert.doesNotMatch(html, /title="Left"/);
});
