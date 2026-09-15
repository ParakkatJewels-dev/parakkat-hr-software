import { accountFixtures } from '../src/test/scaleFixtures.js';
import { addDays } from '../src/lib/dateRange.js';

export const fixture = accountFixtures(525);
export const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const period = today.slice(0, 7);
export const mobileFixtures = typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('qa-mobile');
export const actionsFixtures = typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('qa-actions');
export const chatFixtures = actionsFixtures || (typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('qa-chat'));
export const developerFixtures = typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('qa-developer');
export const paginationFixtures = typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('qa-pagination');
const developerNow = Date.now();
const developerDate = days => new Date(developerNow + days * 86400000).toISOString();
export const developerFixture = {
  settings: { enabled: false, updated_at: developerDate(-3) },
  keys: developerFixtures ? [
    { id: 'qa-key-reporting', name: 'QA reporting dashboard', key_prefix: 'qa_sample_reporting_', scopes: ['employees:read', 'organization:read'], entity_id: null, created_at: developerDate(-7), expires_at: developerDate(83), last_used_at: developerDate(-1), revoked_at: null },
    { id: 'qa-key-attendance', name: 'QA attendance export', key_prefix: 'qa_sample_attendance_', scopes: ['attendance:read'], entity_id: 'company-1', created_at: developerDate(-40), expires_at: developerDate(-10), last_used_at: developerDate(-11), revoked_at: null },
    { id: 'qa-key-revoked', name: 'QA retired integration', key_prefix: 'qa_sample_retired_', scopes: ['employees:read'], entity_id: null, created_at: developerDate(-60), expires_at: developerDate(30), last_used_at: null, revoked_at: developerDate(-2) },
  ] : [],
};
fixture.org.departments = fixture.org.branches.map((b, i) => ({ id: `dept-${i + 1}`,
  entity_id: b.entity_id, branch_id: b.id, branch_name: b.name, name: `Department ${i + 1}`, is_active: true }));
fixture.org.designations = [{ id: 'designation-1', title: 'Sales Associate', grade: 'A', is_active: true }];
fixture.employees.forEach((e, i) => Object.assign(e, {
  department_id: `dept-${i % 3 + 1}`, department: fixture.org.departments[i % 3],
  designation_id: 'designation-1', designation: fixture.org.designations[0], join_date: '2025-01-01',
}));
// The role audit needs branches within zones and departments within branches; a single branch
// per company cannot distinguish an entity grant from a branch grant.
if (typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('qa-role')) {
  fixture.org.zones = fixture.org.entities.flatMap((entity, i) => [0, 1].map((j) => ({
    id: `zone-${i * 2 + j + 1}`, entity_id: entity.id, name: `Zone ${i * 2 + j + 1}`, is_active: true,
  })));
  fixture.org.branches = fixture.org.zones.flatMap((zone, i) => [0, 1].map((j) => ({
    id: `branch-${i * 2 + j + 1}`, entity_id: zone.entity_id, zone_id: zone.id,
    code: `B${i * 2 + j + 1}`, name: `Sample branch ${i * 2 + j + 1}`, is_active: true,
  })));
  fixture.org.departments = fixture.org.branches.flatMap((branch, i) => [0, 1].map((j) => ({
    id: `dept-${i * 2 + j + 1}`, entity_id: branch.entity_id, zone_id: branch.zone_id,
    branch_id: branch.id, branch_name: branch.name, name: `Department ${i * 2 + j + 1}`, is_active: true,
  })));
  fixture.employees.forEach((employee, i) => {
    const sequence = Math.floor(i / 3);
    const branchIndex = (i % 3) * 4 + Math.floor(sequence / 2) % 4;
    const branch = fixture.org.branches[branchIndex];
    const department = fixture.org.departments[branchIndex * 2 + sequence % 2];
    Object.assign(employee, { zone_id: branch.zone_id, branch_id: branch.id, branch,
      department_id: department.id, department });
  });
}
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

