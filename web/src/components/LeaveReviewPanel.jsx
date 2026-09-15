import React, { useId, useState } from 'react';
import { CalendarCheck2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useDecideLeave, useLeaveDecisions } from '../data/leaves';
import { leaveStage, leaveStageLabel, leaveDecisionsFor, leaveDecisionLabel } from '../lib/leaveWorkflow';
import { paginationWindow } from '../lib/pagination';
import FormSection, { FIELD, Field } from './ui/FormSection';
import Pagination from './ui/Pagination';

const stamp = (value) => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function LeaveReviewPanel({ request, onClose }) {
  const { employee } = useAuth();
  const { viewingAsEmployee } = usePermissions();
  const decision = useDecideLeave();
  const options = leaveDecisionsFor(request, employee?.id, viewingAsEmployee);
  const [choice, setChoice] = useState(options[0]?.value ?? 'Approved');
  const selected = options.find((option) => option.value === choice) ?? options[0];
  const [remarks, setRemarks] = useState('');
  const fieldId = useId();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const history = useLeaveDecisions(request.id, page, size);
  const pager = paginationWindow(history.data?.count ?? 0, page, size);
  const submit = async (event) => {
    event.preventDefault();
    if (!selected || !remarks.trim() || decision.isPending) return;
    try {
      await decision.mutateAsync({ id: request.id, status: selected.value, remarks });
      onClose();
    } catch { /* keep remarks and show the database's stage/scope error */ }
  };

  return <FormSection title={`Leave request · ${request.employee?.full_name || 'Employee'}`}
    subtitle={`${request.start_date} – ${request.end_date} · ${request.type} · ${request.days} day${Number(request.days) === 1 ? '' : 's'}`}
    icon={CalendarCheck2} onClose={() => { if (!decision.isPending) onClose(); }}
    onSubmit={selected ? submit : undefined} submitLabel={selected?.label} busy={decision.isPending}
    disabled={!remarks.trim()} error={decision.error?.message}>
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 space-y-2">
      <strong className="block text-sm">{leaveStageLabel(request)}</strong>
      {request.status === 'Pending' || request.status === 'On Hold' ? <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {leaveStage(request) === 'department' ? 'Department approval forwards this request to HR for final sanction.'
          : leaveStage(request) === 'hr' ? 'HR makes the final sanction decision for this request.'
            : 'The assigned reviewer will review this request and record their decision.'}
      </p> : null}
      <p className="text-sm whitespace-pre-wrap break-words">{request.reason}</p>
      {request.auto_cancellation_note && <p className="text-xs text-amber-700 dark:text-amber-300">{request.auto_cancellation_note}</p>}
    </div>
    {selected && <div className="grid gap-3">
      <Field label="Decision" htmlFor={`${fieldId}-decision`} required>
        <select id={`${fieldId}-decision`} className={FIELD} value={selected.value} disabled={decision.isPending}
          onChange={(event) => { setChoice(event.target.value); decision.reset(); }}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Field>
      <Field label="Remarks" htmlFor={`${fieldId}-remarks`} required>
        <textarea id={`${fieldId}-remarks`} className={FIELD} value={remarks} required maxLength={2000} rows={3}
          aria-describedby={`${fieldId}-remarks-hint`} disabled={decision.isPending} onChange={(event) => setRemarks(event.target.value)} placeholder="Explain your decision…" />
        <p id={`${fieldId}-remarks-hint`} className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Visible to the employee and reviewers</p>
      </Field>
    </div>}
    <section aria-label="Leave decision history" className="space-y-3 min-w-0">
      <h4 className="font-bold text-sm">Decision history</h4>
      {history.isLoading && <p className="text-xs" role="status">Loading decisions…</p>}
      {history.error && <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">Could not load decision history. {history.error.message}</p>}
      {(history.data?.rows ?? []).map((entry) => <article key={entry.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 text-xs space-y-1">
        <strong className="block">{leaveDecisionLabel(entry)}</strong>
        <p className="text-neutral-500 dark:text-neutral-400">{entry.actor_name || 'Reviewer'} · {stamp(entry.created_at)}</p>
        <p className="whitespace-pre-wrap break-words">{entry.remarks}</p>
      </article>)}
      {history.isSuccess && !history.data?.count && <p className="text-xs text-neutral-500">No recorded decisions yet.</p>}
      <Pagination {...pager} setPage={setPage} setPageSize={(value) => { setSize(value); setPage(1); }}
        noun="decisions" sizes={[10, 25, 50]} disabled={history.isFetching} />
    </section>
  </FormSection>;
}
