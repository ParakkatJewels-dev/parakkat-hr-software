// The assistant's tool catalogue: what Hermes (or any MCP client) is shown. Server-only, imported by
// mcpGateway.js. The database (0168_hermes_agent_api.sql) is authoritative for every rule; these
// schemas exist so the assistant can call tools correctly first time. hermesTools.test.js keeps the
// names and areas here identical to the database dispatcher.

export const AGENT_AREAS = ['tasks:manage', 'leave:manage', 'assets:manage', 'goals:manage', 'ledger:manage'];

const id = (description) => ({ type: 'string', format: 'uuid', description });
const date = (description) => ({ type: 'string', format: 'date', description: `${description} (YYYY-MM-DD).` });
const text = (description, maxLength = 2000) => ({ type: 'string', maxLength, description });
const ids = (description, maxItems = 20) => ({ type: 'array', items: { type: 'string', format: 'uuid' }, maxItems, description });
const flag = (description) => ({ type: 'boolean', description });
const choice = (values, description) => ({ type: 'string', enum: values, description });
const page = {
  limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to return (default 20, at most 50).' },
  offset: { type: 'integer', minimum: 0, maximum: 10000, description: 'How many to skip, for the next page.' },
};
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TASK_STATUSES = ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'];
const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const ASSET_CATEGORIES = ['Hardware', 'Software', 'Furniture', 'Vehicle', 'Other'];
const ROUTINE_SCHEDULE = {
  type: 'object',
  additionalProperties: false,
  required: ['frequency', 'start_date'],
  description: 'When the routine is due.',
  properties: {
    frequency: choice(['daily', 'weekly', 'monthly', 'interval', 'once'], 'How often.'),
    start_date: date('First day it is due; today or later'),
    end_date: date('Last day it is due, optional'),
    weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'For weekly: 1 = Monday … 7 = Sunday.' },
    month_day: { type: 'integer', minimum: 1, maximum: 31, description: 'For monthly: day of the month.' },
    interval_days: { type: 'integer', minimum: 1, maximum: 365, description: 'For interval: every N days.' },
  },
};
const job = (withId) => ({
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    ...(withId ? { id: id('Existing job id from list_routines. Omit for a new job.') } : {}),
    title: text('What to do.', 200),
    detail: text('Optional detail.', 1000),
  },
});
const ASSET_FIELDS = {
  name: text('Asset name.', 200),
  category: choice(ASSET_CATEGORIES, 'Category.'),
  type: text('Kind of item, e.g. Laptop.', 100),
  code: text('Asset tag / code.', 100),
  make: text('Make.', 100),
  model: text('Model.', 100),
  serial: text('Serial number.', 100),
  condition: text('Condition.', 200),
  location: text('Where it is kept.', 200),
  notes: text('Notes.'),
  purchase_date: date('Purchase date'),
  vendor: text('Vendor.', 200),
  warranty_expires: date('Warranty end'),
};

