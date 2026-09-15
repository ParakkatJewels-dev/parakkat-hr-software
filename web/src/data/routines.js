// Named routines contain jobs that recur on scheduled dates. The database decides which jobs
// are due and who may record completion; the browser never supplies the completion actor.
//
// No permission of its own (0107). Reading follows task.read — an employee holds it at self scope
// and sees their own list, a head holds it over their team. Defining follows task.create, which
// 0021 took away from employees precisely so that work is assigned downward. Ticking follows
// task.update, which is the one thing an employee may record on their own work.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';
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

export function useRoutineSets({ enabled = true, employeeId, includeRetired = false } = {}) {
  return useQuery({
    enabled,
    queryKey: ['routine-sets', employeeId ?? 'all', includeRetired],
    queryFn: () => fetchCollection(() => supabase.rpc('list_routine_sets', {
      _employee_id: employeeId ?? null, _include_retired: includeRetired,
    }).order('id')),
  });
}

export function useRoutineDay(onDate, { enabled = true, employeeId } = {}) {
  const day = onDate ?? istToday();
  return useQuery({
    enabled,
    queryKey: ['routine-day', day, employeeId ?? 'all'],
    queryFn: () => fetchCollection(() => supabase.rpc('routine_day', {
      _on_date: day, _employee_id: employeeId ?? null,
    }).order('id')),
  });
}

export function useRoutineStats(from, to, { enabled = true, employeeIds } = {}) {
  const ids = employeeIds ? [...new Set(employeeIds)].sort() : null;
  return useQuery({
    enabled: enabled && Boolean(from && to),
    queryKey: ['routine-stats', from, to, ids],
    queryFn: () => fetchCollection(() => supabase.rpc('routine_completion_stats', {
      _from: from, _to: to, _employee_ids: ids,
    }).order('id')),
  });
}

function useRoutineCaches() {
  const qc = useQueryClient();
  return () => Promise.all(['routine-items', 'routine-ticks', 'routine-sets', 'routine-day', 'routine-stats']
    .map((key) => qc.invalidateQueries({ queryKey: [key] })));
}

/** Record or reopen one due job. The RPC validates the date, owner, scope and actor atomically. */
export function useSetRoutineTick() {
  const invalidate = useRoutineCaches();
  return useMutation({
    mutationFn: async ({ itemId, onDate, done }) => {
      const { data, error } = await supabase.rpc('set_routine_job_tick', {
        _item_id: itemId, _on_date: onDate ?? istToday(), _done: Boolean(done),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useCreateRoutineSet() {
  const invalidate = useRoutineCaches();
  return useMutation({
    mutationFn: async ({ employeeIds, title, jobs, schedule, detail }) => {
      const { data, error } = await supabase.rpc('create_routine_set', {
        _employee_ids: [...new Set(employeeIds ?? [])], _title: String(title ?? '').trim(),
        _jobs: jobs, _schedule: schedule, _detail: String(detail ?? '').trim() || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useReplaceRoutineSet() {
  const invalidate = useRoutineCaches();
  return useMutation({
    mutationFn: async ({ id, title, jobs, schedule, detail }) => {
      const { data, error } = await supabase.rpc('replace_routine_set', {
        _id: id, _title: String(title ?? '').trim(), _jobs: jobs,
        _schedule: schedule, _detail: String(detail ?? '').trim() || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useRetireRoutineSet() {
  const invalidate = useRoutineCaches();
  return useMutation({
    mutationFn: async (id) => {
      const { data, error } = await supabase.rpc('retire_routine_set', { _id: id });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}
