// Team membership: which department a person sits in, changed by the head who actually manages them.
//
// Every call here goes through an RPC rather than touching public.employees directly, and that is
// the point. A department head is deliberately NOT granted employee.update — `salary`, `pan`,
// `aadhaar` and `bank_account` live on that row — so the database exposes exactly two verbs
// (move someone, list who I could move) and nothing else. See migration 0099.
//
// None of this reaches Easy Time Pro. The device integration is read-only towards the terminal by
// construction, so correcting a department here changes nothing on any biometric reader.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

/** The departments this user may actually build a team for. Derived server-side from their grants. */
export function useMyDepartments({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['my-departments'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_departments');
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** The people already in one department. Plain RLS read — a head can always see their own team. */
export function useDepartmentMembers(departmentId) {
  return useQuery({
    enabled: Boolean(departmentId),
    queryKey: ['department-members', departmentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('id, full_name, employee_code, status, designation:designations(title), branch:branches(code)')
        .eq('department_id', departmentId)
        .eq('status', 'Active')
        .order('full_name')
        .limit(2000);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Who this user could add to `departmentId`.
 *
 * An RPC, not a Directory query, because a department head holds employee.read at DEPARTMENT scope
 * — RLS shows them their own team and nobody else, so a plain query would return an empty picker.
 * The function returns the five fields a picker needs, to someone who may already assign into that
 * department, within the same company. See 0099.
 */
export function useAssignableEmployees(departmentId, query) {
  const q = (query ?? '').trim();
  return useQuery({
    enabled: Boolean(departmentId),
    queryKey: ['assignable-employees', departmentId, q],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('assignable_employees', {
        _department: departmentId,
        _q: q || null,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** What was moved by hand, so it can be reconciled when Easy Time Pro is corrected at source. */
export function useDepartmentMoves(departmentId) {
  return useQuery({
    enabled: Boolean(departmentId),
    queryKey: ['department-moves', departmentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('department_moves')
        .select(`id, moved_at, employee_id, from_department_id, to_department_id,
                 employee:employees!department_moves_employee_id_fkey(full_name, employee_code),
                 from_department:departments!department_moves_from_department_id_fkey(name),
                 to_department:departments!department_moves_to_department_id_fkey(name)`)
        .or(`to_department_id.eq.${departmentId},from_department_id.eq.${departmentId}`)
        .order('moved_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Move one person into a department, or out of one with `departmentId: null`.
 *
 * Invalidates broadly on purpose: department_id is the column every scope in this app reads, so a
 * move changes who appears on the attendance roster, whose leave routes to whom, and which tasks
 * are in scope. Refetching only the team list would leave the rest of the app showing the old shape.
 */
export function useMoveEmployeeDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ employeeId, departmentId }) => {
      const { error } = await supabase.rpc('move_employee_to_department', {
        _employee: employeeId,
        _department: departmentId ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      for (const key of [
        ['my-departments'], ['department-members'], ['assignable-employees'],
        ['department-moves'], ['employees'], ['org'],
      ]) qc.invalidateQueries({ queryKey: key });
    },
  });
}
