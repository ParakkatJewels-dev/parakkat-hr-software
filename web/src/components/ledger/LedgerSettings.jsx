// Settings: what is in this ledger, export everything, bring the old Google Sheet across, and the
// switch-over check that compares our report text with the old app's.
import React, { useState } from 'react';
import { Download, FileUp, Lock, Unlock } from 'lucide-react';
import { fetchLedgerExport, fetchLedgerReport, previewLedgerImport, runLedgerImport, useLedgerImportLock, useRefreshLedger } from '../../data/workLedger';
import { downloadCsv } from '../../lib/csv';
import { istToday } from '../../lib/dates';
import { humanDbError } from '../../lib/dbErrors';
import { exportTable } from '../../lib/ledger/exportCsv.js';
import { IMPORT_ORDER, parseLedgerSheets, sheetsFromWorkbook } from '../../lib/ledger/importWorkbook.js';
import { buildShareText } from '../../lib/ledger/shareText.js';
import { diffReports } from '../../lib/ledger/compare.js';
import { addDays, periodArgument } from '../../lib/ledger/periods.js';

const COUNT_LABELS = [['tasks', 'tasks'], ['support', 'help entries'], ['progress', 'progress notes'], ['subtasks', 'subtasks'],
  ['deliverables', 'deliverables'], ['campaigns', 'campaigns'], ['ideas', 'ideas'], ['vendors', 'vendors'], ['templates', 'templates'],
  ['key_dates', 'key dates'], ['reminders', 'reminders']];
const KIND_LABELS = { tasks: 'Tasks (WorkLog)', subtasks: 'Subtasks', deliverables: 'Deliverables', progress: 'Progress', campaigns: 'Campaigns',
  ideas: 'Ideas', key_dates: 'Key dates', vendors: 'Vendors', templates: 'Templates', brands: 'Brand foundations', reminders: 'Reminders', links: 'Links' };

export default function LedgerSettings({ boot, loading }) {
  const counts = boot?.counts ?? {};
  return (
    <div className="ledger-settings">
      <section className="ledger-section">
        <h3>In this ledger</h3>
        {loading ? <p className="ledger-quiet">Opening…</p> : (
          <p className="ledger-counts">{COUNT_LABELS.filter(([key]) => counts[key] != null).map(([key, label]) => (
            <span key={key}><strong>{counts[key]}</strong> {label}</span>))}</p>
        )}
      </section>
      <ExportSection />
      <ImportSection locked={Boolean(boot?.settings?.import_locked_at)} />
      <CompareSection />
    </div>
  );
}

function ExportSection() {
  const [state, setState] = useState('');
  const run = async () => {
    setState('Preparing…');
    try {
      const table = exportTable(await fetchLedgerExport());
      downloadCsv(`work-ledger-${istToday()}.csv`, table.headers, table.rows);
      setState(`Downloaded ${table.rows.length} tasks.`);
    } catch (error) { setState(humanDbError(error) || 'The export failed. Try again.'); }
  };
  return (
    <section className="ledger-section">
      <h3>Export everything</h3>
      <p>Every task with all 33 original columns, as a CSV file. Keep it as a backup.</p>
      <button type="button" className="ledger-button" onClick={run}><Download size={15} /> Export everything as CSV</button>
      {state && <p className="ledger-quiet" role="status">{state}</p>}
    </section>
  );
}

