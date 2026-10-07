import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePayrollAdjustment, normalizePayrollAdvance, normalizePayrollAdvanceRecovery,
  normalizePayrollPaymentStatus, payrollAdvanceBalance } from './payrollTransactions.js';

test('itemized entries retain their financial type and a separate trimmed reason', () => {
  for (const kind of ['bonus', 'incentive', 'deduction']) {
    assert.deepEqual(normalizePayrollAdjustment({ kind, amount: '1200.50', reason: '  Approved October adjustment  ' }),
      { kind, amount: 1200.5, reason: 'Approved October adjustment' });
  }
  for (const amount of ['', null, false, [], {}, '0', '-1', '12.345', '1e3', '1,000', 'NaN', 'Infinity', '100000000']) {
    assert.throws(() => normalizePayrollAdjustment({ kind: 'deduction', amount, reason: 'Reviewed' }), /Amount/);
  }
  assert.throws(() => normalizePayrollAdjustment({ kind: 'bonus', amount: 1, reason: '  ' }), /Reason/);
  assert.throws(() => normalizePayrollAdjustment({ kind: 'bonus', amount: 1, reason: 'x'.repeat(501) }), /500/);
  assert.throws(() => normalizePayrollAdjustment({ kind: 'salary', amount: 1, reason: 'Reviewed' }), /Choose/);
});

test('advance issue dates cannot silently roll over an invalid calendar date', () => {
  const draft = { issuedOn: '2024-02-29', amount: '99999999.99', reason: 'Employee request' };
  assert.equal(normalizePayrollAdvance(draft).issuedOn, '2024-02-29');
  for (const issuedOn of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-01-32', '0000-01-01', '2026-1-01', '']) {
    assert.throws(() => normalizePayrollAdvance({ ...draft, issuedOn }), /date/);
  }
  assert.equal(normalizePayrollAdvanceRecovery({ period: '2026-10', amount: '0.00' }).amount, 0, 'zero is an explicit recovery removal');
  assert.throws(() => normalizePayrollAdvanceRecovery({ period: '2026-13', amount: 1 }), /month/);
  assert.throws(() => normalizePayrollAdvanceRecovery({ period: '2026-10', amount: '' }), /Recovery/);
});

test('payment records require a hold reason or actual payment reference for their status', () => {
  assert.deepEqual(normalizePayrollPaymentStatus({ status: 'unpaid' }), { status: 'unpaid', reason: '', reference: '' });
  assert.deepEqual(normalizePayrollPaymentStatus({ status: 'held', reason: '  Bank details pending  ' }),
    { status: 'held', reason: 'Bank details pending', reference: '' });
  assert.deepEqual(normalizePayrollPaymentStatus({ status: 'paid', reference: '  NEFT-42  ' }),
    { status: 'paid', reference: 'NEFT-42', reason: '' });
  assert.throws(() => normalizePayrollPaymentStatus({ status: 'held' }), /Hold reason/);
  assert.throws(() => normalizePayrollPaymentStatus({ status: 'paid' }), /Payment reference/);
  assert.equal(normalizePayrollPaymentStatus({ status: 'paid', reference: 'x'.repeat(200) }).reference.length, 200);
  assert.throws(() => normalizePayrollPaymentStatus({ status: 'paid', reference: 'x'.repeat(201) }), /200/);
  assert.throws(() => normalizePayrollPaymentStatus({ status: 'released' }), /Choose/);
});

test('advance balances distinguish posted recovery, reserved installments and remaining debt in exact cents', () => {
  const advance = { id: 'advance-1', amount: '100.30' };
  const recoveries = [
    { advance_id: advance.id, entity_id: 'company-1', period: '2026-08', amount: '10.10' },
    { advance_id: advance.id, entity_id: 'company-1', period: '2026-09', amount: '20.20' },
    { advance_id: advance.id, entity_id: 'company-1', period: '2026-10', amount: '30.00' },
    { advance_id: 'other-advance', entity_id: 'company-1', period: '2026-10', amount: 1000 },
  ];
  const runs = [{ entity_id: 'company-1', period: '2026-08', status: 'Published' },
    { entity_id: 'company-1', period: '2026-09', status: 'Paid' },
    { entity_id: 'company-1', period: '2026-10', status: 'Draft' },
    { entity_id: 'company-2', period: '2026-10', status: 'Published' }];
  assert.deepEqual(payrollAdvanceBalance(advance, recoveries, runs),
    { issued: 100.3, recovered: 30.3, scheduled: 30, outstanding: 70, available: 40 });
  runs[2].status = 'Published';
  assert.deepEqual(payrollAdvanceBalance(advance, recoveries, runs),
    { issued: 100.3, recovered: 60.3, scheduled: 0, outstanding: 40, available: 40 });
  assert.throws(() => payrollAdvanceBalance({ ...advance, amount: 10 }, recoveries, runs), /exceed/);
  assert.deepEqual(payrollAdvanceBalance({ ...advance, voided_at: '2026-10-07T00:00:00Z' }, [], runs),
    { issued: 100.3, recovered: 0, scheduled: 0, outstanding: 0, available: 0 });
  assert.deepEqual(payrollAdvanceBalance(advance, recoveries.map((row, index) => ({ ...row, posted: index < 2 })), []),
    { issued: 100.3, recovered: 30.3, scheduled: 30, outstanding: 70, available: 40 },
    'server publication state remains authoritative without permission to read company run totals');
});
