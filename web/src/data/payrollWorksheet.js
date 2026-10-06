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

/** Every saved input in the chosen company/month, including API pages beyond the first. */
export function usePayrollMonthlyInputs(entityId, period, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['payroll-monthly-inputs', entityId, period],
    enabled: enabled && Boolean(entityId && period),
    queryFn: () => fetchCollection(() => supabase.from('payroll_monthly_inputs').select('*')
      .eq('entity_id', entityId).eq('period', period).order('employee_id'),
    // This table's primary key is (employee_id, period), and period is fixed by the query.
    { key: row => row.employee_id }),
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
    'payroll-policy', 'payroll-monthly-input', 'payroll-monthly-inputs', 'payroll-worksheet-run', 'payroll-register',
    'payroll-runs', 'payslips', 'payslip-lines', 'section-counts',
  ].map(key => client.invalidateQueries({ queryKey: [key] })));
}

export function useSavePayrollPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['save-payroll-policy'],
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
    onError: (_error, { employeeId, period }) => Promise.all([
      client.invalidateQueries({ queryKey: ['payroll-monthly-input', employeeId, period] }),
      client.invalidateQueries({ queryKey: ['payroll-monthly-inputs'] }),
    ]),
    onSuccess: () => invalidateWorksheet(client),
  });
}

/** One transaction for all changed employees; validation must finish before sending any row. */
export function useSavePayrollMonthlyInputs() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['save-payroll-monthly-inputs'],
    mutationFn: async ({ entityId, period, rows }) => {
      if (!entityId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period ?? '')) throw new Error('Choose a company and payroll month.');
      if (!Array.isArray(rows) || !rows.length) throw new Error('There are no changed payroll inputs to save.');
      if (rows.length > 1000) throw new Error('Save no more than 1,000 payroll rows at a time.');
      const seen = new Set();
      const inputs = rows.map(({ employeeId, input, expectedUpdatedAt = null }) => {
        if (!employeeId) throw new Error('Every payroll row must identify an employee.');
        if (seen.has(employeeId)) throw new Error('An employee can appear only once in a payroll batch.');
        seen.add(employeeId);
        return { employee_id: employeeId, input: normalizeMonthlyInput(input), expected_updated_at: expectedUpdatedAt };
      });
      const { data, error } = await supabase.rpc('save_payroll_monthly_inputs', {
        _entity_id: entityId, _period: period, _rows: inputs,
      });
      if (error) throw error;
      return data;
    },
    onError: (_error, { entityId, period, rows }) => Promise.all([
      client.invalidateQueries({ queryKey: ['payroll-monthly-inputs', entityId, period] }),
      client.invalidateQueries({ queryKey: ['payroll-worksheet-run', entityId, period] }),
      ...[...new Set((Array.isArray(rows) ? rows : []).map(row => row?.employeeId).filter(Boolean))].map(employeeId =>
        client.invalidateQueries({ queryKey: ['payroll-monthly-input', employeeId, period] })),
    ]),
    onSuccess: () => invalidateWorksheet(client),
  });
}
