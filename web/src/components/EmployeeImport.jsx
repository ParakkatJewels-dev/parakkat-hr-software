// Bulk employee import from a spreadsheet.
//
// Adding 242 people one form at a time is not a serious proposition, and the roster already
// exists in Excel. Three steps, and nothing is written until the third:
//
//   1. pick a file        — the parser is loaded on demand, not in the main bundle
//   2. check the preview  — which company, what will be created, what will be skipped and why
//   3. import             — chunked, with progress
//
// The preview is the point. A bulk write into a live HR database should never be a surprise.
import React, { useState, useCallback, useMemo } from 'react';
import { Upload, FileSpreadsheet, AlertTriangle, Check, Loader2, X, ArrowLeft } from 'lucide-react';
import { useVisibleOrg } from '../data/org';
import { useEmployees } from '../data/employees';
import { usePermissions } from '../auth/usePermissions';
import { useQueryClient } from '@tanstack/react-query';
import { detectLayout, extractPeople, planImport, runImport } from '../data/employeeImport';
import PageHeader from './ui/PageHeader';

const STATUS_STYLE = {
  new: 'text-[#0c9765] dark:text-[#10b981]',
  update: 'text-blue-600 dark:text-blue-400',
  skip: 'text-neutral-400',
  duplicate: 'text-amber-600 dark:text-amber-400',
};

export default function EmployeeImport({ onDone }) {
  const { data: org } = useVisibleOrg();
  const { data: employees = [] } = useEmployees();
  const { canAny, isSuperAdmin } = usePermissions();
  // Creating branches/designations mid-import needs org.manage; see runImport.
  const canCreateOrg = canAny('org.manage');
  const qc = useQueryClient();

  const [file, setFile] = useState(null);
  const [rawRows, setRawRows] = useState(null);
  const [entityId, setEntityId] = useState('');
  const [parseError, setParseError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const entities = org?.entities ?? [];
  const canImport = isSuperAdmin || canAny('employee.create');

  // The parser is ~400KB. Load it only when somebody actually picks a file.
  const readFile = useCallback(async (f) => {
    setParseError(''); setResult(null);
    try {
      const XLSX = await import('xlsx');
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      // header:1 gives raw arrays, which is what the layout sniffer needs — these files have
      // banner rows above the header, so letting the library guess field names does not work.
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
      if (!rows.length) throw new Error('That sheet is empty.');
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
    });
  }, [people, entityId, employees, org]);

  const entity = entities.find((e) => e.id === entityId);

  const doImport = async () => {
    if (!plan || !entity) return;
    setBusy(true); setProgress({ done: 0, total: plan.counts.create });
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
    } catch (e) {
      setResult({ ok: false, message: e.message });
      qc.invalidateQueries({ queryKey: ['employees'] });
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
            Email, Phone and Join date are picked up automatically if they are there.
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
                    onChange={(e) => setEntityId(e.target.value)}
                    className="w-full sm:max-w-sm text-sm rounded-lg px-2.5 py-2 bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800 cursor-pointer focus:outline-none focus:border-[#0ea971] focus:ring-2 focus:ring-[#0ea971]/20"
                  >
                    <option value="">Select…</option>
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>{e.code} — {e.name}</option>
                    ))}
                  </select>
                </div>

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
                      ['Will be created', plan.counts.create, 'text-[#0c9765] dark:text-[#10b981]'],
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
                      disabled={busy || (plan.counts.create === 0 && plan.counts.update === 0)}
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

                  <div className="premium-card import-preview-card p-0 overflow-hidden">
                    <div className="table-scroll">
                      <table className="premium-table">
                        <thead>
                          <tr>
                            <th className="w-16">Row</th>
                            <th>Name</th>
                            <th className="hidden sm:table-cell">Designation</th>
                            <th className="hidden md:table-cell">Branch</th>
                            <th className="w-44">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.rows.map((r) => (
                            <tr key={`${r._row}-${r.full_name}`}>
                              <td data-label="Row" className="text-2xs font-mono text-neutral-400">{r._row}</td>
                              <td data-label="Name" className="font-semibold text-neutral-900 dark:text-white">{r.full_name}</td>
                              <td data-label="Designation" className="hidden sm:table-cell text-neutral-500">
                                {r.designation || '—'}
                                {r.newDesignation && <span className="ml-1.5 text-2xs text-[#0ea971]">new</span>}
                              </td>
                              <td data-label="Branch" className="hidden md:table-cell text-neutral-500">
                                {r.branch || '—'}
                                {r.newBranch && <span className="ml-1.5 text-2xs text-[#0ea971]">new</span>}
                              </td>
                              <td data-label="Status" className={`text-xs font-semibold ${STATUS_STYLE[r.status]}`}>
                                {r.status === 'new' ? 'Will be created' : r.note}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
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
                <Check size={16} className="text-[#0ea971]" />
                {result.created > 0 && `Added ${result.created} people`}
                {result.created > 0 && result.updated > 0 && ' · '}
                {result.updated > 0 && `Filled in ${result.updated} existing`}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {result.branches > 0 && `${result.branches} new branches. `}
                {result.designations > 0 && `${result.designations} new designations. `}
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
