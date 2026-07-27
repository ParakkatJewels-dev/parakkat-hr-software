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
        .select('id,key,name,description,is_system,role_permissions(permission:permissions(key))')
        .order('key');
      if (error) throw error;
      return (data ?? []).map((r) => ({
        ...r,
        permissionKeys: (r.role_permissions ?? []).map((rp) => rp.permission?.key).filter(Boolean).sort(),
      }));
    },
  });
}

/**
 * One-step "give app access": creates the login if needed, links the employee and grants the
 * role — all inside a single database transaction, so a failure can never leave a half-made
 * login behind. Re-running for the same person reuses their login and skips a role they hold.
 */
export function useGrantAppAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ employee_id, email, password, role_key, scope_type, scope_id }) => {
      const { data, error } = await supabase.rpc('grant_app_access', {
        _employee_id: employee_id,
        _email: email,
        _password: password,
        _role_key: role_key,
        _scope_type: scope_type,
        _scope_id: scope_id ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['managed-users'] });
      qc.invalidateQueries({ queryKey: ['employees'] });
    },
  });
}

/**
 * Delete a login for good. The employee record, their attendance and every other history stay —
 * only the ability to sign in is removed. Refused for your own login and for the last super admin.
 */
export function useDeleteLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (user_id) => {
      const { error } = await supabase.rpc('delete_login', { _user: user_id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['managed-users'] });
      qc.invalidateQueries({ queryKey: ['employees'] });
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

// The full permission catalog, grouped by resource — powers the role editor's checkbox grid.
export function usePermissionCatalog() {
  return useQuery({
    queryKey: ['permission-catalog'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('permissions')
        .select('key,resource,action,description')
        .order('resource')
        .order('action');
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Create a custom role or replace an existing role's permission set (super admin only).
// Pass roleId = null to create.
export function useSaveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roleId = null, key, name, description, permissionKeys }) => {
      const { data, error } = await supabase.rpc('save_role', {
        _role_id: roleId,
        _key: key ?? null,
        _name: name ?? null,
        _description: description ?? null,
        _permission_keys: permissionKeys ?? [],
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['roles-with-perms'] });
    },
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (roleId) => {
      const { error } = await supabase.rpc('delete_role', { _role_id: roleId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['roles-with-perms'] });
    },
  });
}

// Toggle a login's global super-admin flag.
export function useSetSuperAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ user_id, flag }) => {
      const { error } = await supabase.rpc('set_super_admin', { _user: user_id, _flag: flag });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managed-users'] }),
  });
}

// Create a login directly (super admin only) — the admin sets the email + password, no email is
// sent. Backed by the admin_create_user RPC, then optionally link an employee and/or promote to
// super admin. No Edge Function / service_role key in the browser.
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ email, password, employee_id, super_admin }) => {
      const { data: userId, error } = await supabase.rpc('admin_create_user', {
        _email: email,
        _password: password,
      });
      if (error) throw error;
      if (employee_id) {
        const { error: linkErr } = await supabase.rpc('link_user_to_employee', {
          _user: userId, _employee: employee_id,
        });
        if (linkErr) throw linkErr;
      }
      if (super_admin) {
        const { error: saErr } = await supabase.rpc('set_super_admin', { _user: userId, _flag: true });
        if (saErr) throw saErr;
      }
      return { user_id: userId, email };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managed-users'] }),
  });
}
