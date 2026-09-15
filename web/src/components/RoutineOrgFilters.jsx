const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';
const FIELDS = [
  ['designationId', 'designation_id', 'Designation', 'All designations', (person) => person.designation?.title],
  ['departmentId', 'department_id', 'Department', 'All departments', (person) => person.department?.name],
  ['branchId', 'branch_id', 'Branch', 'All branches', (person) => person.branch?.code || person.branch?.name],
];

/** Options are drawn from the already scoped collection; selecting one only narrows it. */
export default function RoutineOrgFilters({ employees, value, onChange }) {
  return FIELDS.map(([field, idKey, label, allLabel, getName]) => {
    const options = [...new Map(employees.filter((person) => person?.[idKey])
      .map((person) => [person[idKey], getName(person) || 'Unnamed'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    return <label key={field} className="space-y-1 text-sm"><span>{label}</span><select className={INPUT} value={value[field] ?? ''}
      onChange={(event) => onChange({ ...value, [field]: event.target.value })}>
      <option value="">{allLabel}</option>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select></label>;
  });
}
