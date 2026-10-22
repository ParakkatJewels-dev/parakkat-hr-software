// Reviewing one leave request (round 3). It used to be a Decision dropdown, a Remarks box and a
// pale full-width button that stayed disabled with no word of why. Now the decision is a choice of
// big buttons in its own colour (approve green, reject red, hold amber), remarks come with a few
// ready phrases, and the button at the bottom says and looks like what it will do.
//
// On a computer the panel opens in place above the list, like the app's other forms. On a phone it
// comes up as a sheet — the inline panel opened at the top of a long list, off screen from the row
// that was tapped.
import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, PauseCircle, RotateCcw, X, XCircle } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useDecideLeave, useLeaveDecisions } from '../data/leaves';
import { useLeaveTypes } from '../data/leaveTypes';
import { leaveStage, leaveStageLabel, leaveDecisionsFor, leaveDecisionLabel } from '../lib/leaveWorkflow';
import { paginationWindow } from '../lib/pagination';
import { humanDbError } from '../lib/dbErrors';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useRevealOnOpen } from '../lib/useRevealOnOpen';
import Avatar from './ui/Avatar';
import Pagination from './ui/Pagination';
import './leaveReview.css';

const stamp = (value) => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** How each decision looks, and the phrases offered for its remark. */
export const DECISION_LOOK = {
  Approved: { tone: 'approve', icon: Check, phrases: ['Approved.', 'Approved — enjoy your time off.'] },
  Rejected: { tone: 'reject', icon: XCircle, phrases: ['Not enough cover on these dates.', 'Please speak to me before applying again.'] },
  'On Hold': { tone: 'hold', icon: PauseCircle, phrases: ['Need more details — please update the reason.', 'Waiting on the team schedule.'] },
  Pending: { tone: 'neutral', icon: RotateCcw, phrases: ['Reopening for another look.'] },
  Cancelled: { tone: 'reject', icon: XCircle, phrases: ['Cancelled at the employee’s request.'] },
};
const lookOf = (value) => DECISION_LOOK[value] ?? DECISION_LOOK.Pending;

/** A ready phrase added to whatever is already written. */
export const addPhrase = (remarks, phrase) => (remarks.trim() ? `${remarks.trimEnd()} ${phrase}` : phrase);

