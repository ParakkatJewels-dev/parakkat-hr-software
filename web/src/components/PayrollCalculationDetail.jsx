// Read only from the published calculation snapshot. A later policy edit must never
// change the explanation of a salary that was already calculated.
const money = value => value == null || !Number.isFinite(Number(value)) ? '—'
  : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const duration = value => {
  if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return '—';
  const minutes = Math.round(Number(value) * 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export default function PayrollCalculationDetail({ register }) {
  if (!register) return null;
  const hourly = register.calculation_mode === 'hourly_workings';
  const variableHours = hourly && register.variable_shift_hours;
  const facts = [
    ['Monthly salary', money(register.salary)],
    ['Earned salary', money(register.earned_salary)],
    ['Day rate', money(register.per_day_wages)],
    ['Hour rate', variableHours ? 'Varies by assigned shift' : money(register.per_hour_wages)],
    ...(hourly ? [['Daily salary basis', variableHours ? 'Each date’s assigned shift' : duration(register.per_day_working_hour)]] : []),
    ['Actual working days', register.actual_working_days],
    ['Public holidays', register.public_holiday],
    ['Off days', register.off_days],
    ['Casual leave', register.casual_leave],
    ...(hourly ? [
      ['Worked time', duration(register.worked_minutes == null ? register.total_working_hours : Number(register.worked_minutes) / 60)],
      ['Paid holiday / leave time', duration(register.credited_hours)],
      [variableHours ? 'Time paid at hourly rates' : 'Total payable time', duration(register.payable_hours)],
      ...(variableHours && Number(register.undated_credit_days) > 0 ? [
        ['Credits paid by day', register.undated_credit_days],
        ['Day-credit amount', money(register.undated_credit_amount)],
      ] : []),
      ['Attendance basis', register.attendance_source === 'reviewed' ? 'HR-reviewed monthly totals' : 'Recorded attendance'],
    ] : [
      ['Approved OT hours', register.ot_hours],
      ['Approved late hours', register.late_hours],
    ]),
  ];
  return <div className="space-y-3">
    {hourly && <p className="text-xs text-neutral-500 dark:text-neutral-400">
      {variableHours ? 'Salary uses each date’s saved shift hours and hourly rate. Credits without a date are paid at one daily wage per credited day.' : 'Salary uses payable hours × the saved hourly rate.'} Overtime is included in worked time.
      Wages are rounded up to a rupee and net pay to the nearest rupee; adjustments appear in the breakdown.
    </p>}
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
      {facts.map(([label, value]) => <div key={label}>
        <dt className="text-neutral-500">{label}</dt>
        <dd className="mt-1 font-semibold text-neutral-800 dark:text-neutral-100">{value ?? '—'}</dd>
      </div>)}
    </dl>
    {hourly && register.shift_days?.length > 0 && <details className="text-xs">
      <summary className="cursor-pointer font-semibold">Daily shift calculation</summary>
      <div className="overflow-x-auto mt-2"><table className="w-full text-left">
        <thead><tr>{['Date', 'Shift', 'Daily basis', 'Hour rate', 'Worked time', 'Paid credit time'].map(label => <th className="p-2" key={label}>{label}</th>)}</tr></thead>
        <tbody>{register.shift_days.map(day => <tr key={day.work_date} className="border-t border-neutral-200 dark:border-neutral-800">
          <td className="p-2">{day.work_date}</td><td className="p-2">{day.shift_name}</td>
          <td className="p-2">{duration(day.daily_hours ?? Number(day.daily_minutes) / 60)}</td>
          <td className="p-2">{money(day.hourly_rate ?? register.per_hour_wages)}</td>
          <td className="p-2">{register.attendance_source === 'reviewed' ? 'Monthly HR total' : duration(day.worked_hours ?? Number(day.worked_minutes) / 60)}</td>
          <td className="p-2">{duration(day.credited_hours)}</td>
        </tr>)}</tbody>
      </table></div>
    </details>}
  </div>;
}