/** @type {Array<{name: string, area: string, title: string, readOnly: boolean, description: string, inputSchema: object}>} */
export const HERMES_TOOLS = [
  { name: 'whoami', area: 'any', title: 'Who am I acting as', readOnly: true,
    description: 'Shows which HR user this key acts as and which areas it can manage. Everything you do is recorded under this person\'s name and limited to what their role allows.',
    inputSchema: schema() },
  { name: 'find_employees', area: 'any', title: 'Find employees', readOnly: true,
    description: 'Search people this user can see, by name or employee code. Returns ids to use in other tools, plus department and designation only.',
    inputSchema: schema({ query: text('Part of a name or code.', 100), department_id: id('Only this department.'),
      include_inactive: flag('Include people who are no longer active.'), ...page }) },
  { name: 'list_departments', area: 'any', title: 'List departments', readOnly: true,
    description: 'Departments this user can see, with ids. Needed for department help requests.',
    inputSchema: schema({ query: text('Part of a department name.', 100) }) },

  { name: 'list_tasks', area: 'tasks:manage', title: 'List tasks', readOnly: true,
    description: 'Tasks this user can see. Open tasks only unless include_closed is true or a status is given.',
    inputSchema: schema({ assignee_id: id('Only tasks this employee is on.'), status: choice(TASK_STATUSES, 'Only this status.'),
      view: choice(['all', 'assigned_to_me', 'created_by_me'], 'Whose tasks.'), due_before: date('Due on or before'),
      include_closed: flag('Also include Done and Cancelled.'), query: text('Words in the title.', 100), ...page }) },
  { name: 'get_task', area: 'tasks:manage', title: 'Open a task', readOnly: true,
    description: 'One task with its description, people, subtasks and latest comments.',
    inputSchema: schema({ task_id: id('Task id.') }, ['task_id']) },
  { name: 'create_task', area: 'tasks:manage', title: 'Create and assign a task', readOnly: false,
    description: 'Create a task for an employee (use find_employees for ids). Optional helpers, priority, due date and a list of subtasks.',
    inputSchema: schema({ title: text('Task title.', 200), description: text('Details.', 4000), assignee_id: id('Main person responsible.'),
      helper_ids: ids('Other people working on it.'), priority: choice(TASK_PRIORITIES, 'Default Medium.'),
      due_date: date('Due date'), subtasks: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 50, description: 'Checklist steps.' } },
    ['title', 'assignee_id']) },
  { name: 'update_task', area: 'tasks:manage', title: 'Update a task', readOnly: false,
    description: 'Change status, priority, due date, title or description. To close a task without finishing it, set status Cancelled. The main person cannot be changed here.',
    inputSchema: schema({ task_id: id('Task id.'), status: choice(TASK_STATUSES, 'New status.'), priority: choice(TASK_PRIORITIES, 'New priority.'),
      due_date: date('New due date'), clear_due_date: flag('Remove the due date.'), title: text('New title.', 200),
      description: text('New description (empty to clear).', 4000) }, ['task_id']) },
  { name: 'add_task_helpers', area: 'tasks:manage', title: 'Add people to a task', readOnly: false,
    description: 'Add more people to work on a task. People already on it are skipped.',
    inputSchema: schema({ task_id: id('Task id.'), employee_ids: { ...ids('People to add.'), minItems: 1 } }, ['task_id', 'employee_ids']) },
  { name: 'comment_on_task', area: 'tasks:manage', title: 'Comment on a task', readOnly: false,
    description: 'Post a comment on a task, or reply to a comment.',
    inputSchema: schema({ task_id: id('Task id.'), body: text('Comment text.', 4000), reply_to: id('Comment being answered.') }, ['task_id', 'body']) },
  { name: 'add_subtask', area: 'tasks:manage', title: 'Add a subtask', readOnly: false,
    description: 'Add a checklist step to a task, optionally owned by one person. Adding a step to a Done task reopens it.',
    inputSchema: schema({ task_id: id('Task id.'), title: text('Step.', 200), owner_id: id('Person who owns this step.') }, ['task_id', 'title']) },
  { name: 'tick_subtask', area: 'tasks:manage', title: 'Tick or untick a subtask', readOnly: false,
    description: 'Mark a checklist step done (or not done). Only people on the task can tick, because the tick records who did the work.',
    inputSchema: schema({ subtask_id: id('Subtask id from get_task.'), done: flag('true = done (default), false = not done.') }, ['subtask_id']) },

  { name: 'list_routines', area: 'tasks:manage', title: 'List routines', readOnly: true,
    description: 'Repeating routines (daily, weekly…) with their jobs and job ids.',
    inputSchema: schema({ employee_id: id('Only this employee.'), include_stopped: flag('Include stopped and finished routines.') }) },
  { name: 'create_routine', area: 'tasks:manage', title: 'Create a routine', readOnly: false,
    description: 'Give one or more employees a repeating routine of jobs.',
    inputSchema: schema({ employee_ids: { ...ids('Employees who get the routine.', 50), minItems: 1 }, title: text('Routine name.', 120),
      jobs: { type: 'array', items: job(false), minItems: 1, maxItems: 100, description: 'Jobs in order.' },
      schedule: ROUTINE_SCHEDULE, detail: text('Optional note.') }, ['employee_ids', 'title', 'jobs', 'schedule']) },
  { name: 'update_routine', area: 'tasks:manage', title: 'Edit a routine', readOnly: false,
    description: 'Change a routine\'s name, schedule or jobs. Send every existing job with its id (from list_routines); jobs cannot be removed here, only edited or added.',
    inputSchema: schema({ routine_id: id('Routine id.'), title: text('Routine name.', 120),
      jobs: { type: 'array', items: job(true), minItems: 1, maxItems: 100, description: 'All jobs, existing ones with their id.' },
      schedule: ROUTINE_SCHEDULE, detail: text('Optional note.') }, ['routine_id', 'title', 'jobs', 'schedule']) },
  { name: 'stop_routine', area: 'tasks:manage', title: 'Stop a routine', readOnly: false,
    description: 'Stop a routine from today. Its history is kept.',
    inputSchema: schema({ routine_id: id('Routine id.') }, ['routine_id']) },

  { name: 'list_help_requests', area: 'tasks:manage', title: 'List department requests', readOnly: true,
    description: 'Requests for help between departments: incoming (asked of my department), outgoing (my department asked) or all.',
    inputSchema: schema({ direction: choice(['incoming', 'outgoing', 'all'], 'Default all.'),
      status: choice(['Pending', 'Accepted', 'Declined', 'Cancelled'], 'Only this status.'), ...page }) },
  { name: 'request_help', area: 'tasks:manage', title: 'Ask another department for help', readOnly: false,
    description: 'Ask another department in the same company for help (use list_departments for ids).',
    inputSchema: schema({ from_department_id: id('Your department.'), to_department_id: id('Department being asked.'),
      title: text('What is needed.', 200), description: text('Details.', 4000), preferred_employee_id: id('Person you would like to do it.'),
      priority: choice(TASK_PRIORITIES, 'Default Medium.'), due_date: date('Needed by') },
    ['from_department_id', 'to_department_id', 'title']) },
  { name: 'answer_help_request', area: 'tasks:manage', title: 'Accept or decline a request', readOnly: false,
    description: 'Accept (creates a task for the chosen person) or decline a request made to your department.',
    inputSchema: schema({ request_id: id('Request id.'), accept: flag('true = accept, false = decline.'),
      assignee_id: id('Who will do it (when accepting).'), note: text('Reply note.'), priority: choice(TASK_PRIORITIES, 'Priority for the task.') },
    ['request_id', 'accept']) },
  { name: 'cancel_help_request', area: 'tasks:manage', title: 'Cancel a request', readOnly: false,
    description: 'Withdraw a request your department made that has not been answered.',
    inputSchema: schema({ request_id: id('Request id.') }, ['request_id']) },

  { name: 'list_ticket_categories', area: 'tasks:manage', title: 'List ticket categories', readOnly: true,
    description: 'Helpdesk categories and which department handles each.',
    inputSchema: schema() },
  { name: 'list_tickets', area: 'tasks:manage', title: 'List tickets', readOnly: true,
    description: 'Helpdesk tickets this user can see.',
    inputSchema: schema({ status: choice(['Open', 'In Progress', 'On Hold', 'Resolved'], 'Only this status.'),
      since: date('Raised on or after (default 180 days ago)'), ...page }) },
  { name: 'create_ticket', area: 'tasks:manage', title: 'Raise a ticket', readOnly: false,
    description: 'Raise a helpdesk ticket in a category.',
    inputSchema: schema({ category_id: id('Category id.'), subject: text('Subject.', 200),
      priority: choice(['Low', 'Medium', 'High'], 'Default Medium.'), description: text('Details.', 4000) }, ['category_id', 'subject']) },
  { name: 'set_ticket_status', area: 'tasks:manage', title: 'Change ticket status', readOnly: false,
    description: 'Move a ticket your department handles to another status.',
    inputSchema: schema({ ticket_id: id('Ticket id.'), status: choice(['Open', 'In Progress', 'On Hold', 'Resolved'], 'New status.') },
    ['ticket_id', 'status']) },

  { name: 'list_leave_requests', area: 'leave:manage', title: 'List leave requests', readOnly: true,
    description: 'Leave requests. Default: the ones waiting for this user\'s decision.',
    inputSchema: schema({ view: choice(['waiting_for_me', 'all_open', 'recent'], 'Default waiting_for_me.'),
      employee_id: id('Only this employee.'), ...page }) },
  { name: 'decide_leave', area: 'leave:manage', title: 'Decide a leave request', readOnly: false,
    description: 'Approve, reject, put on hold or cancel leave. A remark is required. The normal approval steps apply (department, then HR), you cannot decide your own leave, and leave on payroll-locked days cannot change.',
    inputSchema: schema({ leave_id: id('Leave request id.'), decision: choice(['Approved', 'Rejected', 'On Hold', 'Cancelled'], 'Decision.'),
      remarks: text('Reason for the decision.') }, ['leave_id', 'decision', 'remarks']) },

  { name: 'list_assets', area: 'assets:manage', title: 'List assets', readOnly: true,
    description: 'Company assets this user can see, with who holds each.',
    inputSchema: schema({ status: choice(['Available', 'Allocated', 'Under Repair', 'Damaged', 'Lost', 'Retired'], 'Only this status.'),
      category: choice(ASSET_CATEGORIES, 'Only this category.'), query: text('Name, code or serial.', 100),
      holder_id: id('Only assets held by this employee.'), ...page }) },
  { name: 'add_asset', area: 'assets:manage', title: 'Add an asset', readOnly: false,
    description: 'Register a new asset. Set owner_entity_id (and owner_branch_id) to the company that owns it.',
    inputSchema: schema({ ...ASSET_FIELDS, owner_entity_id: id('Owning company.'), owner_branch_id: id('Owning branch.') }, ['name']) },
  { name: 'update_asset', area: 'assets:manage', title: 'Update an asset', readOnly: false,
    description: 'Change an asset\'s details or set its status (Available, Under Repair, Damaged, Lost, Retired). Use assign_asset / return_asset to give it out or take it back.',
    inputSchema: schema({ asset_id: id('Asset id.'), ...ASSET_FIELDS,
      status: choice(['Available', 'Under Repair', 'Damaged', 'Lost', 'Retired'], 'New status.') }, ['asset_id']) },
  { name: 'assign_asset', area: 'assets:manage', title: 'Give an asset to someone', readOnly: false,
    description: 'Hand an available asset to an employee.',
    inputSchema: schema({ asset_id: id('Asset id.'), employee_id: id('Who receives it.'), condition: text('Condition at handover.', 200),
      notes: text('Notes.') }, ['asset_id', 'employee_id']) },
  { name: 'return_asset', area: 'assets:manage', title: 'Take an asset back', readOnly: false,
    description: 'Record that an asset was returned.',
    inputSchema: schema({ asset_id: id('Asset id.'), condition: text('Condition on return.', 200), notes: text('Notes.') }, ['asset_id']) },

  { name: 'list_goals', area: 'goals:manage', title: 'List goals', readOnly: true,
    description: 'Employee goals this user can see.',
    inputSchema: schema({ employee_id: id('Only this employee.'), status: choice(['Active', 'Completed', 'Dropped'], 'Only this status.'), ...page }) },
  { name: 'create_goal', area: 'goals:manage', title: 'Set a goal', readOnly: false,
    description: 'Set a goal for an employee.',
    inputSchema: schema({ employee_id: id('Employee.'), title: text('Goal.', 200), description: text('Details.', 4000),
      target_date: date('Target date'), weight: { type: 'integer', minimum: 0, maximum: 100, description: 'Weight 0–100.' } },
    ['employee_id', 'title']) },
  { name: 'update_goal', area: 'goals:manage', title: 'Update a goal', readOnly: false,
    description: 'Update progress (0–100), status (Active, Completed, Dropped) or details. Set status Dropped to retire a goal.',
    inputSchema: schema({ goal_id: id('Goal id.'), progress: { type: 'integer', minimum: 0, maximum: 100, description: 'Percent done.' },
      status: choice(['Active', 'Completed', 'Dropped'], 'New status.'), title: text('Goal.', 200), description: text('Details.', 4000),
      target_date: date('Target date'), weight: { type: 'integer', minimum: 0, maximum: 100, description: 'Weight 0–100.' } }, ['goal_id']) },
];

