import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { applyChatPreference, chatPreferencesKey, fetchChatPreferences, setChatPreference } from '../lib/chatPreferences';

/** Personal pins/favourites are scoped to the signed-in user and their actual employee link. */
export function useChatPreferences() {
  const { user, employee } = useAuth();
  return useQuery({
    queryKey: chatPreferencesKey(user?.id, employee?.id),
    enabled: Boolean(user?.id && employee?.id),
    queryFn: () => fetchChatPreferences(supabase),
    refetchOnWindowFocus: true,
  });
}

export function useSetChatPreference() {
  const { user, employee } = useAuth();
  const qc = useQueryClient();
  const key = chatPreferencesKey(user?.id, employee?.id);
  return useMutation({
    // Serialize this client's toggles, including rapid clicks, while the server merges flags.
    scope: { id: key.join(':') },
    mutationFn: (payload) => setChatPreference(supabase, payload),
    onSuccess: (saved) => {
      qc.setQueryData(key, (rows) => applyChatPreference(rows, saved));
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}
