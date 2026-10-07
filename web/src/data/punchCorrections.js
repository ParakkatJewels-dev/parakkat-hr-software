import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { punchCorrectionTimes } from '../lib/punchCorrectionTimes.js';

const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// Read a fresh server revision with the evidence HR is correcting. Never persist revisions or
// drafts to disk, and keep polling pending work until the attendance worker has processed it.
export function usePunchCorrectionContext(employeeId, workDate) {
  return useQuery({
    queryKey: ['attendance-punch-correction', employeeId, workDate],
    enabled: Boolean(employeeId && validDate(workDate)),
    staleTime: 0,
    meta: { persist: false },
    refetchInterval: query => query.state.data?.pending_recompute ? 3000 : 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_attendance_punch_correction_context', {
        _employee_id: employeeId, _work_date: workDate,
      });
      if (error) throw error;
      if (!data || data.employee_id !== employeeId || data.work_date !== workDate
        || typeof data.source_revision !== 'string' || !data.source_revision) {
        throw new Error('The punch correction details could not be loaded. Refresh this day and try again.');
      }
      return data;
    },
  });
}

export function useSavePunchCorrection() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['save-attendance-punch-correction'],
    mutationFn: async ({ requestId, employeeId, workDate, checkIn, checkOut, checkOutNextDay, reason, sourceRevision, endpointEvidence }) => {
      if (!requestId || !employeeId) throw new Error('Choose an employee and keep the correction request ID when retrying.');
      if (!String(sourceRevision ?? '').trim()) throw new Error('Load the current punch details before saving.');
      const trimmedReason = String(reason ?? '').trim();
      if (trimmedReason.length < 3 || trimmedReason.length > 1000) throw new Error('Enter a correction reason between 3 and 1000 characters.');
      const times = punchCorrectionTimes({ workDate, checkIn, checkOut, checkOutNextDay, endpointEvidence });
      // This is a Supabase-only override. Never insert fabricated device punches or call the
      // EasyTime/BioTime API; the server queues the existing attendance engine atomically.
      const { data, error } = await supabase.rpc('save_attendance_punch_correction', {
        _request_id: requestId, _employee_id: employeeId, _work_date: workDate,
        _check_in: times.checkIn, _check_out: times.checkOut,
        _reason: trimmedReason, _source_revision: sourceRevision,
      });
      if (error) throw error;
      if (!data?.correction_id) throw new Error('The save response was incomplete. Retry this same correction to confirm it was saved.');
      return data;
    },
    onSuccess: () => Promise.all([
      'attendance-punch-correction', 'attendance', 'regularizations', 'section-counts',
      'notification-ref-statuses', 'payroll-attendance-summary', 'payroll-runs', 'payroll-worksheet-run', 'payroll-register',
    ].map(key => client.invalidateQueries({ queryKey: [key] }))),
    onError: (_error, { employeeId, workDate }) => client.invalidateQueries({
      queryKey: ['attendance-punch-correction', employeeId, workDate],
    }),
  });
}
