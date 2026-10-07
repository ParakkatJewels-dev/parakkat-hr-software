import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';
import { normalizePayrollAdjustment, normalizePayrollAdvance, normalizePayrollAdvanceRecovery,
  normalizePayrollPaymentStatus, normalizePayrollPeriod, normalizePayrollVoidReason } from '../lib/payrollTransactions';

export function usePayrollAdjustments(entityId, period, { enabled = true } = {}) {
  return useQuery({ queryKey: ['payroll-adjustments', entityId, period], enabled: enabled && Boolean(entityId && period),
    queryFn: () => fetchCollection(() => supabase.from('payroll_adjustments').select('*')
      .eq('entity_id', entityId).eq('period', period).order('id')) });
}

export function usePayrollAdvances(entityId, { enabled = true } = {}) {
  return useQuery({ queryKey: ['payroll-advances', entityId], enabled: enabled && Boolean(entityId),
    queryFn: () => fetchCollection(() => supabase.from('payroll_advances').select('*').eq('entity_id', entityId).order('id')) });
}

export function usePayrollAdvanceRecoveries(entityId, { enabled = true } = {}) {
  return useQuery({ queryKey: ['payroll-advance-recoveries', entityId], enabled: enabled && Boolean(entityId),
    queryFn: async () => {
      // A branch payroll manager cannot read company run totals. This scoped JSON response
      // includes each recovery's publication state without exposing those aggregates.
      const rows = await rpc('get_payroll_advance_recoveries', { _entity_id: entityId });
      if (!Array.isArray(rows)) throw new Error('Advance recoveries could not be loaded. Refresh and try again.');
      return rows;
    } });
}

export function usePayrollPayments(runId, { enabled = true } = {}) {
  return useQuery({ queryKey: ['payroll-payments', runId], enabled: enabled && Boolean(runId),
    queryFn: () => fetchCollection(() => supabase.from('payroll_payments').select('*').eq('run_id', runId).order('employee_id'),
      { key: row => row.employee_id }) });
}

function invalidateTransactions(client) {
  return Promise.all(['payroll-adjustments', 'payroll-advances', 'payroll-advance-recoveries', 'payroll-payments',
    'payroll-worksheet-run', 'payroll-register', 'payroll-runs', 'payslips', 'payslip-lines', 'section-counts']
    .map(key => client.invalidateQueries({ queryKey: [key] })));
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

function requireId(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

export function useSavePayrollAdjustment() {
  const client = useQueryClient();
  return useMutation({ mutationKey: ['save-payroll-adjustment'],
    mutationFn: async ({ employeeId, period, adjustment, id, expectedUpdatedAt = null }) => rpc('save_payroll_adjustment', {
      _employee_id: requireId(employeeId, 'Employee'), _period: normalizePayrollPeriod(period),
      _adjustment: normalizePayrollAdjustment(adjustment), _id: requireId(id, 'Adjustment ID'), _expected_updated_at: expectedUpdatedAt,
    }), onSuccess: () => invalidateTransactions(client), onError: () => invalidateTransactions(client) });
}

export function useDeletePayrollAdjustment() {
  const client = useQueryClient();
  return useMutation({ mutationKey: ['delete-payroll-adjustment'],
    mutationFn: async ({ id, expectedUpdatedAt }) => rpc('delete_payroll_adjustment', {
      _id: requireId(id, 'Adjustment ID'), _expected_updated_at: requireId(expectedUpdatedAt, 'Saved adjustment version'),
    }), onSuccess: () => invalidateTransactions(client), onError: () => invalidateTransactions(client) });
}

export function useCreatePayrollAdvance() {
  const client = useQueryClient();
  return useMutation({ mutationKey: ['create-payroll-advance'],
    mutationFn: async ({ employeeId, issuedOn, amount, reason, requestId }) => {
      const advance = normalizePayrollAdvance({ issuedOn, amount, reason });
      return rpc('create_payroll_advance', { _employee_id: requireId(employeeId, 'Employee'), _issued_on: advance.issuedOn,
        _amount: advance.amount, _reason: advance.reason, _request_id: requireId(requestId, 'Advance request ID') });
    }, onSuccess: () => invalidateTransactions(client), onError: () => invalidateTransactions(client) });
}

export function useSavePayrollAdvanceRecovery() {
  const client = useQueryClient();
  return useMutation({ mutationKey: ['save-payroll-advance-recovery'],
    mutationFn: async ({ advanceId, period, amount, expectedUpdatedAt = null }) => {
      const recovery = normalizePayrollAdvanceRecovery({ period, amount });
      return rpc('save_payroll_advance_recovery', { _advance_id: requireId(advanceId, 'Advance'),
        _period: recovery.period, _amount: recovery.amount, _expected_updated_at: expectedUpdatedAt });
    }, onSuccess: () => invalidateTransactions(client), onError: () => invalidateTransactions(client) });
}

export function useVoidPayrollAdvance() {
  const client = useQueryClient();
  return useMutation({ mutationKey: ['void-payroll-advance'],
    mutationFn: async ({ id, reason, expectedUpdatedAt }) => rpc('void_payroll_advance', {
      _id: requireId(id, 'Advance'), _reason: normalizePayrollVoidReason(reason),
      _expected_updated_at: requireId(expectedUpdatedAt, 'Saved advance version'),
    }), onSuccess: () => invalidateTransactions(client), onError: () => invalidateTransactions(client) });
}

export function useSetPayrollPaymentStatus() {
  const client = useQueryClient();
  return useMutation({ mutationKey: ['set-payroll-payment-status'],
    mutationFn: async ({ runId, employeeId, status, reason, reference, expectedUpdatedAt = null }) => {
      const payment = normalizePayrollPaymentStatus({ status, reason, reference });
      return rpc('set_payroll_payment_status', { _run_id: requireId(runId, 'Payroll run'), _employee_id: requireId(employeeId, 'Employee'),
        _status: payment.status, _reason: payment.reason || null, _reference: payment.reference || null,
        _expected_updated_at: expectedUpdatedAt });
    }, onSuccess: () => invalidateTransactions(client), onError: () => invalidateTransactions(client) });
}
