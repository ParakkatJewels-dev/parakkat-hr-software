import { isAssignedTo } from './taskBoard.js';
import { unreadTotal } from './conversations.js';

export const ASSIGNMENT_TITLES = ['New task assigned', 'You were added to a task'];
const ACTIVE_TASKS = new Set(['To Do', 'In Progress', 'Blocked']);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const targetFor = (tab, rows) => rows.length === 1 ? `${tab}?focus=${encodeURIComponent(rows[0].id)}` : tab;

/** Current work drives the cards. Notification history only identifies unseen assignments. */
export function dashboardActions({ employeeId, today, conversations = [], tasks = [], assignments = [],
  approvals = {}, helpRequests = [], tickets = [] } = {}) {
  const actions = [];
  const add = (id, rows, title, detail, tab, icon, tone) => {
    if (rows.length) actions.push({ id, count: rows.length, title, detail, target: targetFor(tab, rows), icon, tone });
  };
  const unread = unreadTotal(conversations);
  if (unread) {
    const chats = conversations.filter((c) => c.request_status !== 'declined' && Number(c.unread_count) > 0);
    actions.push({ id: 'messages', count: unread, title: `You have ${plural(unread, 'unread message')}`,
      detail: 'Open your inbox to read and reply', target: targetFor('messages', chats), icon: 'messages', tone: 'blue' });
  }

  const unseen = new Set(assignments.filter((n) => !n.read_at && n.type === 'task'
    && ASSIGNMENT_TITLES.includes(n.title)).map((n) => n.ref_id));
  const buckets = { overdue: [], due: [], new: [], blocked: [], todo: [], active: [] };
  for (const task of tasks) {
    if (!isAssignedTo(task, employeeId) || !ACTIVE_TASKS.has(task.status)) continue;
    // One card per task: a deadline takes precedence over a new-assignment notice.
    const key = task.due_date && task.due_date < today ? 'overdue'
      : task.due_date === today ? 'due'
      : task.status === 'Blocked' ? 'blocked'
      : task.status === 'To Do' && unseen.has(task.id) ? 'new'
      : task.status === 'To Do' ? 'todo' : 'active';
    buckets[key].push(task);
  }
  const taskDetail = (rows, fallback) => rows.length === 1 ? rows[0].title : fallback;
  for (const [key, title, detail, icon, tone] of [
    ['overdue', `${plural(buckets.overdue.length, 'task')} overdue`, 'Review overdue work assigned to you', 'overdue', 'red'],
    ['due', `${plural(buckets.due.length, 'task')} due today`, 'Finish today’s assigned work', 'due', 'amber'],
    ['new', buckets.new.length === 1 ? 'You have a new task' : `You have ${buckets.new.length} new tasks`, 'New assignments to review', 'tasks', 'blue'],
    ['blocked', `${plural(buckets.blocked.length, 'task')} blocked`, 'Resolve blockers to continue', 'blocked', 'red'],
    ['todo', `${plural(buckets.todo.length, 'task')} to start`, 'Your remaining to-do list', 'tasks', 'neutral'],
    ['active', `${plural(buckets.active.length, 'task')} in progress`, 'Continue your assigned work', 'tasks', 'neutral'],
  ]) add(`tasks-${key}`, buckets[key], title, taskDetail(buckets[key], detail), 'tasks/todo', icon, tone);

  for (const [key, label, tab, icon] of [
    ['leaves', 'leave request', 'leave', 'leave'],
    ['expenses', 'expense claim', 'expense', 'expense'],
    ['punches', 'punch correction', 'attendance/regularizations', 'attendance'],
  ]) {
    const rows = approvals[key] ?? [];
    add(`approvals-${key}`, rows, `${plural(rows.length, label)} awaiting your approval`,
      'Review and make a decision', tab, icon, 'amber');
  }
  add('help', helpRequests, `${plural(helpRequests.length, 'department request')} to answer`,
    'Accept or decline requests sent to your team', 'tasks/requests', 'help', 'amber');
  add('tickets', tickets, `${plural(tickets.length, 'support ticket')} to resolve`,
    'Review open tickets in your scope', 'helpdesk', 'help', 'amber');
  return actions;
}
