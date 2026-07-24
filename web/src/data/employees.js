// Data-access hook for employees. RLS scopes the rows automatically to what the caller may see
// (super admin = all; branch HR = their branch; employee = just themselves).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useEmployees() {
  return useQuery({
    queryKey: ['employees'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select(
          `id, full_name, employee_code, status, email, phone, join_date, salary,
           entity:entities(code,name),
           branch:branches(code,name),
           department:departments(name),
           designation:designations(title,grade)`
        )
        .order('full_name', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}
