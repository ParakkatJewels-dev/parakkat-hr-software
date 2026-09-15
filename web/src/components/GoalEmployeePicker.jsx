import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Users } from 'lucide-react';
import { humanDbError } from '../lib/dbErrors';
import Pagination, { usePagination } from './ui/Pagination';
import { SkeletonRows } from './ui/Skeleton';
import { btnClass } from './ui/Btn';

const INPUT = 'w-full min-w-0 min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50';
const BUTTON = `${btnClass('ghost')} min-h-11`;
const FILTERS = [
  ['designationId', 'designation_id', 'Designation', 'All designations', (employee) => employee.designation?.title],
  ['departmentId', 'department_id', 'Department', 'All departments', (employee) => employee.department?.name],
  ['branchId', 'branch_id', 'Branch', 'All branches', (employee) => employee.branch?.code || employee.branch?.name],
];
const employeeDetails = (employee) => [employee.designation?.title, employee.department?.name,
  employee.branch?.code || employee.branch?.name].filter(Boolean).join(' · ');

/** A single selection from the caller's eligible roster. Filters only narrow that roster. */
export default function GoalEmployeePicker({ employees = [], value = '', onChange, isLoading = false, error, onRetry, disabled = false }) {
  const id = useId();
  const searchRef = useRef(null);
  const selectedRef = useRef(null);
  const focusRequest = useRef(null);
  const [searching, setSearching] = useState(() => !value);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ designationId: '', departmentId: '', branchId: '' });
  const selected = employees.find((employee) => employee.id === value);
  const showSearch = searching || !selected || isLoading || Boolean(error);
  const invalidSelection = Boolean(value && !selected && !isLoading && !error);
  const hasFilters = Boolean(search.trim() || Object.values(filters).some(Boolean));
  const matches = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return employees.filter((employee) => FILTERS.every(([key, idKey]) => !filters[key] || employee[idKey] === filters[key])
      && terms.every((term) => [employee.full_name, employee.employee_code, employee.designation?.title,
        employee.department?.name, employee.branch?.code, employee.branch?.name].filter(Boolean).join(' ').toLocaleLowerCase().includes(term)));
  }, [employees, search, filters]);
  const pager = usePagination(matches, 10, null, `${search}:${filters.designationId}:${filters.departmentId}:${filters.branchId}`);
  useEffect(() => {
    if (!focusRequest.current) return;
    const target = focusRequest.current === 'search' ? searchRef.current : selectedRef.current;
    if (target) { target.focus(); focusRequest.current = null; }
  }, [searching, showSearch, value]);
  const clearFilters = () => { setSearch(''); setFilters({ designationId: '', departmentId: '', branchId: '' }); };
  const openSearch = () => {
    focusRequest.current = 'search';
    setSearching(true);
    if (searchRef.current) { searchRef.current.focus(); focusRequest.current = null; }
  };
  const changeEmployee = () => {
    onChange('');
    clearFilters();
    openSearch();
  };
  const selectEmployee = (employeeId) => {
    focusRequest.current = 'selected';
    onChange(employeeId);
    setSearching(false);
  };

  return <fieldset className="min-w-0 space-y-3" disabled={disabled || isLoading} aria-busy={isLoading}
    aria-describedby={invalidSelection ? `${id}-invalid` : `${id}-help`}>
    <legend className="mb-2 flex items-center gap-2 text-sm font-bold text-neutral-900 dark:text-white"><Users size={17} aria-hidden="true" />Employee for goal</legend>
    <p id={`${id}-help`} className={showSearch ? 'text-sm text-neutral-500 dark:text-neutral-400' : 'sr-only'}>Choose one employee. Search by name, employee code or designation.</p>

    {selected && <div ref={selectedRef} tabIndex={-1} role="group" className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-xl border border-brand/35 bg-brand-soft p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50" aria-label="Selected employee">
      <div className="flex min-w-0 flex-1 items-start gap-2"><Check size={17} className="mt-0.5 shrink-0 text-brand-ink" aria-hidden="true" /><div className="min-w-0">
        <p className="text-xs font-semibold text-brand-ink">Selected employee</p>
        <p className="mt-1 break-words text-sm font-bold text-neutral-900 dark:text-white">{selected.full_name}
          {selected.status && selected.status !== 'Active' && <span className="ml-2 inline-block rounded bg-neutral-200/70 dark:bg-neutral-800 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">{selected.status}</span>}</p>
        {selected.employee_code && <p className="mt-0.5 break-words font-mono text-xs text-neutral-600 dark:text-neutral-300">{selected.employee_code}</p>}
        {employeeDetails(selected) && <p className="mt-1 break-words text-xs text-neutral-600 dark:text-neutral-300">{employeeDetails(selected)}</p>}
      </div></div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} onClick={changeEmployee}>Change employee</button>
        {!isLoading && !error && <button type="button" className={BUTTON} aria-expanded={showSearch} aria-controls={`${id}-search`}
          onClick={() => {
            if (searching) { focusRequest.current = 'selected'; setSearching(false); }
            else openSearch();
          }}>{searching ? 'Close employee search' : 'Search other employees'}</button>}
      </div>
    </div>}
    {invalidSelection && <div id={`${id}-invalid`} role="alert" className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-200">
      <p>The selected employee is no longer available for this goal. Choose another employee.</p>
      <button type="button" className={`${BUTTON} mt-2`} onClick={changeEmployee}>Choose another employee</button>
    </div>}

    {showSearch && <div id={`${id}-search`} className="min-w-0 space-y-3"><div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="min-w-0 space-y-1 text-sm"><span>Search employees</span><input ref={searchRef} type="search" autoComplete="off" className={INPUT}
        value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, code or designation" /></label>
      {FILTERS.map(([key, idKey, label, allLabel, getName]) => {
        const options = [...new Map(employees.filter((employee) => employee[idKey])
          .map((employee) => [employee[idKey], getName(employee) || 'Unnamed'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
        return <label key={key} className="min-w-0 space-y-1 text-sm"><span>{label}</span><select className={INPUT} value={filters[key]}
          onChange={(event) => setFilters((previous) => ({ ...previous, [key]: event.target.value }))}>
          <option value="">{allLabel}</option>{options.map(([optionId, name]) => <option key={optionId} value={optionId}>{name}</option>)}
        </select></label>;
      })}
    </div>

    {isLoading ? <SkeletonRows rows={3} avatar={false} trailing={false} label="Loading employees" />
      : error ? <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 dark:border-rose-900 p-3 text-sm text-rose-700 dark:text-rose-300">
        <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" /><div className="min-w-0"><p className="break-words">{humanDbError(error)}</p>
          {onRetry && <button type="button" className={`${BUTTON} mt-2`} onClick={onRetry}>Retry employees</button>}
        </div></div>
        : <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">{matches.length} matching employee{matches.length === 1 ? '' : 's'}</p>
            {hasFilters && <button type="button" className={BUTTON} onClick={clearFilters}>Clear filters</button>}
          </div>
          <div className="min-w-0 overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
            {matches.length > 0 ? <ul aria-label="Employee search results" className="divide-y divide-neutral-200 dark:divide-neutral-800">{pager.slice.map((employee) => <li key={employee.id}>
              <label className={`flex min-h-14 min-w-0 cursor-pointer items-center gap-3 px-3 py-2 ${employee.id === value ? 'bg-brand-soft' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'}`}>
                <input type="radio" name={`${id}-employee`} checked={employee.id === value} value={employee.id}
                  onChange={() => selectEmployee(employee.id)} aria-label={`Select ${employee.full_name} ${employee.employee_code ?? ''}`.trim()} className="shrink-0 accent-brand" />
                <span className="min-w-0"><span className="block break-words text-sm font-semibold text-neutral-800 dark:text-neutral-200">{employee.full_name}
                  {employee.status && employee.status !== 'Active' && <span className="ml-2 inline-block rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">{employee.status}</span>}</span>
                  {employee.employee_code && <span className="mt-0.5 block break-words font-mono text-xs text-neutral-500 dark:text-neutral-400">{employee.employee_code}</span>}
                  {employeeDetails(employee) && <span className="mt-0.5 block break-words text-xs text-neutral-500 dark:text-neutral-400">{employeeDetails(employee)}</span>}
                </span>
              </label>
            </li>)}</ul> : <p className="px-3 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">{employees.length
              ? 'No employees match these filters. Try another name or clear the filters.'
              : 'No employees are available for you to assign a goal to.'}</p>}
            <div className="paged-collection"><Pagination {...pager} noun="employees" sizes={[10, 25, 50]} disabled={disabled} /></div>
          </div>
          {selected && <p className="text-xs text-neutral-500 dark:text-neutral-400">Your selected employee stays selected when you change filters or pages.</p>}
        </>}
    </div>}
  </fieldset>;
}
