import React, { useEffect, useRef, useState } from 'react';
import { MailOpen, X, Loader2, DoorOpen } from 'lucide-react';
import TicketDesk from './TicketDesk';
import { useExits, useAddExit } from '../data/exits';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';

export default function HelpdeskExit() {
  const { employee } = useAuth();
  const { can, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const addExit = useAddExit();
  // The exit clearances panel lists other people's separations — name, department, last day — and
  // had no permission expression at all. RLS spared a plain employee (exits_select admits your own
  // row unconditionally); everyone else saw the queue whether or not they handle exits.
  const canRequestExit = Boolean(employee?.id) && can('exit.create', { employeeId: employee.id });
  const canSeeExits = canBeyondSelf('exit.manage') || canRequestExit;

  const { data: exits = [] } = useExits();
  // The same lens the tickets list already honours, applied to separations too. RLS answers to
  // the ACCOUNT, so an entity admin who switched to "Employee" still received every separation in
  // the entity — names, last working days, clearance status — on a screen presenting itself as
  // self-service. Hiding the controls is not hiding the rows; this narrows the rows.
  const exitsMineOnly = viewingAsEmployee || !canBeyondSelf('exit.manage');
  const visibleExits = exitsMineOnly
    ? exits.filter((x) => x.employee?.id === employee?.id)
    : exits;
  const [showExitForm, setShowExitForm] = useState(false);
  const exitFormRef = useRef(null);
  const [exitForm, setExitForm] = useState({ last_day: '', reason: '' });
  const myOpenExit = exits.find(
    (x) => x.employee?.id === employee?.id && !['Completed', 'Cleared'].includes(x.status)
  );
  useEffect(() => {
    if (!showExitForm) return;
    exitFormRef.current?.scrollIntoView({ block: 'start' });
    exitFormRef.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [showExitForm]);

  const submitExit = async (e) => {
    e.preventDefault();
    if (!exitForm.last_day || !exitForm.reason.trim() || !employee?.id) return;
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
          {canRequestExit && !showExitForm && !myOpenExit && (
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
                  <button type="submit" disabled={addExit.isPending} className={btnClass('primary')}>
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
            {visibleExits.length === 0 ? (
              <p className="text-neutral-500 py-6 text-center">No exit records visible to you.</p>
            ) : (
            <div className="space-y-3.5 max-h-[420px] overflow-y-auto pr-1">
              {exitPager.slice.map((ext) => (
                <div key={ext.id} className="p-3 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-900 rounded-xl space-y-3">
                  <div className="mobile-list-row flex justify-between items-start">
                    <div>
                      <h4 className="font-bold text-xs text-neutral-805 dark:text-slate-200">{ext.employee?.full_name || '—'}</h4>
                      <span className="text-2xs text-neutral-500 block">Dept: {ext.employee?.department?.name || '—'} · Last Day: {ext.last_day || '—'}</span>
                    </div>
                    <span className="text-2xs px-2 py-0.5 bg-neutral-200 dark:bg-neutral-900 text-neutral-550 dark:text-neutral-400 rounded-full font-mono border border-neutral-300 dark:border-neutral-800">{ext.status}</span>
                  </div>
                  <div className="border-t border-neutral-100 dark:border-neutral-900/60 pt-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-2xs">
                    {Object.keys(ext.approvals || {}).map((dept) => (
                      <div key={dept} className={`p-1.5 rounded-lg border text-center font-mono ${ext.approvals[dept] === 'Approved' ? 'bg-emerald-100/50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900/20 dark:text-emerald-300 text-emerald-800' : 'bg-neutral-105 border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-neutral-500'}`}>
                        <span className="block font-bold text-2xs uppercase">{dept}</span>
                        <span className="block text-2xs font-semibold mt-0.5">{ext.approvals[dept]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            )}
            <div className="paged-collection"><Pagination {...exitPager} noun="exit records" sizes={[10, 25, 50]} /></div>
          </div>
        </div>
        )}
      </div>

    </div>
  );
}

const INPUT = 'w-full text-xs rounded-xl px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-brand font-medium';
const Field = ({ label, children }) => (
  <div className="space-y-1"><label className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">{label}</label>{children}</div>
);
