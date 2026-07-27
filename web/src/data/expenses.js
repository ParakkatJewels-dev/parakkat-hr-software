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
          `id, category, amount, expense_date, description, status, created_at,
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

export function useSetExpenseStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }) => {
      const { error } = await supabase.from('expenses').update({ status }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}