function ImportSection({ locked }) {
  const refresh = useRefreshLedger();
  const lock = useLedgerImportLock();
  const [dateOrder, setDateOrder] = useState('DMY');
  const [files, setFiles] = useState([]);
  const [parsed, setParsed] = useState(null);
  const [preview, setPreview] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const hasCsv = files.some((file) => /\.csv$/i.test(file.name));

  const read = async (chosen = files, order = dateOrder) => {
    setError(''); setParsed(null); setPreview(null); setResult(null);
    if (!chosen.length) return;
    try {
      const XLSX = await import('xlsx');
      const sheets = {};
      for (const file of chosen) {
        const buffer = await file.arrayBuffer();
        if (/\.csv$/i.test(file.name)) {
          // A CSV is one tab; its file name says which ("Work Ledger - Subtasks.csv").
          const book = XLSX.read(new TextDecoder().decode(buffer), { type: 'string', raw: true });
          sheets[file.name] = sheetsFromWorkbook(XLSX, book)[book.SheetNames[0]];
        } else {
          Object.assign(sheets, sheetsFromWorkbook(XLSX, XLSX.read(buffer, { type: 'array' })));
        }
      }
      setParsed(parseLedgerSheets(sheets, { dateOrder: order }));
    } catch { setError('That file could not be read. Download the Sheet again as Microsoft Excel (.xlsx) and choose it here.'); }
  };
  const check = async () => {
    setError('');
    try {
      const entries = await Promise.all(IMPORT_ORDER.filter((kind) => kind !== 'links' && parsed.kinds[kind]?.length).map(async (kind) =>
        [kind, await previewLedgerImport(kind, parsed.kinds[kind].map((row) => row.legacy_row))]));
      setPreview(Object.fromEntries(entries));
    } catch (failure) { setError(humanDbError(failure) || 'The check failed. Try again.'); }
  };
  const run = async () => {
    setError(''); setResult(null); setProgress({ sent: 0, total: 1 });
    try {
      setResult(await runLedgerImport(parsed.kinds, { onProgress: setProgress }));
      refresh();
    } catch (failure) {
      setError(`${humanDbError(failure) || 'The import stopped.'} Rows already saved stay saved; run the import again to continue.`);
    } finally { setProgress(null); }
  };
  const total = parsed ? IMPORT_ORDER.filter((kind) => kind !== 'links').reduce((sum, kind) => sum + (parsed.kinds[kind]?.length ?? 0), 0) : 0;

  return (
    <section className="ledger-section">
      <h3>Bring over the Google Sheet</h3>
      <p>In Google Sheets choose <em>File → Download → Microsoft Excel (.xlsx)</em> and pick that file. CSV files of single tabs work too.
        Importing again later updates the same rows; anything you have changed here since is left alone and listed.</p>
      {locked ? (
        <p className="ledger-note"><Lock size={14} /> Import is locked for this ledger.
          <button type="button" className="ledger-link" onClick={() => lock.mutate(false)} disabled={lock.isPending}>Unlock</button></p>
      ) : <>
        <div className="ledger-pickers">
          <label className="ledger-file"><FileUp size={15} /> Choose file
            <input type="file" accept=".xlsx,.csv" multiple onChange={(e) => { const chosen = [...e.target.files]; setFiles(chosen); read(chosen); }} /></label>
          {hasCsv && <label>Dates in the CSV are
            <select value={dateOrder} onChange={(e) => { setDateOrder(e.target.value); read(files, e.target.value); }}>
              <option value="DMY">day first (07/10/2026)</option><option value="MDY">month first (10/07/2026)</option>
            </select></label>}
        </div>
        {files.length > 0 && <p className="ledger-quiet">{files.map((file) => file.name).join(', ')}</p>}
      </>}
      {error && <p className="ledger-alert" role="alert">{error}</p>}
      {parsed && !locked && (
        <div className="ledger-import-summary">
          <table className="ledger-table">
            <thead><tr><th scope="col">Tab</th><th scope="col">Rows</th><th scope="col">Skipped (deleted)</th>{preview && <th scope="col">Already here</th>}</tr></thead>
            <tbody>{IMPORT_ORDER.filter((kind) => parsed.stats[kind]).map((kind) => (
              <tr key={kind}><td>{KIND_LABELS[kind]}</td><td>{parsed.stats[kind].rows}</td><td>{parsed.stats[kind].skipped}</td>
                {preview && <td>{preview[kind]?.existing ?? 0}{preview[kind]?.edited_rows?.length ? ` · ${preview[kind].edited_rows.length} edited here` : ''}</td>}</tr>
            ))}</tbody>
          </table>
          <ul className="ledger-findings">
            {parsed.legacy_statuses > 0 && <li>{parsed.legacy_statuses} old status values (Done, Completed, Pending…) will be read as Delivered or Brief.</li>}
            {parsed.campaigns_created_from_tasks > 0 && <li>{parsed.campaigns_created_from_tasks} campaigns named only on tasks will be created at Captured.</li>}
            {[...parsed.problems, ...parsed.warnings].slice(0, 12).map((line, index) => <li key={index}>{line}</li>)}
            {parsed.problems.length + parsed.warnings.length > 12 && <li>…and {parsed.problems.length + parsed.warnings.length - 12} more.</li>}
          </ul>
          <div className="ledger-actions">
            <button type="button" className="ledger-button" onClick={check} disabled={Boolean(progress)}>Check against this ledger</button>
            <button type="button" className="ledger-button ledger-button-primary" onClick={run} disabled={Boolean(progress) || !total}>Import {total} rows</button>
          </div>
          {progress && <p className="ledger-quiet" role="status"><progress value={progress.sent} max={progress.total} /> {progress.sent} of {progress.total} rows…</p>}
        </div>
      )}
      {result && (
        <div className="ledger-import-result" role="status">
          <p><strong>Import finished.</strong></p>
          <ul className="ledger-findings">{Object.entries(result).filter(([kind]) => kind !== 'links').map(([kind, r]) => (
            <li key={kind}>{KIND_LABELS[kind]}: {r.inserted} added, {r.updated} updated{r.skipped.length ? `, ${r.skipped.length} left alone (edited here or incomplete)` : ''}
              {r.unresolved.length ? `, ${r.unresolved.length} pointing at missing tasks` : ''}</li>
          ))}</ul>
          <button type="button" className="ledger-button" onClick={() => lock.mutate(true)} disabled={lock.isPending}><Lock size={15} /> Lock import after switch-over</button>
        </div>
      )}
      {!locked && !parsed && <p className="ledger-quiet"><Unlock size={13} /> Import is open.</p>}
    </section>
  );
}

