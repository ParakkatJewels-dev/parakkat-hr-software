// Data hooks for in-app notifications. Rows are created only by DB triggers (migration 0023);
// RLS scopes every query to the signed-in user's own notifications, and realtime.js invalidates
// ['notifications'] the moment a new row streams in, so the bell updates live.
import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { filterActionableNotifications, idsToMarkRead } from '../lib/actionableNotifications';
import { notificationTarget } from '../lib/focusRow';

const REF_TABLES = {
  leave: 'leaves',
  expense: 'expenses',
  regularization: 'attendance_regularizations',
  task: 'tasks',
  ticket: 'tickets',
  help: 'help_requests',
};

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, type, title, body, tab, ref_id, read_at, created_at')
        .order('created_at', { ascending: false })
        .limit(40);
      if (error) throw error;
      return data ?? [];
    },
  });
}

function idsForType(notifications, type) {
  return [
    ...new Set(
      (notifications ?? [])
        .filter((n) => !n.read_at && n.type === type && n.ref_id)
        .map((n) => n.ref_id)
    ),
  ].sort();
}

function useNotificationRefStatuses(type, ids) {
  return useQuery({
    enabled: ids.length > 0,
    queryKey: ['notification-ref-statuses', type, ids],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(REF_TABLES[type])
        .select('id, status')
        .in('id', ids);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((row) => [row.id, row.status]));
    },
  });
}

export function useActionableNotifications() {
  const notificationsQuery = useNotifications();
  const notifications = notificationsQuery.data ?? [];
  const leaveIds = idsForType(notifications, 'leave');
  const expenseIds = idsForType(notifications, 'expense');
  const regularizationIds = idsForType(notifications, 'regularization');
  const taskIds = idsForType(notifications, 'task');
  const ticketIds = idsForType(notifications, 'ticket');
  const helpIds = idsForType(notifications, 'help');

  const leaveStatuses = useNotificationRefStatuses('leave', leaveIds);
  const expenseStatuses = useNotificationRefStatuses('expense', expenseIds);
  const regularizationStatuses = useNotificationRefStatuses('regularization', regularizationIds);
  const taskStatuses = useNotificationRefStatuses('task', taskIds);
  const ticketStatuses = useNotificationRefStatuses('ticket', ticketIds);
  const helpStatuses = useNotificationRefStatuses('help', helpIds);

  const refStatuses = useMemo(() => {
    const statuses = {};
    if (leaveIds.length === 0 || leaveStatuses.isFetched) statuses.leave = leaveStatuses.data ?? {};
    if (expenseIds.length === 0 || expenseStatuses.isFetched) statuses.expense = expenseStatuses.data ?? {};
    if (regularizationIds.length === 0 || regularizationStatuses.isFetched) {
      statuses.regularization = regularizationStatuses.data ?? {};
    }
    if (taskIds.length === 0 || taskStatuses.isFetched) statuses.task = taskStatuses.data ?? {};
    if (ticketIds.length === 0 || ticketStatuses.isFetched) statuses.ticket = ticketStatuses.data ?? {};
    if (helpIds.length === 0 || helpStatuses.isFetched) statuses.help = helpStatuses.data ?? {};
    return statuses;
  }, [
    expenseIds.length,
    expenseStatuses.data,
    expenseStatuses.isFetched,
    leaveIds.length,
    leaveStatuses.data,
    leaveStatuses.isFetched,
    regularizationIds.length,
    regularizationStatuses.data,
    regularizationStatuses.isFetched,
    taskIds.length,
    taskStatuses.data,
    taskStatuses.isFetched,
    ticketIds.length,
    ticketStatuses.data,
    ticketStatuses.isFetched,
    helpIds.length,
    helpStatuses.data,
    helpStatuses.isFetched,
  ]);

  return {
    ...notificationsQuery,
    data: filterActionableNotifications(notifications, refStatuses),
  };
}

/**
 * Mark one notification read, or a whole group of them.
 *
 * Takes an id or an array, because the dashboard strip collapses identical notifications into one
 * row and that row stands for all of them — see groupUnreadNotifications.
 *
 * `.select('id')` is not decoration. A PostgREST update with no select returns SUCCESS and no error
 * when RLS filters it to zero rows, so a mark-read that reached nothing looked exactly like one
 * that worked and the badge simply never went down. Same failure that was found and fixed in
 * useSetExpenseStatus; this is the notifications copy of it.
 */
export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (idOrIds) => {
      const ids = (Array.isArray(idOrIds) ? idOrIds : [idOrIds]).filter(Boolean);
      if (ids.length === 0) return;
      const { data, error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .in('id', ids)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('Those notifications could not be marked read — they may already be gone.');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

/** Back-compat name for the single-id call sites. */
export const useMarkNotificationRead = useMarkNotificationsRead;

/**
 * Opening a notification: mark it read, then go where it points.
 *
 * ONE definition, deliberately. The bell and the notifications screen each grew their own identical
 * `openItem`, and when the dashboard's "Needs attention" strip was added it got only half of the
 * pair — it navigated and never marked anything read, so acting on an item cleared the strip (the
 * underlying row stopped being actionable) while the bell badge kept counting it forever. That is
 * the same drift the row markup was pulled into ui/NotificationRow.jsx to prevent; this is the
 * behaviour half of it.
 */
export function useOpenNotification(onNavigate) {
  const markRead = useMarkNotificationsRead();
  const open = useCallback(
    (n) => {
      const ids = idsToMarkRead(n);
      if (ids.length > 0) markRead.mutate(ids);
      // The row, not just the screen. Every notification stores the id of the thing it is about;
      // this is where that finally gets used. A grouped row stands for several and gets the screen
      // alone — see notificationTarget.
      const target = notificationTarget(n);
      if (target && onNavigate) onNavigate(target);
    },
    [markRead, onNavigate]
  );
  return { open, error: markRead.error };
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .is('read_at', null);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useClearNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('notifications').delete().not('read_at', 'is', null);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
