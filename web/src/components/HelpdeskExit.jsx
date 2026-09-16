import React, { useEffect, useRef, useState } from 'react';
import { MailOpen, X, Loader2, DoorOpen } from 'lucide-react';
import TicketDesk from './TicketDesk';
import { useExits, useAddExit, useDecideExitClearance, useCompleteExit } from '../data/exits';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import QueryError from './ui/QueryError';
import { SkeletonRows } from './ui/Skeleton';
import ConfirmDialog from './ui/ConfirmDialog';
import { canManageExit, EXIT_DEPARTMENTS, exitReadyToComplete } from '../lib/exitClearance';
import { humanDbError } from '../lib/dbErrors';

export default function HelpdeskExit() {
  const { employee, user } = useAuth();
  const { can, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const addExit = useAddExit();
  const decide = useDecideExitClearance();
  const complete = useCompleteExit();
  const [completing, setCompleting] = useState(null);
  // The exit clearances panel lists other people's separations — name, department, last day — and
  // had no permission expression at all. RLS spared a plain employee (exits_select admits your own
  // row unconditionally); everyone else saw the queue whether or not they handle exits.
  const canRequestExit = Boolean(employee?.id) && can('exit.create', { employeeId: employee.id });
  const canSeeExits = canBeyondSelf('exit.manage') || canRequestExit;

  const exitsQuery = useExits({ enabled: canSeeExits });
  const { data: exits = [] } = exitsQuery;
  const hasExits = Array.isArray(exitsQuery.data);
  const exitsReady = hasExits && !exitsQuery.error && !exitsQuery.isFetching;
  const canReview = (exit) => canManageExit(exit, { employeeId: employee?.id, userId: user?.id, viewingAsEmployee, can });
  // The same lens the tickets list already honours, applied to separations too. RLS answers to
  // the ACCOUNT, so an entity admin who switched to "Employee" still received every separation in
  // the entity — names, last working days, clearance status — on a screen presenting itself as
  // self-service. Hiding the controls is not hiding the rows; this narrows the rows.
  const exitsMineOnly = viewingAsEmployee || !canBeyondSelf('exit.manage');
  const visibleExits = exitsMineOnly
    ? exits.filter((x) => (x.employee_id ?? x.employee?.id) === employee?.id)
    : exits;
  const [showExitForm, setShowExitForm] = useState(false);
  const exitFormRef = useRef(null);
  const [exitForm, setExitForm] = useState({ last_day: '', reason: '' });
  const myOpenExit = exits.find(
    (x) => (x.employee_id ?? x.employee?.id) === employee?.id && x.status !== 'Completed'
  );
  useEffect(() => {
    if (!showExitForm) return;
    exitFormRef.current?.scrollIntoView({ block: 'start' });
    exitFormRef.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [showExitForm]);

  const submitExit = async (e) => {
    e.preventDefault();
    if (!exitForm.last_day || !exitForm.reason.trim() || !employee?.id || !exitsReady || myOpenExit || addExit.isPending) return;
    try {
      await addExit.mutateAsync({
        employee_id: employee.id,
        last_day: exitForm.last_day,
        reason: exitForm.reason.trim(),
      });
      setExitForm({ last_day: '', reason: '' });
      setShowExitForm(false);
    } catch { /* shown below */ }
  };

  const exitPager = usePagination(visibleExits, 10, null, exitsMineOnly);

  return (
    <div className="page-shell space-y-6 animate-slide-up text-xs">
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">Helpdesk &amp; Separation</h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">Raise support tickets and track exit clearances.</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {canRequestExit && exitsReady && !showExitForm && !myOpenExit && (
            <button onClick={() => setShowExitForm(true)} className={btnClass('ghost')}>
              <DoorOpen size={12} /> Request Exit
            </button>
          )}

        </div>
      </div>

      <TicketDesk />

      <div>
        {/* Exit clearances, from public.exits — the note that used to say "sample data"
            outlived the sample data by some months. */}
        {canSeeExits && (
        <div className="space-y-4">
          <div className="premium-card space-y-3.5">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-850 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2 flex items-center">
              <MailOpen size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Exit Clearances
            </h3>
            <QueryError error={exitsQuery.error} title={hasExits ? 'Exit records could not be refreshed.' : 'Exit records could not be loaded.'}
              hasData={hasExits} onRetry={exitsQuery.refetch} retrying={exitsQuery.isFetching} />
            <QueryError error={decide.error} title="Clearance could not be saved." />
            {exitsQuery.isLoading && <SkeletonRows rows={3} label="Loading exit records" />}
            {showExitForm && canRequestExit && !myOpenExit && (
              <form ref={exitFormRef} onSubmit={submitExit} className="space-y-3 scroll-mt-4 rounded-xl border border-neutral-200 dark:border-neutral-850 bg-neutral-50 dark:bg-neutral-950/30 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-neutral-850 dark:text-neutral-100">Request separation</p>
                    <p className="text-2xs text-neutral-500 mt-0.5">Submitted against your employee record for HR clearance.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { addExit.reset(); setShowExitForm(false); }}
                    className="p-1 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
                    aria-label="Close exit request"
                  >
                    <X size={14} />
                  </button>
                </div>
                <Field label="Last working day">
                  <input
                    type="date"
                    required
                    value={exitForm.last_day}
                    onChange={(e) => setExitForm({ ...exitForm, last_day: e.target.value })}
                    className={INPUT}
                  />
                </Field>
                <Field label="Reason">
                  <textarea
                    required
                    rows={3}
                    value={exitForm.reason}
                    onChange={(e) => setExitForm({ ...exitForm, reason: e.target.value })}
                    className={`${INPUT} resize-none`}
                    placeholder="Share the reason for separation..."
                  />
                </Field>
                {addExit.error && <p className="text-xs text-red-500">{addExit.error.message}</p>}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { addExit.reset(); setShowExitForm(false); }} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
                  <button type="submit" disabled={addExit.isPending || !exitsReady} className={btnClass('primary')}>
                    {addExit.isPending && <Loader2 size={13} className="animate-spin" />} Submit Request
                  </button>
                </div>
              </form>
            )}
            {myOpenExit && canRequestExit && (
              <p className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Your exit request is already in progress. Last working day: {myOpenExit.last_day || 'not set yet'}.
              </p>
            )}
            {!hasExits ? null : visibleExits.length === 0 && !exitsQuery.error ? (
              <p className="text-neutral-500 py-6 text-center">No exit records visible to you.</p>
            ) : (
            <div className="space-y-3.5 max-h-[420px] overflow-y-auto pr-1">
              {exitPager.slice.map((ext) => (
                <article key={ext.id} aria-label={`Exit for ${ext.employee?.full_name || 'Employee'}`} className="p-3 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-900 rounded-xl space-y-3">
                  <div className="mobile-list-row flex justify-between items-start">
                    <div>
                      <h4 className="font-bold text-xs text-neutral-805 dark:text-slate-200">{ext.employee?.full_name || '—'}</h4>
                      <span className="text-2xs text-neutral-500 block">Dept: {ext.employee?.department?.name || '—'} · Last Day: {ext.last_day || '—'}</span>
                    </div>
                    <span className="text-2xs px-2 py-0.5 bg-neutral-200 dark:bg-neutral-900 text-neutral-550 dark:text-neutral-400 rounded-full font-mono border border-neutral-300 dark:border-neutral-800">{ext.status}</span>
                  </div>
                  <div className="border-t border-neutral-100 dark:border-neutral-900/60 pt-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-2xs">
                    {EXIT_DEPARTMENTS.map((dept) => (
                      <div key={dept} className={`p-1.5 rounded-lg border text-center font-mono ${ext.approvals?.[dept] === 'Approved' ? 'bg-emerald-100/50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900/20 dark:text-emerald-300 text-emerald-800' : 'bg-neutral-105 border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-neutral-500'}`}>
                        <span className="block font-bold text-2xs uppercase">{dept}</span>
                        {canReview(ext) ? <select className={`${INPUT} mt-2`} value={ext.approvals?.[dept] ?? 'Pending'}
                          disabled={!exitsReady || decide.isPending || complete.isPending}
                          aria-label={`${dept} clearance for ${ext.employee?.full_name || 'Employee'}`}
                          onChange={event => decide.mutate({ id: ext.id, department: dept, decision: event.target.value })}>
                          <option value="Pending" disabled>Pending</option><option value="Approved">Approved</option><option value="Rejected">Rejected</option>
                        </select> : <span className="block text-2xs font-semibold mt-0.5">{ext.approvals?.[dept] ?? 'Pending'}</span>}
                      </div>
                    ))}
                  </div>
                  {canReview(ext) && exitReadyToComplete(ext) && <button type="button" className={btnClass('primary')}
                    disabled={!exitsReady || decide.isPending || complete.isPending} onClick={() => { complete.reset(); setCompleting(ext); }}>Complete exit</button>}
                </article>
              ))}
            </div>
            )}
            <div className="paged-collection"><Pagination {...exitPager} noun="exit records" sizes={[10, 25, 50]} /></div>
          </div>
        </div>
        )}
      </div>

      {completing && <ConfirmDialog title="Complete this exit?" confirmLabel="Complete exit" busy={complete.isPending}
        error={humanDbError(complete.error)} onCancel={() => { if (!complete.isPending) setCompleting(null); }}
        onConfirm={async () => {
          try { await complete.mutateAsync(completing.id); setCompleting(null); }
          catch { /* Keep the confirmed employee and server refusal visible. */ }
        }}><p>All departments have cleared {completing.employee?.full_name || 'this employee'}. Mark the separation record as completed?</p></ConfirmDialog>}

    </div>
  );
}

const INPUT = 'w-full text-xs rounded-xl px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-brand font-medium';
const Field = ({ label, children }) => (
  <div className="space-y-1"><label className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">{label}</label>{children}</div>
);