function CompareSection() {
  const today = istToday();
  const [period, setPeriod] = useState('day');
  const [day, setDay] = useState(today);
  const [oldText, setOldText] = useState('');
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');
  const compare = async () => {
    setError(''); setDiff(null);
    try {
      const date = periodArgument(period, { day, month: day.slice(0, 7), from: addDays(day, -6), to: day });
      setDiff(diffReports(oldText, buildShareText(await fetchLedgerReport({ period, date }))));
    } catch (failure) { setError(humanDbError(failure) || 'The report could not be built.'); }
  };
  const differences = diff?.filter((entry) => entry.type !== 'same').length ?? 0;
  return (
    <section className="ledger-section">
      <h3>Compare with the old app</h3>
      <p>Paste a report from the old ledger, choose the same period, and see every line that differs.</p>
      <div className="ledger-pickers">
        <label>Period <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="all">Overall to date</option>
        </select></label>
        {period !== 'all' && <label>{period === 'day' ? 'Day' : period === 'week' ? 'Any day in the week' : 'Any day in the month'}
          <input type="date" value={day} onChange={(e) => setDay(e.target.value || today)} /></label>}
      </div>
      <label className="sr-only" htmlFor="ledger-old-report">Old report text</label>
      <textarea id="ledger-old-report" className="ledger-draft ledger-draft-short" placeholder="*Parakkat Work — Daily Report*…" value={oldText} onChange={(e) => setOldText(e.target.value)} />
      <button type="button" className="ledger-button" onClick={compare} disabled={!oldText.trim()}>Compare</button>
      {error && <p className="ledger-alert" role="alert">{error}</p>}
      {diff && (differences === 0
        ? <p className="ledger-note" role="status">The reports match line for line.</p>
        : <div role="status"><p className="ledger-note">{differences} line{differences === 1 ? '' : 's'} differ. Lines marked − are only in the old report; + only in ours.</p>
          <pre className="ledger-diff">{diff.map((entry, index) => (
            <span key={index} data-type={entry.type}>{entry.type === 'old' ? '− ' : entry.type === 'new' ? '+ ' : '  '}{entry.line}{'\n'}</span>
          ))}</pre></div>)}
    </section>
  );
}
