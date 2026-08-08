// Data hooks for the Leave module. RLS scopes what each user sees:
// an employee sees their own; a branch manager/HR sees their branch's; a zonal manager, their zone.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { windowStartIso } from '../lib/dates';

export function useLeaves({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['leaves'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leaves')
        .select(
          // disambiguate: leaves has two FKs to employees (employee_id + approver_id)
          `id, employee_id, entity_id, zone_id, branch_id, department_id,
           type, start_date, end_date, days, reason, status, created_at,
           cancelled_dates, auto_cancelled_at, auto_cancellation_note,
           employee:employees!leaves_employee_id_fkey(id, full_name, employee_code, branch_id, branch:branches(code))`
        )
        // Bounded: the whole table was fetched on every dashboard. Screens show recent activity;
        // historical analysis goes through the Reports RPCs.
        .gte('start_date', windowStartIso(180))
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
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
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leaves')
        .select(
          `id, employee_id, entity_id, zone_id, branch_id, department_id,
           type, start_date, end_date, days, reason, status, created_at,
           employee:employees!leaves_employee_id_fkey(id, full_name, employee_code, branch_id, branch:branches(code))`
        )
        // Touching the range, not contained by it: a leave that straddles the month boundary
        // belongs to both months' reports.
        .lte('start_date', to)
        .gte('end_date', from)
        .limit(5000);
      if (error) throw error;
      return data ?? [];
    },
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

export function useSetLeaveStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }) => {
      const { data, error } = await supabase
        .from('leaves')
        .update({ status })
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('That leave request is outside the scope you can manage.');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leaves'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
  });
}