// Work Ledger (0172): the key owner's own ledger. Same rules as the Work Ledger screens.
const LEDGER_STATUSES = ['Brief', 'In Progress', 'Internal Review', 'Awaiting Approval', 'Revisions', 'Approved', 'Delivered', 'Blocked', 'Cancelled'];
const LEDGER_TASK_FIELDS = {
  title: text('Task title.', 500),
  brand: text('Brand, e.g. Parakkat Jewels, Parakkat Munnar Resort, Parakkat Riverscape, Parakkat Adimali Retreat or General (any other name is added).', 80),
  priority: choice(['High', 'Medium', 'Low'], 'Default Medium.'),
  deadline: date('Deadline'), start_date: date('Start'), end_date: date('End'),
  status: choice(LEDGER_STATUSES, 'Workflow status.'),
  campaign: text('Campaign name; a new name creates the campaign.', 160),
  type: text('Work type, e.g. Print, Reel, Social, Photography.', 120),
  vendor: text('Vendor name; a new name is added to the vendor list.', 160),
  waiting_on: text('Who or what it is waiting on (for Blocked or Awaiting Approval).', 200),
  tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20, description: 'Tags.' },
  repeat: choice(['daily', 'weekly', 'weekdays', 'monthly'], 'Repeat after it is done.'),
  est_cost: { type: 'number', description: 'Estimated cost in rupees.' },
};
HERMES_TOOLS.push(
  { name: 'ledger_home', area: 'ledger:manage', title: 'Work Ledger today', readOnly: true,
    description: 'The Work Ledger at a glance: open work on the board, delivered today, help given today, overdue count, campaign alerts and today\'s reminders.',
    inputSchema: schema() },
  { name: 'ledger_list_tasks', area: 'ledger:manage', title: 'List ledger tasks', readOnly: true,
    description: 'Ledger tasks, newest first. Open ones unless a status is given or include_closed is true.',
    inputSchema: schema({ status: choice(LEDGER_STATUSES, 'Only this status.'), query: text('Words in the title.', 100),
      include_closed: flag('Also Delivered and Cancelled.'), limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' } }) },
  { name: 'ledger_get_task', area: 'ledger:manage', title: 'Open a ledger task', readOnly: true,
    description: 'One ledger task with its notes history, subtasks, deliverables, progress notes and attachments.',
    inputSchema: schema({ task_id: id('Ledger task id.') }, ['task_id']) },
  { name: 'ledger_report', area: 'ledger:manage', title: 'Work report', readOnly: true,
    description: 'The work report for a period, including share_text formatted for WhatsApp. period: day (date YYYY-MM-DD), week (any day in it), month (YYYY-MM), all, or range (date "YYYY-MM-DD|YYYY-MM-DD").',
    inputSchema: schema({ period: choice(['day', 'week', 'month', 'all', 'range'], 'Default day (today).'), date: text('See description.', 21) }) },
  { name: 'ledger_list_ideas', area: 'ledger:manage', title: 'List ideas', readOnly: true,
    description: 'Ideas in the ledger, optionally by status.',
    inputSchema: schema({ status: choice(['Open', 'Developing', 'Parked', 'Promoted', 'Archived'], 'Only this status.') }) },
  { name: 'ledger_list_reminders', area: 'ledger:manage', title: 'List reminders', readOnly: true,
    description: 'Upcoming reminders (and finished ones if asked).',
    inputSchema: schema({ include_done: flag('Include finished reminders.') }) },
  { name: 'ledger_list_campaigns', area: 'ledger:manage', title: 'List campaigns', readOnly: true,
    description: 'Campaigns with stage, launch date, next action, blocker and task progress.',
    inputSchema: schema() },
  { name: 'ledger_add_task', area: 'ledger:manage', title: 'Add a ledger task', readOnly: false,
    description: 'Add a task to the Work Ledger. Starts at Brief unless a status is given.',
    inputSchema: schema({ ...LEDGER_TASK_FIELDS, notes: text('A first note.', 4000),
      subtasks: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50, description: 'Checklist steps.' } }, ['title']) },
  { name: 'ledger_update_task', area: 'ledger:manage', title: 'Update a ledger task', readOnly: false,
    description: 'Change a ledger task. Only the fields you send change. Moving to Revisions counts a revision; Approved records the latest deliverable version; every change is added to the task\'s history. To close without finishing, set status Cancelled.',
    inputSchema: schema({ task_id: id('Ledger task id.'), ...LEDGER_TASK_FIELDS, outcome: text('Result line.', 1000), note: text('A note for the history.', 4000),
      actual_cost: { type: 'number', description: 'Actual cost in rupees.' } }, ['task_id']) },
  { name: 'ledger_mark_done', area: 'ledger:manage', title: 'Mark a ledger task done', readOnly: false,
    description: 'Deliver a task, with an optional outcome. A repeating task gets its next occurrence automatically.',
    inputSchema: schema({ task_id: id('Ledger task id.'), outcome: text('What came of it.', 1000) }, ['task_id']) },
  { name: 'ledger_log_progress', area: 'ledger:manage', title: 'Log progress', readOnly: false,
    description: 'Add a "what I did on this today" note to a multi-day task. The first note moves a Brief task to In Progress.',
    inputSchema: schema({ task_id: id('Ledger task id.'), note: text('What was done.', 4000),
      minutes: { type: 'integer', minimum: 0, maximum: 1440, description: 'Optional minutes spent.' }, date: date('Day, default today') }, ['task_id', 'note']) },
  { name: 'ledger_log_help', area: 'ledger:manage', title: 'Log help or a review', readOnly: false,
    description: 'Record help or a review given to someone. It shows only under Support & reviews in reports, never on the board.',
    inputSchema: schema({ what: text('What you did.', 500), for_whom: text('Who was helped.', 120),
      minutes: { type: 'integer', minimum: 0, maximum: 1440, description: 'Optional minutes.' }, brand: text('Brand.', 80),
      type: choice(['Review / Feedback', 'Team support'], 'Default Review / Feedback.'), note: text('Note.', 4000), date: date('Day, default today') }, ['what']) },
  { name: 'ledger_add_idea', area: 'ledger:manage', title: 'Capture an idea', readOnly: false,
    description: 'Keep an idea in the ledger until it is acted on.',
    inputSchema: schema({ text: text('The idea.', 4000), brand: text('Brand.', 80),
      tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20, description: 'Tags.' } }, ['text']) },
  { name: 'ledger_add_reminder', area: 'ledger:manage', title: 'Set a reminder', readOnly: false,
    description: 'Set a reminder. If Google Calendar is connected it also becomes a calendar event with pop-ups. due_at is local Asia/Kolkata time like 2026-10-08T10:00.',
    inputSchema: schema({ text: text('What to be reminded of.', 500), due_at: { type: 'string', maxLength: 16, description: 'YYYY-MM-DDTHH:mm, Asia/Kolkata.' },
      repeat: choice(['daily', 'weekly', 'weekdays', 'monthly'], 'Repeat.'), task_id: id('Related ledger task.') }, ['text', 'due_at']) },
);
// Called by the gateway itself (calendar mirroring), never offered to the assistant.
export const LEDGER_INTERNAL_TOOLS = ['ledger_calendar_outbox', 'ledger_calendar_ack', 'ledger_google_secret'];

export const HERMES_TOOL_MAP = new Map(HERMES_TOOLS.map((tool) => [tool.name, tool]));

/** Tools a key may use: the basics plus its areas. */
export function toolsForAreas(areas = []) {
  const allowed = new Set(areas);
  return HERMES_TOOLS.filter((tool) => tool.area === 'any' || allowed.has(tool.area));
}

/** The MCP shape of one tool. */
export function mcpTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
  };
}

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
};

