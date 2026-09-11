import { accountFixtures } from '../src/test/scaleFixtures.js';

export const fixture = accountFixtures(525);
export const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const period = today.slice(0, 7);
fixture.org.departments = fixture.org.branches.map((b, i) => ({ id: `dept-${i + 1}`,
  entity_id: b.entity_id, branch_id: b.id, branch_name: b.name, name: `Department ${i + 1}`, is_active: true }));
fixture.org.designations = [{ id: 'designation-1', title: 'Sales Associate', grade: 'A', is_active: true }];
fixture.employees.forEach((e, i) => Object.assign(e, {
  department_id: `dept-${i % 3 + 1}`, department: fixture.org.departments[i % 3],
  designation_id: 'designation-1', designation: fixture.org.designations[0], join_date: '2025-01-01',
}));
const stamp = `${today}T09:00:00+05:30`;
const leaveType = { id: 'leave-1', name: 'Casual Leave', code: 'CL', is_paid: true, annual_quota: 12, is_active: true };
export const tables = {
  ...fixture.org, employees: fixture.employees, roles: fixture.roles,
  attendance: fixture.employees.map((e, i) => ({ id: `attendance-${i}`, employee_id: e.id, employee: e,
    entity_id: e.entity_id, branch_id: e.branch_id, department_id: e.department_id,
    work_date: today, status: i % 5 === 0 ? 'Absent' : 'Present', day_type: 'Working',
    check_in: i % 5 === 0 ? null : stamp, check_out: i % 5 === 0 ? null : `${today}T18:00:00+05:30`,
    hours: i % 5 === 0 ? 0 : 8, worked_minutes: i % 5 === 0 ? 0 : 480,
    is_late: false, is_early_exit: false, is_missing_punch: false, is_lop: i % 5 === 0,
    late_minutes: 0, early_exit_minutes: 0, ot_minutes: 0, day_fraction: i % 5 === 0 ? 0 : 1,
    punches: [], punch_count: i % 5 === 0 ? 0 : 2, break_minutes: 60, remarks: '',
  })),
  attendance_regularizations: fixture.employees.map((e, i) => ({ id: `reg-${i}`, employee_id: e.id,
    employee: e, entity_id: e.entity_id, branch_id: e.branch_id, department_id: e.department_id,
    work_date: today, check_in: stamp, check_out: `${today}T18:00:00+05:30`,
    status: 'Pending', reason: `Synthetic correction ${i + 1}`, created_at: stamp })),
  leaves: fixture.employees.map((e, i) => ({ id: `leave-request-${i}`, employee_id: e.id, employee: e,
    entity_id: e.entity_id, branch_id: e.branch_id, department_id: e.department_id,
    start_date: today, end_date: today, days: 1, type: 'CL', leave_type: leaveType, leave_type_id: leaveType.id,
    status: 'Pending', reason: 'Synthetic leave request', created_at: stamp })),
  leave_types: [leaveType],
  leave_balances: fixture.employees.map((e, i) => ({ id: `balance-${i}`, employee_id: e.id,
    employee: e, leave_type: leaveType, leave_type_id: leaveType.id, year: Number(today.slice(0, 4)),
    entitled: 12, carried_forward: 0, used: 2, available: 10 })),
  payslips: fixture.employees.map((e, i) => ({ id: `payslip-${i}`, employee_id: e.id, employee: e,
    period, net: 20000, gross: 22000, deductions: 2000, status: 'Published' })),
  salary_structures: fixture.employees.map((e, i) => ({ id: `salary-${i}`, employee_id: e.id,
    employee: e, effective_from: '2025-01-01', basic: 10000, gross: 22000, hra: 5000, allowances: 7000 })),
  payroll_runs: [{ id: 'run-1', period, status: 'Published', employee_count: 525, total_net: 10500000, created_at: stamp }],
  goals: fixture.employees.map((e, i) => ({ id: `goal-${i}`, employee_id: e.id, employee: e,
    title: `Synthetic goal ${i + 1}`, status: 'In Progress', progress: 50, target_date: today, created_at: stamp })),
  tasks: fixture.employees.map((e, i) => ({ id: `task-${i}`, employee_id: e.id, assignee: e,
    entity_id: e.entity_id, branch_id: e.branch_id, department_id: e.department_id,
    title: `Synthetic task ${i + 1}`, description: 'QA task', priority: 'Medium', status: 'To Do',
    due_date: today, created_at: stamp, assignees: [{ employee_id: e.id, employee: e }], checklist: [] })),
  onboarding: fixture.employees.map((e, i) => ({ id: `hire-${i}`, name: e.full_name, tasks: [], progress: 0 })),
  jobs: [{ id: 'job-1', title: 'Sales Associate', status: 'Open', openings: 4, entity_id: 'company-1' }],
  candidates: fixture.employees.map((e, i) => ({ id: `candidate-${i}`, name: e.full_name,
    stage: ['Applied', 'Shortlisted', 'Interview', 'Offered'][i % 4], job: { title: 'Sales Associate' } })),
  org_settings: [{ key: 'workspace', value: { name: 'Synthetic QA workspace' } }],
  assets: [], documents: [], expenses: [], exits: [], tickets: [], notifications: [], shifts: [],
  employee_shift_assignments: [], raw_punches: [], holidays: [], holiday_calendars: [],
  biotime_employees: [], devices: [], sync_state: [], sync_runs: [], service_commands: [],
  routine_items: [], routine_ticks: [], conversations: [], messages: [], conversation_members: [],
  help_requests: [], task_comments: [], task_attachments: [], pay_components: [], audit_log: [],
};

// One long group thread exercises cursor pagination and mobile scroll anchoring.
const conversation = { id: 'qa-conversation', kind: 'group', title: 'QA history test',
  created_by: fixture.employees[0].id, created_at: stamp, last_message_at: stamp,
  last_body: 'Synthetic message 250', last_kind: 'text', unread_count: 0 };
tables.my_conversations = [conversation];
tables.conversation_overview = [conversation];
tables.conversations = [conversation];
tables.conversation_members = fixture.employees.slice(0, 2).map((employee) => ({
  conversation_id: conversation.id, employee_id: employee.id, employee, role: 'member', joined_at: stamp,
}));
tables.messages = Array.from({ length: 250 }, (_, i) => ({ id: `message-${String(i + 1).padStart(4, '0')}`,
  conversation_id: conversation.id, sender_id: fixture.employees[1].id, sender: fixture.employees[1],
  kind: 'text', body: `Synthetic message ${i + 1}`, created_at: new Date(new Date(stamp).getTime() + i * 60_000).toISOString(),
}));