if (mobileFixtures) {
  const employee = fixture.employees[0];
  const punchTimes = ['09:37', '13:23', '13:42', '13:48', '14:14', '15:47', '16:21', '18:51']
    .map((time) => new Date(`${today}T${time}:00+05:30`).toISOString());
  Object.assign(tables.attendance[0], { status: 'Present', is_lop: false, day_fraction: 1,
    check_in: punchTimes[0], check_out: punchTimes.at(-1), punches: punchTimes, punch_count: 8,
    worked_minutes: 475, hours: 475 / 60, break_minutes: 79 });
  tables.raw_punches = punchTimes.map((punch_time, i) => ({ id: `qa-punch-${i}`, employee_id: employee.id,
    punch_time, punch_state: 255, terminal_alias: 'Synthetic terminal', source: 'qa' }));
  tables.routine_items = [
    { id: 'qa-routine-1', employee_id: employee.id, employee, title: 'Check the opening stock and prepare the daily handover notes', detail: 'Synthetic routine for phone layout testing.', sort_order: 0, is_active: true, created_at: stamp },
    { id: 'qa-routine-2', employee_id: employee.id, employee, title: 'Review today’s customer follow-ups', sort_order: 1, is_active: true, created_at: stamp },
    { id: 'qa-routine-archived', employee_id: employee.id, employee, title: 'Archived duty must stay hidden', sort_order: 2, is_active: false, created_at: stamp },
    { id: 'qa-routine-other', employee_id: fixture.employees[1].id, employee: fixture.employees[1], title: 'Another employee’s private routine', sort_order: 0, is_active: true, created_at: stamp },
  ];
  tables.tasks[0].title = 'Prepare the branch inventory handover and follow up on the outstanding customer requests before closing';
}

if (paginationFixtures) {
  const own = tables.attendance[0];
  tables.attendance = [
    ...Array.from({ length: 120 }, (_, i) => {
      const work_date = addDays(today, -i);
      return { ...own, id: `qa-attendance-${i}`, work_date, status: 'Present', day_fraction: 1,
        is_lop: false, worked_minutes: 480, hours: 8, punches: [], punch_count: 2,
        check_in: `${work_date}T09:00:00+05:30`, check_out: `${work_date}T18:00:00+05:30` };
    }),
    ...tables.attendance.slice(1),
  ];
  tables.shifts = Array.from({ length: 45 }, (_, i) => ({ id: `qa-shift-${i}`, code: `S${String(i + 1).padStart(3, '0')}`,
    name: `QA shift ${i + 1}`, start_time: '09:00', end_time: '18:00', weekly_offs: [0],
    grace_in_minutes: 15, grace_out_minutes: 15, break_minutes: 60, full_day_minutes: 480, is_active: true }));
  tables.notifications = Array.from({ length: 125 }, (_, i) => ({ id: `qa-notification-${String(i).padStart(3, '0')}`,
    type: 'info', title: `Pagination notice ${i + 1}`, body: 'Synthetic notification for history paging.',
    tab: 'attendance', read_at: i % 2 ? stamp : null, created_at: `${addDays(today, -i)}T09:00:00+05:30` }));
  tables.sync_runs = Array.from({ length: 125 }, (_, i) => ({ id: `qa-run-${String(i).padStart(3, '0')}`,
    kind: 'transactions', status: 'success', started_at: `${addDays(today, -i)}T09:00:00+05:30`,
    records_fetched: i + 1, records_inserted: i + 1, records_skipped: 0, duration_ms: 1000 }));
  tables.service_commands = Array.from({ length: 37 }, (_, i) => ({ id: `qa-command-${String(i).padStart(3, '0')}`,
    kind: 'sync_transactions', status: 'done', requested_at: `${addDays(today, -i)}T09:00:00+05:30`,
    result: { inserted: i + 1 } }));
}

// Production's ancestry trigger stamps every employee-owned row. Include the same columns here
// so per-row zone checks exercise realistic responses instead of missing fixture metadata.
const employeesById = new Map(fixture.employees.map((employee) => [employee.id, employee]));
for (const rows of Object.values(tables)) {
  for (const row of rows) {
    const employee = employeesById.get(row.employee_id);
    if (employee) Object.assign(row, { entity_id: employee.entity_id, zone_id: employee.zone_id,
      branch_id: employee.branch_id, department_id: employee.department_id });
  }
}

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
if (mobileFixtures) {
  const direct = { id: 'qa-direct', kind: 'direct', title: null, created_by: fixture.employees[0].id,
    created_at: stamp, last_message_at: stamp, last_body: 'Synthetic direct message', last_kind: 'text', unread_count: 0 };
  tables.conversations.push(direct);
  tables.my_conversations.push(direct);
  tables.conversation_overview.push(direct);
  tables.conversation_members.push(...fixture.employees.slice(0, 2).map((employee) => ({
    conversation_id: direct.id, employee_id: employee.id, employee, role: 'member', joined_at: stamp,
  })));
}

