import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePermissions } from '../auth/usePermissions';
import { useIsMutating } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Download, FileSpreadsheet, Loader2, Search, Upload, Users } from 'lucide-react';
import { usePayrollSessionState } from '../lib/usePayrollSessionState';
import { usePayrollMonthlyInputs, usePayrollAttendanceSummary, useSavePayrollMonthlyInputs } from '../data/payrollWorksheet';
import { MONTHLY_INPUT_FIELDS, monthlyInputDraft, normalizeMonthlyInput, formatPayrollMinutes } from '../lib/payrollWorksheet';
import { applyPayrollPaste, parsePayrollPaste, parsePayrollImportRows, readPayrollInputWorkbook, exportPayrollInputTemplate } from '../lib/payrollInputGrid';
import Pagination from './ui/Pagination';
import { paginationWindow } from '../lib/pagination.js';
import ConfirmDialog from './ui/ConfirmDialog';
import { btnClass } from './ui/Btn';
import PayrollSheetFrame from './PayrollSheetFrame';
import './payrollInputGrid.css';

const EMPTY = [];
const NOTES = { key: 'notes', label: 'Notes / deduction reason', group: 'Notes' };
const ALL_FIELDS = [...MONTHLY_INPUT_FIELDS, NOTES];
const GROUPS = ['All inputs', 'Earnings', 'Hours & deductions'];
const message = error => error?.message || String(error);
const needsNote = draft => !String(draft.notes ?? '').trim() && (String(draft.ot_hours ?? '').trim() !== '' || String(draft.late_hours ?? '').trim() !== '' || Number(draft.other_deductions) > 0 || String(draft.tds ?? '').trim() !== '' || draft.attendance_source === 'reviewed' || String(draft.off_days ?? '').trim() !== '' || String(draft.casual_leave_days ?? '').trim() !== '' || String(draft.pf ?? '').trim() !== '' || String(draft.esi ?? '').trim() !== '');
const rowError = (draft, calculationMode, creditMode) => { try { normalizeMonthlyInput(draft, { calculationMode, creditMode }); return ''; } catch (error) { return message(error); } };
const equal = (a, b) => {
  try { return JSON.stringify(normalizeMonthlyInput(a)) === JSON.stringify(normalizeMonthlyInput(b)); }
  catch { return JSON.stringify(a) === JSON.stringify(b); }
};
const fieldLabel = key => ALL_FIELDS.find(field => field.key === key)?.label ?? key;
const branchLabel = person => person.branch?.name || person.branch?.code || 'Unassigned branch';
const isHour = key => key === 'ot_hours' || key === 'late_hours';
const cellText = (value, key) => value === '' || value == null ? (isHour(key) ? 'Auto from attendance' : 'Default') : String(value);
const duration = value => value == null || !Number.isFinite(Number(value)) ? '—' : formatPayrollMinutes(Math.round(Number(value) * 60));
const hours = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const punchStamp = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(new Date(value)) : '—';
const autoHours = (row, key) => !row || row.in_payroll_month === false ? null : key === 'ot_hours' ? row.recorded_ot_hours
  : row.policy_deduct_late ? row.deductible_late_hours : 0;
const timeIssue = row => !row ? 'Attendance summary unavailable.' : row.in_payroll_month === false ? '' : row.employment_issue || row.override_issue || row.attendance_review_issue ? row.employment_issue || row.override_issue || row.attendance_review_issue
  : row.reviewed_source_ready ? ''
  : Number(row.pending_recompute_days) > 0 ? `${row.pending_recompute_days} days awaiting attendance processing.`
    : Number(row.unresolved_days) + Number(row.invalid_days) > 0 ? `${Number(row.unresolved_days || 0) + Number(row.invalid_days || 0)} attendance days need review.`
      : Number(row.missing_days) > 0 ? `${row.missing_days} days have no calculated attendance.` : '';


// Drafts and original revisions stay together. Background refreshes can update clean rows,
// but cannot replace an operator's work or silently renew their optimistic-lock revision.
function stagePayrollDrafts(current, patches, records) {
  const next = { ...current };
  for (const { employeeId, patch } of patches) {
    const entry = next[employeeId] ?? {
      base: monthlyInputDraft(records.get(employeeId)),
      expectedUpdatedAt: records.get(employeeId)?.updated_at ?? null,
    };
    const draft = { ...(entry.draft ?? entry.base), ...patch };
    if (patch.attendance_source === 'recorded') Object.assign(draft, { worked_minutes: '', actual_working_days: '', public_holiday_days: '' });
    if (equal(draft, entry.base)) delete next[employeeId];
    else next[employeeId] = { ...entry, draft };
  }
  return next;
}

