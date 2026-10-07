import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, Detail;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: Detail } = await server.ssrLoadModule('/src/components/PayrollCalculationDetail.jsx'));
});
after(async () => { await server?.close(); });
const render = register => renderToStaticMarkup(React.createElement(Detail, { register }));

test('hourly payslip explains its saved hours without presenting overtime as another earning', () => {
  const html = render({ calculation_mode: 'hourly_workings', salary: 12000, earned_salary: 11209.80,
    per_day_wages: 400, per_hour_wages: 47.1, worked_minutes: 11220, total_working_hours: 999,
    credited_hours: 51, payable_hours: 238, attendance_source: 'reviewed', ot_hours: 100 });
  assert.match(html, /187h 0m/);
  assert.match(html, /51h 0m/);
  assert.match(html, /238h 0m/);
  assert.match(html, /HR-reviewed monthly totals/);
  assert.match(html, /₹11,209.80/);
  assert.doesNotMatch(html, /999|Approved OT hours|Approved late hours/);
});

test('legacy payslips keep their saved OT and late breakdown without inferred hourly credits', () => {
  const html = render({ schema_version: 3, salary: 15000, ot_hours: 2, late_hours: 0.5 });
  assert.match(html, /Approved OT hours/);
  assert.match(html, /Approved late hours/);
  assert.doesNotMatch(html, /Total payable time|HR-reviewed monthly totals|Overtime is included/);
});

test('zero hours stay zero and absent calculation snapshots show nothing', () => {
  const html = render({ calculation_mode: 'hourly_workings', worked_minutes: 0, credited_hours: 0, payable_hours: 0, attendance_source: 'recorded' });
  assert.match(html, /0h 0m/);
  assert.match(html, /Recorded attendance/);
  assert.equal(render(null), '');
});

test('mixed shifts explain per-date hourly rates separately from undated daily credits', () => {
  const html = render({ calculation_mode: 'hourly_workings', variable_shift_hours: true, attendance_source: 'recorded',
    salary: 30000, per_day_wages: 1000, per_hour_wages: null, per_day_working_hour: null,
    worked_minutes: 990, credited_hours: 0, payable_hours: 16.5, undated_credit_days: 1, undated_credit_amount: 1000,
    shift_days: [
      { work_date: '2026-10-01', shift_name: 'Day', daily_hours: 8.5, hourly_rate: 117.6, worked_hours: 8.5, credited_hours: 0 },
      { work_date: '2026-10-02', shift_name: 'Night', daily_hours: 8, hourly_rate: 125, worked_hours: 8, credited_hours: 0 },
    ] });
  assert.match(html, /Varies by assigned shift/);
  assert.match(html, /one daily wage per credited day/);
  assert.match(html, /Credits paid by day/);
  assert.match(html, /₹1,000.00/);
  assert.match(html, /8h 30m/);
  assert.match(html, /₹117.60/);
  assert.match(html, /₹125.00/);
});
