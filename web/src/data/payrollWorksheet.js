import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';
import { normalizeMonthlyInput, normalizePayrollPolicy } from '../lib/payrollWorksheet';

export function usePayrollPolicy(entityId, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['payroll-policy', entityId],
    enabled: enabled && Boolean(entityId),
    queryFn: async () => {
      const { data, error } = await supabase.from('payroll_policies').select('*').eq('entity_id', entityId).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
}

export function usePayrollMonthlyInput(employeeId, period, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['payroll-monthly-input', employeeId, period],
    enabled: enabled && Boolean(employeeId && period),
    queryFn: async () => {
      const { data, error } = await supabase.from('payroll_monthly_inputs').select('*')
        .eq('employee_id', employeeId).eq('period', period).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
}

export function usePayrollWorksheetRun(entityId, period, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['payroll-worksheet-run', entityId, period],
    enabled: enabled && Boolean(entityId && period),
    queryFn: async () => {
      const { data, error } = await supabase.from('payroll_runs')
        .select('id, entity_id, period, status, employees, needs_recalculation')
        .eq('entity_id', entityId).eq('period', period).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
}

export function usePayrollRegister(runId, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['payroll-register', runId],
    enabled: enabled && Boolean(runId),
    queryFn: () => fetchCollection(() => supabase.from('payslips')
      .select('id, employee_id, run_id, payroll_register').eq('run_id', runId).order('id')),
  });
}

function invalidateWorksheet(client) {
  return Promise.all([
    'payroll-policy', 'payroll-monthly-input', 'payroll-worksheet-run', 'payroll-register',
    'payroll-runs', 'payslips', 'payslip-lines', 'section-counts',
  ].map(key => client.invalidateQueries({ queryKey: [key] })));
}

export function useSavePayrollPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ entityId, policy, expectedUpdatedAt = null }) => {
      const { data, error } = await supabase.rpc('save_payroll_policy', {
        _entity_id: entityId, _policy: normalizePayrollPolicy(policy), _expected_updated_at: expectedUpdatedAt,
      });
      if (error) throw error;
      return data;
    },
    onError: (_error, { entityId }) => client.invalidateQueries({ queryKey: ['payroll-policy', entityId] }),
    onSuccess: () => invalidateWorksheet(client),
  });
}

export function useSavePayrollMonthlyInput() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ employeeId, period, input, expectedUpdatedAt = null }) => {
      const { data, error } = await supabase.rpc('save_payroll_monthly_input', {
        _employee_id: employeeId, _period: period, _input: normalizeMonthlyInput(input), _expected_updated_at: expectedUpdatedAt,
      });
      if (error) throw error;
      return data;
    },
    onError: (_error, { employeeId, period }) => client.invalidateQueries({ queryKey: ['payroll-monthly-input', employeeId, period] }),
    onSuccess: () => invalidateWorksheet(client),
  });
}