export default function PayrollInputGrid({ entityId, companyName, period, employees, published, disabled, snapshots = EMPTY, salaryState = 'uncalculated', onDirtyChange, onBusyChange, onContinue, continueDisabled = false, calculationMode = 'paid_days', creditMode = 'earned' }) {
  const { can } = usePermissions();
  const hourly = calculationMode === 'hourly_workings';
  const groups = hourly ? ['All inputs', 'Earnings', 'Deductions', 'Attendance'] : GROUPS;
  const availableFields = ALL_FIELDS.filter(field => hourly ? field.group !== 'Hours' : field.group !== 'Attendance');
  const query = usePayrollMonthlyInputs(entityId, period);
  const attendance = usePayrollAttendanceSummary(entityId, period, { enabled: !published });
  const save = useSavePayrollMonthlyInputs();
  const activeSaves = useIsMutating({ mutationKey: ['save-payroll-monthly-inputs'], predicate: mutation =>
    mutation.state.variables?.entityId === entityId && mutation.state.variables?.period === period });
  const saving = save.isPending || activeSaves > 0;
  const [drafts, setDrafts] = usePayrollSessionState(['inputs', entityId, period], {});
  // Keep the worksheet's place alongside its drafts when HR visits an employee's punches.
  // This store is isolated by access scope and stays in memory, never browser storage.
  const [view, setView] = usePayrollSessionState(['input-view', entityId, period], () => ({
    search: '', branch: '', status: 'all', group: 'All inputs', selected: new Set(),
    fillField: 'incentive', fillValue: '', page: 1, pageSize: 25,
  }));
  const { search, branch, status, group, selected, fillField, fillValue } = view;
  const changeView = (key, value, resetPage = false) => setView(current => ({ ...current,
    [key]: typeof value === 'function' ? value(current[key]) : value, ...(resetPage ? { page: 1 } : {}),
  }));
  const setSearch = value => changeView('search', value, true);
  const setBranch = value => changeView('branch', value, true);
  const setStatus = value => changeView('status', value, true);
  const setGroup = value => changeView('group', value);
  const setSelected = value => changeView('selected', value);
  const setFillField = value => changeView('fillField', value);
  const setFillValue = value => changeView('fillValue', value);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = usePayrollSessionState(['preview', entityId, period], null);
  const [busyFile, setBusyFile] = useState(false);
  const [discard, setDiscard] = useState(null);
  const fileRef = useRef(null);
  const tableRef = useRef(null);
  const writeInFlight = useRef(false);
  const records = useMemo(() => new Map((query.data ?? EMPTY).map(row => [row.employee_id, row])), [query.data]);
  const people = useMemo(() => new Map(employees.map(person => [person.id, person])), [employees]);
  const attendanceMap = useMemo(() => new Map((attendance.data ?? EMPTY).map(row => [row.employee_id, row])), [attendance.data]);
  const latestPunch = useMemo(() => (attendance.data ?? EMPTY).reduce((latest, row) =>
    people.has(row.employee_id) && Date.parse(row.last_punch_at) > (Date.parse(latest) || 0) ? row.last_punch_at : latest, null), [attendance.data, people]);
  const snapshotMap = useMemo(() => new Map(snapshots.map(row => [row.employee_id, row])), [snapshots]);
  const attendanceFor = id => {
    if (!published) return attendanceMap.get(id);
    const snapshot = snapshotMap.get(id)?.payroll_register;
    return snapshot ? { recorded_worked_hours: snapshot.recorded_worked_hours ?? snapshot.total_working_hours,
      recorded_ot_hours: snapshot.recorded_ot_hours, recorded_late_hours: snapshot.recorded_late_hours,
      deductible_late_hours: snapshot.recorded_deductible_late_hours, policy_deduct_late: snapshot.policy?.deduct_late,
      undated_credit_days: snapshot.undated_credit_days, variable_shift_hours: snapshot.variable_shift_hours, effective_worked_hours: snapshot.worked_hours, credited_hours: snapshot.credited_hours, payable_hours: snapshot.payable_hours, reviewed_source_ready: snapshot.attendance_reviewed, effective_ot_hours: snapshot.ot_hours, effective_late_hours: snapshot.late_hours } : null;
  };
  const attendanceBlocked = !published && (!attendance.isSuccess || attendance.isFetching || Boolean(attendance.error));
  const attendanceIssues = published ? [] : employees.filter(person => timeIssue(attendanceMap.get(person.id)));
  const dirtyIds = Object.keys(drafts);
  const conflicts = dirtyIds.filter(id => !people.has(id) || drafts[id].expectedUpdatedAt !== (records.get(id)?.updated_at ?? null));
  const errors = Object.fromEntries(dirtyIds.map(id => [id, rowError(drafts[id].draft, calculationMode, creditMode)]).filter(([, value]) => value));
  const errorCount = Object.keys(errors).length;
  const blocked = published || disabled || attendanceBlocked || !query.isSuccess || query.isFetching || Boolean(query.error) || saving || busyFile;
  const activeGroup = groups.includes(group) ? group : 'All inputs';
  const columns = availableFields.filter(field => field.key === 'notes'
    || (activeGroup === 'Attendance' ? field.group === 'Attendance'
      : field.group !== 'Attendance' && (activeGroup === 'All inputs' || field.group === activeGroup
        || (activeGroup === 'Hours & deductions' && ['Hours', 'Deductions'].includes(field.group)))));
  const branches = [...new Map(employees.map(person => [person.branch_id ?? '', branchLabel(person)])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const filtered = useMemo(() => employees.filter(person => {
    if (branch && (person.branch_id ?? '__none') !== branch) return false;
    if (search.trim() && !`${person.full_name} ${person.employee_code} ${branchLabel(person)}`.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (status === 'changed' && !drafts[person.id]) return false;
    if (status === 'issues' && !errors[person.id] && !conflicts.includes(person.id) && (published || !timeIssue(attendanceMap.get(person.id)))) return false;
    if (status === 'saved' && (!records.has(person.id) || drafts[person.id])) return false;
    if (status === 'empty' && (records.has(person.id) || drafts[person.id])) return false;
    return true;
  }), [employees, branch, search, status, drafts, records, errors, conflicts, published, attendanceMap]);
  // Clamp the visible page without erasing its retained position while queries are loading.
  const pageWindow = paginationWindow(filtered.length, view.page, view.pageSize);
  const pager = { ...pageWindow, initialPageSize: 25,
    slice: filtered.slice((pageWindow.page - 1) * pageWindow.pageSize, pageWindow.page * pageWindow.pageSize),
    setPage: next => setView(current => ({ ...current, page: paginationWindow(filtered.length,
      typeof next === 'function' ? next(paginationWindow(filtered.length, current.page, current.pageSize).page) : next,
      current.pageSize).page })),
    setPageSize: next => setView(current => ({ ...current, page: 1,
      pageSize: paginationWindow(0, 1, typeof next === 'function' ? next(current.pageSize) : next).pageSize })),
  };
  const selectedPeople = employees.filter(person => selected.has(person.id));
  const hiddenSelected = selectedPeople.filter(person => !filtered.some(row => row.id === person.id)).length;
  const currentDraft = id => drafts[id]?.draft ?? monthlyInputDraft(records.get(id));

  useEffect(() => { onDirtyChange?.(dirtyIds.length > 0 || Boolean(preview) || saving || busyFile); }, [dirtyIds.length, preview, saving, busyFile, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { onBusyChange?.(saving || busyFile); }, [saving, busyFile, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    if (!dirtyIds.length && !preview && !saving) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyIds.length, preview, saving]);

  const stage = patches => {
    if (blocked || writeInFlight.current) return;
    if (new Set([...Object.keys(drafts), ...patches.map(row => row.employeeId)]).size > 1000) {
      setError('Save the current changes before adding more rows. Each batch supports up to 1,000 employees.'); return false;
    }
    setDrafts(current => stagePayrollDrafts(current, patches, records));
    setNotice(''); setError(''); save.reset(); return true;
  };
  const paste = (event, rowIndex, columnIndex) => {
    if (blocked || writeInFlight.current) return;
    const text = event.clipboardData.getData('text/plain');
    if (columns[columnIndex].key === 'notes' && !text.includes('\t') && !/[\r\n]/.test(text)) return;
    event.preventDefault();
    try {
      const patches = applyPayrollPaste({ rows: pager.slice, columns: columns.map(field => field.key), startRow: rowIndex, startColumn: columnIndex, values: parsePayrollPaste(text) });
      if (stage(patches)) setNotice(`Updated ${patches.length} employee ${patches.length === 1 ? 'row' : 'rows'}. Review changes, then save.`);
    } catch (reason) { setError(message(reason)); }
  };
  const move = (event, row, column) => {
    if (event.key !== 'Enter' && !(event.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key))) return;
    event.preventDefault();
    const nextRow = row + (event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0);
    const nextColumn = column + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0);
    const target = tableRef.current?.querySelector(`[data-row="${nextRow}"][data-column="${nextColumn}"]`);
    target?.focus(); target?.select?.();
  };
  const preparePreview = (rows, title, warnings = [], fileErrors = []) => {
    const changes = rows.map(row => {
      row = { ...row, patch: Object.fromEntries(Object.entries(row.patch).map(([key, value]) => [key, isHour(key) && String(value).trim().toUpperCase() === 'AUTO' ? '' : value])) };
      const before = currentDraft(row.employeeId);
      const after = { ...before, ...row.patch };
      if (row.patch.attendance_source === 'recorded') { row.patch = { ...row.patch, worked_minutes: '', actual_working_days: '', public_holiday_days: '' }; Object.assign(after, row.patch); }
      return { ...row, employeeName: people.get(row.employeeId)?.full_name ?? row.employeeName,
        before, after, needsNote: needsNote(after), expectedUpdatedAt: records.get(row.employeeId)?.updated_at ?? null, changes: Object.keys(row.patch).filter(key => before[key] !== after[key]), error: rowError(after, calculationMode, creditMode) };
    }).filter(row => row.changes.length);
    const limitErrors = new Set([...dirtyIds, ...changes.map(row => row.employeeId)]).size > 1000 ? [{ row: '—', message: 'A batch supports up to 1,000 employees. Save current changes or import a smaller batch.' }] : [];
    setPreview({ title, reason: '', rows: changes, warnings, errors: [...fileErrors, ...limitErrors] }); setError(''); setNotice('');
  };
  const importFile = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || blocked) return;
    setBusyFile(true); onBusyChange?.(true); setError('');
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Choose an Excel file smaller than 10 MB.');
      const aoa = await readPayrollInputWorkbook(file);
      const result = parsePayrollImportRows(aoa, employees);
      preparePreview(result.rows, `Import review · ${file.name}`, result.warnings, result.errors);
    } catch (reason) { setError(message(reason)); }
    finally { setBusyFile(false); onBusyChange?.(false); }
  };
  const saveAll = async () => {
    if (blocked || writeInFlight.current || !dirtyIds.length || errorCount || conflicts.length || preview) return;
    writeInFlight.current = true; onBusyChange?.(true); setNotice(''); setError('');
    try {
      await save.mutateAsync({ entityId, period, rows: dirtyIds.map(employeeId => ({ employeeId,
        input: drafts[employeeId].draft, expectedUpdatedAt: drafts[employeeId].expectedUpdatedAt })) });
      setDrafts({}); setNotice(`${dirtyIds.length} employee rows saved. Recalculate payroll to update the salary register.`);
    } catch (reason) { setError(`${message(reason)} The save could not be confirmed. Your edits are kept; compare refreshed saved values before retrying.`); }
    finally { writeInFlight.current = false; onBusyChange?.(false); }
  };
  const toggle = id => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const previewChanged = Boolean(preview?.rows.some(row => !people.has(row.employeeId)
    || row.expectedUpdatedAt !== (records.get(row.employeeId)?.updated_at ?? null) || !equal(row.before, currentDraft(row.employeeId))));
  const previewIssues = preview && (preview.errors.length + preview.rows.filter(row => row.error).length);

  return <PayrollSheetFrame defaultExpanded sessionKey={['input-frame', entityId, period]}
    restoreReady={!disabled && query.isSuccess && !query.isFetching && (published || (attendance.isSuccess && !attendance.isFetching))}
    title={`${companyName ? `${companyName} · ` : ''}${period} · Monthly inputs`}>{({ control, fullscreenControl, rememberPosition }) => <section className="payroll-input-workspace premium-card" aria-label="Employee monthly inputs">
    <div className="payroll-input-heading payroll-input-main-heading">
      <div className="payroll-input-title"><FileSpreadsheet size={16} /><h3>{companyName || 'Payroll'} <span>· {period}</span></h3><span className="payroll-input-title-kind">Monthly inputs</span>{published && <span className="payroll-input-readonly">Published · read-only</span>}</div>
      <div className="payroll-input-actions">
        <details className="payroll-sheet-help"><summary>Details &amp; help</summary><div className="payroll-sheet-help-panel">
    <div className="payroll-input-stats" aria-label="Input summary">
      <span><Users size={14} /><b>{employees.length}</b> employees</span>
      <span><b>{dirtyIds.length}</b> changed</span>
      <span className={errorCount || conflicts.length || attendanceIssues.length ? 'payroll-input-danger' : ''}><b>{new Set([...Object.keys(errors), ...conflicts, ...attendanceIssues.map(person => person.id)]).size}</b> need attention</span>
      <span className="payroll-input-month-status">{published ? 'Published · read-only' : 'Draft inputs'}</span>
    </div>
    <div className="payroll-attendance-info"><div><strong>{published ? 'Hours from the published register' : 'Punch time flows into payroll automatically'}</strong>
      {!published && attendance.isSuccess && !attendance.error && <small className="payroll-attendance-freshness">{latestPunch ? `Latest processed punch: ${punchStamp(latestPunch)} IST` : 'No processed punches for this month.'}</small>}
      <p>{published ? 'These hours are frozen with the published salary.' : hourly ? 'Recorded attendance supplies worked hours and paid credits. HR-reviewed monthly totals replace that source for the selected employee with a recorded reason.' : 'Attendance supplies worked, OT and late hours. Enter an override only when needed, with a reason.'}</p></div>
      {!published && <button type="button" className={btnClass('ghost', 'sm')} disabled={attendance.isFetching || saving} onClick={() => attendance.refetch()}>Refresh punch hours</button>}
    </div>
    {hourly && <p className="payroll-input-callout">Hourly workings includes all worked hours in salary. Use Attendance for approved monthly totals, including employees without a device. Enter worked time as H:MM, such as 199:45. {creditMode === 'attendance' ? 'For reviewed totals, enter off days and casual leave days explicitly, including zero.' : 'Blank off / casual leave credits use the saved company rule.'}</p>}
    <div className="payroll-input-tip"><strong>Spreadsheet help · amounts in ₹</strong><p>Tab moves across · Enter moves down · Paste into a cell on the current page. {hourly ? `Reviewed worked time uses H:MM. Choose the source before entering monthly totals. ${creditMode === 'attendance' ? 'Reviewed totals require explicit off / casual-leave credits, including zero.' : 'Blank or AUTO off / casual-leave credits use the saved rule.'} Reviewed totals, credit exceptions and TDS require a reason.` : 'OT / late blank or AUTO = attendance. A number, including 0, overrides attendance and needs a reason.'} PF / ESI / TDS blank = configured component. An explicit amount, including 0, overrides it and requires a reason. Imports read the first worksheet. Save includes changed rows across every page and filter; recalculate payroll after saving. Edits stay when switching views; save before refreshing or signing out.</p></div>
        </div></details>
        <button type="button" className={btnClass('ghost')} disabled={blocked || !employees.length} onClick={async () => {
          setBusyFile(true); setError('');
          try { await exportPayrollInputTemplate(employees, new Map(employees.map(person => [person.id, currentDraft(person.id)])), period); }
          catch (reason) { setError(message(reason)); } finally { setBusyFile(false); }
        }}><Download size={14} />Excel template</button>
        <button type="button" className={btnClass('ghost')} disabled={blocked || !employees.length || Boolean(preview)} onClick={() => fileRef.current?.click()}><Upload size={14} />Import Excel</button>
        {fullscreenControl}{control}
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="sr-only" aria-label="Import payroll Excel file" tabIndex={-1} disabled={blocked || Boolean(preview)} onChange={importFile} />
      </div>
    </div>
    {!published && attendance.isLoading && <p role="status" className="payroll-input-feedback"><Loader2 size={14} className="animate-spin" />Loading punch-derived hours…</p>}
    {!published && attendance.error && <p role="alert" className="payroll-input-feedback payroll-input-danger">{message(attendance.error)}</p>}
    {(query.isLoading || busyFile) && <p role="status" className="payroll-input-feedback"><Loader2 size={14} className="animate-spin" />{busyFile ? 'Preparing spreadsheet…' : 'Loading employee inputs…'}</p>}
    {(query.error || error) && <p role="alert" className="payroll-input-feedback payroll-input-danger"><AlertTriangle size={14} />{error || message(query.error)}</p>}
    {conflicts.length > 0 && <p role="alert" className="payroll-input-callout">{conflicts.length} changed rows have newer saved values or are no longer in your scope. Reload those rows before saving. Your edits have been kept for comparison.</p>}
    {preview && <div className="payroll-import-preview" role="region" aria-label="Review staged payroll changes">
      <div className="payroll-input-heading"><div><h4>{preview.title}</h4><p>{preview.rows.length} employee rows · {period}. Only listed cells change. Blank import cells keep existing values; enter 0 to clear an amount.</p></div>
        <button type="button" className={btnClass('ghost')} onClick={() => setPreview(null)}>Cancel review</button></div>
      {preview.warnings.length > 0 && <div className="payroll-input-callout">{preview.warnings.map((warning, i) => <p key={i}>{typeof warning === 'string' ? warning : warning.message}</p>)}</div>}
      {preview.rows.some(row => row.needsNote) && <label className="payroll-import-reason"><span>Approval note for rows missing a reason</span>
        <input type="text" aria-label="Import approval note" value={preview.reason ?? ''} placeholder="Approval reference or reason for deductions / overrides" disabled={blocked || previewChanged} onChange={event => {
          const reason = event.target.value;
          setPreview(current => ({ ...current, reason, rows: current.rows.map(row => {
            if (!row.needsNote) return row;
            const patch = { ...row.patch, notes: reason }, after = { ...row.before, ...patch };
            return { ...row, patch, after, changes: Object.keys(patch).filter(key => row.before[key] !== after[key]), error: rowError(after, calculationMode, creditMode) };
          }) }));
        }} /><small>This note is added only to rows that need an approval reason and do not already have one.</small></label>}
      {previewChanged && <p role="alert" className="payroll-input-danger">Saved inputs or your employee scope changed during review. Cancel this review and prepare it again using the latest values.</p>}
      {preview.errors.length > 0 && <div role="alert" className="payroll-input-danger"><p>Correct these file errors and import again:</p><ul>{preview.errors.map((item, index) => <li key={index}>Row {item.row}: {item.message}</li>)}</ul></div>}
      <div className="payroll-import-table"><table><caption className="sr-only">Import and bulk fill changes before applying</caption><thead><tr><th>Employee</th><th>Changes · before → after</th><th>Validation</th></tr></thead><tbody>
        {preview.rows.map(row => <tr key={row.employeeId}><th scope="row">{row.employeeName}<small>{people.get(row.employeeId)?.employee_code}</small></th>
          <td>{row.changes.map(key => <div key={key}><b>{fieldLabel(key)}:</b> {cellText(row.before[key], key)} → <strong>{cellText(row.after[key], key)}</strong></div>)}</td>
          <td className={row.error ? 'payroll-input-danger' : 'payroll-input-success'}>{row.error || 'Ready'}</td></tr>)}
      </tbody></table></div>
      {!preview.rows.length && !preview.errors.length && <p>No changed values were found.</p>}
      <div className="payroll-input-actions"><button type="button" className={btnClass('primary')} disabled={blocked || !preview.rows.length || Boolean(previewIssues) || previewChanged} onClick={() => {
        if (blocked || previewChanged || previewIssues) return;
        if (!stage(preview.rows.map(row => ({ employeeId: row.employeeId, patch: row.patch })))) return;
        setPreview(null);
        setNotice(`${preview.rows.length} employee rows applied to the worksheet. Review changes, then save.`);
      }}>Apply {preview.rows.length} rows to worksheet</button><span>Applying does not save payroll.</span></div>
    </div>}
    <div className="payroll-input-toolbar">
      <div className="payroll-input-groups" role="group" aria-label="Input column groups">{groups.map(label => <button type="button" key={label} aria-pressed={label === activeGroup} onClick={() => setGroup(label)}>{label}</button>)}</div>
      <div className="payroll-input-filters">
        <label className="payroll-input-search"><Search size={14} /><input type="search" aria-label="Search payroll employees" placeholder="Search name or employee code" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <select aria-label="Filter payroll branch" value={branch} onChange={event => setBranch(event.target.value)}><option value="">All branches</option>{branches.map(([id, label]) => <option value={id || '__none'} key={id}>{label}</option>)}</select>
        <select aria-label="Filter input status" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All employees</option><option value="changed">Changed rows</option><option value="issues">Needs attention{new Set([...Object.keys(errors), ...conflicts, ...attendanceIssues.map(person => person.id)]).size ? ` (${new Set([...Object.keys(errors), ...conflicts, ...attendanceIssues.map(person => person.id)]).size})` : ''}</option><option value="saved">Saved inputs</option><option value="empty">No saved inputs</option></select>
      </div>
    </div>
    {selectedPeople.length > 0 && <div className="payroll-bulk-bar">
      <span><b>{selectedPeople.length}</b> selected{hiddenSelected > 0 ? ` (${hiddenSelected} outside this filter)` : ''}</span>
      <button type="button" className={btnClass('subtle', 'sm')} disabled={!filtered.length || blocked} onClick={() => setSelected(new Set(filtered.map(person => person.id)))}>Select all {filtered.length} matching</button>
      {selectedPeople.length > 0 && <button type="button" className={btnClass('subtle', 'sm')} onClick={() => setSelected(new Set())}>Clear selection</button>}
      {!hourly && selectedPeople.length > 0 && <button type="button" className={btnClass('ghost', 'sm')} disabled={blocked || Boolean(preview)} onClick={() => preparePreview(selectedPeople.map(person => ({ employeeId: person.id, patch: { ot_hours: '', late_hours: '' } })), 'Use automatic punch hours')}>Use punch hours</button>}
      {selectedPeople.length > 0 && <div className="payroll-bulk-fields"><select aria-label="Bulk fill field" value={fillField} onChange={event => setFillField(event.target.value)} disabled={blocked || Boolean(preview)}>{availableFields.map(field => <option value={field.key} key={field.key}>{field.label}</option>)}</select>
        <input aria-label="Bulk fill value" value={fillValue} inputMode={fillField === 'notes' || isHour(fillField) || ['worked_minutes', 'attendance_source'].includes(fillField) ? 'text' : 'decimal'} placeholder={fillField === 'notes' ? 'Enter a reason' : isHour(fillField) ? 'Hours or AUTO' : 'Value'} onChange={event => setFillValue(event.target.value)} disabled={blocked || Boolean(preview)} />
        <button type="button" className={btnClass('ghost', 'sm')} disabled={blocked || Boolean(preview) || !selectedPeople.length} onClick={() => preparePreview(selectedPeople.map(person => ({ employeeId: person.id, patch: { [fillField]: fillValue } })), `Bulk fill · ${fieldLabel(fillField)}`)}>Review fill</button></div>}
    </div>}
    <div className="payroll-input-table-wrap" ref={tableRef} tabIndex={0} role="region" aria-label="Scrollable monthly input table">
      <table className="payroll-input-table"><caption className="sr-only">Employee monthly inputs for {period}</caption><thead><tr>
        <th className="payroll-input-select"><input type="checkbox" aria-label="Select current page" checked={pager.slice.length > 0 && pager.slice.every(person => selected.has(person.id))} disabled={blocked || !pager.slice.length} onChange={event => setSelected(current => {
          const next = new Set(current); pager.slice.forEach(person => event.target.checked ? next.add(person.id) : next.delete(person.id)); return next;
        })} /></th>
        <th className="payroll-input-employee">Employee / branch</th>
        <th scope="col">{hourly ? 'Worked time' : 'Worked hours'}<small>{hourly ? 'SAVED SOURCE · H:MM' : 'FROM PUNCHES'}</small></th>{hourly ? <><th scope="col">Paid credit time<small>OFF / LEAVE / HOLIDAY · H:MM</small></th><th scope="col">Payable time<small>WORKED + CREDIT · H:MM</small></th></> : <><th scope="col">Recorded OT<small>FROM ATTENDANCE</small></th><th scope="col">Eligible late<small>FULLY PAID DUTY DAYS</small></th></>}
        {columns.map(field => <th scope="col" key={field.key} className={field.key === 'notes' ? 'payroll-input-notes' : ''}>{field.label}<small>{field.type === 'duration' ? 'H:MM' : field.type === 'source' ? 'RECORDED / REVIEWED' : field.group === 'Attendance' ? (field.auto && creditMode !== 'attendance' ? 'DAYS · BLANK = AUTO' : 'DAYS · REQUIRED FOR REVIEWED') : field.group === 'Hours' ? 'HOURS' : field.key === 'notes' ? 'REFERENCE / REASON' : 'INR'}</small></th>)}
        <th scope="col">Status</th>
        <th scope="col" className="payroll-input-total-salary" title="Net payable after earnings and deductions. Updates when payroll is calculated.">Total salary<small>INR · NET PAY</small></th>
      </tr></thead><tbody>{pager.slice.map((person, rowIndex) => {
        const draft = currentDraft(person.id), dirty = Boolean(drafts[person.id]), conflict = conflicts.includes(person.id), rowIssue = errors[person.id];
        const time = attendanceFor(person.id);
        const issue = published ? '' : timeIssue(time);
        const payslip = snapshotMap.get(person.id);
        const salary = payslip?.net;
        const hasSalary = ['current', 'stale'].includes(salaryState) && ['number', 'string'].includes(typeof salary)
          && String(salary).trim() !== '' && Number.isFinite(Number(salary)) && Number(salary) >= 0;
        const salaryAmount = hasSalary ? `₹${Number(salary).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
        const salaryOutdated = !published && (dirty || salaryState === 'stale' || Boolean(issue));
        const salaryNote = salaryState === 'loading' ? 'Loading salary…' : salaryState === 'unavailable' ? 'Salary unavailable'
          : salaryState === 'uncalculated' ? 'Calculate payroll'
            : !hasSalary ? (payslip ? 'Salary unavailable' : published ? 'No published payslip' : 'Not in this run')
              : published ? 'Published net pay' : salaryOutdated ? 'Last calculation · recalculate' : 'Calculated net pay';
        const canReview = can('attendance.read', { entityId: person.entity_id, zoneId: person.zone_id, branchId: person.branch_id, deptId: person.department_id, employeeId: person.id });
        return <tr key={person.id} className={dirty ? 'payroll-input-dirty' : ''}>
          <td className="payroll-input-select"><input type="checkbox" aria-label={`Select ${person.full_name}`} checked={selected.has(person.id)} disabled={blocked} onChange={() => toggle(person.id)} /></td>
          <th scope="row" className="payroll-input-employee"><strong>{person.full_name}</strong><small>{person.employee_code} · {branchLabel(person)}</small>
            {person.status !== 'Active' && <small>{person.status}</small>}
            {time?.in_payroll_month === false && <small>Outside payroll month</small>}
            {canReview && (saving || busyFile
              ? <span className="payroll-punch-link opacity-50" aria-disabled="true">Review / correct punches</span>
              : <Link className="payroll-punch-link" data-payroll-employee={person.id}
                to={`/attendance/person?${new URLSearchParams({ employee: person.id, period, show: 'issues', from: 'payroll', entity: entityId, payrollPeriod: period })}`}
                onClick={event => { setView(current => ({ ...current, page: pager.page })); rememberPosition?.(event.currentTarget); }}>Review / correct punches</Link>)}
            {!published && <small className="payroll-input-last-punch">Last punch: {punchStamp(time?.last_punch_at)} IST</small>}
          </th>
          <td className="payroll-punch-metric"><strong>{hourly ? duration(time?.effective_worked_hours ?? time?.recorded_worked_hours) : `${hours(time?.recorded_worked_hours)}h`}</strong>{time?.reviewed_source_ready && <small>HR-reviewed total</small>}<small>{published ? 'Published snapshot' : time?.reviewed_source_ready ? 'Reviewed for this month' : `${time?.attendance_days ?? '—'} / ${time?.expected_days ?? '—'} days calculated`}</small></td>
            {hourly ? <><td className="payroll-punch-metric"><strong>{duration(time?.credited_hours)}</strong><small>{Number(time?.undated_credit_days) > 0 ? `Plus ${time.undated_credit_days} credits paid by day` : 'Saved paid credits'}</small></td><td className="payroll-punch-metric"><strong>{duration(time?.payable_hours)}</strong><small>{time?.variable_shift_hours ? 'Time paid at daily shift rates' : published ? 'Published snapshot' : 'Updates after saving'}</small></td></> : <><td className="payroll-punch-metric"><strong>{hours(time?.recorded_ot_hours)}h</strong><small>{published ? 'Published snapshot' : 'Calculated from punches'}</small></td>
            <td className="payroll-punch-metric"><strong>{hours(time?.deductible_late_hours)}h</strong><small>All late: {hours(time?.recorded_late_hours)}h</small>{time?.policy_deduct_late === false && <small>Late deduction disabled</small>}</td></>}
          {columns.map((field, columnIndex) => {
            const requiredAttendance = field.group === 'Attendance' && field.type !== 'source' && draft.attendance_source === 'reviewed' && (!field.auto || creditMode === 'attendance');
            const automatic = isHour(field.key) && String(draft[field.key] ?? '').trim() === '';
            const calculated = published ? time?.[field.key === 'ot_hours' ? 'effective_ot_hours' : 'effective_late_hours'] : autoHours(time, field.key);
            return <td key={field.key} className={`${field.key === 'notes' ? 'payroll-input-notes' : ''} ${dirty && drafts[person.id].base[field.key] !== draft[field.key] ? 'payroll-input-cell-changed' : ''}`}>
            {field.type === 'source' ? <select aria-label={`${person.full_name} · ${field.label}`} value={draft[field.key]} disabled={blocked || Boolean(preview)}
              data-row={rowIndex} data-column={columnIndex} onKeyDown={event => move(event, rowIndex, columnIndex)}
              onChange={event => stage([{ employeeId: person.id, patch: { attendance_source: event.target.value,
                ...(event.target.value === 'recorded' ? { worked_minutes: '', actual_working_days: '', public_holiday_days: '' } : {}) } }])}>
              <option value="recorded">Recorded attendance</option><option value="reviewed">HR-reviewed totals</option>
            </select> : <input type="text" aria-label={`${person.full_name} · ${field.label}`} aria-required={requiredAttendance || undefined} aria-invalid={Boolean(rowIssue) || undefined} aria-describedby={rowIssue || conflict ? `payroll-issue-${person.id}` : undefined}
              data-row={rowIndex} data-column={columnIndex} inputMode={field.key === 'notes' || field.type === 'duration' ? 'text' : 'decimal'} value={automatic ? (calculated == null ? '' : String(calculated)) : draft[field.key]} readOnly={automatic}
              placeholder={field.type === 'duration' ? '199:45' : automatic ? time?.in_payroll_month === false ? 'Not applicable' : 'Awaiting punches' : requiredAttendance ? 'Required' : field.nullable ? 'Default' : field.key === 'notes' ? 'Add a note…' : '0.00'} disabled={blocked || Boolean(preview) || (isHour(field.key) && time?.in_payroll_month === false) || (['worked_minutes', 'actual_working_days', 'public_holiday_days'].includes(field.key) && draft.attendance_source !== 'reviewed')}
              onChange={event => stage([{ employeeId: person.id, patch: { [field.key]: field.auto && event.target.value.trim().toUpperCase() === 'AUTO' ? '' : event.target.value } }])}
              onFocus={event => { if (field.key !== 'notes') event.target.select(); }}
              onKeyDown={event => move(event, rowIndex, columnIndex)} onPaste={event => paste(event, rowIndex, columnIndex)} />}
            {isHour(field.key) && <div className="payroll-hour-mode"><span>{automatic ? 'Auto · attendance' : 'HR override'}</span>
              {!published && <button type="button" aria-label={`${person.full_name} · ${automatic ? 'Override' : 'Use automatic'} ${field.label}`} disabled={blocked || Boolean(preview) || (automatic && calculated == null)} onClick={() => stage([{ employeeId: person.id, patch: { [field.key]: automatic ? String(calculated) : '' } }])}>{automatic ? 'Edit' : 'Use auto'}</button>}
            </div>}
            {conflict && <small className="payroll-input-latest">Saved: {cellText(monthlyInputDraft(records.get(person.id))[field.key], field.key)}</small>}
          </td>; })}
          <td className="payroll-input-row-status"><span className={conflict || rowIssue || issue ? 'payroll-input-danger' : dirty ? 'payroll-input-unsaved' : 'payroll-input-muted'}>{conflict ? 'Changed elsewhere' : rowIssue || issue ? 'Needs attention' : dirty ? 'Unsaved' : records.has(person.id) ? 'Saved' : 'No inputs'}</span>
            {(rowIssue || conflict || issue) && <p id={`payroll-issue-${person.id}`}>{conflict ? 'Compare saved values, then reload this row.' : rowIssue || issue}</p>}
            {hourly && !published && (Number(draft.ot_hours) > 0 || Number(draft.late_hours) > 0) && <button type="button" disabled={blocked || Boolean(preview)} onClick={() => stage([{ employeeId: person.id, patch: { ot_hours: '', late_hours: '' } }])}>Clear separate OT / late overrides</button>}
            {dirty && <button type="button" disabled={saving || Boolean(preview)} onClick={() => setDiscard(person.id)}>{conflict ? 'Reload row' : 'Undo row'}</button>}
          </td>
          <td className="payroll-input-total-salary" aria-label={`${person.full_name} · Total salary · ${salaryAmount} · ${salaryNote}`}>
            <strong>{salaryAmount}</strong>
            <small className={salaryOutdated && hasSalary ? 'payroll-input-unsaved' : ''}>{salaryNote}</small>
          </td>
        </tr>;
      })}</tbody></table>
      {!filtered.length && !query.isLoading && <p className="payroll-input-empty">{employees.length ? 'No employees match these filters.' : 'No employees are available in your payroll scope.'}</p>}
    </div>
    <div className="payroll-input-footer">
    <Pagination {...pager} sizes={[25, 50, 100, 200]} noun="employees" keepVisible disabled={saving} />
    <div className="payroll-input-savebar">
      <div role="status" className="payroll-input-save-status"><strong>{notice || (dirtyIds.length ? `${dirtyIds.length} employee rows with unsaved changes` : query.isLoading ? 'Loading saved inputs…' : query.error ? 'Saved inputs unavailable' : 'No unsaved changes')}</strong>{errorCount > 0 && <p className="payroll-input-danger">Fix {errorCount} rows before saving.</p>}</div>
      <div className="payroll-input-actions"><button type="button" className={btnClass('ghost')} disabled={!dirtyIds.length || saving} onClick={() => { setStatus('changed'); setSearch(''); setBranch(''); }}>Review changes</button>
        <button type="button" className={btnClass('ghost')} disabled={!dirtyIds.length || saving || Boolean(preview)} onClick={() => setDiscard('all')}>Discard</button>
        <button type="button" className={btnClass(dirtyIds.length ? 'primary' : 'ghost')} disabled={blocked || !dirtyIds.length || Boolean(errorCount || conflicts.length || preview)} onClick={saveAll}>{saving && <Loader2 size={14} className="animate-spin" />}Save {dirtyIds.length ? `${dirtyIds.length} changes` : 'changes'}</button>
        {onContinue && <button type="button" className={btnClass('primary')} disabled={continueDisabled || saving || busyFile || dirtyIds.length > 0 || Boolean(preview)}
          onClick={() => { if (!continueDisabled && !saving && !busyFile && !writeInFlight.current && !dirtyIds.length && !preview) onContinue(); }}>Continue to review<ArrowRight size={14} /></button>}</div>
    </div>
    </div>
    {discard && <ConfirmDialog title={discard === 'all' ? 'Discard all unsaved inputs?' : 'Reload this employee’s saved inputs?'} confirmLabel={discard === 'all' ? 'Discard changes' : 'Reload row'} onCancel={() => setDiscard(null)} onConfirm={() => {
      setDrafts(current => { if (discard === 'all') return {}; const next = { ...current }; delete next[discard]; return next; }); setDiscard(null); setError(''); setNotice('');
    }}><p>{discard === 'all' ? `${dirtyIds.length} employee rows` : people.get(discard)?.full_name} will return to the latest saved values.</p></ConfirmDialog>}
  </section>}</PayrollSheetFrame>;
}
