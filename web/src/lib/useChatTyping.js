import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from '../auth/AuthContext';
import { createTypingPublisher, createTypingRoster, bindTypingLifecycle } from './chatTyping';

/** Real keystroke activity, visible only to members of accepted conversations. */
export function useChatTyping({ conversationId, me, enabled = true }) {
  const { user, employee } = useAuth();
  const allowed = Boolean(enabled && conversationId && me && user?.id && employee?.id === me);
  const [state, setState] = useState({ key: null, ids: [] });
  const publisherRef = useRef(null);
  const key = allowed ? `${conversationId}:${me}:${user.id}` : null;

  useEffect(() => {
    if (!allowed) return undefined;
    let closed = false, writable = true, sessionActive = true, refreshVersion = 0;
    const roster = createTypingRoster({ conversationId, me });
    const paint = () => {
      if (closed) return;
      const ids = roster.ids();
      setState((previous) => previous.key === key && previous.ids.join(',') === ids.join(',') ? previous : { key, ids });
    };
    const publisher = createTypingPublisher({
      write: async (typing) => {
        if (!writable) return;
        const { data: authData } = await supabase.auth.getSession();
        if (!writable || authData.session?.user?.id !== user.id) return;
        const { error } = await supabase.rpc('set_chat_typing', { _conversation_id: conversationId, _typing: typing });
        if (error) throw error;
      },
      // Typing is optional. A missing migration or permission loss must never interrupt messages
      // or send a failing request for every keystroke. A new thread mount can try again.
      onError: () => { writable = false; publisher.stop(); },
    });
    publisherRef.current = { key, publisher };
    const refresh = async () => {
      const version = ++refreshVersion;
      try {
        const { data, error } = await supabase.from('chat_typing')
          .select('id,conversation_id,employee_id,is_typing,updated_at,expires_at')
          .eq('conversation_id', conversationId).eq('is_typing', true).neq('employee_id', me);
        if (closed || !sessionActive || version !== refreshVersion || document.visibilityState !== 'visible') return;
        if (error) { roster.clear(); paint(); return; }
        for (const row of data ?? []) roster.upsert(row);
        paint();
      } catch { if (!closed) { roster.clear(); paint(); } }
    };
    const channel = supabase.channel(`chat-typing:${conversationId}:${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_typing', filter: `conversation_id=eq.${conversationId}` }, (payload) => {
        if (closed || !sessionActive || document.visibilityState !== 'visible') return;
        if (payload.eventType === 'DELETE') roster.remove(payload.old?.id);
        else roster.upsert(payload.new);
        paint();
      }).subscribe((status) => {
        if (status === 'SUBSCRIBED') void refresh();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { roster.clear(); paint(); }
      });
    void refresh();
    // A dropped socket/tab must never leave somebody “typing” indefinitely.
    const expiryTimer = setInterval(paint, 250);
    const removeLifecycle = bindTypingLifecycle({
      publisher, auth: supabase.auth, userId: user.id, windowTarget: window, documentTarget: document,
      onHidden: () => { refreshVersion += 1; roster.clear(); paint(); },
      onVisible: () => { void refresh(); },
      onSessionEnd: () => { writable = false; sessionActive = false; },
    });
    return () => {
      closed = true;
      publisher.dispose();
      if (publisherRef.current?.publisher === publisher) publisherRef.current = null;
      clearInterval(expiryTimer);
      removeLifecycle();
      supabase.removeChannel(channel);
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
    let closed = false, sessionActive = true, refreshVersion = 0;
    const roster = createTypingRoster({ me });
    const paint = () => {
      if (closed) return;
      const groups = roster.byConversation();
      setState((previous) => previous.key === key && JSON.stringify(previous.groups) === JSON.stringify(groups)
        ? previous : { key, groups });
    };
    const clear = () => { refreshVersion += 1; roster.clear(); paint(); };
    const refresh = async () => {
      const version = ++refreshVersion;
      try {
        // Membership, accepted-request status and server expiry are enforced by table RLS.
        const { data, error } = await supabase.from('chat_typing')
          .select('id,conversation_id,employee_id,is_typing,updated_at,expires_at')
          .eq('is_typing', true).neq('employee_id', me);
        if (closed || !sessionActive || version !== refreshVersion || document.visibilityState !== 'visible') return;
        if (error) { clear(); return; }
        for (const row of data ?? []) roster.upsert(row);
        paint();
      } catch { if (!closed) clear(); }
    };
    const channel = supabase.channel(`inbox-typing:${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_typing' }, (payload) => {
        if (closed || !sessionActive || document.visibilityState !== 'visible') return;
        if (payload.eventType === 'DELETE') roster.remove(payload.old?.id);
        else roster.upsert(payload.new);
        paint();
      }).subscribe((status) => {
        if (status === 'SUBSCRIBED') void refresh();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') clear();
      });
    void refresh();
    const expiryTimer = setInterval(paint, 250);
    const removeLifecycle = bindTypingLifecycle({
      publisher: { stop() {} }, auth: supabase.auth, userId: user.id, windowTarget: window, documentTarget: document,
      onHidden: clear, onVisible: () => { void refresh(); }, onSessionEnd: () => { sessionActive = false; },
    });
    return () => {
      closed = true;
      clearInterval(expiryTimer);
      removeLifecycle();
      supabase.removeChannel(channel);
    };
  }, [allowed, me, key, user?.id]);
  return { typingByConversation: allowed && state.key === key ? state.groups : {} };
}
