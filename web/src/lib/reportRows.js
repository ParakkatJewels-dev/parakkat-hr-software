/** A branch ID is the grouping key; codes are only labels and may repeat across companies. */
export function headcountByBranch(employees, exits, { from, to, branchId = 'all', org = {} }) {
  const rows = new Map();
  const branch = (id, employee) => {
    const key = id ?? `unassigned:${employee?.entity_id ?? 'unknown'}`;
    if (!rows.has(key)) {
      const placement = org?.branches?.find(item => item.id === id) ?? employee?.branch;
      const company = org?.entities?.find(item => item.id === (placement?.entity_id ?? employee?.entity_id));
      const label = [company?.code || company?.name, placement?.code, placement?.name].filter(Boolean).join(' · ')
        || (id ? `Branch ${id}` : 'Unassigned');
      rows.set(key, { id: key, label, active: 0, joiners: 0, exits: 0 });
    }
    return rows.get(key);
  };
  for (const employee of employees) {
    if (branchId !== 'all' && employee.branch_id !== branchId) continue;
    const row = branch(employee.branch_id, employee);
    if (employee.status === 'Active') row.active += 1;
    if (employee.join_date >= from && employee.join_date <= to) row.joiners += 1;
  }
  for (const exit of exits) {
    const employee = { ...exit.employee, branch_id: exit.branch_id ?? exit.employee?.branch_id,
      entity_id: exit.entity_id ?? exit.employee?.entity_id };
    if ((branchId !== 'all' && employee?.branch_id !== branchId) || !exit.last_day
        || exit.last_day < from || exit.last_day > to) continue;
    branch(employee?.branch_id, employee).exits += 1;
  }
  // Even an incomplete organization lookup must not leave duplicate visible labels ambiguous.
  const labels = new Map();
  for (const row of rows.values()) labels.set(row.label, (labels.get(row.label) ?? 0) + 1);
  return [...rows.values()].map(row => ({ ...row,
    label: labels.get(row.label) > 1 ? `${row.label} (${row.id})` : row.label,
  })).sort((a, b) => b.active - a.active || a.label.localeCompare(b.label));
}

export const reportReady = (...queries) => queries.every(query => Array.isArray(query.data) && !query.error && !query.isLoading);
