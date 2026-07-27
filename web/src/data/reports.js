// Reporting hooks. The attendance summary aggregates in the database (SECURITY INVOKER RPC, so
// RLS scopes it to the caller: branch manager → their branch, admin → everything). The other
// report tabs reuse the module hooks, which are already RLS-scoped.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useAttendanceReport(from, to) {
  return useQuery({
    enabled: Boolean(from && to),
    queryKey: ['report', 'attendance-summary', from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('report_attendance_summary', {
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Month-to-date exception counters as ONE row, instead of pulling every exception row. */
export function useAttendanceExceptionSummary(from, to) {
  return useQuery({
    enabled: Boolean(from && to),
    queryKey: ['report', 'attendance-exceptions', from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('report_attendance_exceptions', {
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return data?.[0] ?? {};
    },
  });
}
