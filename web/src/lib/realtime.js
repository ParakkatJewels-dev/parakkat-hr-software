// Live sync: subscribe to Supabase Realtime (Postgres changes) and invalidate the matching
// React Query caches so every signed-in device updates the instant data changes — no manual reload.
// RLS still applies to Realtime, so each user only receives changes to rows they may see (e.g. an
// employee gets the INSERT for a task assigned to them). Requires the tables to be in the
// `supabase_realtime` publication — see migration 0022.
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabaseClient';
import { useAuth } from '../auth/AuthContext';
import { mergeConversationReceipts } from './messageReceipts';

const CHAT_TABLES = new Set(['messages', 'conversations', 'conversation_members']);
const CHAT_KEYS = [['messages'], ['conversations'], ['admin-conversations'], ['message-delivery']];
const ROUTINE_KEYS = [['routine-items'], ['routine-ticks'], ['routine-sets'], ['routine-day'], ['routine-stats']];
// These responses include server-computed reviewer/routing permissions. A head leaving a role,
// a staff transfer or a permission change can alter the queue without changing its request rows.
const WORKFLOW_ACCESS_KEYS = [['leaves'], ['leaves-period'], ['leave-balances'], ['ticket-access'],
  ['ticket-categories'], ['tickets'], ['notification-ref-statuses'], ...ROUTINE_KEYS];

// public table → query-key prefixes to invalidate when it changes. A prefix invalidates every
// query whose key starts with it (e.g. ['attendance'] covers ['attendance','day',date]).
const TABLE_KEYS = {
  notifications: [['notifications']],
  tasks: [['tasks'], ['notification-ref-statuses']],
  goals: [['goals']],
  // A help request is answered by somebody else, on another screen, and the person who raised it is
  // sitting looking at it. Without this the answer only arrives on the 5-minute safety poll.
  // ['tasks'] is here too: accepting a request CREATES a task, and the requester can see it (0101).
  help_requests: [['help-requests'], ['tasks'], ['notification-ref-statuses']],
  // A thread that needs a refresh is not a conversation, and a completion board a head is watching
  // should fill in as the floor ticks things off.
  task_comments:    [['task-comments'], ['task-comment-counts']],
  task_attachments: [['task-attachments'], ['task-attachment-counts']],
  routine_ticks: ROUTINE_KEYS,
  routine_items: ROUTINE_KEYS,
  routine_sets: ROUTINE_KEYS,
  leaves: [['leaves'], ['leaves-period'], ['leave-balances'], ['notification-ref-statuses']],
  leave_decisions: [['leaves'], ['notifications']],
  expenses: [['expenses'], ['notification-ref-statuses']],
  attendance_regularizations: [['regularizations'], ['notification-ref-statuses']],
  attendance: [['attendance']],
  // Punches invalidate ONLY the punch drill-down. They used to also invalidate ['attendance'],
  // which meant every punch re-pulled the (large) attendance queries on every connected admin's
  // screen — during the morning rush that is a refetch per person walking in. Attendance is
  // derived from punches by the engine, and the engine's own write emits an `attendance` event.
  raw_punches: [['punches']],
  // Queued work for the sync service. Pushed rather than polled so a button press shows its
  // outcome the moment the service writes it back, instead of on the next 5-second tick.
  service_commands: [['service-commands'], ['sync-runs'], ['sync-health']],
  tickets: [['tickets'], ['notification-ref-statuses']],
  ticket_categories: [['ticket-categories'], ['ticket-access'], ['tickets']],
  assets: [['assets']],
  asset_assignments: [['assets'], ['asset-history']],
  employees: [['employees'], ['employee'], ['messaging-people'], ...WORKFLOW_ACCESS_KEYS],
  documents: [['documents'], ['employee-avatars']],
  exits: [['exits']],
  onboarding: [['onboarding']],
  role_assignments: [['managed-users'], ...WORKFLOW_ACCESS_KEYS],
  roles: [['roles'], ['roles-with-perms'], ...WORKFLOW_ACCESS_KEYS],
  role_permissions: [['roles'], ['roles-with-perms'], ...WORKFLOW_ACCESS_KEYS],
  profiles: [['managed-users'], ...WORKFLOW_ACCESS_KEYS],
  entities: [['org']],
  zones: [['org']],
  branches: [['org'], ['messaging-people'], ...ROUTINE_KEYS],
  departments: [['org'], ['ticket-categories'], ['ticket-access'], ['tickets'], ...ROUTINE_KEYS],
  designations: [['org'], ['employees'], ...ROUTINE_KEYS],
  // A chat that arrives on the five-minute safety poll is not a chat. RLS applies to realtime too,
  // so a subscriber is only sent messages from conversations they are already allowed to read.
  //
  // ['conversations'] as well as ['messages']: a new message changes the LIST — its order, its
  // preview line and its unread badge — and the person it matters most to is the one looking at
  // the list rather than at the thread.
  messages: [['messages'], ['conversations'], ['admin-conversations'], ['message-delivery']],
  conversations: [['conversations'], ['admin-conversations'], ['message-delivery']],
  conversation_members: [['conversations'], ['admin-conversations'], ['message-delivery']],
};

