import test from 'node:test';
import assert from 'node:assert/strict';
import { financialYearOf, payYearTotals, periodLabel } from './payYear.js';

test('the pay year is the Indian financial year, April to March', () => {
  assert.deepEqual(financialYearOf('2026-10-22'), { start: 2026, label: '2026–27', from: '2026-04', to: '2027-03' });
  assert.equal(financialYearOf('2027-02-10').start, 2026, 'February belongs to the year that began last April');
  assert.equal(financialYearOf('2026-04-01').start, 2026);
});

test('year totals add up only the payslips inside the financial year', () => {
  const slips = [
    { period: '2026-10', gross: 52000, deductions: 2000, net: 50000 },
    { period: '2026-04', gross: 52000, deductions: 2000, net: 50000 },
    { period: '2026-03', gross: 48000, deductions: 1800, net: 46200 },
  ];
  assert.deepEqual(payYearTotals(slips, '2026-10-22'), { label: '2026–27', months: 2, gross: 104000, deductions: 4000, net: 100000 });
  assert.equal(payYearTotals([], '2026-10-22').gross, 0);
  assert.equal(payYearTotals(null, '2026-10-22').months, 0);
});

test('periods read as month and year', () => {
  assert.equal(periodLabel('2026-10'), 'October 2026');
  assert.equal(periodLabel('2026-10', 'short'), 'Oct 2026');
  assert.equal(periodLabel('bad'), 'bad');
});
