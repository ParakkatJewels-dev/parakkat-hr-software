import { useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import Pagination, { usePagination } from './ui/Pagination';
import { btnClass } from './ui/Btn';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';
const choices = (employees, idKey, getName) => [...new Map(employees.filter((employee) => employee[idKey])
  .map((employee) => [employee[idKey], getName(employee) || 'Unnamed'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));

/** Receives only employees whom the current view may assign; filters never widen that pool. */
export default function RoutinePeoplePicker({ employees = [], selectedIds = [], onChange, disabled = false }) {
  const [search, setSearch] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const selected = new Set(selectedIds);
  const matches = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return employees.filter((employee) => (!designationId || employee.designation_id === designationId)
      && (!departmentId || employee.department_id === departmentId)
      && (!branchId || employee.branch_id === branchId)
      && (!onlySelected || selectedIds.includes(employee.id))
      && terms.every((term) => [employee.full_name, employee.employee_code, employee.designation?.title,
        employee.department?.name, employee.branch?.code].join(' ').toLocaleLowerCase().includes(term)));
  }, [employees, search, designationId, departmentId, branchId, onlySelected, selectedIds]);
  const pager = usePagination(matches, 25, null, `${search}:${designationId}:${departmentId}:${branchId}:${onlySelected}`);
  const allMatchingSelected = matches.length > 0 && matches.every((employee) => selected.has(employee.id));
  const exceedsLimit = new Set([...selectedIds, ...matches.map((employee) => employee.id)]).size > 1000;
  const changePerson = (id, checked) => onChange(checked ? [...new Set([...selectedIds, id])] : selectedIds.filter((value) => value !== id));
  const selectMatching = () => {
    const matchingIds = new Set(matches.map((employee) => employee.id));
    onChange(allMatchingSelected ? selectedIds.filter((id) => !matchingIds.has(id)) : [...new Set([...selectedIds, ...matchingIds])]);
  };
  return <fieldset className="space-y-3" disabled={disabled}>
    <legend className="mb-2 flex items-center gap-2 text-sm font-bold"><Users size={17} />Assign employees</legend>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="space-y-1 text-sm"><span>Search employees</span><input type="search" className={INPUT} value={search}
        onChange={(event) => setSearch(event.target.value)} placeholder="Name or employee code" /></label>
      <label className="space-y-1 text-sm"><span>Designation</span><select className={INPUT} value={designationId} onChange={(event) => setDesignationId(event.target.value)}>
        <option value="">All designations</option>{choices(employees, 'designation_id', (employee) => employee.designation?.title).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label className="space-y-1 text-sm"><span>Department</span><select className={INPUT} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
        <option value="">All departments</option>{choices(employees, 'department_id', (employee) => employee.department?.name).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label className="space-y-1 text-sm"><span>Branch</span><select className={INPUT} value={branchId} onChange={(event) => setBranchId(event.target.value)}>
        <option value="">All branches</option>{choices(employees, 'branch_id', (employee) => employee.branch?.code || employee.branch?.name).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-neutral-600 dark:text-neutral-400" role="status">{selectedIds.length} selected · {matches.length} matching employees</p>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)} />Show selected only</label>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={btnClass('ghost')} disabled={!matches.length || (!allMatchingSelected && exceedsLimit)} onClick={selectMatching}>
        {allMatchingSelected ? 'Deselect' : 'Select'} all {matches.length} matching employees</button>
      {selectedIds.length > 0 && <button type="button" className={btnClass('ghost')} onClick={() => onChange([])}>Clear selection</button>}
    </div>
    <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
      {matches.length ? <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">{pager.slice.map((employee) => <li key={employee.id}>
        <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900">
          <input type="checkbox" checked={selected.has(employee.id)} disabled={!selected.has(employee.id) && selectedIds.length >= 1000} onChange={(event) => changePerson(employee.id, event.target.checked)}
            aria-label={`Assign ${employee.full_name} ${employee.employee_code ?? ''}`.trim()} />
          <span className="min-w-0"><span className="block break-words text-sm font-semibold">{employee.full_name}<span className="ml-2 font-mono text-xs font-normal text-neutral-500">{employee.employee_code}</span></span>
            <span className="mt-0.5 block break-words text-xs text-neutral-500">{[employee.designation?.title, employee.department?.name, employee.branch?.code].filter(Boolean).join(' · ')}</span></span>
        </label></li>)}</ul> : <p className="px-3 py-6 text-center text-sm text-neutral-500">{employees.length ? 'No employees match these filters.' : 'No employees are available within your assignment scope.'}</p>}
      <div className="paged-collection"><Pagination {...pager} noun="employees" sizes={[25, 50, 100]} /></div>
    </div>
    <p className="text-xs text-neutral-500">Selections stay selected when you change filters or pages.</p>
    {exceedsLimit && <p className="text-xs text-amber-700 dark:text-amber-300">Assign up to 1,000 employees at a time. Narrow the filters or select a smaller group.</p>}
  </fieldset>;
}
