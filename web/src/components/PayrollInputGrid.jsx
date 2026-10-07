import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePermissions } from '../auth/usePermissions';
import { useIsMutating } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, Download, FileSpreadsheet, Loader2, Search, Upload, Users } from 'lucide-react';
import { usePayrollSessionState } from '../lib/usePayrollSessionState';
import { usePayrollMonthlyInputs, usePayrollAttendanceSummary, useSavePayrollMonthlyInputs } from '../data/payrollWorksheet';
import { MONTHLY_INPUT_FIELDS, monthlyInputDraft, normalizeMonthlyInput } from '../lib/payrollWorksheet';
import { applyPayrollPaste, parsePayrollPaste, parsePayrollImportRows, readPayrollInputWorkbook, exportPayrollInputTemplate } from '../lib/payrollInputGrid';
import Pagination, { usePagination } from './ui/Pagination';
import ConfirmDialog from './ui/ConfirmDialog';
import { btnClass } from './ui/Btn';
import PayrollSheetFrame from './PayrollSheetFrame';
import './payrollInputGrid.css';

const EMPTY = [];
const NOTES = { key: 'notes', label: 'Notes / deduction reason', group: 'Notes' };
const ALL_FIELDS = [...MONTHLY_INPUT_FIELDS, NOTES];
const GROUPS = ['All inputs', 'Earnings', 'Hours & deductions'];
const message = error => error?.message || String(error);
const needsNote = draft => !String(draft.notes ?? '').trim() && (String(draft.ot_hours ?? '').trim() !== '' || String(draft.late_hours ?? '').trim() !== '' || Number(draft.other_deductions) > 0 || String(draft.pf ?? '').trim() !== '' || String(draft.esi ?? '').trim() !== '');
const rowError = draft => { try { normalizeMonthlyInput(draft); return ''; } catch (error) { return message(error); } };
const equal = (a, b) => {
  try { return JSON.stringify(normalizeMonthlyInput(a)) === JSON.stringify(normalizeMonthlyInput(b)); }
  catch { return JSON.stringify(a) === JSON.stringify(b); }
};
const fieldLabel = key => ALL_FIELDS.find(field => field.key === key)?.label ?? key;
const branchLabel = person => person.branch?.name || person.branch?.code || 'Unassigned branch';
const isHour = key => key === 'ot_hours' || key === 'late_hours';
const cellText = (value, key) => value === '' || value == null ? (isHour(key) ? 'Auto from attendance' : 'Default') : String(value);
const hours = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const punchStamp = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(new Date(value)) : '—';
const autoHours = (row, key) => !row || row.in_payroll_month === false ? null : key === 'ot_hours' ? row.recorded_ot_hours
  : row.policy_deduct_late ? row.deductible_late_hours : 0;
const timeIssue = row => !row ? 'Attendance summary unavailable.' : row.in_payroll_month === false ? '' : row.employment_issue || row.override_issue ? row.employment_issue || row.override_issue
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
    if (equal(draft, entry.base)) delete next[employeeId];
    else next[employeeId] = { ...entry, draft };
  }
  return next;
}

