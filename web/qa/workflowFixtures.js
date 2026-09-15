// Local UI fixtures only. Database authorization and complete multi-user flows run in SQL tests.
import { fixture, tables, today } from './fixtures';
export const workflowFixtures = new URL(window.location.href).searchParams.has('qa-workflow');
const hrRoles = ['super_admin', 'entity_admin', 'hr_manager'];
const waiting = (row) => ['Pending', 'On Hold'].includes(row.status);
const at = () => new Date().toISOString();

if (workflowFixtures) {
  const me = fixture.employees[0];
  const colleague = fixture.employees.find((person) => person.id !== me.id && person.department_id === me.department_id);
  fixture.org.departments.find((d) => d.id === me.department_id).name = 'IT';
  const hr = fixture.org.departments.find((d) => d.entity_id === me.entity_id && d.id !== me.department_id);
  hr.name = 'HR';
  const makeLeave = (id, employee, stage) => ({ id, employee_id: employee.id, employee, type: 'CL', days: 1,
    start_date: today, end_date: today, status: 'Pending', approval_stage: stage, reason: 'Family appointment — synthetic workflow request.',
    entity_id: employee.entity_id, zone_id: employee.zone_id, branch_id: employee.branch_id, department_id: employee.department_id, created_at: at() });
  tables.leaves = [makeLeave('qa-leave-department', colleague, 'department'), makeLeave('qa-leave-hr', colleague, 'hr'), makeLeave('qa-leave-own', me, 'department')];
  tables.leave_decisions = [{ id: 'qa-head-decision', leave_id: 'qa-leave-hr', stage: 'department', decision: 'Approved',
    remarks: 'Handover arranged; forwarded to HR for sanction.', actor_name: 'QA Department Head', created_at: at(),
    from_status: 'Pending', to_status: 'Pending', from_stage: 'department', to_stage: 'hr' }];
  tables.ticket_categories = [
    { id: 'qa-cat-it', name: 'IT support', department_id: me.department_id, is_active: true, is_hr_queue: false },
    { id: 'qa-cat-hr', name: 'HR support', department_id: hr.id, is_active: true, is_hr_queue: true },
  ];
  tables.tickets = Array.from({ length: 31 }, (_, index) => {
    const category = tables.ticket_categories[index % 2];
    return { id: `qa-ticket-${String(index).padStart(3, '0')}`, employee_id: index === 0 ? me.id : colleague.id,
      employee: index === 0 ? me : colleague, subject: `${category.is_hr_queue ? 'Leave policy question' : 'Laptop setup help'} ${index + 1}`,
      description: 'Synthetic department routing request.', category: category.name, category_id: category.id,
      routed_department_id: category.department_id, is_hr_queue: category.is_hr_queue,
      status: index === 30 ? 'Resolved' : 'Open', priority: 'Medium', created_at: at(),
      entity_id: me.entity_id, zone_id: me.zone_id, branch_id: me.branch_id, department_id: me.department_id };
  });
}

export function workflowLeaveRows(rows, { role, employee, allows }) {
  return rows.map((row) => {
    const approval_stage = role === 'dept_head' && row.employee_id === employee?.id && waiting(row) ? 'hr'
      : row.approval_stage ?? (waiting(row) ? (role === 'dept_head' ? 'department' : 'hr') : 'completed');
    const canAct = row.employee_id !== employee?.id && allows('leave.approve', row);
    return { ...row, approval_stage, effective_stage: approval_stage,
      can_decide: canAct && waiting(row) && (approval_stage === 'department' ? role === 'dept_head' : hrRoles.includes(role)),
      can_reopen: canAct && !waiting(row) && hrRoles.includes(role) };
  });
}