export function useRealtimeSync() {
  const qc = useQueryClient();
  const { reloadAccess, session, user, employee } = useAuth();

  useEffect(() => {
    if (!session) return undefined;

    // Authenticate the Realtime socket so RLS scopes the change stream to this user.
    supabase.realtime.setAuth(session.access_token);

    // Coalesce bursts: the engine rewrites every employee's row on each recompute, which arrives
    // as hundreds of events within a second. Invalidating per event would fire hundreds of
    // refetch checks; collecting them and flushing once collapses that into one pass.
    let pending = new Set();
    let accessRefreshPending = false;
    let flushTimer = null;
    let chatPending = new Set();
    let chatTimer = null;
    let chatFallbackTimer = null;
    let closed = false;
    let hasSubscribed = false;
    let hiddenDirty = new Set();
    let hiddenAllDirty = false;
    // Mark cached screens stale too, but only fetch mounted screens while visible. A hidden
    // phone can receive a whole attendance import without downloading every new snapshot.
    const invalidate = (queryKey) => {
      const apply = () => {
        if (closed) return Promise.resolve();
        const visible = document.visibilityState === 'visible';
        if (!visible) {
          if (queryKey) hiddenDirty.add(JSON.stringify(queryKey));
          else hiddenAllDirty = true;
        }
        // A focus-triggered fetch that started after cancellation already covers the change.
        return qc.invalidateQueries({ queryKey, refetchType: visible ? 'active' : 'none' }, { cancelRefetch: false });
      };
      // Default refetch cancellation only replaces queries that already have data. Explicitly
      // cancel pre-event reads, including initial loads, so an older snapshot cannot clear the
      // invalidated flag. Inactive reads are cancelled too, but only active screens refetch.
      const fetching = { queryKey, fetchStatus: 'fetching' };
      if (document.visibilityState === 'visible' && qc.getQueryCache().findAll(fetching).length) {
        return qc.cancelQueries(fetching).then(apply);
      }
      return apply();
    };
    const refreshChat = () => {
      for (const queryKey of CHAT_KEYS) invalidate(queryKey);
    };
    // A disconnected socket must not leave message ticks on the app-wide five-minute poll.
    // Only run this fallback while disconnected and while the app is visible.
    const startChatFallback = () => {
      if (closed || chatFallbackTimer) return;
      chatFallbackTimer = setInterval(() => {
        if (document.visibilityState === 'visible') refreshChat();
      }, 10_000);
    };
    const stopChatFallback = () => {
      if (chatFallbackTimer) clearInterval(chatFallbackTimer);
      chatFallbackTimer = null;
    };
    const queueChatInvalidation = (keys) => {
      for (const key of keys) chatPending.add(JSON.stringify(key));
      if (chatTimer) return;
      chatTimer = setTimeout(() => {
        chatTimer = null;
        const keys = [...chatPending];
        chatPending = new Set();
        for (const serialized of keys) invalidate(JSON.parse(serialized));
      }, 100);
    };
    const flush = () => {
      flushTimer = null;
      const keys = [...pending];
      pending = new Set();
      for (const serialized of keys) {
        invalidate(JSON.parse(serialized));
      }
      if (accessRefreshPending) {
        accessRefreshPending = false;
        reloadAccess();
      }
    };
    const queueInvalidation = (keys, refreshAccess = false) => {
      for (const key of keys) pending.add(JSON.stringify(key));
      accessRefreshPending = accessRefreshPending || refreshAccess;
      if (!flushTimer) flushTimer = setTimeout(flush, 1_000);
    };
    const touchesCurrentAccess = (table, payload) => {
      if (table === 'roles' || table === 'role_permissions') return true;
      if (!user?.id) return false;
      if (table === 'employees') return payload.new?.user_id === user.id || payload.old?.user_id === user.id
        || Boolean(employee?.id && (payload.new?.id === employee.id || payload.old?.id === employee.id));
      if (table !== 'role_assignments' && table !== 'profiles') return false;
      // Realtime DELETE payloads under RLS may retain only the primary key, so the deleted grant's
      // user_id can be unavailable. Refresh access once per batch when its owner is unknown.
      if (table === 'role_assignments' && payload.eventType === 'DELETE'
        && !payload.new?.user_id && !payload.old?.user_id) return true;
      return payload.new?.user_id === user.id || payload.old?.user_id === user.id;
    };

    const channel = supabase.channel('app-live-sync');
    for (const [table, keys] of Object.entries(TABLE_KEYS)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        if (closed) return;
        if (CHAT_TABLES.has(table)) {
          // Ticks use member cursors, not message rows. Render the authenticated UPDATE itself;
          // waiting for the inbox and member directory to refetch added several network trips.
          if (table === 'conversation_members' && payload.eventType === 'UPDATE') {
            for (const queryKey of [['conversations'], ['admin-conversations']]) {
              qc.setQueriesData({ queryKey }, (data) => mergeConversationReceipts(data, payload.new));
            }
          }
          const conversationId = payload.new?.conversation_id ?? payload.old?.conversation_id;
          queueChatInvalidation(table === 'messages' && conversationId
            ? keys.map((key) => key[0] === 'messages' ? ['messages', conversationId] : key)
            : keys);
          return;
        }
        // Adding a secondary assignee emits a task notification without updating the task row.
        // Refresh newly granted tasks when that notification arrives, using the same burst batch.
        const relatedKeys = table === 'notifications' && payload.new?.type === 'task'
          ? [...keys, ...TABLE_KEYS.tasks]
          : keys;
        queueInvalidation(relatedKeys, touchesCurrentAccess(table, payload));
      });
    }

    startChatFallback();
    channel.subscribe((status) => {
      if (closed) return;
      // Ordinary screens accept their bounded cache TTL on first connection. Chat must catch
      // messages sent between its last read and the subscription becoming ready, even when its
      // cached inbox is fresh. Later reconnects catch missed changes for every screen.
      if (status === 'SUBSCRIBED') {
        stopChatFallback();
        if (hasSubscribed) invalidate();
        else {
          refreshChat();
          if (document.visibilityState === 'visible') {
            qc.refetchQueries({ type: 'active', stale: true,
              predicate: (query) => !CHAT_KEYS.some(([key]) => query.queryKey[0] === key) }, { cancelRefetch: false });
          }
        }
        hasSubscribed = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        startChatFallback();
        // Surfaced so a misconfigured publication / blocked socket is visible in the console rather
        // than failing silently. Chat uses the short fallback above; other screens keep their
        // normal QueryClient safety poll.
        console.warn('[realtime] channel status:', status, '— falling back to polling');
      }
    });

    // Retain the native-webview fallback, honoring freshness and joining React Query's own
    // focus request instead of cancelling it and starting the same request a second time.
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') {
        // An older in-flight request can finish after a hidden change and clear TanStack's
        // invalidated flag. Remember the change independently until the foreground catches up.
        const dirty = hiddenDirty;
        hiddenDirty = new Set();
        if (hiddenAllDirty) {
          hiddenAllDirty = false;
          invalidate();
        } else {
          for (const serialized of dirty) invalidate(JSON.parse(serialized));
        }
        qc.refetchQueries({ type: 'active', stale: true }, { cancelRefetch: false });
      }
    };
    document.addEventListener('visibilitychange', refreshVisible);

    return () => {
      closed = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (chatTimer) clearTimeout(chatTimer);
      stopChatFallback();
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [session, qc, reloadAccess, user?.id, employee?.id]);
}
