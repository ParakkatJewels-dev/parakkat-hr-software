// Payroll data hooks.
//
// Salary is computed in the database (public.run_payroll) from the attendance the engine already
// derived, so the browser never does money maths. RLS scopes every read: an employee sees their
// own payslips and salary structure, payroll.manage holders see their scope.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function usePayslips() {
  return useQuery({
    queryKey: ['payslips'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payslips')
        .select(
          `id, period, gross, deductions, net, status, paid_days, lop_days, employer_cost, run_id,
           employee:employees(id, full_name, employee_code, branch:branches(code))`
        )
        .order('period', { ascending: false })
        .limit(60);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** The individual earning/deduction lines behind one payslip. */
export function usePayslipLines(payslipId) {
  return useQuery({
    enabled: Boolean(payslipId),
    queryKey: ['payslip-lines', payslipId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payslip_lines')
        .select('id, code, name, kind, amount, sort_order')
        .eq('payslip_id', payslipId)
        .order('sort_order');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function usePayrollRuns() {
  return useQuery({
    queryKey: ['payroll-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payroll_runs')
        .select(
          // entity_id as well as the embed: payroll_runs_write checks the id, and the embed comes
          // back null when RLS hides the entity row — which would silently disable Publish.
          'id, period, status, employees, total_gross, total_net, published_at, created_at, '
          + 'entity_id, entity:entities(code, name)'
        )
        .order('period', { ascending: false })
        .limit(36);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useRunPayroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ entity_id, period }) => {
      const { data, error } = await supabase.rpc('run_payroll', {
        _entity_id: entity_id,
        _period: period,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll-runs'] });
      qc.invalidateQueries({ queryKey: ['payslips'] });
    },
  });
}

export function usePublishPayroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId) => {
      const { error } = await supabase.rpc('publish_payroll', { _run_id: runId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll-runs'] });
      qc.invalidateQueries({ queryKey: ['payslips'] });
    },
  });
}

export function useDeletePayrollRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId) => {
      const { error } = await supabase.rpc('delete_draft_payroll', { _run_id: runId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll-runs'] });
      qc.invalidateQueries({ queryKey: ['payslips'] });
      qc.invalidateQueries({ queryKey: ['payslip-lines'] });
    },
  });
}

// ---------------------------------------------------------------- salary structures
export function useSalaryStructures(employeeId) {
  return useQuery({
    queryKey: ['salary-structures', employeeId ?? 'all'],
    queryFn: async () => {
      let q = supabase
        .from('salary_structures')
        .select(
          'id, employee_id, effective_from, basic, gross, notes, employee:employees(full_name, employee_code)'
        )
        .order('effective_from', { ascending: false })
        .limit(2000);
      if (employeeId) q = q.eq('employee_id', employeeId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSaveSalaryStructure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...row }) => {
      const q = id
        ? supabase.from('salary_structures').update(row).eq('id', id)
        : supabase.from('salary_structures').insert(row);
      const { error } = await q;
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salary-structures'] }),
  });
}

// ---------------------------------------------------------------- pay components
export function usePayComponents() {
  return useQuery({
    queryKey: ['pay-components'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pay_components')
        .select('*')
        .order('display_order')
        .order('code');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSavePayComponent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...row }) => {
      const q = id
        ? supabase.from('pay_components').update(row).eq('id', id)
        : supabase.from('pay_components').insert(row);
      const { error } = await q;
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pay-components'] }),
  });
}

export function useDeletePayComponent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('pay_components').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pay-components'] }),
  });
}
