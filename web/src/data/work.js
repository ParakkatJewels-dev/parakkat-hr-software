// Work Ledger data. The Ledger runs on Task Management's own records (0173): tasks and their
// subtasks, comments and files keep their existing hooks (data/tasks.js and friends); this file
// adds the ledger parts — review steps, progress notes, deliverables, personal focus/pin, the help
// log — and the reads behind Home, Reports, Insights and search. Every write is a plain table write
// governed by the task's own policies, so it means the same thing on every screen.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { istToday } from '../lib/dates';

export const workKeys = {
  root: ['work'],
  home: () => ['work', 'home'],
  task: (id) => ['work', 'task', id],
  report: (employee, period, date) => ['work', 'report', employee ?? 'me', period, date ?? null],
  insights: (employee) => ['work', 'insights', employee ?? 'me'],
};
// A change to a task can move it on Task Management's screens, its counts and its notifications too.
const AFFECTED = [['work'], ['tasks'], ['section-counts'], ['notification-ref-statuses']];

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}
export const workRpc = rpc;

function useRefresh() {
  const client = useQueryClient();
  return () => Promise.all(AFFECTED.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function useWorkHome() {
  const { user } = useAuth();
  return useQuery({ queryKey: workKeys.home(), enabled: Boolean(user?.id), queryFn: () => rpc('work_home') });
}
export function useWorkTask(id, { enabled = true } = {}) {
  const { user } = useAuth();
  return useQuery({ queryKey: workKeys.task(id), enabled: Boolean(user?.id && id && enabled), meta: { persist: false },
    queryFn: () => rpc('work_task', { _id: id }) });
}
export function useWorkReport({ employee = null, period, date }) {
  const { user } = useAuth();
  return useQuery({ queryKey: workKeys.report(employee, period, date), enabled: Boolean(user?.id && period), meta: { persist: false },
    queryFn: () => fetchWorkReport({ employee, period, date }) });
}
export const fetchWorkReport = ({ employee = null, period, date }) =>
  rpc('work_report', { _period: period, _date: date ?? null, _employee: employee });
export function useWorkInsights(employee = null) {
  const { user } = useAuth();
  return useQuery({ queryKey: workKeys.insights(employee), enabled: Boolean(user?.id), meta: { persist: false },
    queryFn: () => rpc('work_insights', { _employee: employee }) });
}
export const searchWork = (query) => rpc('work_search', { _query: query });

/** Where a board lane sends a task: the status and review step it lands on. */
export const LANE_TARGETS = {
  todo: { status: 'To Do', review_stage: null },
  progress: { status: 'In Progress', review_stage: null },
  review: { status: 'In Progress', review_stage: 'Internal Review' },
  approved: { status: 'In Progress', review_stage: 'Approved' },
  blocked: { status: 'Blocked', review_stage: null },
};
export function laneFor(status, review) {
  if (status === 'To Do') return 'todo';
  if (status === 'Blocked') return 'blocked';
  if (status === 'In Progress' && review === 'Approved') return 'approved';
  if (status === 'In Progress' && ['Internal Review', 'Awaiting Approval', 'Revisions'].includes(review)) return 'review';
  if (status === 'In Progress') return 'progress';
  return 'closed';
}
export function stepFor(status, review) {
  if (status === 'In Progress' && review === 'Internal Review') return 'In review';
  if (status === 'In Progress' && review === 'Awaiting Approval') return 'Waiting for approval';
  if (status === 'In Progress' && review === 'Revisions') return 'Changes needed';
  if (status === 'In Progress' && review === 'Approved') return 'Approved';
  return { 'To Do': 'To do', 'In Progress': 'In progress' }[status] ?? status;
}

/**
 * Change a task: status, review step, waiting on, outcome, depends on, tags or the creative fields.
 * A move on the board shows at once; the server confirms (and applies its rules) in the background.
 */
export function useWorkUpdate() {
  const client = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({ id, patch }) => {
      const change = { ...patch };
      // completed_at follows Done, exactly as Task Management's own update does.
      if (change.status === 'Done') change.completed_at = new Date().toISOString();
      else if ('status' in change) change.completed_at = null;
      const { data, error } = await supabase.from('tasks').update(change).eq('id', id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('This task could not be changed. Your access may have changed, or the task was deleted.');
    },
    onMutate: async ({ id, patch }) => {
      if (!('status' in patch) && !('review_stage' in patch)) return undefined;
      await client.cancelQueries({ queryKey: workKeys.home() });
      const previous = client.getQueryData(workKeys.home());
      if (previous?.pending) {
        client.setQueryData(workKeys.home(), {
          ...previous,
          pending: previous.pending.map((task) => {
            if (task.id !== id) return task;
            const status = patch.status ?? task.status;
            const review = 'review_stage' in patch ? patch.review_stage : status === 'In Progress' ? task.review_stage : null;
            return { ...task, status, review_stage: review, lane: laneFor(status, review), step: stepFor(status, review) };
          }),
        });
      }
      return { previous };
    },
    onError: (_error, _variables, context) => { if (context?.previous) client.setQueryData(workKeys.home(), context.previous); },
    onSettled: refresh,
  });
}

/** The ledger parts of a task, and the help log. One mutation, one refresh. */
export function useWorkWrite() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({ op, ...input }) => {
      const now = new Date().toISOString();
      const run = async (query) => {
        const { data, error } = await query;
        if (error) throw error;
        return data;
      };
      switch (op) {
        case 'progress':
          return run(supabase.from('task_progress').insert({ task_id: input.taskId, note: input.note, minutes: input.minutes || null,
            on_date: input.date || istToday() }).select('id').single());
        case 'remove-progress':
          return run(supabase.from('task_progress').update({ deleted_at: now }).eq('id', input.id).select('id'));
        case 'deliverable':
          return run(supabase.from('task_deliverables').insert({ task_id: input.taskId, type: input.type || null, version: input.version || null,
            link: input.link || null, used_where: input.used_where || null }).select('id').single());
        case 'remove-deliverable':
          return run(supabase.from('task_deliverables').update({ deleted_at: now }).eq('id', input.id).select('id'));
        case 'mark':
          return run(supabase.from('task_marks').upsert({ task_id: input.taskId, pinned: Boolean(input.pinned),
            focus_date: input.focus ? istToday() : null }, { onConflict: 'user_id,task_id' }).select('task_id'));
        case 'help':
          return run(supabase.from('task_help_log').insert({ what: input.what, for_whom: input.for_whom || null, minutes: input.minutes || null,
            kind: input.kind || 'Review / Feedback', on_date: input.date || istToday(), note: input.note || null, brand: input.brand || null,
            task_id: input.taskId || null }).select('id').single());
        case 'remove-help':
          return run(supabase.from('task_help_log').update({ deleted_at: now }).eq('id', input.id).select('id'));
        default:
          throw new Error(`Unknown change: ${op}`);
      }
    },
    onSettled: refresh,
  });
}

/** Reminder and calendar calls (the 0170 reminder RPCs, now linked to real tasks). */
export function useWorkRpc() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ name, args }) => rpc(name, args), onSettled: refresh });
}

// Sound is a per-device choice, kept in the browser.
const SOUND_KEY = 'parakkat.work.sound';
export function readSound() { try { return globalThis.localStorage?.getItem(SOUND_KEY) === 'on'; } catch { return false; } }
export function saveSound(on) { try { globalThis.localStorage?.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* private mode */ } }
