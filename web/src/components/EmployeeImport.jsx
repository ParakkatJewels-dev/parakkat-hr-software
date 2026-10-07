// Bulk employee import from a spreadsheet.
//
// Adding 242 people one form at a time is not a serious proposition, and the roster already
// exists in Excel. Three steps, and nothing is written until the third:
//
//   1. pick a file        — the parser is loaded on demand, not in the main bundle
//   2. check the preview  — which company, what will be created, what will be skipped and why
//   3. import             — each employee and initial shift saved together, with progress
//
// The preview is the point. A bulk write into a live HR database should never be a surprise.
import React, { useState, useCallback, useMemo } from 'react';
import { Upload, FileSpreadsheet, AlertTriangle, Check, Loader2, X, ArrowLeft } from 'lucide-react';
import { useVisibleOrg } from '../data/org';
import { useEmployees } from '../data/employees';
import { useShifts } from '../data/shifts';
import { usePermissions } from '../auth/usePermissions';
import { useQueryClient } from '@tanstack/react-query';
import { detectLayout, extractPeople, planImport, runImport } from '../data/employeeImport';
import PageHeader from './ui/PageHeader';
import PagedCollection from './ui/PagedCollection';

const STATUS_STYLE = {
  new: 'text-brand-ink dark:text-brand-ink',
  update: 'text-blue-600 dark:text-blue-400',
  skip: 'text-neutral-400',
  duplicate: 'text-amber-600 dark:text-amber-400',
};

