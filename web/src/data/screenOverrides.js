// Screens hidden from one person on top of their role (migration 0109).
//
// Plain table reads and writes rather than an RPC: there is no computation to do server-side, and
// user_screen_overrides_write already carries the whole rule — you must hold rbac.manage, you must
// outrank the target, and you may not narrow yourself. A wrapper function would only restate it.
//
// NARROWS ONLY. There is no "allow" row; the absence of a row is the permitted state. So the two
// verbs here are hide and unhide, and neither can widen anybody's access beyond their role.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

/** The screens currently hidden from one user. */
export function useScreenOverrides(userId) {
  return useQuery({
    enabled: Boolean(userId),
    queryKey: ['screen-overrides', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_screen_overrides')
        .select('id, screen_id, reason, created_at')
        .eq('user_id', userId)
        .order('screen_id');
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Hide a screen, or put it back.
 *
 * `hidden` is the state you want the screen to end in, so the caller passes a checkbox value
 * rather than working out which of two mutations to fire.
 */
export function useSetScreenOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, screenId, hidden, reason = null }) => {
      if (hidden) {
        const { error } = await supabase
          .from('user_screen_overrides')
          .upsert(
            { user_id: userId, screen_id: screenId, reason },
            { onConflict: 'user_id,screen_id' }
          );
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('user_screen_overrides')
          .delete()
          .eq('user_id', userId)
          .eq('screen_id', screenId);
        if (error) throw error;
      }
      return { screenId, hidden };
    },
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['screen-overrides', vars.userId] });
      // The target's own session is repainted by AuthContext's realtime subscription on this
      // table; this only refreshes the administrator's view of it.
      qc.invalidateQueries({ queryKey: ['managed-users'] });
    },
  });
}
