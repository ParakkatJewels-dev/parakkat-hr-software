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
      // Bounded by TIME, not by an arbitrary count. `.limit(200)` newest-first quietly drops the
      // oldest request once the company passes two hundred, and the ones it drops are exactly the
      // ones an administrator is hunting for — the stale asks nobody answered. A year's window
      // keeps every open request whatever the volume, and the closed ones stop accumulating.
      //
      // The same shape as the task board's own window (CLOSED_TASK_WINDOW_DAYS in taskBoard.js).
      const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('help_requests')
        .select(SELECT)
        // Anything still Pending stays visible however old it is; only settled requests age out.
        .or(`status.eq.Pending,created_at.gte.${since}`)
        .order('created_at', { ascending: false })
        .limit(2000);
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
    mutationFn: async ({ requestId, accept, assigneeId, note, priority }) => {
      const { data, error } = await supabase.rpc('respond_to_help_request', {
        _request: requestId,
        _accept: accept,
        _assignee: assigneeId || null,
        _note: note || null,
        // Null means "keep what was asked for". The head taking the work decides how urgent it is
        // on their own board — see migration 0103.
        _priority: priority || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => TOUCHED.forEach((key) => qc.invalidateQueries({ queryKey: key })),
  });
}

/** Correct a request nobody has answered yet. Null means "leave it"; the clear flags mean "remove it". */
export function useUpdateHelpRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ requestId, title, description, priority, dueDate, preferredId, clearPreferred, clearDue }) => {
      const { error } = await supabase.rpc('update_help_request', {
        _request: requestId,
        _title: title ?? null,
        _description: description ?? null,
        _priority: priority ?? null,
        _due_date: dueDate || null,
        _preferred: preferredId || null,
        _clear_preferred: Boolean(clearPreferred),
        _clear_due: Boolean(clearDue),
      });
      if (error) throw error;
    },
    onSuccess: () => TOUCHED.forEach((key) => qc.invalidateQueries({ queryKey: key })),
  });
}

/**
 * Change WHAT the work is, on a task you asked another department for.
 *
 * Not who is doing it or where it stands — the receiving head chose the person and the person owns
 * the progress, so those columns are not in the update at all (0104).
 */
export function useUpdateRequestedTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, title, description, priority, dueDate, clearDue }) => {
      const { error } = await supabase.rpc('update_requested_task', {
        _task: taskId,
        _title: title ?? null,
        _description: description ?? null,
        _priority: priority ?? null,
        _due_date: dueDate || null,
        _clear_due: Boolean(clearDue),
      });
      if (error) throw error;
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
