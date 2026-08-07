// Data hooks for in-app notifications. Rows are created only by DB triggers (migration 0023);
// RLS scopes every query to the signed-in user's own notifications, and realtime.js invalidates
// ['notifications'] the moment a new row streams in, so the bell updates live.
import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { filterActionableNotifications } from '../lib/actionableNotifications';

const REF_TABLES = {
  leave: 'leaves',
  expense: 'expenses',
  regularization: 'attendance_regularizations',
  task: 'tasks',
  ticket: 'tickets',
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

  const leaveStatuses = useNotificationRefStatuses('leave', leaveIds);
  const expenseStatuses = useNotificationRefStatuses('expense', expenseIds);
  const regularizationStatuses = useNotificationRefStatuses('regularization', regularizationIds);
  const taskStatuses = useNotificationRefStatuses('task', taskIds);
  const ticketStatuses = useNotificationRefStatuses('ticket', ticketIds);

  const refStatuses = useMemo(() => {
    const statuses = {};
    if (leaveIds.length === 0 || leaveStatuses.isFetched) statuses.leave = leaveStatuses.data ?? {};
    if (expenseIds.length === 0 || expenseStatuses.isFetched) statuses.expense = expenseStatuses.data ?? {};
    if (regularizationIds.length === 0 || regularizationStatuses.isFetched) {
      statuses.regularization = regularizationStatuses.data ?? {};
    }
    if (taskIds.length === 0 || taskStatuses.isFetched) statuses.task = taskStatuses.data ?? {};
    if (ticketIds.length === 0 || ticketStatuses.isFetched) statuses.ticket = ticketStatuses.data ?? {};
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
  ]);

  return {
    ...notificationsQuery,
    data: filterActionableNotifications(notifications, refStatuses),
  };
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
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
