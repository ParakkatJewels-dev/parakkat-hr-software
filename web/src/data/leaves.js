// Data hooks for the Leave module. RLS scopes what each user sees:
// an employee sees their own; a branch manager/HR sees their branch's; a zonal manager, their zone.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { windowStartIso } from '../lib/dates';
import { fetchCollection } from '../lib/fetchCollection';
import { fetchPage } from '../lib/fetchPage';

const WORKFLOW_FIELDS = 'approval_stage, effective_stage:leave_effective_stage, can_decide:leave_can_decide, can_reopen:leave_can_reopen';

export function useLeaves({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['leaves'],
    queryFn: () => fetchCollection(() => supabase
        .from('leaves')
        .select(
          // disambiguate: leaves has two FKs to employees (employee_id + approver_id)
          `id, employee_id, entity_id, zone_id, branch_id, department_id,
           type, start_date, end_date, days, reason, status, created_at,
           cancelled_dates, auto_cancelled_at, auto_cancellation_note, ${WORKFLOW_FIELDS},
           employee:employees!leaves_employee_id_fkey(id, full_name, employee_code, branch_id, branch:branches(code))`
        )
        // Pending and held requests still need a decision, even after the history window.
        // Only settled history ages out of operational lists and dashboard action counts.
        .or(`status.in.(Pending,"On Hold"),start_date.gte.${windowStartIso(180)}`)
        .order('created_at', { ascending: false }).order('id')),
  });
}

/**
 * Every leave touching a date range — the Reports screen's shape of the question.
 *
 * Deliberately NOT useLeaves with a longer window. That hook feeds activity lists, so it is
 * bounded to recent rows on purpose; a report is bounded by the period the reader picked, and
 * feeding it the activity window meant any month older than ~6 months summed to zero and was
 * presented as fact. Keyed on the range so changing the month refetches.
 */
export function useLeavesForPeriod(from, to, { enabled = true } = {}) {
  return useQuery({
    enabled: enabled && Boolean(from) && Boolean(to),
    queryKey: ['leaves-period', from, to],
    queryFn: () => fetchCollection(() => supabase
        .from('leaves')
        .select(
          `id, employee_id, entity_id, zone_id, branch_id, department_id,
           type, start_date, end_date, days, reason, status, created_at,
           employee:employees!leaves_employee_id_fkey(id, full_name, employee_code, branch_id, branch:branches(code))`
        )
        // Touching the range, not contained by it: a leave that straddles the month boundary
        // belongs to both months' reports.
        .lte('start_date', to)
        .gte('end_date', from).order('id')),
  });
}

export function useApplyLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      // ancestry (entity/branch/…) is stamped automatically by the DB trigger from employee_id
      const { error } = await supabase.from('leaves').insert({ ...payload, status: 'Pending' });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leaves'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
  });
}

export function useDecideLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, remarks }) => {
      const note = String(remarks ?? '').trim();
      if (!note) throw new Error('Add remarks before recording your decision.');
      if (note.length > 2000) throw new Error('Keep remarks within 2,000 characters.');
      const { data, error } = await supabase.rpc('decide_leave', {
        _leave_id: id, _decision: status, _remarks: note,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => Promise.all(['leaves', 'leaves-period', 'leave-balances', 'attendance', 'notifications', 'notification-ref-statuses']
      .map((key) => qc.invalidateQueries({ queryKey: [key] }))),
  });
}

export const useSetLeaveStatus = useDecideLeave;

/** Decision history grows independently of leave requests and stays paged on the server. */
export function useLeaveDecisions(leaveId, page = 1, pageSize = 10) {
  return useQuery({
    enabled: Boolean(leaveId),
    queryKey: ['leaves', 'decisions', leaveId, page, pageSize],
    queryFn: () => fetchPage(() => supabase.from('leave_decisions')
      .select('id, leave_id, stage, decision, remarks, actor_name, created_at, from_status, to_status, from_stage, to_stage', { count: 'exact' })
      .eq('leave_id', leaveId).order('created_at', { ascending: false }).order('id', { ascending: false }), { page, pageSize }),
    placeholderData: (previous) => previous,
  });
}
