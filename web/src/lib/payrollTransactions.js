const MONEY_LIMIT = 99999999.99;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export const PAYROLL_ADJUSTMENT_KINDS = ['bonus', 'incentive', 'deduction'];
export const PAYROLL_PAYMENT_STATUSES = ['unpaid', 'held', 'paid'];

export function payrollTransactionAmount(value, { allowZero = false, label = 'Amount' } = {}) {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  const amount = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(amount)
    || amount > MONEY_LIMIT || (allowZero ? amount < 0 : amount <= 0)) {
    throw new Error(`${label} must be ${allowZero ? 'zero or a positive' : 'a positive'} amount up to 99,999,999.99 with at most two decimal places.`);
  }
  return amount;
}

function requiredText(value, label, required = true, limit = 500) {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((required && !text) || text.length > limit) throw new Error(`${label} ${required ? 'is required and ' : ''}must be ${limit} characters or fewer.`);
  return text;
}

export function normalizePayrollPeriod(period) {
  if (typeof period !== 'string' || !PERIOD.test(period) || period.startsWith('0000-')) throw new Error('Choose a valid payroll month.');
  return period;
}

export function normalizePayrollAdjustment(adjustment) {
  if (!PAYROLL_ADJUSTMENT_KINDS.includes(adjustment?.kind)) throw new Error('Choose bonus, incentive, or deduction.');
  return { kind: adjustment.kind, amount: payrollTransactionAmount(adjustment.amount), reason: requiredText(adjustment.reason, 'Reason') };
}

export function normalizePayrollAdvance({ issuedOn, amount, reason } = {}) {
  if (typeof issuedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)
      || issuedOn.startsWith('0000-') || !Number.isFinite(Date.parse(`${issuedOn}T00:00:00Z`))
      || new Date(`${issuedOn}T00:00:00Z`).toISOString().slice(0, 10) !== issuedOn) throw new Error('Choose a valid advance issue date.');
  return { issuedOn, amount: payrollTransactionAmount(amount), reason: requiredText(reason, 'Reason') };
}

export function normalizePayrollAdvanceRecovery({ period, amount } = {}) {
  return { period: normalizePayrollPeriod(period), amount: payrollTransactionAmount(amount, { allowZero: true, label: 'Recovery' }) };
}

export function normalizePayrollVoidReason(reason) {
  return requiredText(reason, 'Void reason');
}

export function normalizePayrollPaymentStatus({ status, reason, reference } = {}) {
  if (!PAYROLL_PAYMENT_STATUSES.includes(status)) throw new Error('Choose unpaid, held, or paid.');
  return { status, reason: requiredText(reason, 'Hold reason', status === 'held'),
    reference: requiredText(reference, 'Payment reference', status === 'paid', 200) };
}

/** Publication books a recovery. Draft months reserve that amount without reducing the outstanding balance. */
export function payrollAdvanceBalance(advance, recoveries = [], runs = []) {
  const issued = Math.round(payrollTransactionAmount(advance?.amount) * 100);
  if (advance.voided_at) return { issued: issued / 100, recovered: 0, scheduled: 0, outstanding: 0, available: 0 };
  const published = new Set(runs.filter(run => ['Published', 'Paid'].includes(run.status))
    .map(run => `${run.entity_id}:${run.period}`));
  let recovered = 0, scheduled = 0;
  for (const recovery of recoveries) {
    if (recovery.advance_id !== advance.id) continue;
    const cents = Math.round(payrollTransactionAmount(recovery.amount, { allowZero: true }) * 100);
    if (typeof recovery.posted === 'boolean' ? recovery.posted : published.has(`${recovery.entity_id}:${recovery.period}`)) recovered += cents;
    else scheduled += cents;
  }
  if (recovered + scheduled > issued) throw new Error('Advance recoveries exceed the issued amount. Refresh the advance register.');
  return { issued: issued / 100, recovered: recovered / 100, scheduled: scheduled / 100,
    outstanding: (issued - recovered) / 100, available: (issued - recovered - scheduled) / 100 };
}
