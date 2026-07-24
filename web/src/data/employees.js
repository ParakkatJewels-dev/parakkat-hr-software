// Data-access hooks for employees. RLS scopes the rows automatically to what the caller may see
// (super admin = all; branch HR = their branch; employee = just themselves). Writes require
// employee.create / employee.update at the row's scope; entity/zone ancestry is stamped by a DB
// trigger from the chosen branch/department.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useEmployees() {
  return useQuery({
    queryKey: ['employees'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select(
          `id, full_name, employee_code, status, email, phone, join_date, salary,
           entity_id, zone_id, branch_id, department_id, designation_id,
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

// Fields an admin may set. entity_id is required (NOT NULL); branch/department/designation optional.
const EMPLOYEE_COLS = [
  'full_name', 'employee_code', 'email', 'phone', 'join_date', 'status',
  'entity_id', 'branch_id', 'department_id', 'designation_id',
];

function cleanEmployeePayload(input) {
  const row = {};
  for (const k of EMPLOYEE_COLS) {
    if (k in input) row[k] = input[k] === '' ? null : input[k];
  }
  return row;
}

export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const { data, error } = await supabase
        .from('employees')
        .insert(cleanEmployeePayload(payload))
        .select('id, full_name, employee_code')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}

export function useUpdateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }) => {
      const { data, error } = await supabase
        .from('employees')
        .update(cleanEmployeePayload(patch))
        .eq('id', id)
        .select('id')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}
