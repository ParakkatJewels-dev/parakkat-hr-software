// Payroll: payslips scoped by payslip.read (own for employees; scoped for HR/managers).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function usePayslips() {
  return useQuery({
    queryKey: ['payslips'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payslips')
        .select('id, period, gross, deductions, net, status, employee:employees(full_name, employee_code, branch:branches(code))')
        .order('period', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}