export default function EmployeeImport({ onDone }) {
  const { data: org, isLoading: orgLoading, error: orgError } = useVisibleOrg();
  const { data: employees = [], isLoading: employeesLoading, error: employeesError } = useEmployees();
  const shiftsQuery = useShifts();
  const { canAny, isSuperAdmin } = usePermissions();
  // Creating branches/designations mid-import needs org.manage; see runImport.
  const canCreateOrg = canAny('org.manage');
  const qc = useQueryClient();

  const [file, setFile] = useState(null);
  const [rawRows, setRawRows] = useState(null);
  const [entityId, setEntityId] = useState('');
  const [defaultShiftId, setDefaultShiftId] = useState('');
  const [defaultJoinDate, setDefaultJoinDate] = useState('');
  const [parseError, setParseError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const entities = org?.entities ?? [];
  const availableShifts = (shiftsQuery.data ?? []).filter(shift => shift.is_active && (!shift.entity_id || shift.entity_id === entityId));
  const canImport = isSuperAdmin || canAny('employee.create');

  // The parser is ~400KB. Load it only when somebody actually picks a file.
  const readFile = useCallback(async (f) => {
    setParseError(''); setResult(null);
    try {
      const { readEmployeeSheet } = await import('../lib/employeeSpreadsheet');
      const buf = await f.arrayBuffer();
      // header:1 gives raw arrays, which is what the layout sniffer needs — these files have
      // banner rows above the header, so letting the library guess field names does not work.
      const rows = readEmployeeSheet(buf);
      const detected = detectLayout(rows);
      // Validate while errors can still be shown beside the upload control. Letting invalid
      // calendar values reach the render-time preview would take down the entire app boundary.
      if (detected?.usable) extractPeople(rows, detected);
      setRawRows(rows); setFile(f);
    } catch (e) {
      setParseError(e.message || 'Could not read that file.');
      setRawRows(null); setFile(null);
    }
  }, []);

  const layout = useMemo(() => (rawRows ? detectLayout(rawRows) : null), [rawRows]);
  const people = useMemo(
    () => (rawRows && layout?.usable ? extractPeople(rawRows, layout) : []),
    [rawRows, layout]
  );

  const plan = useMemo(() => {
    if (!people.length || !entityId) return null;
    const mine = employees.filter((e) => e.entity_id === entityId);
    return planImport(people, {
      existingByName: new Map(mine.map((e) => [(e.full_name || '').toLowerCase(), e])),
      existingByCode: new Map(mine.filter((e) => e.employee_code).map((e) => [e.employee_code.toLowerCase(), e])),
      branches: new Set((org?.branches ?? []).filter((b) => b.entity_id === entityId).map((b) => b.code.toUpperCase())),
      designations: new Set((org?.designations ?? []).filter((d) => d.entity_id === entityId).map((d) => (d.title || '').toUpperCase())),
      entityId, shifts: shiftsQuery.data ?? [], defaultShiftId, defaultJoinDate,
    });
  }, [people, entityId, employees, org, shiftsQuery.data, defaultShiftId, defaultJoinDate]);

  const entity = entities.find((e) => e.id === entityId);
  const previewKey = useMemo(() => ({ rawRows, entityId }), [rawRows, entityId]);
  const setupError = orgError || employeesError || (plan?.counts.create ? shiftsQuery.error : null);
  const setupLoading = orgLoading || employeesLoading || Boolean(plan?.counts.create && shiftsQuery.isLoading);

  const doImport = async () => {
    if (!plan || !entity || busy || plan.counts.invalid || setupError || setupLoading) return;
    setBusy(true); setProgress({ done: 0, total: plan.counts.create + plan.counts.update });
    try {
      const res = await runImport({
        entityId: entity.id,
        entityCode: entity.code,
        rows: plan.rows,
        onProgress: (done, total) => setProgress({ done, total }),
        createOrg: canCreateOrg,
      });
      setResult({ ok: true, ...res });
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      qc.invalidateQueries({ queryKey: ['shift-assignments'] });
    } catch (e) {
      setResult({ ok: false, message: e.message });
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['shift-assignments'] });
    } finally {
      setBusy(false); setProgress(null);
    }
  };

  const reset = () => {
    setFile(null); setRawRows(null); setResult(null); setParseError(''); setProgress(null);
  };

  if (!canImport) {
    return (
      <div className="page-shell">
        <div className="premium-card p-8 text-center text-sm text-neutral-500">
          You do not have permission to add employees.
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell people-page space-y-5 animate-fade-in">
      <PageHeader
        eyebrow="People"
        icon={Upload}
        title="Import employees"
        subtitle="Load a roster from Excel or CSV. Nothing is saved until you review it."
        actions={
          onDone && (
            <button onClick={onDone} className="people-action-button people-action-button-secondary">
              <ArrowLeft size={13} /> Back to directory
            </button>
          )
        }
      />

      {/* ---- step 1: the file ---------------------------------------------------------- */}
      {!file && (
        <label className="premium-card import-dropzone">
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
          />
          <span className="import-dropzone-icon"><FileSpreadsheet size={24} /></span>
          <p>
            Choose a spreadsheet
          </p>
          <small>
            .xlsx, .xls or .csv. It needs a column of employee names; Designation, Branch, Code,
            Email, Phone, Join date and Shift are picked up automatically if they are there.
          </small>
        </label>
      )}

      {parseError && (
        <p role="alert" className="premium-card flex items-start gap-2 text-sm text-rose-600 dark:text-rose-300">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {parseError}
        </p>
      )}

      {/* ---- step 2: what we found ----------------------------------------------------- */}
      {file && !result && (
        <>
          <div className="premium-card import-file-card">
            <span className="import-file-icon"><FileSpreadsheet size={16} /></span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-neutral-900 dark:text-white truncate">{file.name}</p>
              <p className="text-xs text-neutral-500">
                {layout?.usable
                  ? `Header found on row ${layout.headerRow + 1} · ${people.length} people`
                  : 'No column of employee names found'}
              </p>
            </div>
            <button onClick={reset} className="people-action-button people-action-button-secondary">
              <X size={13} /> Choose another
            </button>
          </div>

          {!layout?.usable ? (
            <p className="premium-card text-sm text-amber-700 dark:text-amber-300">
              This sheet has no column called <b>Employee Name</b> (or Name / Staff Name), so there is
              nothing to import. The columns found were: {layout?.headers.filter(Boolean).join(', ') || '(none)'}.
            </p>
          ) : (
            <>
              <div className="premium-card import-mapping-card space-y-3">
                <div>
                  <label htmlFor="imp-entity" className="block text-2xs font-bold uppercase tracking-wider text-neutral-450 mb-1">
                    Import into which company? *
                  </label>
                  <select
                    id="imp-entity"
                    value={entityId}
                    disabled={busy}
                    onChange={(e) => { setEntityId(e.target.value); setDefaultShiftId(''); }}
                    className="w-full sm:max-w-sm text-sm rounded-lg px-2.5 py-2 bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800 cursor-pointer focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  >
                    <option value="">Select…</option>
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>{e.code} — {e.name}</option>
                    ))}
                  </select>
                </div>

                {plan?.counts.create > 0 && <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300" htmlFor="imp-shift">
                    Shift for rows without a shift
                    <select id="imp-shift" value={defaultShiftId} onChange={event => setDefaultShiftId(event.target.value)}
                      disabled={shiftsQuery.isLoading || Boolean(shiftsQuery.error)}
                      className="mt-1 w-full rounded-lg px-2.5 py-2 text-sm bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800">
                      <option value="">Select a shift…</option>
                      {availableShifts.map(shift => <option key={shift.id} value={shift.id}>
                        {shift.code} — {shift.name} · {shift.start_time?.slice(0, 5)}–{shift.end_time?.slice(0, 5)}{shift.crosses_midnight ? ' next day' : ''} · {Math.floor(shift.full_day_minutes / 60)}h {shift.full_day_minutes % 60}m paid
                      </option>)}
                    </select>
                  </label>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300" htmlFor="imp-join-date">
                    Join date for rows without a date
                    <input id="imp-join-date" type="date" value={defaultJoinDate} onChange={event => setDefaultJoinDate(event.target.value)}
                      className="mt-1 w-full rounded-lg px-2.5 py-2 text-sm bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800" />
                  </label>
                  <p className="sm:col-span-2 text-xs text-neutral-500">
                    Each new employee starts the selected shift on their join date. A Shift code or name and Join date in the sheet take priority. Existing employees keep their current shift.
                  </p>
                  {!shiftsQuery.isLoading && !shiftsQuery.error && availableShifts.length === 0 &&
                    <p role="alert" className="sm:col-span-2 text-xs text-rose-600">This company has no active shifts. Configure a shift before adding employees.</p>}
                </fieldset>}

                {setupError && <p role="alert" className="text-xs text-rose-600">Could not load import setup: {setupError.message}. Reload before importing.</p>}
                {plan?.counts.invalid > 0 && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
                  Complete the shift and join date for {plan.counts.invalid} new employee{plan.counts.invalid === 1 ? '' : 's'} before importing. Review the marked rows below.
                </p>}

                {/* Which columns were recognised — so a mis-detected sheet is obvious before writing. */}
                <div className="import-column-chips">
                  {Object.entries(layout.columns).map(([field, i]) => (
                    <span key={field}>
                      {field.replace('_', ' ')} ← “{layout.headers[i] || `column ${i + 1}`}”
                    </span>
                  ))}
                </div>
              </div>

              {plan && (
                <>
                  {/* Said before the run, not discovered during it: the run used to attempt these
                      inserts regardless and die midway on the RLS refusal, updates already
                      written. Now it skips them — and the skip is announced here. */}
                  {!canCreateOrg && (plan.counts.newBranches > 0 || plan.counts.newDesignations > 0) && (
                    <div className="premium-card border-amber-300 dark:border-amber-900/60" role="alert">
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        This sheet names {[
                          plan.counts.newBranches ? `${plan.counts.newBranches} branch${plan.counts.newBranches === 1 ? '' : 'es'}` : null,
                          plan.counts.newDesignations ? `${plan.counts.newDesignations} designation${plan.counts.newDesignations === 1 ? '' : 's'}` : null,
                        ].filter(Boolean).join(' and ')} this company does not have yet, and creating
                        those needs organisation permission you do not hold. Everyone will still be
                        imported — the people concerned just arrive without that placement, ready to
                        be placed once an admin adds it in Organization.
                      </p>
                    </div>
                  )}
                  <div className="premium-card import-plan-card">
                    {[
                      ['Will be created', plan.counts.create, 'text-brand-ink dark:text-brand-ink'],
                      ['Will be filled in', plan.counts.update, 'text-blue-600 dark:text-blue-400'],
                      ['Nothing to change', plan.counts.skip, 'text-neutral-400'],
                      ['Duplicate in file', plan.counts.duplicate, 'text-amber-600 dark:text-amber-400'],
                      ['New branches', plan.counts.newBranches, 'text-neutral-600 dark:text-neutral-300'],
                      ['New designations', plan.counts.newDesignations, 'text-neutral-600 dark:text-neutral-300'],
                    ].map(([label, n, cls]) => (
                      <div key={label} className="import-plan-stat">
                        <p className={cls}>{n}</p>
                        <span>{label}</span>
                      </div>
                    ))}
                    <button
                      onClick={doImport}
                      disabled={busy || setupLoading || Boolean(setupError) || plan.counts.invalid > 0 || (plan.counts.create === 0 && plan.counts.update === 0)}
                      className="people-action-button people-action-button-primary"
                    >
                      {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                      {busy && progress
                        ? `Working ${progress.done}/${progress.total}…`
                        : plan.counts.create && plan.counts.update
                        ? `Add ${plan.counts.create}, update ${plan.counts.update}`
                        : plan.counts.create
                        ? `Import ${plan.counts.create} people`
                        : `Update ${plan.counts.update} people`}
                    </button>
                  </div>

                  <ImportPreview rows={plan.rows} resetKey={previewKey} busy={busy} />
                </>
              )}
            </>
          )}
        </>
      )}

      {/* ---- step 3: the outcome ------------------------------------------------------- */}
      {result && (
        <div className="premium-card import-result-card">
          {result.ok ? (
            <>
              <p className="flex items-center gap-2 text-md font-bold text-neutral-900 dark:text-white">
                <Check size={16} className="text-brand-ink" />
                {result.created > 0 && `Added ${result.created} people`}
                {result.created > 0 && result.updated > 0 && ' · '}
                {result.updated > 0 && `Filled in ${result.updated} existing`}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {result.branches > 0 && `${result.branches} new branches. `}
                {result.designations > 0 && `${result.designations} new designations. `}
                {result.created > 0 && 'Every new employee has their initial shift assigned from their join date. '}
                Employee codes were generated where the sheet had none — if the punching terminals
                use different numbers, set those in Time &amp; Attendance → Setup so attendance links up.
              </p>
            </>
          ) : (
            <p className="flex items-start gap-2 text-sm text-rose-600 dark:text-rose-300">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {result.message}
            </p>
          )}
          <div className="people-form-actions mt-3">
            <button onClick={reset} className="people-action-button people-action-button-secondary">Import another file</button>
            {onDone && <button onClick={onDone} className="people-action-button people-action-button-primary">Go to the directory</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// Paging affects the review only; doImport always submits the complete plan.
export function ImportPreview({ rows, resetKey, busy }) {
  return (
    <PagedCollection items={rows} pageSize={25} noun="import rows" resetKey={resetKey} disabled={busy}>
      {(pageRows) => <div className="premium-card import-preview-card p-0 overflow-hidden">
        <div className="table-scroll">
          <table className="premium-table">
            <thead>
              <tr>
                <th className="w-16">Row</th>
                <th>Name</th>
                <th className="hidden sm:table-cell">Designation</th>
                <th className="hidden md:table-cell">Branch</th>
                <th>Initial shift / start date</th>
                <th className="w-44">Status</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={`${r._row}-${r.full_name}`}>
                  <td data-label="Row" className="text-2xs font-mono text-neutral-400">{r._row}</td>
                  <td data-label="Name" className="font-semibold text-neutral-900 dark:text-white">{r.full_name}</td>
                  <td data-label="Designation" className="hidden sm:table-cell text-neutral-500">
                    {r.designation || '—'}
                    {r.newDesignation && <span className="ml-1.5 text-2xs text-brand-ink">new</span>}
                  </td>
                  <td data-label="Branch" className="hidden md:table-cell text-neutral-500">
                    {r.branch || '—'}
                    {r.newBranch && <span className="ml-1.5 text-2xs text-brand-ink">new</span>}
                  </td>
                  <td data-label="Initial shift / start date" className="text-xs text-neutral-500">
                    {r.status === 'new' ? <>{r.initialShiftLabel || 'Shift required'}<br />{r.resolvedJoinDate || 'Join date required'}</> : r.status === 'duplicate' ? 'Skipped duplicate' : 'Current shift retained'}
                  </td>
                  <td data-label="Status" className={`text-xs font-semibold ${r.setupIssue ? 'text-rose-600' : STATUS_STYLE[r.status]}`}>
                    {r.setupIssue || (r.status === 'new' ? 'Will be created' : r.note)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>}
    </PagedCollection>
  );
}