export default function PayrollInputGrid({ entityId, companyName, period, employees, published, disabled, snapshots = EMPTY, onDirtyChange, onBusyChange, onContinue, continueDisabled = false }) {
  const { can } = usePermissions();
  const query = usePayrollMonthlyInputs(entityId, period);
  const attendance = usePayrollAttendanceSummary(entityId, period, { enabled: !published });
  const save = useSavePayrollMonthlyInputs();
  const activeSaves = useIsMutating({ mutationKey: ['save-payroll-monthly-inputs'], predicate: mutation =>
    mutation.state.variables?.entityId === entityId && mutation.state.variables?.period === period });
  const saving = save.isPending || activeSaves > 0;
  const [drafts, setDrafts] = usePayrollSessionState(['inputs', entityId, period], {});
  const [search, setSearch] = useState('');
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState('all');
  const [group, setGroup] = useState('All inputs');
  const [selected, setSelected] = useState(new Set());
  const [fillField, setFillField] = useState('incentive');
  const [fillValue, setFillValue] = useState('');
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
  const snapshotMap = useMemo(() => new Map(snapshots.map(row => [row.employee_id, row.payroll_register])), [snapshots]);
  const attendanceFor = id => {
    if (!published) return attendanceMap.get(id);
    const snapshot = snapshotMap.get(id);
    return snapshot ? { recorded_worked_hours: snapshot.recorded_worked_hours ?? snapshot.total_working_hours,
      recorded_ot_hours: snapshot.recorded_ot_hours, recorded_late_hours: snapshot.recorded_late_hours,
      deductible_late_hours: snapshot.recorded_deductible_late_hours, policy_deduct_late: snapshot.policy?.deduct_late,
      effective_ot_hours: snapshot.ot_hours, effective_late_hours: snapshot.late_hours } : null;
  };
  const attendanceBlocked = !published && (!attendance.isSuccess || attendance.isFetching || Boolean(attendance.error));
  const attendanceIssues = published ? [] : employees.filter(person => timeIssue(attendanceMap.get(person.id)));
  const dirtyIds = Object.keys(drafts);
  const conflicts = dirtyIds.filter(id => !people.has(id) || drafts[id].expectedUpdatedAt !== (records.get(id)?.updated_at ?? null));
  const errors = Object.fromEntries(dirtyIds.map(id => [id, rowError(drafts[id].draft)]).filter(([, value]) => value));
  const errorCount = Object.keys(errors).length;
  const blocked = published || disabled || attendanceBlocked || !query.isSuccess || query.isFetching || Boolean(query.error) || saving || busyFile;
  const columns = ALL_FIELDS.filter(field => field.key === 'notes' || group === 'All inputs'
    || (group === 'Earnings' ? field.group === 'Earnings' : field.group === 'Hours' || field.group === 'Deductions'));
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
  const pager = usePagination(filtered, 25, null, `${search}|${branch}|${status}`);
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
      if (stage(patches)) setNotice(`Pasted values into ${patches.length} employee rows. Review changes, then save.`);
    } catch (reason) { setError(message(reason)); }
  };
  const move = (event, row, column) => {
    if (event.key !== 'Enter' && !(event.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key))) return;
    event.preventDefault();
    const nextRow = row + (event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0);
    const nextColumn = column + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0);
    const target = tableRef.current?.querySelector(`[data-row="${nextRow}"][data-column="${nextColumn}"]`);
    target?.focus(); target?.select();
  };
  const preparePreview = (rows, title, warnings = [], fileErrors = []) => {
    const changes = rows.map(row => {
      row = { ...row, patch: Object.fromEntries(Object.entries(row.patch).map(([key, value]) => [key, isHour(key) && String(value).trim().toUpperCase() === 'AUTO' ? '' : value])) };
      const before = currentDraft(row.employeeId);
      const after = { ...before, ...row.patch };
      return { ...row, employeeName: people.get(row.employeeId)?.full_name ?? row.employeeName,
        before, after, needsNote: needsNote(after), expectedUpdatedAt: records.get(row.employeeId)?.updated_at ?? null, changes: Object.keys(row.patch).filter(key => before[key] !== after[key]), error: rowError(after) };
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

  return <PayrollSheetFrame defaultExpanded title={`${companyName ? `${companyName} · ` : ''}${period} · Monthly inputs`}>{({ control }) => <section className="payroll-input-workspace premium-card" aria-label="Employee monthly inputs">
    <div className="payroll-input-heading">
      <div><div className="payroll-input-eyebrow"><FileSpreadsheet size={14} /> MONTHLY INPUTS <span>{period}</span></div>
        <h3>Employee monthly inputs</h3>
        <p>Edit cells or paste from Excel. Save your changes before reviewing payroll.</p></div>
      <div className="payroll-input-actions">
        {control}
        <button type="button" className={btnClass('ghost')} disabled={blocked || !employees.length} onClick={async () => {
          setBusyFile(true); setError('');
          try { await exportPayrollInputTemplate(employees, new Map(employees.map(person => [person.id, currentDraft(person.id)])), period); }
          catch (reason) { setError(message(reason)); } finally { setBusyFile(false); }
        }}><Download size={14} />Excel template</button>
        <button type="button" className={btnClass('ghost')} disabled={blocked || !employees.length || Boolean(preview)} onClick={() => fileRef.current?.click()}><Upload size={14} />Import Excel</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="sr-only" aria-label="Import payroll Excel file" tabIndex={-1} disabled={blocked || Boolean(preview)} onChange={importFile} />
      </div>
    </div>
    <div className="payroll-input-stats" aria-label="Input summary">
      <span><Users size={14} /><b>{employees.length}</b> employees</span>
      <span><b>{dirtyIds.length}</b> changed</span>
      <span className={errorCount || conflicts.length || attendanceIssues.length ? 'payroll-input-danger' : ''}><b>{new Set([...Object.keys(errors), ...conflicts, ...attendanceIssues.map(person => person.id)]).size}</b> need attention</span>
      <span className="payroll-input-month-status">{published ? 'Published · read-only' : 'Draft inputs'}</span>
    </div>
    {group !== 'Earnings' && <div className="payroll-attendance-info"><div><strong>{published ? 'Hours from the published register' : 'Punch time flows into payroll automatically'}</strong>
      <p>{published ? 'These hours are frozen with the published salary.' : 'Attendance supplies worked, OT and late hours. Enter an override only when needed, with a reason.'}</p></div>
      {!published && <button type="button" className={btnClass('ghost', 'sm')} disabled={attendance.isFetching || saving} onClick={() => attendance.refetch()}>Refresh punch hours</button>}
    </div>}
    {!published && attendance.isLoading && <p role="status" className="payroll-input-feedback"><Loader2 size={14} className="animate-spin" />Loading punch-derived hours…</p>}
    {!published && attendance.error && <p role="alert" className="payroll-input-feedback payroll-input-danger">{message(attendance.error)}</p>}
    {!published && attendance.isSuccess && attendanceIssues.length > 0 && <p className="payroll-input-callout">{attendanceIssues.length} employees need attendance or hour-override review. Check each row’s status before calculating payroll.</p>}
    {published && <p className="payroll-input-callout">This month is published. Its inputs are read-only.</p>}
    {(query.isLoading || busyFile) && <p role="status" className="payroll-input-feedback"><Loader2 size={14} className="animate-spin" />{busyFile ? 'Preparing spreadsheet…' : 'Loading employee inputs…'}</p>}
    {(query.error || error) && <p role="alert" className="payroll-input-feedback payroll-input-danger"><AlertTriangle size={14} />{error || message(query.error)}</p>}
    {notice && <p role="status" className="payroll-input-feedback payroll-input-success"><Check size={14} />{notice}</p>}
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
            return { ...row, patch, after, changes: Object.keys(patch).filter(key => row.before[key] !== after[key]), error: rowError(after) };
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
      <div className="payroll-input-groups" role="group" aria-label="Input column groups">{GROUPS.map(label => <button type="button" key={label} aria-pressed={label === group} onClick={() => setGroup(label)}>{label}</button>)}</div>
      <div className="payroll-input-filters">
        <label className="payroll-input-search"><Search size={14} /><input type="search" aria-label="Search payroll employees" placeholder="Search name or employee code" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <select aria-label="Filter payroll branch" value={branch} onChange={event => setBranch(event.target.value)}><option value="">All branches</option>{branches.map(([id, label]) => <option value={id || '__none'} key={id}>{label}</option>)}</select>
        <select aria-label="Filter input status" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All employees</option><option value="changed">Changed rows</option><option value="issues">Needs attention</option><option value="saved">Saved inputs</option><option value="empty">No saved inputs</option></select>
      </div>
    </div>
    <div className="payroll-bulk-bar">
      <span><b>{selectedPeople.length}</b> selected{hiddenSelected > 0 ? ` (${hiddenSelected} outside this filter)` : ''}</span>
      <button type="button" className={btnClass('subtle', 'sm')} disabled={!filtered.length || blocked} onClick={() => setSelected(new Set(filtered.map(person => person.id)))}>Select all {filtered.length} matching</button>
      {selectedPeople.length > 0 && <button type="button" className={btnClass('subtle', 'sm')} onClick={() => setSelected(new Set())}>Clear selection</button>}
      {selectedPeople.length > 0 && <button type="button" className={btnClass('ghost', 'sm')} disabled={blocked || Boolean(preview)} onClick={() => preparePreview(selectedPeople.map(person => ({ employeeId: person.id, patch: { ot_hours: '', late_hours: '' } })), 'Use automatic punch hours')}>Use punch hours</button>}
      {selectedPeople.length > 0 && <div className="payroll-bulk-fields"><select aria-label="Bulk fill field" value={fillField} onChange={event => setFillField(event.target.value)} disabled={blocked || Boolean(preview)}>{ALL_FIELDS.map(field => <option value={field.key} key={field.key}>{field.label}</option>)}</select>
        <input aria-label="Bulk fill value" value={fillValue} inputMode={fillField === 'notes' || isHour(fillField) ? 'text' : 'decimal'} placeholder={fillField === 'notes' ? 'Enter a reason' : isHour(fillField) ? 'Hours or AUTO' : 'Value'} onChange={event => setFillValue(event.target.value)} disabled={blocked || Boolean(preview)} />
        <button type="button" className={btnClass('ghost', 'sm')} disabled={blocked || Boolean(preview) || !selectedPeople.length} onClick={() => preparePreview(selectedPeople.map(person => ({ employeeId: person.id, patch: { [fillField]: fillValue } })), `Bulk fill · ${fieldLabel(fillField)}`)}>Review fill</button></div>}
    </div>
    <details className="payroll-input-tip"><summary>Spreadsheet help · amounts in ₹</summary><p>Tab moves across · Enter moves down · Paste into a cell on the current page. OT / late blank or AUTO = attendance. A number, including 0, overrides attendance and needs a reason. PF / ESI blank = configured component. Imports read the first worksheet. Edits stay when switching views; save before refreshing or signing out.</p></details>
    <div className="payroll-input-table-wrap" ref={tableRef} tabIndex={0} role="region" aria-label="Scrollable monthly input table">
      <table className="payroll-input-table"><caption className="sr-only">Employee monthly inputs for {period}</caption><thead><tr>
        <th className="payroll-input-select"><input type="checkbox" aria-label="Select current page" checked={pager.slice.length > 0 && pager.slice.every(person => selected.has(person.id))} disabled={blocked || !pager.slice.length} onChange={event => setSelected(current => {
          const next = new Set(current); pager.slice.forEach(person => event.target.checked ? next.add(person.id) : next.delete(person.id)); return next;
        })} /></th>
        <th className="payroll-input-employee">Employee / branch</th>
        {group !== 'Earnings' && <><th scope="col">Worked hours<small>FROM PUNCHES</small></th><th scope="col">Recorded OT<small>FROM ATTENDANCE</small></th><th scope="col">Eligible late<small>FULLY PAID DUTY DAYS</small></th></>}
        {columns.map(field => <th scope="col" key={field.key} className={field.key === 'notes' ? 'payroll-input-notes' : ''}>{field.label}<small>{field.group === 'Hours' ? 'HOURS' : field.key === 'notes' ? 'REFERENCE / REASON' : 'INR'}</small></th>)}
        <th scope="col">Status</th>
      </tr></thead><tbody>{pager.slice.map((person, rowIndex) => {
        const draft = currentDraft(person.id), dirty = Boolean(drafts[person.id]), conflict = conflicts.includes(person.id), rowIssue = errors[person.id];
        const time = attendanceFor(person.id);
        const issue = published ? '' : timeIssue(time);
        const canReview = can('attendance.read', { entityId: person.entity_id, zoneId: person.zone_id, branchId: person.branch_id, deptId: person.department_id, employeeId: person.id });
        return <tr key={person.id} className={dirty ? 'payroll-input-dirty' : ''}>
          <td className="payroll-input-select"><input type="checkbox" aria-label={`Select ${person.full_name}`} checked={selected.has(person.id)} disabled={blocked} onChange={() => toggle(person.id)} /></td>
          <th scope="row" className="payroll-input-employee"><strong>{person.full_name}</strong><small>{person.employee_code} · {branchLabel(person)}</small>
            {person.status !== 'Active' && <small>{person.status}</small>}
            {time?.in_payroll_month === false && <small>Outside payroll month</small>}
            {canReview && (group !== 'Earnings' || issue) && <Link className="payroll-punch-link" to={`/attendance/person?employee=${encodeURIComponent(person.id)}&period=${encodeURIComponent(period)}`}>Review / correct punches</Link>}
            {group !== 'Earnings' && !published && <small className="payroll-input-last-punch">Last punch: {punchStamp(time?.last_punch_at)} IST</small>}
          </th>
          {group !== 'Earnings' && <><td className="payroll-punch-metric"><strong>{hours(time?.recorded_worked_hours)}h</strong><small>{published ? 'Published snapshot' : `${time?.attendance_days ?? '—'} / ${time?.expected_days ?? '—'} days calculated`}</small></td>
            <td className="payroll-punch-metric"><strong>{hours(time?.recorded_ot_hours)}h</strong><small>{published ? 'Published snapshot' : 'Calculated from punches'}</small></td>
            <td className="payroll-punch-metric"><strong>{hours(time?.deductible_late_hours)}h</strong><small>All late: {hours(time?.recorded_late_hours)}h</small>{time?.policy_deduct_late === false && <small>Late deduction disabled</small>}</td></>}
          {columns.map((field, columnIndex) => {
            const automatic = isHour(field.key) && String(draft[field.key] ?? '').trim() === '';
            const calculated = published ? time?.[field.key === 'ot_hours' ? 'effective_ot_hours' : 'effective_late_hours'] : autoHours(time, field.key);
            return <td key={field.key} className={`${field.key === 'notes' ? 'payroll-input-notes' : ''} ${dirty && drafts[person.id].base[field.key] !== draft[field.key] ? 'payroll-input-cell-changed' : ''}`}>
            <input type="text" aria-label={`${person.full_name} · ${field.label}`} aria-invalid={Boolean(rowIssue) || undefined} aria-describedby={rowIssue || conflict ? `payroll-issue-${person.id}` : undefined}
              data-row={rowIndex} data-column={columnIndex} inputMode={field.key === 'notes' ? 'text' : 'decimal'} value={automatic ? (calculated == null ? '' : String(calculated)) : draft[field.key]} readOnly={automatic}
              placeholder={automatic ? time?.in_payroll_month === false ? 'Not applicable' : 'Awaiting punches' : field.nullable ? 'Default' : field.key === 'notes' ? 'Add a note…' : '0.00'} disabled={blocked || Boolean(preview) || (isHour(field.key) && time?.in_payroll_month === false)}
              onChange={event => stage([{ employeeId: person.id, patch: { [field.key]: isHour(field.key) && event.target.value.trim().toUpperCase() === 'AUTO' ? '' : event.target.value } }])}
              onFocus={event => { if (field.key !== 'notes') event.target.select(); }}
              onKeyDown={event => move(event, rowIndex, columnIndex)} onPaste={event => paste(event, rowIndex, columnIndex)} />
            {isHour(field.key) && <div className="payroll-hour-mode"><span>{automatic ? 'Auto · attendance' : 'HR override'}</span>
              {!published && <button type="button" aria-label={`${person.full_name} · ${automatic ? 'Override' : 'Use automatic'} ${field.label}`} disabled={blocked || Boolean(preview) || (automatic && calculated == null)} onClick={() => stage([{ employeeId: person.id, patch: { [field.key]: automatic ? String(calculated) : '' } }])}>{automatic ? 'Edit' : 'Use auto'}</button>}
            </div>}
            {conflict && <small className="payroll-input-latest">Saved: {cellText(monthlyInputDraft(records.get(person.id))[field.key], field.key)}</small>}
          </td>; })}
          <td className="payroll-input-row-status"><span className={conflict || rowIssue || issue ? 'payroll-input-danger' : dirty ? 'payroll-input-unsaved' : 'payroll-input-muted'}>{conflict ? 'Changed elsewhere' : rowIssue || issue ? 'Needs attention' : dirty ? 'Unsaved' : records.has(person.id) ? 'Saved' : 'No inputs'}</span>
            {(rowIssue || conflict || issue) && <p id={`payroll-issue-${person.id}`}>{conflict ? 'Compare saved values, then reload this row.' : rowIssue || issue}</p>}
            {dirty && <button type="button" disabled={saving || Boolean(preview)} onClick={() => setDiscard(person.id)}>{conflict ? 'Reload row' : 'Undo row'}</button>}
          </td>
        </tr>;
      })}</tbody></table>
      {!filtered.length && !query.isLoading && <p className="payroll-input-empty">{employees.length ? 'No employees match these filters.' : 'No employees are available in your payroll scope.'}</p>}
    </div>
    <Pagination {...pager} sizes={[25, 50, 100]} noun="employees" keepVisible disabled={saving} />
    <div className="payroll-input-savebar">
      <div><strong>{dirtyIds.length ? `${dirtyIds.length} employee rows with unsaved changes` : query.isLoading ? 'Loading saved inputs…' : query.error ? 'Saved inputs unavailable' : 'No unsaved changes'}</strong><p>{errorCount ? `Fix ${errorCount} rows before saving.` : 'Save includes changed rows across every page and filter. Recalculate payroll after saving.'}</p></div>
      <div className="payroll-input-actions"><button type="button" className={btnClass('ghost')} disabled={!dirtyIds.length || saving} onClick={() => { setStatus('changed'); setSearch(''); setBranch(''); }}>Review changes</button>
        <button type="button" className={btnClass('ghost')} disabled={!dirtyIds.length || saving || Boolean(preview)} onClick={() => setDiscard('all')}>Discard</button>
        <button type="button" className={btnClass(dirtyIds.length ? 'primary' : 'ghost')} disabled={blocked || !dirtyIds.length || Boolean(errorCount || conflicts.length || preview)} onClick={saveAll}>{saving && <Loader2 size={14} className="animate-spin" />}Save {dirtyIds.length ? `${dirtyIds.length} changes` : 'changes'}</button>
        {onContinue && <button type="button" className={btnClass('primary')} disabled={continueDisabled || saving || busyFile || dirtyIds.length > 0 || Boolean(preview)}
          onClick={() => { if (!continueDisabled && !saving && !busyFile && !writeInFlight.current && !dirtyIds.length && !preview) onContinue(); }}>Continue to review<ArrowRight size={14} /></button>}</div>
    </div>
    {discard && <ConfirmDialog title={discard === 'all' ? 'Discard all unsaved inputs?' : 'Reload this employee’s saved inputs?'} confirmLabel={discard === 'all' ? 'Discard changes' : 'Reload row'} onCancel={() => setDiscard(null)} onConfirm={() => {
      setDrafts(current => { if (discard === 'all') return {}; const next = { ...current }; delete next[discard]; return next; }); setDiscard(null); setError('');
    }}><p>{discard === 'all' ? `${dirtyIds.length} employee rows` : people.get(discard)?.full_name} will return to the latest saved values.</p></ConfirmDialog>}
  </section>}</PayrollSheetFrame>;
}
