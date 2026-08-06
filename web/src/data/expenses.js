// Data hooks for the Expense module. RLS scopes rows; approve requires expense.approve at scope.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { windowStartIso } from '../lib/dates';

export function useExpenses({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['expenses'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('expenses')
        .select(
          // The ancestry columns are here so the screen can ask, per row, whether THIS claim is one
          // the viewer may decide — expenses_update checks all five. Without them the buttons were
          // drawn from a single canAny('expense.approve'), which is true for a branch manager and
          // then offered on every branch's claims.
          `id, category, amount, expense_date, description, status, created_at,
           entity_id, zone_id, branch_id, department_id, employee_id, created_by, approver_id,
           employee:employees!expenses_employee_id_fkey(id, full_name, employee_code, branch_id, branch:branches(code))`
        )
        .gte('expense_date', windowStartIso(180))
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAddExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const { error } = await supabase.from('expenses').insert({ ...payload, status: 'Pending' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

/**
 * Approve or reject a claim.
 *
 * The `.select()` is the point of this function, not decoration. Without it PostgREST answers an
 * UPDATE that RLS filtered down to zero rows with a plain success and no error — so pressing
 * Approve on a claim outside your scope did nothing at all, reported nothing at all, and refetched
 * the unchanged row. It reads exactly like "the status is not updating", which is how it was
 * reported. Asking for the updated row back turns that silence into something the screen can say.
 *
 * approver_id is stamped here because nothing was stamping it: the column has existed since the
 * table was created and every claim ever decided still has it null, so "who approved this?" had no
 * answer. The database cannot default it — auth.uid() would be right for the DEFAULT on insert, but
 * this is an update — so the caller has to supply it.
 */
export function useSetExpenseStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }) => {
      const { data: me } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from('expenses')
        .update({ status, approver_id: me?.user?.id ?? null })
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data?.length) {
        throw new Error(
          'That claim is outside the area you can approve, so nothing was changed. Ask whoever manages that branch or department to review it.'
        );
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}
