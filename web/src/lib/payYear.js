// Year-to-date pay for one person's payslips (round 2, the phone payslips overview). Payroll in
// India runs on the financial year, April to March, so "this year" is the financial year the given
// day falls in. Periods are 'YYYY-MM'.

export function financialYearOf(iso) {
  const year = Number(String(iso).slice(0, 4));
  const month = Number(String(iso).slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return { start, label: `${start}–${String(start + 1).slice(2)}`, from: `${start}-04`, to: `${start + 1}-03` };
}

export function payYearTotals(payslips, todayIso) {
  const fy = financialYearOf(todayIso);
  const inYear = (payslips ?? []).filter((p) => p.period >= fy.from && p.period <= fy.to);
  const sum = (key) => inYear.reduce((total, p) => total + Number(p[key] || 0), 0);
  return { label: fy.label, months: inYear.length, gross: sum('gross'), deductions: sum('deductions'), net: sum('net') };
}

/** "October 2026" for a 'YYYY-MM' period. */
export function periodLabel(period, month = 'long') {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return String(period ?? '');
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { timeZone: 'UTC', month, year: 'numeric' });
}
