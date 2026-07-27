// Leave types and per-employee balances.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useLeaveTypes() {
  return useQuery({
    queryKey: ['leave-types'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leave_types')
        .select(
          `id, code, name, description, annual_quota, is_paid, allow_half_day, carry_forward,
           max_carry_forward, requires_approval, deducts_balance, colour, sort_order, is_active`
        )
        .order('sort_order');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSaveLeaveType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (type) => {
      const payload = {
        code: type.code?.toUpperCase(),
        name: type.name,
        description: type.description || null,
        annual_quota: Number(type.annual_quota) || 0,
        is_paid: type.is_paid !== false,
        allow_half_day: type.allow_half_day !== false,
        carry_forward: Boolean(type.carry_forward),
        max_carry_forward: Number(type.max_carry_forward) || 0,
        requires_approval: type.requires_approval !== false,
        deducts_balance: type.deducts_balance !== false,
        colour: type.colour || null,
        sort_order: Number(type.sort_order) || 0,
        is_active: type.is_active !== false,
      };

      const query = type.id
        ? supabase.from('leave_types').update(payload).eq('id', type.id)
        : supabase.from('leave_types').insert(payload);

      const { error } = await query;
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-types'] }),
  });
}

export function useLeaveBalances(employeeId, year = new Date().getFullYear(), { all = false } = {}) {
  return useQuery({
    // Guard: without this, a login with no linked employee passes undefined and silently gets
    // EVERY balance row RLS allows — shown to them as their own. Pass {all:true} deliberately.
    enabled: all || Boolean(employeeId),
    queryKey: ['leave-balances', employeeId ?? 'all', year],
    queryFn: async () => {
      let query = supabase
        .from('leave_balances')
        .select(
          `id, employee_id, leave_type_id, year, entitled, carried_forward, used, available,
           leave_type:leave_types(id, code, name, colour, is_paid),
           employee:employees!leave_balances_employee_id_fkey(id, full_name, employee_code)`
        )
        .eq('year', year)
        // 264 staff x N leave types. The old 2000 cap would silently truncate HR's
        // leave-liability report the day a 6th type was added; warn rather than lie.
        .limit(20000);

      if (employeeId) query = query.eq('employee_id', employeeId);

      const { data, error } = await query;
      if (error) throw error;
      if ((data?.length ?? 0) === 20000) {
        console.warn('[leave-balances] hit the row cap — results are truncated; add pagination');
      }
      return data ?? [];
    },
  });
}

/**
 * Give every active employee a balance row for a type/year, seeded from the annual quota.
 *
 * Balances are created lazily on first approval too, but doing it up front means HR can see and
 * adjust the year's entitlements before anyone applies — and adjust them per person, since the
 * quota on the type is only a starting point.
 */
export function useSeedBalances() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leaveTypeId, year, entitled }) => {
      const { data: employees, error: empError } = await supabase
        .from('employees')
        .select('id')
        .eq('status', 'Active')
        .limit(5000);
      if (empError) throw empError;

      const rows = (employees ?? []).map((e) => ({
        employee_id: e.id,
        leave_type_id: leaveTypeId,
        year,
        entitled: Number(entitled) || 0,
      }));

      // Chunked: a 250-row upsert is fine, but this also covers a group that grows later.
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await supabase
          .from('leave_balances')
          .upsert(rows.slice(i, i + 200), { onConflict: 'employee_id,leave_type_id,year', ignoreDuplicates: true });
        if (error) throw error;
      }

      return rows.length;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-balances'] }),
  });
}

export function useUpdateBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, entitled, carried_forward }) => {
      const { error } = await supabase
        .from('leave_balances')
        .update({
          ...(entitled !== undefined ? { entitled: Number(entitled) } : {}),
          ...(carried_forward !== undefined ? { carried_forward: Number(carried_forward) } : {}),
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-balances'] }),
  });
}
