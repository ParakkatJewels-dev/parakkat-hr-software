import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from '../auth/AuthContext';
import { createTypingPublisher, subscribeToTyping, bindTypingLifecycle, isTypingUnavailable } from './chatTyping';

/** Real keystroke activity, visible only to members of accepted conversations. */
export function useChatTyping({ conversationId, me, enabled = true }) {
  const { user, employee } = useAuth();
  const allowed = Boolean(enabled && conversationId && me && user?.id && employee?.id === me);
  const [state, setState] = useState({ key: null, ids: [] });
  const publisherRef = useRef(null);
  const key = allowed ? `${conversationId}:${me}:${user.id}` : null;

  useEffect(() => {
    if (!allowed) return undefined;
    let writable = true;
    const publisher = createTypingPublisher({
      write: async (typing) => {
        if (!writable) return;
        const { data: authData } = await supabase.auth.getSession();
        if (!writable || authData.session?.user?.id !== user.id) return;
        const { error } = await supabase.rpc('set_chat_typing', { _conversation_id: conversationId, _typing: typing });
        if (error) throw error;
      },
      // Missing schema / membership loss disables optional typing; ordinary connection errors
      // retry within the publisher's throttle so a mobile network change doesn't disable it.
      onError: (error) => {
        if (isTypingUnavailable(error)) { writable = false; publisher.stop(); }
      },
    });
    publisherRef.current = { key, publisher };
    const feed = subscribeToTyping({
      client: supabase, conversationId, me, isVisible: () => document.visibilityState === 'visible',
      onChange: (roster) => {
        const ids = roster.ids();
        setState((previous) => previous.key === key && previous.ids.join(',') === ids.join(',') ? previous : { key, ids });
      },
    });
    const removeLifecycle = bindTypingLifecycle({
      publisher, auth: supabase.auth, userId: user.id, windowTarget: window, documentTarget: document,
      onHidden: feed.clear, onVisible: feed.refresh,
      onSessionEnd: () => { writable = false; feed.endSession(); },
    });
    return () => {
      publisher.dispose();
      if (publisherRef.current?.publisher === publisher) publisherRef.current = null;
      removeLifecycle();
      feed.dispose();
    };
  }, [allowed, conversationId, me, key, user?.id]);

  const setTyping = useCallback((typing) => {
    const current = publisherRef.current;
    if (!current || current.key !== key) return;
    current.publisher.setTyping(Boolean(typing && allowed && document.visibilityState === 'visible' && document.hasFocus()));
  }, [allowed, key]);
  return { typingIds: allowed && state.key === key ? state.ids : [], setTyping };
}

/** One read-only subscription covers the whole inbox; it never publishes typing activity. */
export function useInboxTyping({ me, enabled = true }) {
  const { user, employee } = useAuth();
  const allowed = Boolean(enabled && me && user?.id && employee?.id === me);
  const key = allowed ? `${me}:${user.id}` : null;
  const [state, setState] = useState({ key: null, groups: {} });

  useEffect(() => {
    if (!allowed) return undefined;
    const feed = subscribeToTyping({
      client: supabase, me, isVisible: () => document.visibilityState === 'visible',
      onChange: (roster) => {
        const groups = roster.byConversation();
        setState((previous) => previous.key === key && JSON.stringify(previous.groups) === JSON.stringify(groups)
          ? previous : { key, groups });
      },
    });
    const removeLifecycle = bindTypingLifecycle({
      publisher: { stop() {} }, auth: supabase.auth, userId: user.id, windowTarget: window, documentTarget: document,
      onHidden: feed.clear, onVisible: feed.refresh, onSessionEnd: feed.endSession,
    });
    return () => {
      removeLifecycle();
      feed.dispose();
    };
  }, [allowed, me, key, user?.id]);
  return { typingByConversation: allowed && state.key === key ? state.groups : {} };
}
