import { useMemo, useState } from 'react';
import { useEmployees } from '../data/employees';
import { useAssignEmployeeShifts, useShiftAssignments, useShifts } from '../data/shifts';
import { todayIso } from '../data/attendance';
import { usePermissions } from '../auth/usePermissions';
import Pagination, { usePagination } from './ui/Pagination';
import { btnClass } from './ui/Btn';

const input = 'w-full rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 px-3 py-2 text-xs';
const hours = minutes => `${Math.floor(Number(minutes) / 60)}h ${Number(minutes) % 60}m`;
const covers = (assignment, date) => assignment.effective_from <= date && (!assignment.effective_to || assignment.effective_to >= date);

export default function EmployeeShiftAssignments() {
  const employeesQuery = useEmployees();
  const assignmentsQuery = useShiftAssignments();
  const shiftsQuery = useShifts();
  const assign = useAssignEmployeeShifts();
  const { can } = usePermissions();
  const [search, setSearch] = useState('');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('active');
  const [selected, setSelected] = useState(new Set());
  const [shiftId, setShiftId] = useState('');
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const employees = useMemo(() => (employeesQuery.data ?? []).filter(employee => can('shift.manage', {
    entityId: employee.entity_id, zoneId: employee.zone_id, branchId: employee.branch_id,
    deptId: employee.department_id, employeeId: employee.id,
  })), [employeesQuery.data, can]);
  const companies = [...new Map(employees.map(employee => [employee.entity_id, employee.entity?.name || employee.entity?.code || 'Company'])).entries()];
  const filtered = employees.filter(employee => (status === 'all' || employee.status === 'Active') && (!company || employee.entity_id === company)
    && `${employee.full_name} ${employee.employee_code} ${employee.branch?.name || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pager = usePagination(filtered, 25, null, `${company}|${status}|${search}`);
  const chosenEmployees = employees.filter(employee => selected.has(employee.id));
  const shifts = shiftsQuery.data ?? [];
  const availableShifts = shifts.filter(shift => shift.is_active && (!company || !shift.entity_id || shift.entity_id === company)
    && chosenEmployees.every(employee => !shift.entity_id || shift.entity_id === employee.entity_id));
  const chosenShift = availableShifts.find(shift => shift.id === shiftId);
  const assignments = assignmentsQuery.data ?? [];
  const queryError = employeesQuery.error || assignmentsQuery.error || shiftsQuery.error;
  const error = queryError || assign.error;
  const loading = employeesQuery.isLoading || assignmentsQuery.isLoading || shiftsQuery.isLoading;
  const toggle = id => setSelected(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const allPageSelected = pager.slice.length > 0 && pager.slice.every(employee => selected.has(employee.id));
  const shiftFor = employee => {
    const assignment = assignments.find(row => row.employee_id === employee.id && covers(row, from));
    const shift = assignment ? shifts.find(row => row.id === assignment.shift_id)
      : shifts.find(row => row.is_default && row.is_active && row.entity_id === employee.entity_id)
        || shifts.find(row => row.is_default && row.is_active && !row.entity_id);
    return { shift, assignment };
  };
  const submit = event => {
    event.preventDefault();
    if (assign.isPending || loading || queryError || !chosenEmployees.length || !chosenShift || !from || to && to < from) return;
    setMessage('');
    assign.mutate({ employeeIds: chosenEmployees.map(employee => employee.id), shiftId, effectiveFrom: from, effectiveTo: to || null, note: note.trim() || null }, {
      onSuccess: () => {
        setMessage(`${chosenEmployees.length} employee${chosenEmployees.length === 1 ? '' : 's'} assigned to ${chosenShift.name} from ${from}. Attendance will refresh after recomputation.`);
        setSelected(new Set());
      },
    });
  };
  return <section className="space-y-3" aria-labelledby="employee-shifts-heading">
    <div>
      <h3 id="employee-shifts-heading" className="font-semibold text-sm">Assign employee shifts</h3>
      <p className="text-xs text-neutral-500 mt-1">Choose employees, then apply a shift from its effective date. The table shows the shift on that date.</p>
    </div>
    <form onSubmit={submit} className="premium-card space-y-3">
      <fieldset disabled={assign.isPending} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs">Company<select aria-label="Assignment company" className={input} value={company} onChange={event => { setCompany(event.target.value); setSelected(new Set()); setShiftId(''); }}>
            <option value="">All companies</option>{companies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label className="text-xs">Employee status<select aria-label="Assignment employee status" className={input} value={status} onChange={event => { setStatus(event.target.value); setSelected(new Set()); }}>
            <option value="active">Active</option><option value="all">All employees</option>
          </select></label>
          <label className="text-xs">Search employees<input className={input} value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, code or branch" /></label>
          <label className="text-xs">Effective from<input required type="date" className={input} value={from} onChange={event => setFrom(event.target.value)} /></label>
          <label className="text-xs">End date (optional)<input type="date" min={from} className={input} value={to} onChange={event => setTo(event.target.value)} /></label>
        </div>
        <div className="table-scroll"><table className="w-full text-xs">
          <thead><tr>
            <th className="p-2 text-left"><input type="checkbox" aria-label="Select this page of employees" checked={allPageSelected} disabled={loading || !pager.slice.length} onChange={() => setSelected(previous => {
              const next = new Set(previous); pager.slice.forEach(employee => { if (allPageSelected) next.delete(employee.id); else next.add(employee.id); }); return next;
            })} /></th>
            <th className="p-2 text-left">Employee / branch</th><th className="p-2 text-left">Shift on {from || 'effective date'}</th><th className="p-2 text-left">Daily salary basis</th>
          </tr></thead>
          <tbody>{pager.slice.map(employee => {
            const { shift, assignment } = shiftFor(employee);
            return <tr key={employee.id} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="p-2"><input type="checkbox" aria-label={`Select ${employee.full_name}`} checked={selected.has(employee.id)} onChange={() => toggle(employee.id)} /></td>
              <td className="p-2" data-label="Employee"><strong>{employee.full_name}</strong><div className="text-neutral-500">{employee.employee_code} · {employee.branch?.name || 'No branch'}{employee.status !== 'Active' ? ` · ${employee.status}` : ''}</div></td>
              <td className="p-2">{shift ? <><span>{shift.name} · {shift.start_time?.slice(0, 5)}–{shift.end_time?.slice(0, 5)}{shift.crosses_midnight ? ' (+1 day)' : ''}</span><div className="text-neutral-500">{assignment ? `${assignment.effective_from} → ${assignment.effective_to || 'ongoing'}` : 'Default shift'}</div></> : <span className="text-amber-700">No shift assigned</span>}
                {assignments.some(row => row.employee_id === employee.id) && <details className="mt-1"><summary className="cursor-pointer text-neutral-500">Assignment history</summary><ul className="mt-1 space-y-1">{assignments.filter(row => row.employee_id === employee.id).map(row => <li key={row.id}>{row.shift?.name || shifts.find(item => item.id === row.shift_id)?.name || 'Shift'} · {row.effective_from} → {row.effective_to || 'ongoing'}{row.note ? ` · ${row.note}` : ''}</li>)}</ul></details>}
              </td>
              <td className="p-2">{shift ? hours(shift.full_day_minutes) : 'Set a shift'}</td>
            </tr>;
          })}</tbody>
        </table></div>
        {loading && <p role="status" className="text-xs text-neutral-500">Loading employees and shifts…</p>}
        {!loading && !queryError && !filtered.length && <p className="text-xs text-neutral-500">No employees match these filters.</p>}
        <Pagination {...pager} noun="employees" disabled={assign.isPending} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs">Assign shift<select required className={input} value={chosenShift?.id || ''} onChange={event => setShiftId(event.target.value)}>
            <option value="">Choose a shift</option>{availableShifts.map(shift => <option key={shift.id} value={shift.id}>{shift.code} — {shift.name} ({hours(shift.full_day_minutes)})</option>)}
          </select></label>
          <label className="text-xs">Note (optional)<input className={input} value={note} onChange={event => setNote(event.target.value)} placeholder="Reason or roster reference" /></label>
        </div>
        {!loading && !queryError && !availableShifts.length && <p className="text-xs text-amber-700 dark:text-amber-400">No active shift matches these employees. Choose one company or create a shared shift.</p>}
        {to && <p className="text-xs text-amber-700 dark:text-amber-400">After the end date, the company default applies unless another assignment covers that date. The previous shift does not resume automatically.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs">{chosenEmployees.length} selected{chosenEmployees.length !== filtered.filter(employee => selected.has(employee.id)).length ? ' (including employees outside this search)' : ''}</span>
          {!!selected.size && <button type="button" className={btnClass('ghost')} onClick={() => setSelected(new Set())}>Clear selection</button>}
          <button type="submit" className={btnClass('primary')} disabled={assign.isPending || loading || Boolean(queryError) || !chosenEmployees.length || !chosenShift || !from || Boolean(to && to < from)}>{assign.isPending ? 'Assigning…' : `Assign shift to ${chosenEmployees.length || 'selected'} employee${chosenEmployees.length === 1 ? '' : 's'}`}</button>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-xs text-red-600">{error.message}</p>}
      {message && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">{message}</p>}
    </form>
  </section>;
}
