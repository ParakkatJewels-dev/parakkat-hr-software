import { useId, useRef, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { useAddRoutineNote, useRoutineNotes } from '../data/routines';
import { humanDbError } from '../lib/dbErrors';
import FormSection, { FIELD } from './ui/FormSection';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';

const EMPTY_NOTES = [];
const NOTE_LIMIT = 4000;
const SAVED_TIME = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

function savedTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? `${SAVED_TIME.format(date)} IST` : 'Time unavailable';
}

export function RoutineNoteEntry({ note, showEmployee = false, showRoutine = false }) {
  return <article className="space-y-1.5 rounded-xl bg-neutral-50 p-3 dark:bg-neutral-950">
    {showRoutine && <h5 className="break-words text-sm font-semibold">{note.routine_name || 'Routine'}</h5>}
    {showEmployee && <p className="text-xs text-neutral-600 dark:text-neutral-400">{note.employee?.full_name || 'Employee'}
      {note.employee?.employee_code ? ` · ${note.employee.employee_code}` : ''}</p>}
    <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">{note.author_name || 'Employee'}
      <span className="font-normal text-neutral-500 dark:text-neutral-400"> · <time dateTime={note.created_at}>{savedTime(note.created_at)}</time></span>
    </p>
    <p className="text-xs text-neutral-500 dark:text-neutral-400">For {note.on_date} · {note.completed_jobs} of {note.total_jobs} jobs complete when noted</p>
    <p className="whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200">{note.body}</p>
  </article>;
}

/** An occurrence's audit notes are append-only; saving does not change job completion. */
export default function RoutineNotes({ routineId, onDate, today, canAdd = false, routineName }) {
  const query = useRoutineNotes(routineId, onDate, { enabled: Boolean(routineId && onDate) });
  const add = useAddRoutineNote();
  const notes = query.data ?? EMPTY_NOTES;
  const pager = usePagination(notes, 5, null, `${routineId}:${onDate}`);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const submitting = useRef(false);
  const attempt = useRef(null);
  const inputId = useId();
  const allowed = Boolean(canAdd && routineId && onDate && today && onDate <= today);
  const valid = body.trim().length > 0 && body.length <= NOTE_LIMIT;

  const close = () => {
    if (submitting.current || add.isPending) return;
    setOpen(false);
    setBody('');
    setError(null);
    attempt.current = null;
  };
  const save = async (event) => {
    event.preventDefault();
    if (!allowed || !valid || submitting.current || add.isPending) return;
    submitting.current = true;
    setError(null);
    setNotice('');
    const text = body.trim();
    try {
      // Retrying an uncertain network response uses the same ID, so an accepted note is not added twice.
      if (!attempt.current || attempt.current.body !== text) attempt.current = { body: text, id: crypto.randomUUID() };
      await add.mutateAsync({ routineId, onDate, body: text, clientId: attempt.current.id });
      setBody('');
      setOpen(false);
      attempt.current = null;
      pager.setPage(1);
      setNotice('Note saved. Routine completion is unchanged.');
    } catch (failure) {
      setError(failure);
    } finally {
      submitting.current = false;
    }
  };

  return <section className="space-y-3 border-t border-neutral-200 pt-3 dark:border-neutral-800" aria-label={`Routine notes for ${onDate}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h5 className="text-sm font-semibold">Notes{notes.length > 0 ? ` (${notes.length})` : ''}</h5>
      {allowed && !open && <button type="button" className={btnClass('ghost')} onClick={() => {
        setOpen(true); setError(null); setNotice('');
      }}><MessageSquarePlus size={15} aria-hidden="true" />Add note</button>}
    </div>
    {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
    {allowed && open && <FormSection title="Add routine note" subtitle={`${routineName ? `${routineName} · ` : ''}${onDate}`}
      onClose={close} onSubmit={save} submitLabel="Save note" busyLabel="Saving note…"
      busy={add.isPending} disabled={!valid} error={error}>
      <div className="space-y-2">
        <label htmlFor={inputId} className="block text-sm font-medium">Note for {onDate}</label>
        <textarea id={inputId} className={`${FIELD} min-h-28`} value={body} rows={4} required maxLength={NOTE_LIMIT}
          aria-describedby={`${inputId}-help`} placeholder="Explain why you could not complete the routine, what you completed, or what is still pending."
          onChange={(event) => {
            if (submitting.current || add.isPending) return;
            setBody(event.target.value); setError(null);
          }} />
        <p id={`${inputId}-help`} className="text-xs text-neutral-500 dark:text-neutral-400">
          Your head and authorised managers can read this note. Saved notes remain in the audit history; add another note to correct or update them.
        </p>
        <p className="text-right text-xs text-neutral-500">{body.length}/{NOTE_LIMIT}</p>
      </div>
    </FormSection>}
    {query.error && <div role="alert" className="space-y-2 text-xs text-amber-700 dark:text-amber-300">
      <p>{notes.length ? 'The notes may be out of date. ' : 'Notes could not be loaded. '}{humanDbError(query.error)}</p>
      <button type="button" className={btnClass('ghost')} disabled={query.isFetching} onClick={() => query.refetch()}>Try again</button>
    </div>}
    {query.isLoading ? <p role="status" className="text-xs text-neutral-500">Loading notes…</p>
      : notes.length > 0 ? <>
        <ol className="space-y-3" aria-label="Saved routine notes">
          {pager.slice.map((note) => <li key={note.id}><RoutineNoteEntry note={note} /></li>)}
        </ol>
        <Pagination {...pager} noun="routine notes" sizes={[5, 10]} />
      </> : !query.error && <p className="text-xs text-neutral-500">No notes for {onDate}.</p>}
  </section>;
}
