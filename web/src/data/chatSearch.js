import { useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchChatSearchPage } from '../lib/chatSearch';

export function useChatSearch(conversationId, query, { enabled = true } = {}) {
  const term = String(query ?? '').trim();
  const result = useInfiniteQuery({
    queryKey: ['messages', conversationId, 'search', term],
    enabled: enabled && Boolean(conversationId && term),
    initialPageParam: null,
    queryFn: ({ pageParam }) => fetchChatSearchPage(supabase, conversationId, term, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return { ...result, data: result.data?.pages.flatMap((page) => page.messages) ?? [] };
}
