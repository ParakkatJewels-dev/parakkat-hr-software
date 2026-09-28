// Local task recovery scenarios only. The SQL suite owns authorization/transaction guarantees.
import { fixture, tables, today } from './fixtures';

export const taskTrashFixtures = new URL(window.location.href).searchParams.has('qa-task-trash');
if (taskTrashFixtures) {
  const me = fixture.employees[0];
  const makeTask = (id, title, extra = {}) => ({ id, title, description: 'Synthetic recoverable task.', employee_id: me.id,
    assignee: me, assigned_by: me.id, assigner: me, parent_task_id: null,
    entity_id: me.entity_id, zone_id: me.zone_id, branch_id: me.branch_id, department_id: me.department_id,
    status: 'In Progress', priority: 'Medium', due_date: today, created_at: new Date().toISOString(),
    completed_at: null, deleted_at: null, assignees: [{ employee_id: me.id, employee: me }],
    checklist: [{ id: `${id}-check`, completed_at: new Date().toISOString(), completed_by: me.id }], ...extra });
  tables.tasks = [makeTask('qa-trash-parent', 'Prepare the monthly handover'),
    makeTask('qa-trash-child', 'Attach the stock summary', { parent_task_id: 'qa-trash-parent' }),
    makeTask('qa-trash-personal', 'Review my notes', { status: 'To Do' })];
}

export function taskTrashRpc(name, args, { employee, userId, allows, canWrite, event }) {
  if (!['list_deleted_tasks', 'soft_delete_task', 'restore_task'].includes(name)) return undefined;
  const manageable = task => allows('task.manage', task)
    || (!task.parent_task_id && task.employee_id === employee?.id && task.assigned_by === employee?.id);
  const family = root => {
    const ids = new Set([root.id]);
    let count;
    do {
      count = ids.size;
      for (const task of tables.tasks) if (ids.has(task.parent_task_id)) ids.add(task.id);
    } while (ids.size !== count);
    return tables.tasks.filter(task => ids.has(task.id));
  };
  const batch = root => tables.tasks.filter(task => task.delete_batch_id === root.id);
  const canRestore = root => batch(root).every(task => manageable(task) && !tables.tasks.some(parent =>
    parent.id === task.parent_task_id && parent.deleted_at && parent.delete_batch_id !== root.id));
  if (name === 'list_deleted_tasks') return { rows: tables.tasks.filter(task => task.deleted_at && task.delete_batch_id === task.id && manageable(task))
    .map(task => ({ ...task, can_restore: canRestore(task), deleted_task_count: batch(task).length })) };
  if (!taskTrashFixtures || !canWrite) return { error: { message: 'QA mode: this write is intentionally blocked.' } };
  const root = tables.tasks.find(task => task.id === args._task_id);
  if (!root || !manageable(root)) return { error: { message: 'You cannot change this task.' } };
  const deleting = name === 'soft_delete_task';
  if (deleting ? root.deleted_at : !root.deleted_at) return { error: { message: 'Refresh the task list and try again.' } };
  const rows = deleting ? family(root).filter(task => !task.deleted_at) : batch(root);
  if (rows.some(task => !manageable(task)) || (!deleting && !canRestore(root))) return { error: { message: 'Restore the parent first and check access to its subtasks.' } };
  const stamp = new Date().toISOString();
  for (const row of rows) {
    const previous = { ...row };
    Object.assign(row, { deleted_at: deleting ? stamp : null, deleted_by: deleting ? userId : null, delete_batch_id: deleting ? root.id : null });
    if (!deleting) row.restored_at = stamp;
    event('tasks', 'UPDATE', row, previous);
  }
  return { one: true, rows: [root.id], mutated: true };
}