// Explicit synthetic chat preview; the standard and phone audit fixtures above stay unchanged.
if (chatFixtures) {
  ['QA Reviewer', 'Asha Nair · QA', 'Ravi Menon · QA', 'Neha Shah · QA', 'Arun Das · QA', 'Maya Joseph · QA', 'Deepa Roy · QA', 'Kiran Rao · QA']
    .forEach((name, index) => { fixture.employees[index].full_name = name; fixture.users[index].employee_name = name; });
  const me = fixture.employees[0];
  const now = Date.now();
  const when = (minutes) => new Date(now - minutes * 60_000).toISOString();
  // Three earlier pages are required to reach message 10; the default fixture remains 250.
  tables.messages = Array.from({ length: 650 }, (_, index) => ({
    id: `message-${String(index + 1).padStart(4, '0')}`, conversation_id: conversation.id,
    sender_id: fixture.employees[1].id, sender: fixture.employees[1], kind: 'text',
    body: `Synthetic message ${index + 1}`, created_at: when(681 - index),
  }));
  Object.assign(conversation, { last_body: 'Synthetic message 650', last_message_at: when(32) });
  for (const member of tables.conversation_members.filter((row) => row.conversation_id === conversation.id)) member.joined_at = when(1440);
  const makeConversation = (id, memberIndices, title, bodies, options = {}) => {
    const people = [me, ...memberIndices.map((index) => fixture.employees[index])];
    const rows = bodies.map((item, index) => ({ id: `${id}-message-${String(index + 1).padStart(3, '0')}`, conversation_id: id,
      sender_id: item.own ? me.id : people[1].id, sender: item.own ? me : people[1], kind: 'text',
      body: item.body, created_at: when((options.minutes ?? 1) + bodies.length - index), ...item,
      reply_to: item.reply ? `${id}-message-${String(item.reply).padStart(3, '0')}` : null }));
    const last = rows.at(-1);
    const chat = { id, kind: title ? 'group' : 'direct', title: title ?? null, created_by: me.id, created_at: when(1440),
      request_status: 'accepted', last_message_at: last?.created_at ?? when(options.minutes ?? 1),
      last_body: last?.body ?? '', last_kind: last?.kind ?? 'text', last_sender_id: last?.sender_id,
      last_message_id: last?.id, last_message_created_at: last?.created_at, unread_count: options.unread ?? 0 };
    for (const table of ['conversations', 'my_conversations', 'conversation_overview']) tables[table].push(chat);
    tables.conversation_members.push(...people.map((employee, index) => ({ conversation_id: id, employee_id: employee.id, employee,
      role: index === 0 ? 'owner' : 'member', joined_at: when(1440), last_read_at: when(0), last_delivered_at: when(0) })));
    tables.messages.push(...rows);
  };
  makeConversation('qa-chat-asha', [1], null, [
    { body: 'Hi! Is the handover ready?' }, { own: true, body: 'Yes 👍' },
    { body: 'Great, thank you.' }, { own: true, body: 'See you at 4.' },
  ], { unread: 2 });
  makeConversation('qa-chat-operations', [2, 3, 4], 'Branch operations · QA', [
    { body: 'Please review the opening checklist before tomorrow’s shift. The updated checklist includes stock counts, customer follow-ups and the branch handover notes.' },
    { own: true, body: 'I have checked the stock counts. Customer follow-ups are complete too.', reply: 1 },
    { body: 'Thanks. We can use this sample guide: https://example.com/branch-handover' },
    { own: true, body: 'I will share the final checklist with the team.' },
  ], { minutes: 12 });
  makeConversation('qa-chat-ravi', [2], null, [
    { body: 'Here is the sample shift roster.', kind: 'file', mime_type: 'application/pdf', storage_path: 'qa-media/sample-shift-roster.pdf', byte_size: 48128 },
    { own: true, body: 'Received, thank you!', reply: 1 },
  ], { minutes: 28 });
  makeConversation('qa-chat-neha', [3], null, [{ body: 'Can we move the team meeting to 3:30?' }, { own: true, body: 'That works for me.' }], { minutes: 45 });
  makeConversation('qa-chat-planning', [4, 5, 6], 'Weekly planning · QA', [{ body: 'Tomorrow’s agenda is ready.' }, { own: true, body: 'Added my notes.' }], { minutes: 75, unread: 4 });
  makeConversation('qa-chat-maya', [5], null, [{ body: 'The sample onboarding document is ready for review.' }], { minutes: 125 });
  makeConversation('qa-chat-deepa', [6], null, [{ own: true, body: 'Welcome to the QA workspace!' }], { minutes: 160 });
  tables.chat_preferences = [{ conversation_id: 'qa-chat-asha', is_pinned: true, is_favourite: true }];
  tables.chat_typing = [];
}