export function workflowRpc(name, args, context) {
  const { role, employee, allows, event, canWrite } = context;
  const admin = ['super_admin', 'entity_admin'].includes(role);
  const isHr = hrRoles.includes(role);
  const department = (id) => fixture.org.departments.find((row) => row.id === id);
  const categories = () => (tables.ticket_categories ?? []).map((row) => ({ ...row,
    department: { is_active: true, ...department(row.department_id) }, can_manage: admin }));
  const tickets = () => (tables.tickets ?? []).filter((row) => isHr || row.employee_id === employee?.id || row.routed_department_id === employee?.department_id)
    .map((row) => ({ ...row, routed_department: department(row.routed_department_id), can_manage: isHr || (role === 'dept_head' && row.routed_department_id === employee?.department_id) }));
  if (name === 'get_ticket_access') return { one: true, rows: [{ is_hr: isHr, can_manage_categories: admin,
    can_view_queue: isHr || role === 'dept_head' || (workflowFixtures && role === 'employee'), can_create: Boolean(employee?.id) }] };
  if (name === 'list_ticket_categories') return { rows: categories() };
  if (name === 'list_ticket_departments') return { rows: fixture.org.departments };
  if (name === 'list_tickets') return { rows: tickets() };
  if (!workflowFixtures || !canWrite) return undefined;
  if (name === 'decide_leave') {
    const raw = tables.leaves.find((row) => row.id === args._leave_id);
    const row = raw && workflowLeaveRows([raw], context)[0];
    if (!row || (!row.can_decide && !row.can_reopen) || !args._remarks?.trim()) return { error: { message: 'You cannot decide this stage, or remarks are missing.' } };
    const previous = { ...raw };
    const forwards = row.approval_stage === 'department' && args._decision === 'Approved';
    Object.assign(raw, { status: forwards ? 'Pending' : args._decision,
      approval_stage: forwards ? 'hr' : ['Pending', 'On Hold'].includes(args._decision) ? row.approval_stage : 'completed' });
    const entry = { id: crypto.randomUUID(), leave_id: row.id, stage: row.approval_stage, decision: args._decision,
      remarks: args._remarks.trim(), actor_name: role === 'dept_head' ? 'QA Department Head' : 'QA HR Reviewer', created_at: at(),
      from_status: row.status, to_status: raw.status, from_stage: row.approval_stage, to_stage: raw.approval_stage };
    tables.leave_decisions.push(entry); event('leaves', 'UPDATE', raw, previous); event('leave_decisions', 'INSERT', entry);
    return { rows: [raw], one: true, mutated: true };
  }
  if (name === 'save_ticket_category' && admin) {
    const dept = department(args._department_id);
    if (!dept || !args._name?.trim()) return { error: { message: 'Name and department are required.' } };
    const row = tables.ticket_categories.find((r) => r.id === args._id) ?? { id: crypto.randomUUID() };
    const previous = { ...row };
    const exists = tables.ticket_categories.includes(row);
    Object.assign(row, { name: args._name.trim(), department_id: dept.id, is_active: args._is_active, is_hr_queue: args._is_hr_queue });
    if (!exists) tables.ticket_categories.push(row);
    event('ticket_categories', exists ? 'UPDATE' : 'INSERT', row, previous);
    return { rows: [row], one: true, mutated: true };
  }
  if (name === 'create_ticket') {
    const category = categories().find((row) => row.id === args._category_id && row.is_active);
    if (!category || !args._subject?.trim()) return { error: { message: 'Choose an active category and enter a subject.' } };
    const row = { id: crypto.randomUUID(), employee_id: employee.id, employee, entity_id: employee.entity_id,
      zone_id: employee.zone_id, branch_id: employee.branch_id, department_id: employee.department_id,
      category: category.name, category_id: category.id, routed_department_id: category.department_id, is_hr_queue: category.is_hr_queue,
      subject: args._subject.trim(), description: args._description, priority: args._priority, status: 'Open', created_at: at() };
    tables.tickets.push(row); event('tickets', 'INSERT', row);
    return { rows: [row], one: true, mutated: true };
  }
  if (name === 'set_ticket_status') {
    const row = tickets().find((r) => r.id === args._id && r.can_manage);
    if (!row) return { error: { message: 'This ticket is outside your queue.' } };
    const raw = tables.tickets.find((r) => r.id === row.id);
    Object.assign(raw, { status: args._status }); event('tickets', 'UPDATE', raw, row);
    return { rows: [raw], one: true, mutated: true };
  }
  return undefined;
}
