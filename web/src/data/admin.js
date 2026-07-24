// Data hooks for User & Role Management.
// Listing users uses a SECURITY DEFINER RPC (browser can't read auth.users). Assign/revoke go
// straight to role_assignments — RLS + the escalation guard enforce who may grant what, where.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useManagedUsers() {
  return useQuery({
    queryKey: ['managed-users'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_managed_users');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      const { data, error } = await supabase.from('roles').select('id,key,name,description').order('key');
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Roles with their permission keys (for the read-only Roles matrix).
export function useRolesWithPermissions() {
  return useQuery({
    queryKey: ['roles-with-perms'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('roles')
        .select('id,key,name,description,role_permissions(permission:permissions(key))')
        .order('key');
      if (error) throw error;
      return (data ?? []).map((r) => ({
        ...r,
        permissionKeys: (r.role_permissions ?? []).map((rp) => rp.permission?.key).filter(Boolean).sort(),
      }));
    },
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ user_id, role_id, scope_type, scope_id }) => {
      const { error } = await supabase
        .from('role_assignments')
        .insert({ user_id, role_id, scope_type, scope_id: scope_id || null });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managed-users'] }),
  });
}

export function useRevokeRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (assignmentId) => {
      const { error } = await supabase.from('role_assignments').delete().eq('id', assignmentId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managed-users'] }),
  });
}

export function useLinkEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ user_id, employee_id }) => {
      const { error } = await supabase.rpc('link_user_to_employee', {
        _user: user_id,
        _employee: employee_id || null,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managed-users'] }),
  });
}
