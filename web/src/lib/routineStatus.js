/** Combine every due routine before labelling an employee's day as completed. */
export function employeeRoutineStatus(rows = []) {
  const people = new Map();
  for (const row of rows ?? []) {
    if (!row.employee_id || !(Number(row.scheduled) > 0)) continue;
    if (!people.has(row.employee_id)) people.set(row.employee_id, {
      employeeId: row.employee_id, employee: row.employee ?? null, scheduled: 0, completed: 0,
    });
    const person = people.get(row.employee_id);
    person.scheduled += Number(row.scheduled) || 0;
    person.completed += Number(row.completed) || 0;
  }
  return [...people.values()].map(person => ({
    ...person, pending: person.scheduled - person.completed,
    status: person.completed >= person.scheduled ? 'Completed' : person.completed > 0 ? 'In progress' : 'Not started',
    pct: Math.round(person.completed / person.scheduled * 100),
  })).sort((a, b) => a.pct - b.pct
    || (a.employee?.full_name ?? '').localeCompare(b.employee?.full_name ?? '')
    || a.employeeId.localeCompare(b.employeeId));
}
