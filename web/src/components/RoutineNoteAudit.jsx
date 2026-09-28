import { useMemo, useState } from 'react';
import { useRoutineNoteAudit } from '../data/routines';
import { humanDbError } from '../lib/dbErrors';
import { RoutineNoteEntry } from './RoutineNotes';
import Pagination, { usePagination } from './ui/Pagination';
import { SkeletonRows } from './ui/Skeleton';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm';
const EMPTY = [];

export default function RoutineNoteAudit({ from, to, today, onRangeChange, invalidRange, employeeId, showEmployee = false }) {
  const query = useRoutineNoteAudit(from, to, { employeeId, enabled: !invalidRange });
  const [search, setSearch] = useState('');
  const rows = query.data ?? EMPTY;
  const filtered = useMemo(() => {
    const terms = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return rows.filter((note) => {
      const text = [note.routine_name, note.employee?.full_name, note.employee?.employee_code, note.author_name, note.body]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
  }, [rows, search]);
  const pager = usePagination(filtered, 10, null, `${from}:${to}:${search}:${employeeId ?? 'all'}`);

  return <section className="space-y-4" aria-label="Routine notes history">
    <div><h3 className="text-base font-bold">Notes history</h3>
      <p className="mt-1 text-sm text-neutral-500">Employee explanations for routine work, with the completion count recorded when each note was saved. Earlier notes stay available after schedule changes.</p></div>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-1 text-sm"><span>Routine dates from</span><input type="date" required className={INPUT} max={to || today} value={from}
        onChange={(event) => onRangeChange({ from: event.target.value, to })} /></label>
      <label className="space-y-1 text-sm"><span>Routine dates to</span><input type="date" required className={INPUT} min={from} max={today} value={to}
        onChange={(event) => onRangeChange({ from, to: event.target.value })} /></label>
      <label className="space-y-1 text-sm"><span>Search notes</span><input type="search" className={INPUT} value={search}
        onChange={(event) => setSearch(event.target.value)} placeholder="Employee, routine or explanation" /></label>
    </div>
    <p className="text-xs text-neutral-500">Choose up to 366 days. Notes are shown by routine date; the saved time shows when the explanation was recorded.</p>
    {invalidRange ? <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{invalidRange}</p>
      : query.isLoading ? <SkeletonRows rows={3} avatar={false} label="Loading routine notes history" />
        : <>
          {query.error && <div role="alert" className="text-sm text-rose-700 dark:text-rose-300">
            <p>{rows.length ? 'These notes may be out of date. ' : 'Could not load notes history. '}{humanDbError(query.error)}</p>
            <button type="button" className="underline" onClick={() => query.refetch()}>Retry notes history</button>
          </div>}
          {filtered.length > 0 ? <>
            <p className="text-xs text-neutral-500">{filtered.length} saved note{filtered.length === 1 ? '' : 's'}</p>
            <ul className="space-y-3">{pager.slice.map(note => <li key={note.id} className="premium-card p-4">
              <RoutineNoteEntry note={note} showEmployee={showEmployee} showRoutine />
            </li>)}</ul>
            <Pagination {...pager} noun="routine notes" sizes={[10, 25, 50]} />
          </> : !query.error && <p className="premium-card py-8 text-center text-sm text-neutral-500">{search ? 'No notes match this search.' : 'No notes were saved for these routine dates.'}</p>}
        </>}
  </section>;
}