// Small, deliberately different queues make stale cards and accidental team-task counts visible.
// Use ?qa-role=employee&qa-actions#/dashboard; the chat scenario is enabled automatically.
if (actionsFixtures) {
  const me = fixture.employees[0];
  const colleague = fixture.employees.find((row) => row.id !== me.id && row.department_id === me.department_id) ?? fixture.employees[3];
  const now = new Date().toISOString();
  const task = (id, title, overrides = {}) => ({
    id, title, description: 'Isolated Home actions QA task.', priority: 'Medium', status: 'In Progress',
    employee_id: me.id, assignee: me, employee: me, assigned_by: colleague.id, assigner: colleague,
    entity_id: me.entity_id, zone_id: me.zone_id, branch_id: me.branch_id, department_id: me.department_id,
    due_date: null, created_at: now, completed_at: null,
    assignees: [{ employee_id: me.id, employee: me }], checklist: [], ...overrides,
  });
  tables.tasks = [
    task('qa-action-overdue', 'QA overdue: reconcile the opening stock', { due_date: addDays(today, -2), priority: 'High' }),
    task('qa-action-today', 'QA due today: prepare the branch handover', { due_date: today }),
    task('qa-action-assigned', 'QA newly assigned: review the customer follow-ups', { status: 'To Do', due_date: addDays(today, 3) }),
    task('qa-action-self', 'QA personal to-do: organise my notes', { status: 'To Do', assigned_by: me.id, assigner: me }),
    task('qa-action-other', 'QA other employee task: exclude from my actions', {
      employee_id: colleague.id, employee: colleague, assignee: colleague, assigned_by: me.id, assigner: me,
      assignees: [{ employee_id: colleague.id, employee: colleague }], status: 'To Do', due_date: addDays(today, -3),
    }),
    task('qa-action-done', 'QA completed task: exclude from my actions', { status: 'Done', completed_at: now, due_date: addDays(today, -1) }),
  ];
  tables.leaves = [{ ...tables.leaves[0], id: 'qa-action-leave', reason: 'QA sample leave awaiting a reviewer', status: 'Pending' }];
  tables.attendance_regularizations = [];
  tables.expenses = [];
  tables.help_requests = [];
  tables.tickets = [];

  // The regular chat preview intentionally exaggerates some counters for layout testing. Here
  // use real incoming-message cursors: Asha has 2 unread messages and Planning has 1.
  const unreadChats = new Set(['qa-chat-asha', 'qa-chat-planning']);
  for (const chat of tables.conversations) {
    const incoming = tables.messages.filter((row) => row.conversation_id === chat.id && row.sender_id !== me.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const newest = incoming.at(-1);
    const member = tables.conversation_members.find((row) => row.conversation_id === chat.id && row.employee_id === me.id);
    const unread = unreadChats.has(chat.id);
    if (!member) continue;
    Object.assign(member, {
      last_read_at: unread ? new Date(new Date(incoming[0].created_at).getTime() - 1).toISOString() : newest?.created_at ?? now,
      last_read_message_id: unread ? null : newest?.id ?? null,
    });
    Object.assign(member, { last_delivered_at: member.last_read_at, last_delivered_message_id: member.last_read_message_id });
    Object.assign(chat, { unread_count: unread ? incoming.length : 0,
      last_incoming_message_id: newest?.id ?? null, last_incoming_message_created_at: newest?.created_at ?? null,
      last_read_at: member.last_read_at, last_read_message_id: member.last_read_message_id,
      last_delivered_at: member.last_delivered_at, last_delivered_message_id: member.last_delivered_message_id });
  }
  const notification = (suffix, type, title, tab, ref_id) => ({ id: `qa-action-notification-${suffix}`, type, title,
    body: 'Synthetic Home actions notification.', tab, ref_id, read_at: null, created_at: now });
  tables.notifications = [
    notification('stale-chat', 'message', 'QA stale chat notice: Ravi is already read', 'messages', 'qa-chat-ravi'),
    notification('asha', 'message', 'New message', 'messages', 'qa-chat-asha'),
    notification('planning', 'message', 'New message', 'messages', 'qa-chat-planning'),
    notification('assigned', 'task', 'New task assigned', 'tasks', 'qa-action-assigned'),
    notification('done', 'task', 'QA stale completed task notice', 'tasks', 'qa-action-done'),
    notification('leave', 'leave', 'QA sample leave request', 'leave', 'qa-action-leave'),
  ];
}
