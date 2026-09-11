// The daily routine: duties defined once, ticked each day.
//
// No permission of its own (0107). Reading follows task.read — an employee holds it at self scope
// and sees their own list, a head holds it over their team. Defining follows task.create, which
// 0021 took away from employees precisely so that work is assigned downward. Ticking follows
// task.update, which is the one thing an employee may record on their own work.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';
import { useAuth } from '../auth/AuthContext';
import { istToday } from '../lib/dates';

/** Every routine the caller can see — their own, or their team's. RLS decides which. */
export function useRoutineItems({ enabled = true, employeeId } = {}) {
  return useQuery({
    enabled,
    queryKey: employeeId ? ['routine-items', employeeId] : ['routine-items'],
    queryFn: () => fetchCollection(() => {
      const query = supabase
        .from('routine_items')
        .select('id, employee_id, title, detail, sort_order, is_active, created_at, employee:employees!routine_items_employee_id_fkey(id, full_name, employee_code)')
        .eq('is_active', true)
        .order('sort_order').order('id');
      return employeeId ? query.eq('employee_id', employeeId) : query;
    }),
  });
}

/**
 * Ticks for ONE day.
 *
 * Bounded to the day on purpose: this table grows by a row per duty per person per day forever, and
 * nothing on screen ever asks about last March.
 */
export function useRoutineTicks(onDate, { enabled = true, employeeId } = {}) {
  const day = onDate ?? istToday();
  return useQuery({
    enabled,
    queryKey: employeeId ? ['routine-ticks', day, employeeId] : ['routine-ticks', day],
    queryFn: () => fetchCollection(() => {
      const query = supabase
        .from('routine_ticks')
        .select('id, routine_item_id, employee_id, on_date, done_at')
        .eq('on_date', day).order('id');
      return employeeId ? query.eq('employee_id', employeeId) : query;
    }),
  });
}

function useRoutineCaches() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['routine-items'] });
    qc.invalidateQueries({ queryKey: ['routine-ticks'] });
  };
}

/**
 * Tick or un-tick one duty for one day.
 *
 * An upsert, not an insert: the unique index makes a second tick the same fact arriving twice, and
 * a duplicate-key error is not something to show somebody who double-tapped. Un-ticking deletes,
 * because "not done" is the absence of a tick rather than a tick saying no.
 */
export function useSetRoutineTick() {
  const { employee } = useAuth();
  const invalidate = useRoutineCaches();
  return useMutation({
    mutationFn: async ({ itemId, employeeId, onDate, done }) => {
      const day = onDate ?? istToday();
      if (done) {
        const { data, error } = await supabase
          .from('routine_ticks')
          .upsert(
            { routine_item_id: itemId, employee_id: employeeId, on_date: day, done_by: employee?.id ?? null },
            { onConflict: 'routine_item_id,on_date' }
          ).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('That duty could not be marked done. Your access may have changed.');
      } else {
        const { data, error } = await supabase
          .from('routine_ticks').delete().eq('routine_item_id', itemId).eq('on_date', day).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('That duty could not be reopened. Refresh the routine and try again.');
      }
    },
    onSuccess: invalidate,
  });
}

export function useSaveRoutineItem() {
  const { employee } = useAuth();
  const invalidate = useRoutineCaches();
  return useMutation({
    mutationFn: async ({ id, employeeId, title, detail, sortOrder }) => {
      const row = {
        employee_id: employeeId,
        title: (title ?? '').trim(),
        detail: (detail ?? '').trim() || null,
        sort_order: Number(sortOrder) || 0,
      };
      if (!row.title) throw new Error('A duty needs a name.');
      const q = id
        ? supabase.from('routine_items').update(row).eq('id', id).select('id')
        : supabase.from('routine_items').insert({ ...row, created_by: employee?.id ?? null }).select('id');
      const { data, error } = await q;
      if (error) throw error;
      if (!data?.length) throw new Error('That routine could not be saved. Your access may have changed.');
    },
    onSuccess: invalidate,
  });
}

/**
 * Retire a duty rather than delete it: the ticks are a record of work that was actually done, and
 * `on delete cascade` would take that history with it.
 */
export function useRetireRoutineItem() {
  const invalidate = useRoutineCaches();
  return useMutation({
    mutationFn: async (id) => {
      const { data, error } = await supabase
        .from('routine_items').update({ is_active: false }).eq('id', id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('That duty could not be retired.');
    },
    onSuccess: invalidate,
  });
}