/**
 * Shape check only: types, required fields, unknown fields and sizes. Allowed values (statuses and
 * so on) are left to the database, which also accepts spellings like "done" or "in_progress".
 * Returns an error sentence, or null when the arguments are well formed.
 */
export function checkArguments(schemaNode, value, path = 'arguments') {
  if (!TYPE_CHECKS[schemaNode.type]?.(value)) {
    return `${path} must be ${schemaNode.type === 'integer' ? 'a whole number' : `a${/^[aeiou]/.test(schemaNode.type) ? 'n' : ''} ${schemaNode.type}`}.`;
  }
  if (schemaNode.type === 'object') {
    for (const name of schemaNode.required ?? []) {
      if (value[name] === undefined || value[name] === null) return `${path}.${name} is required.`;
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = schemaNode.properties?.[name];
      if (!childSchema) {
        if (schemaNode.additionalProperties === false) return `${path}.${name} is not a known field.`;
        continue;
      }
      if (child === null) continue;
      const problem = checkArguments(childSchema, child, `${path}.${name}`);
      if (problem) return problem;
    }
  }
  if (schemaNode.type === 'array') {
    if (schemaNode.maxItems !== undefined && value.length > schemaNode.maxItems) return `${path} can have at most ${schemaNode.maxItems} items.`;
    if (schemaNode.minItems !== undefined && value.length < schemaNode.minItems) return `${path} needs at least ${schemaNode.minItems} item(s).`;
    for (let index = 0; index < value.length; index++) {
      const problem = checkArguments(schemaNode.items, value[index], `${path}[${index}]`);
      if (problem) return problem;
    }
  }
  if (schemaNode.type === 'string' && schemaNode.maxLength !== undefined && value.length > schemaNode.maxLength) {
    return `${path} can be at most ${schemaNode.maxLength} characters.`;
  }
  if (schemaNode.type === 'integer' && ((schemaNode.minimum !== undefined && value < schemaNode.minimum)
      || (schemaNode.maximum !== undefined && value > schemaNode.maximum))) {
    return `${path} must be from ${schemaNode.minimum} to ${schemaNode.maximum}.`;
  }
  return null;
}