export default function LeaveReviewPanel({ request, onClose, initialDecision }) {
  const { employee } = useAuth();
  const { viewingAsEmployee } = usePermissions();
  const decision = useDecideLeave();
  const options = leaveDecisionsFor(request, employee?.id, viewingAsEmployee);
  const [choice, setChoice] = useState(() => options.find((o) => o.value === initialDecision)?.value ?? options[0]?.value ?? 'Approved');
  const selected = options.find((option) => option.value === choice) ?? options[0];
  const [remarks, setRemarks] = useState('');
  const fieldId = useId();
  const titleId = useId();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const history = useLeaveDecisions(request.id, page, size);
  const pager = paginationWindow(history.data?.count ?? 0, page, size);
  const { data: leaveTypes = [] } = useLeaveTypes();
  const typeName = leaveTypes.find((t) => t.code === request.type)?.name ?? request.type;
  const phone = useMediaQuery('(max-width: 640px)');
  // A computer scrolls the panel into view; a phone's sheet is already in view, and opening the
  // keyboard over it before anything is chosen would hide the choices.
  const revealRef = useRevealOnOpen(!phone, { focus: false, block: 'nearest' });
  const pending = decision.isPending;
  const close = () => { if (!pending) onClose(); };

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!phone) return undefined;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, [phone]);

  const submit = async (event) => {
    event.preventDefault();
    if (!selected || !remarks.trim() || pending) return;
    try {
      await decision.mutateAsync({ id: request.id, status: selected.value, remarks });
      onClose();
    } catch { /* keep remarks and show the database's stage/scope error */ }
  };

  const look = selected ? lookOf(selected.value) : null;
  const SubmitIcon = look?.icon;
  const waiting = request.status === 'Pending' || request.status === 'On Hold';
  const name = request.employee?.full_name || 'Employee';
  const when = `${day(request.start_date)}${request.end_date !== request.start_date ? ` – ${day(request.end_date)}` : ''}`;
  const count = history.data?.count ?? 0;

  const panel = (
    <form ref={phone ? undefined : revealRef} onSubmit={submit} className="leave-review" aria-labelledby={titleId} aria-busy={pending}
      role={phone ? 'dialog' : undefined} aria-modal={phone ? 'true' : undefined}>
      <header className="leave-review-head">
        <Avatar name={name} size="md" />
        <div className="leave-review-who">
          <h3 id={titleId}>{name}</h3>
          <p>{typeName} · {when} · {request.days} day{Number(request.days) === 1 ? '' : 's'}</p>
        </div>
        <button type="button" className="leave-review-close" onClick={close} disabled={pending} aria-label={`Close leave request for ${name}`}>
          <X size={18} />
        </button>
      </header>

      <div className="leave-review-body">
        <section className="leave-review-request" aria-label="Request">
          <span className="leave-review-stage">{leaveStageLabel(request)}</span>
          {request.reason && <p className="leave-review-reason">{request.reason}</p>}
          {waiting && (
            <p className="leave-review-note">
              {leaveStage(request) === 'department' ? 'Approving forwards this request to HR for final sanction.'
                : leaveStage(request) === 'hr' ? 'HR makes the final sanction decision for this request.'
                  : 'The assigned reviewer records the decision.'}
            </p>
          )}
          {request.auto_cancellation_note && <p className="leave-review-warn">{request.auto_cancellation_note}</p>}
        </section>

        {selected && (
          <>
            <fieldset className="leave-review-choices" disabled={pending}>
              <legend>Your decision</legend>
              <div role="radiogroup" aria-label="Your decision" data-count={options.length}>
                {options.map((option) => {
                  const { tone, icon: Icon } = lookOf(option.value);
                  const on = option.value === selected.value;
                  return (
                    <button key={option.value} type="button" role="radio" aria-checked={on} data-tone={tone}
                      onClick={() => { setChoice(option.value); decision.reset(); }}>
                      <Icon size={17} aria-hidden="true" />
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="leave-review-remarks">
              <label htmlFor={`${fieldId}-remarks`}>Remarks <span aria-hidden="true">*</span></label>
              <textarea id={`${fieldId}-remarks`} value={remarks} required maxLength={2000} rows={3} disabled={pending}
                aria-describedby={`${fieldId}-remarks-hint`} onChange={(event) => setRemarks(event.target.value)}
                placeholder="Explain your decision…" />
              <div className="leave-review-phrases" aria-label="Ready phrases">
                {look.phrases.map((phrase) => (
                  <button key={phrase} type="button" disabled={pending} onClick={() => setRemarks((text) => addPhrase(text, phrase))}>{phrase}</button>
                ))}
              </div>
              <p id={`${fieldId}-remarks-hint`} className="leave-review-hint">
                {remarks.trim() ? 'Visible to the employee and reviewers.' : 'A remark is needed. The employee and reviewers will see it.'}
              </p>
            </div>
          </>
        )}

        {decision.error && <p role="alert" className="leave-review-error">{humanDbError(decision.error)}</p>}

        <details className="leave-review-history">
          <summary>Decision history{history.isSuccess ? ` (${count})` : ''}<ChevronDown size={15} aria-hidden="true" /></summary>
          <section aria-label="Leave decision history" className="space-y-2 pt-2">
            {history.isLoading && <p className="text-xs" role="status">Loading decisions…</p>}
            {history.error && <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">Could not load decision history. {history.error.message}</p>}
            {(history.data?.rows ?? []).map((entry) => (
              <article key={entry.id} className="leave-review-entry">
                <strong>{leaveDecisionLabel(entry)}</strong>
                <span>{entry.actor_name || 'Reviewer'} · {stamp(entry.created_at)}</span>
                <p>{entry.remarks}</p>
              </article>
            ))}
            {history.isSuccess && !count && <p className="text-xs text-neutral-500">No recorded decisions yet.</p>}
            {count > size && <Pagination {...pager} setPage={setPage} setPageSize={(value) => { setSize(value); setPage(1); }}
              noun="decisions" sizes={[10, 25, 50]} disabled={history.isFetching} />}
          </section>
        </details>
      </div>

      <footer className="leave-review-foot">
        <button type="button" className="leave-review-cancel" onClick={close} disabled={pending}>Cancel</button>
        {selected && (
          <button type="submit" className="leave-review-submit" data-tone={look.tone} disabled={pending || !remarks.trim()}>
            {pending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <SubmitIcon size={16} aria-hidden="true" />}
            {pending ? 'Saving…' : selected.label}
          </button>
        )}
      </footer>
    </form>
  );

  if (!phone) return panel;
  return createPortal(
    <div className="leave-review-layer">
      <button type="button" className="leave-review-backdrop" aria-label="Close" tabIndex={-1} onClick={close} />
      {panel}
    </div>,
    document.body,
  );
}
