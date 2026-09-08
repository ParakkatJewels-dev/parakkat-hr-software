// Asking another department for a hand, and answering when you are asked.
//
// Everything goes through an RPC. A head has no rights over the department they are asking — that
// is the whole reason for asking — so "may I raise this", "may I answer it" and "may I look inside
// that team to name someone" are all decided in the database, not by which buttons the client drew.
// See migration 0101.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

const SELECT = `
  id, status, title, description, priority, due_date, created_at, decided_at, decision_note, task_id,
  from_department_id, to_department_id,
  from_department:departments!help_requests_from_department_id_fkey(name, code),
  to_department:departments!help_requests_to_department_id_fkey(name, code),
  requester:employees!help_requests_requested_by_fkey(id, full_name, employee_code),
  preferred:employees!help_requests_preferred_employee_id_fkey(id, full_name, employee_code),
  assignee:employees!help_requests_assigned_employee_id_fkey(id, full_name, employee_code),
  decider:employees!help_requests_decided_by_fkey(id, full_name),
  task:tasks!help_requests_task_id_fkey(id, status, due_date)
`;

/**
 * Every request this person is either side of. RLS returns both ends, so the split into "asked"
 * and "received" is done here from the department ids rather than by running two queries.
 */
export function useHelpRequests({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['help-requests'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('help_requests')
        .select(SELECT)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Names and codes in one department, for naming a preference. Nothing else — see 0101. */
export function useDepartmentPeople(departmentId, query) {
  const q = (query ?? '').trim();
  return useQuery({
    enabled: Boolean(departmentId),
    queryKey: ['department-people', departmentId, q],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('department_people', {
        _department: departmentId,
        _q: q || null,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Departments in the companies this person can see, so they can choose who to ask. */
export function useDepartments() {
  return useQuery({
    queryKey: ['org', 'departments'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('departments')
        .select('id, name, code, entity_id, branch_id')
        .eq('is_active', true)
        .order('name')
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Accepting creates a task, so the task caches have to go too — the board, the counts and the
// notification badges all change on the strength of one click here.
const TOUCHED = [
  ['help-requests'], ['tasks'], ['notifications'], ['notification-ref-statuses'],
];

export function useRequestHelp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ fromDepartmentId, toDepartmentId, title, description, preferredId, priority, dueDate }) => {
      const { data, error } = await supabase.rpc('request_department_help', {
        _from_department: fromDepartmentId,
        _to_department: toDepartmentId,
        _title: title,
        _description: description || null,
        _preferred: preferredId || null,
        _priority: priority || 'Medium',
        _due_date: dueDate || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => TOUCHED.forEach((key) => qc.invalidateQueries({ queryKey: key })),
  });
}

export function useRespondToHelpRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ requestId, accept, assigneeId, note }) => {
      const { data, error } = await supabase.rpc('respond_to_help_request', {
        _request: requestId,
        _accept: accept,
        _assignee: assigneeId || null,
        _note: note || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => TOUCHED.forEach((key) => qc.invalidateQueries({ queryKey: key })),
  });
}

export function useCancelHelpRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requestId) => {
      const { error } = await supabase.rpc('cancel_help_request', { _request: requestId });
      if (error) throw error;
    },
    onSuccess: () => TOUCHED.forEach((key) => qc.invalidateQueries({ queryKey: key })),
  });
}
