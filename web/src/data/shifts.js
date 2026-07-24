// Shifts and effective-dated shift assignments.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useShifts() {
  return useQuery({
    queryKey: ['shifts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shifts')
        .select(
          `id, entity_id, code, name, start_time, end_time, crosses_midnight,
           grace_in_minutes, grace_out_minutes, break_minutes, weekly_offs,
           full_day_minutes, half_day_minutes, ot_after_minutes, min_ot_minutes,
           is_default, is_active, entity:entities(id, code, name)`
        )
        .order('code');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSaveShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (shift) => {
      const payload = {
        entity_id: shift.entity_id || null,
        code: shift.code,
        name: shift.name,
        start_time: shift.start_time,
        end_time: shift.end_time,
        grace_in_minutes: Number(shift.grace_in_minutes) || 0,
        grace_out_minutes: Number(shift.grace_out_minutes) || 0,
        break_minutes: Number(shift.break_minutes) || 0,
        weekly_offs: shift.weekly_offs ?? [0],
        full_day_minutes: Number(shift.full_day_minutes) || 480,
        half_day_minutes: Number(shift.half_day_minutes) || 240,
        ot_after_minutes: Number(shift.ot_after_minutes) || 0,
        min_ot_minutes: Number(shift.min_ot_minutes) || 0,
        is_default: Boolean(shift.is_default),
        is_active: shift.is_active !== false,
      };

      const query = shift.id
        ? supabase.from('shifts').update(payload).eq('id', shift.id)
        : supabase.from('shifts').insert(payload);

      const { error } = await query;
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shifts'] }),
  });
}

export function useDeleteShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('shifts').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shifts'] }),
  });
}

export function useShiftAssignments(employeeId) {
  return useQuery({
    queryKey: ['shift-assignments', employeeId ?? 'all'],
    queryFn: async () => {
      let query = supabase
        .from('employee_shift_assignments')
        .select(
          `id, employee_id, shift_id, effective_from, effective_to, note,
           employee:employees!employee_shift_assignments_employee_id_fkey(id, full_name, employee_code),
           shift:shifts(id, code, name)`
        )
        .order('effective_from', { ascending: false })
        .limit(500);

      if (employeeId) query = query.eq('employee_id', employeeId);

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Assign a shift from a date. The database rejects overlapping ranges for one employee
 * (esa_no_overlap), so the caller must close the previous assignment first — this does that in
 * the same flow rather than leaving the user to work out why their save failed.
 */
export function useAssignShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ employeeId, shiftId, effectiveFrom, effectiveTo = null, note = null }) => {
      const { data: open, error: findError } = await supabase
        .from('employee_shift_assignments')
        .select('id, effective_from, effective_to')
        .eq('employee_id', employeeId)
        .is('effective_to', null);
      if (findError) throw findError;

      const dayBefore = new Date(`${effectiveFrom}T00:00:00Z`);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const closeOn = dayBefore.toISOString().slice(0, 10);

      for (const row of open ?? []) {
        if (row.effective_from >= effectiveFrom) {
          // The existing row starts on or after the new one — it is superseded outright.
          const { error } = await supabase.from('employee_shift_assignments').delete().eq('id', row.id);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('employee_shift_assignments')
            .update({ effective_to: closeOn })
            .eq('id', row.id);
          if (error) throw error;
        }
      }

      const { error } = await supabase.from('employee_shift_assignments').insert({
        employee_id: employeeId,
        shift_id: shiftId,
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
        note,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-assignments'] });
      // The trigger queued a recompute; the calendar will change once it drains.
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
