import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { todayIso, fmtTime } from '../data/attendance';
import { usePunchCorrectionContext, useSavePunchCorrection } from '../data/punchCorrections';
import { regularizationTimes, correctionDateLabel } from '../lib/regularizationTimes';
import { punchDate } from '../lib/recordedPunches';
import FormSection, { FIELD } from './ui/FormSection';
import ConfirmDialog from './ui/ConfirmDialog';
import { btnClass } from './ui/Btn';

const clockValue = value => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '';
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const initialForm = (context, workDate) => {
  const approved = context?.active_correction?.status === 'Approved' ? context.active_correction : null;
  return {
    // Derived attendance can contain schedule reconstructions. Only a prior HR correction is a
    // verified manual value; blank endpoints continue to use the recorded device punches.
    checkIn: clockValue(approved?.check_in),
    checkOut: clockValue(approved?.check_out),
    checkOutNextDay: Boolean(approved?.check_out && punchDate(approved.check_out) > workDate),
    reason: '',
  };
};

export default function PunchCorrectionEditor({ employee, workDate: startingDate, onClose, onStateChange }) {
  const { employee: me } = useAuth();
  const { can, viewingAsEmployee } = usePermissions();
  const [workDate, setWorkDate] = useState(startingDate);
  const [draft, setDraft] = useState(null);
  const [discard, setDiscard] = useState(null);
  const [formError, setFormError] = useState('');
  const [saved, setSaved] = useState(false);
  const submitting = useRef(false);
  const retry = useRef(null);
  const notify = useRef(onStateChange);
  notify.current = onStateChange;
  const allowed = Boolean(employee && employee.id !== me?.id && !viewingAsEmployee && can('attendance.manage', {
    entityId: employee.entity_id, zoneId: employee.zone_id, branchId: employee.branch_id,
    deptId: employee.department_id, employeeId: employee.id,
  }));
  const dateValid = validDate(workDate) && workDate <= todayIso();
  const context = usePunchCorrectionContext(allowed && dateValid ? employee.id : null, workDate);
  const save = useSavePunchCorrection();
  const data = context.data;
  const form = draft?.form ?? initialForm(data, workDate);
  const dirty = Boolean(draft);
  const stale = dirty && data?.source_revision !== draft.sourceRevision;
  const pending = save.isPending;
  const malformed = data?.employee_id !== employee?.id || data?.work_date !== workDate
    || typeof data?.source_revision !== 'string' || !data?.source_revision;
  const baseBlocked = !allowed || !dateValid || !context.isSuccess || context.isFetching || Boolean(context.error)
    || malformed || data?.can_correct !== true || data?.is_locked || pending;
  const payload = draft ? { employeeId: employee.id, workDate, ...form, reason: form.reason.trim(), sourceRevision: draft.sourceRevision } : null;
  // A connection can fail after the server committed. An unchanged request ID and original
  // source revision let the receipt confirm that save, even if the refreshed source is newer.
  const retryAvailable = Boolean(save.error && !save.error.code && retry.current
    && retry.current.fingerprint === JSON.stringify(payload));
  const reloadRequired = stale || ['40001', '42501', '55000'].includes(save.error?.code);
  const blocked = baseBlocked || (reloadRequired && !retryAvailable);

  useEffect(() => {
    notify.current?.(dirty || pending);
    return () => notify.current?.(false);
  }, [dirty, pending]);
  useEffect(() => {
    if (!dirty && !pending) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pending]);

  const clearDraft = () => { setDraft(null); setSaved(false); setFormError(''); retry.current = null; save.reset(); };
  const requestChange = action => {
    if (pending || submitting.current) return;
    if (dirty) setDiscard({ action }); else action();
  };
  const change = (field, value) => {
    if (baseBlocked || reloadRequired) return;
    setSaved(false); setFormError(''); save.reset();
    setDraft(current => ({ sourceRevision: current?.sourceRevision ?? data.source_revision,
      form: { ...(current?.form ?? initialForm(data, workDate)), [field]: value } }));
  };
  const submit = async () => {
    if (blocked || !dirty || submitting.current) return;
    setFormError('');
    if (form.reason.trim().length < 3 || form.reason.trim().length > 1000) { setFormError('Enter a reason between 3 and 1,000 characters.'); return; }
    try { regularizationTimes({ workDate, ...form }); }
    catch (error) { setFormError(error.message); return; }
    const fingerprint = JSON.stringify(payload);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, requestId: crypto.randomUUID() };
    submitting.current = true;
    try {
      await save.mutateAsync({ ...payload, requestId: retry.current.requestId });
      setDraft(null); setSaved(true); retry.current = null;
    } catch { /* Preserve the draft and request ID; the mutation supplies the visible error. */ }
    finally { submitting.current = false; }
  };
  const reload = () => requestChange(() => { clearDraft(); context.refetch(); });
  const close = () => requestChange(onClose);

  return <>
    <FormSection title="Edit punches" subtitle={`${employee.full_name} · ${employee.employee_code || ''}`} icon={Clock}
      onClose={close} onSubmit={submit} submitLabel={retryAvailable ? 'Retry save' : 'Save punch correction'} busy={pending} disabled={blocked || !dirty}
      error={formError || save.error || context.error}>
      <p className="text-xs text-neutral-500">Save a missing or corrected check-in / check-out for this day. The correction is stored in Supabase; EasyTime Pro and original device punches stay unchanged.</p>
      <label className="block max-w-xs text-xs font-semibold text-neutral-600 dark:text-neutral-300">Work date
        <input type="date" aria-label="Punch correction date" className={`${FIELD} mt-1`} value={workDate} max={todayIso()} required
          onChange={event => { const next = event.target.value; requestChange(() => { clearDraft(); setWorkDate(next); }); }} />
      </label>
      {!dateValid && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">Choose today or an earlier valid date.</p>}
      {!allowed && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">You cannot directly edit this employee’s punches. Use a correction request for your own attendance.</p>}
      {context.isLoading && <p role="status" className="text-xs text-neutral-500">Loading this day’s punches…</p>}
      {context.error && <button type="button" className={btnClass('ghost', 'sm')} onClick={() => context.refetch()}>Retry loading punches</button>}
      {data && !malformed && allowed && <>
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-3 sm:grid-cols-2 text-xs">
          <div><p className="font-semibold mb-1">Device punches around this day</p>
            {data.raw_punches?.length ? <ol className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Recorded device punches">{data.raw_punches.map(punch => <li key={punch.id || punch.punch_time} className="font-mono">{fmtTime(punch.punch_time)}{correctionDateLabel(punch.punch_time, workDate)}</li>)}</ol> : <p className="text-neutral-500">No device punches recorded.</p>}
          </div>
          <div><p className="font-semibold mb-1">Current attendance</p><p className="font-mono">{fmtTime(data.attendance?.check_in)} – {fmtTime(data.attendance?.check_out)}{correctionDateLabel(data.attendance?.check_out, workDate)}</p>
            <p className="mt-1 text-neutral-500">{data.attendance ? `${data.attendance.status || 'Calculated'} · ${((data.attendance.worked_minutes || 0) / 60).toFixed(2)} worked hours` : 'No attendance calculated for this day yet.'}</p></div>
        </div>
        {data.is_locked && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">This day is locked by published payroll. Its punches cannot be edited here.</p>}
        {!data.is_locked && !data.can_correct && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{data.blocked_reason || 'This day cannot be corrected.'}</p>}
        {reloadRequired && <div role="alert" className="space-y-2 text-xs text-amber-700 dark:text-amber-300"><p>{retryAvailable ? 'The save could not be confirmed. Retry save to check whether it was saved, or reload this day.' : 'This day changed or could not be saved. Reload its current punches before saving.'}</p><button type="button" className={btnClass('ghost', 'sm')} onClick={reload}>Reload current day</button></div>}
        {!saved && data.pending_recompute && <p role="status" className="text-xs text-neutral-500">A saved change is waiting for attendance processing. Worked hours will refresh after processing.</p>}
      </>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300">Corrected check-in
          <input type="time" aria-label="Punch corrected check-in" className={`${FIELD} mt-1`} value={form.checkIn} disabled={blocked} onChange={event => change('checkIn', event.target.value)} /></label>
        <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300">Corrected check-out
          <input type="time" aria-label="Punch corrected check-out" className={`${FIELD} mt-1`} value={form.checkOut} disabled={blocked} onChange={event => change('checkOut', event.target.value)} /></label>
      </div>
      <label className="flex gap-2 items-center text-xs"><input type="checkbox" aria-label="Punch check-out is next day" checked={form.checkOutNextDay} disabled={blocked || !form.checkOut} onChange={event => change('checkOutNextDay', event.target.checked)} />Check-out is next day</label>
      <p className="text-2xs text-neutral-500">Times are in IST. Fill the missing or incorrect endpoint; leave the other blank to use device punches. Break punches remain as recorded.</p>
      <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300">Reason
        <textarea aria-label="Punch correction reason" className={`${FIELD} mt-1`} rows={2} required minLength={3} maxLength={1000} value={form.reason} disabled={blocked}
          placeholder="For example: missed the check-out punch" onChange={event => change('reason', event.target.value)} /></label>
      {saved && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{data?.pending_recompute === false ? 'Saved to Supabase. Attendance for this day has been processed.' : 'Saved to Supabase. Attendance and payroll hours will update after the attendance service processes this day.'}</p>}
      {allowed && !malformed && data?.history?.length > 0 && <details className="text-xs"><summary className="cursor-pointer font-semibold text-brand-ink">Correction history ({data.history.length})</summary>
        <ol className="mt-2 space-y-2">{data.history.map(item => {
          const audit = data.correction_history?.find(entry => entry.correction_id === item.id || entry.after_state?.id === item.id);
          const changedAt = audit?.changed_at || item.decided_at || item.created_at;
          const hasTimestamp = changedAt && Number.isFinite(Date.parse(changedAt));
          return <li key={item.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-2">
            {hasTimestamp && <time dateTime={changedAt} className="block mb-1 text-neutral-500">{new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(changedAt))} IST</time>}
            <p>{fmtTime(item.check_in)} – {fmtTime(item.check_out)}{correctionDateLabel(item.check_out, workDate)} · {item.status}</p>
            <p className="mt-1 text-neutral-500 whitespace-pre-wrap break-words">{item.reason}</p>
          </li>;
        })}</ol>
      </details>}
    </FormSection>
    {discard && <ConfirmDialog title="Discard punch correction changes?" confirmLabel="Discard changes" cancelLabel="Keep editing" onCancel={() => setDiscard(null)} onConfirm={() => { discard.action(); setDiscard(null); }}><p>Your unsaved punch times and reason will be discarded.</p></ConfirmDialog>}
  </>;
}
