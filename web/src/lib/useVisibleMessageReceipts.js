import { useEffect, useRef } from 'react';

/** A mounted thread is not necessarily being read: require a visible, focused message viewport. */
export function useVisibleMessageReceipts({ conversationId, messages, me, enabled, viewportRef, markRead }) {
  const acknowledged = useRef(new Set());
  const pending = useRef(new Set());
  const mutationRef = useRef(markRead);
  mutationRef.current = markRead;

  useEffect(() => {
    if (!enabled || !viewportRef.current) return;
    const viewport = viewportRef.current;
    const received = new Set(messages.filter((message) => message.sender_id !== me && !message.deleted_at).map((message) => message.id));
    let timer, closed = false;
    const visibleIds = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus() || navigator.onLine === false
          || document.querySelector('[aria-modal="true"]')) return [];
      const frame = viewport.getBoundingClientRect();
      if (!frame.width || !frame.height) return [];
      return Array.from(viewport.querySelectorAll('[data-message-id]')).filter((node) => {
        const id = node.dataset.messageId;
        if (!received.has(id) || acknowledged.current.has(id) || pending.current.has(id)) return false;
        const rect = node.getBoundingClientRect();
        const height = Math.min(rect.bottom, frame.bottom, window.innerHeight) - Math.max(rect.top, frame.top, 0);
        return rect.width > 0 && height >= Math.min(rect.height, frame.height) * 0.5;
      }).map((node) => node.dataset.messageId);
    };
    const flush = async () => {
      const messageIds = visibleIds();
      if (!messageIds.length || closed) return;
      for (const id of messageIds) pending.current.add(id);
      try {
        await mutationRef.current.mutateAsync({ conversationId, messageIds });
        for (const id of messageIds) acknowledged.current.add(id);
      } catch {
        if (!closed) timer = setTimeout(flush, 5000);
      } finally {
        for (const id of messageIds) pending.current.delete(id);
      }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 200); };
    viewport.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('visibilitychange', schedule);
    document.addEventListener('focusin', schedule);
    window.addEventListener('focus', schedule);
    window.addEventListener('blur', schedule);
    window.addEventListener('online', schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
    schedule();
    return () => {
      closed = true;
      clearTimeout(timer);
      resize.disconnect();
      viewport.removeEventListener('scroll', schedule);
      document.removeEventListener('visibilitychange', schedule);
      document.removeEventListener('focusin', schedule);
      window.removeEventListener('focus', schedule);
      window.removeEventListener('blur', schedule);
      window.removeEventListener('online', schedule);
    };
  }, [conversationId, messages, me, enabled, viewportRef]);
}
