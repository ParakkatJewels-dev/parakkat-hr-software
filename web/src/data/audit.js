// Audit trail (RLS-scoped by audit.read). Read-only.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useAuditLog() {
  return useQuery({
    queryKey: ['audit-log'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_log')
        .select('id, actor_email, action, table_name, row_id, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });
}
