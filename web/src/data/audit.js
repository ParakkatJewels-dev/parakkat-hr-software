// Audit trail (RLS-scoped by audit.read). Read-only.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchAuditPage } from '../lib/auditQuery';

export function useAuditLog(options) {
  return useQuery({
    queryKey: ['audit-log', options],
    queryFn: () => fetchAuditPage(supabase, options),
  });
}
