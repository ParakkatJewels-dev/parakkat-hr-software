// Shifts and effective-dated shift assignments.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';
import { normalizeShiftForm } from '../lib/shiftForm.js';

export function useShifts() {
  return useQuery({
    queryKey: ['shifts'],
    queryFn: () => fetchCollection(() => supabase
        .from('shifts')
        .select(
          `id, entity_id, code, name, start_time, end_time, crosses_midnight,
           grace_in_minutes, grace_out_minutes, break_minutes, weekly_offs,
           full_day_minutes, half_day_minutes, ot_after_minutes, min_ot_minutes,
           break_policy, break_windows, is_flexible, ot_basis, missed_punch_policy, late_absent_minutes,
           early_absent_minutes, short_day_tolerance_minutes, is_default, is_active, entity:entities(id, code, name)`
        )
        .order('code').order('id')),
  });
}

export function useSaveShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (shift) => {
      const payload = normalizeShiftForm(shift);

      const query = shift.id
        ? supabase.from('shifts').update(payload).eq('id', shift.id)
        : supabase.from('shifts').insert(payload);

      const { error } = await query;
      if (error) throw error;
    },
    onSuccess: () => Promise.all(['shifts', 'leaves-period-days', 'attendance', 'payroll-attendance-summary', 'payroll-worksheet-run', 'payroll-register']
      .map(key => qc.invalidateQueries({ queryKey: [key] }))),
  });
}

export function useDeleteShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('shifts').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => Promise.all(['shifts', 'leaves-period-days', 'attendance', 'payroll-attendance-summary', 'payroll-worksheet-run', 'payroll-register']
      .map(key => qc.invalidateQueries({ queryKey: [key] }))),
  });
}

export function useShiftAssignments(employeeId) {
  return useQuery({
    queryKey: ['shift-assignments', employeeId ?? 'all'],
    queryFn: () => fetchCollection(() => {
      let query = supabase
        .from('employee_shift_assignments')
        .select(
          `id, employee_id, shift_id, effective_from, effective_to, note,
           employee:employees!employee_shift_assignments_employee_id_fkey(id, full_name, employee_code),
           shift:shifts(id, code, name)`
        )
        .order('effective_from', { ascending: false })
        .order('id');

      if (employeeId) query = query.eq('employee_id', employeeId);

      return query;
    }),
  });
}

/**
 * Assign a shift from a date. The database rejects overlapping ranges for one employee
 * (esa_no_overlap). Closing the previous assignment and inserting its replacement happen in
 * one database transaction, so a failed replacement cannot erase the original assignment.
 */
export function useAssignShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ employeeId, shiftId, effectiveFrom, effectiveTo = null, note = null }) => {
      const { data, error } = await supabase.rpc('assign_employee_shift', {
        _employee_id: employeeId,
        _shift_id: shiftId,
        _effective_from: effectiveFrom,
        _effective_to: effectiveTo,
        _note: note,
      });
      if (error) {
        if (error.code === 'PGRST202' || error.code === '42883') {
          throw new Error('Shift assignment needs a database update. Apply migration 0121 and try again.');
        }
        throw error;
      }
      return data;
    },
    // Leave allocations read effective assignments directly; attendance follows the queued recompute.
    onSuccess: () => Promise.all(['shift-assignments', 'attendance', 'leaves-period-days']
      .map(key => qc.invalidateQueries({ queryKey: [key] }))),
  });
}

/** Save a reviewed selection in one database transaction; no employee is changed on failure. */
export function useAssignEmployeeShifts() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['assign-employee-shifts'],
    mutationFn: async ({ employeeIds, shiftId, effectiveFrom, effectiveTo = null, note = null }) => {
      if (!Array.isArray(employeeIds) || !employeeIds.length || employeeIds.length > 1000
        || employeeIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Choose between 1 and 1,000 employees.');
      if (new Set(employeeIds).size !== employeeIds.length) throw new Error('Each employee can appear only once in a shift assignment.');
      if (!shiftId) throw new Error('Choose a shift.');
      const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
        && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
      if (!validDate(effectiveFrom) || (effectiveTo && (!validDate(effectiveTo) || effectiveTo < effectiveFrom))) throw new Error('Choose a valid start date and an end date on or after it.');
      const { data, error } = await supabase.rpc('assign_employee_shifts', {
        _employee_ids: employeeIds, _shift_id: shiftId, _effective_from: effectiveFrom,
        _effective_to: effectiveTo || null, _note: String(note ?? '').trim() || null,
      });
      if (error) {
        if (error.code === 'PGRST202' || error.code === '42883') throw new Error('Bulk shift assignment needs a database update before it can be used.');
        throw error;
      }
      return data;
    },
    onSuccess: () => Promise.all(['shift-assignments', 'attendance', 'leaves-period-days', 'payroll-attendance-summary',
      'payroll-worksheet-run', 'payroll-register', 'payroll-runs', 'payslips']
      .map(key => qc.invalidateQueries({ queryKey: [key] }))),
  });
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
