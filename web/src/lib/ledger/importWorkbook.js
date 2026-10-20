// Reads the original Work Ledger Google Sheet (downloaded as .xlsx, or tab-by-tab CSVs) and turns
// it into clean rows for the ledger_import_batch RPC. Columns are matched by header name because
// older rows are shorter than newer ones. Row numbers are the sheet's own (header = row 1), which
// is how every tab refers to every other tab.

export const LEDGER_STATUSES = ['Brief', 'In Progress', 'Internal Review', 'Awaiting Approval', 'Revisions', 'Approved', 'Delivered', 'Blocked', 'Cancelled'];
const LEGACY_STATUS = { done: 'Delivered', completed: 'Delivered', complete: 'Delivered', pending: 'Brief' };
const STAGES = ['Captured', 'Developing', 'Decision', 'Approved', 'Production', 'Live', 'Reviewed', 'Parked', 'Cancelled'];
const IDEA_STATUSES = ['Open', 'Developing', 'Parked', 'Promoted', 'Archived'];

// Tab → canonical kind, with the header names each field may appear under.
export const LEDGER_TABS = {
  tasks: { names: ['worklog', 'work log', 'tasks'], key: 'title', fields: {
    logged_at: ['logged at', 'timestamp'], work_date: ['work date', 'date'], brand: ['brand'], title: ['task', 'title'],
    status: ['status'], priority: ['priority'], deadline: ['deadline'], start_date: ['start date'], end_date: ['end date'],
    notes: ['notes / links', 'notes/links', 'notes'], last_updated: ['last updated'], repeat: ['repeat'], pinned: ['pinned'],
    type: ['type'], campaign: ['campaign'], tags: ['tags'], revision: ['revision'], status_since: ['status since'],
    waiting_on: ['waiting on'], focus_date: ['focus date'], outcome: ['outcome'], est_cost: ['est cost', 'estimated cost'],
    actual_cost: ['actual cost'], vendor: ['vendor'], brief: ['brief'], for_whom: ['for'], minutes: ['minutes'],
    entry_kind: ['entry kind'], depends_on: ['depends on'], approved_version: ['approved version'],
  } },
  subtasks: { names: ['subtasks'], key: 'text', fields: {
    parent_row: ['parent row', 'parent task', 'task row'], text: ['text', 'subtask'], done: ['done'], created_at: ['created at'] } },
  deliverables: { names: ['deliverables'], key: 'parent_row', fields: {
    parent_row: ['parent row', 'task row'], type: ['type'], version: ['version'], link: ['link'], used_where: ['used where'], added_at: ['added at'] } },
  progress: { names: ['progress'], key: 'note', fields: {
    task_row: ['task row', 'parent row'], date: ['date'], note: ['note'], minutes: ['minutes'] } },
  campaigns: { names: ['campaigns'], key: 'name', fields: {
    name: ['name', 'campaign'], brand: ['brand'], launch_date: ['launch date'], brief_link: ['brief link'], notes: ['notes'],
    created_at: ['created at'], stage: ['stage'], status: ['status'], priority: ['priority'], objective: ['objective'],
    next_action: ['next action'], milestone: ['milestone'], milestone_date: ['milestone date'], blocker: ['blocker'],
    decision: ['decision'], budget: ['budget'], brief: ['brief json', 'brief'], measure: ['measure json', 'measure'],
    results: ['results json', 'results'], log: ['log json', 'log'], idea_rows: ['idea rows'] } },
  ideas: { names: ['ideas'], key: 'text', fields: {
    text: ['text', 'idea'], original: ['original'], brand: ['brand'], tags: ['tags'], links: ['links'], status: ['status'],
    created_at: ['created at'], revisit_date: ['revisit date'], revisit_when: ['revisit when'], concept: ['concept json', 'concept'],
    task_row: ['task row'], campaign_row: ['campaign row'] } },
  key_dates: { names: ['key dates', 'keydates'], key: 'name', fields: {
    name: ['name'], date: ['date'], brand: ['brand'], lead_days: ['lead days'], notes: ['notes'] } },
  vendors: { names: ['vendors'], key: 'name', fields: {
    name: ['name'], role: ['role'], phone: ['phone'], email: ['email'], rate: ['rate'], rating: ['rating'], notes: ['notes'],
    last_worked: ['last worked'] } },
  templates: { names: ['templates'], key: 'name', fields: { name: ['name'], type: ['type'], subtasks: ['subtasks'] } },
  brands: { names: ['brand foundations', 'brandfoundations', 'brands'], key: 'brand', fields: {
    brand: ['brand'], positioning: ['positioning'], audiences: ['audiences'], tone: ['tone'], visual: ['visual'],
    offerings: ['offerings'], claims: ['claims'], updated_at: ['updated at'] } },
  reminders: { names: ['reminders'], key: 'text', fields: {
    text: ['text'], due_at: ['due at'], repeat: ['repeat'], done: ['done'], calendar_event_id: ['event id', 'calendar event id'],
    created_at: ['created at'], source: ['source'], task_row: ['task row', 'task'] } },
};
// Import order: everything a row refers to exists before the row.
export const IMPORT_ORDER = ['brands', 'vendors', 'templates', 'key_dates', 'campaigns', 'tasks', 'subtasks', 'deliverables', 'progress', 'ideas', 'reminders', 'links'];

const squash = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (value) => { const s = value == null ? '' : String(value).trim(); return s === '' ? null : s; };
const pad = (n) => String(n).padStart(2, '0');

/** Excel serial (days since 1899-12-30, fraction = time of day) → parts. */
function fromSerial(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}

/** Accepts sheet serials, Date objects, ISO strings and dd/mm/yyyy (or mm/dd/yyyy with dateOrder 'MDY'). */
export function toDateParts(value, dateOrder = 'DMY') {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return fromSerial(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate(), h: value.getHours(), min: value.getMinutes() };
  }
  const s = String(value).trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(s);
  if (match) return { y: +match[1], m: +match[2], d: +match[3], h: +(match[4] ?? 0), min: +(match[5] ?? 0) };
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?)?$/i.exec(s);
  if (match) {
    const [first, second] = [+match[1], +match[2]];
    let h = +(match[4] ?? 0);
    if (match[6]) h = (h % 12) + (/pm/i.test(match[6]) ? 12 : 0);
    const dm = dateOrder === 'MDY' ? { m: first, d: second } : { d: first, m: second };
    return { y: +match[3], ...dm, h, min: +(match[5] ?? 0) };
  }
  return null;
}
function validParts(p) {
  if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return null;
  const check = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return check.getUTCMonth() === p.m - 1 ? p : null;
}
export function toDay(value, dateOrder) {
  const p = validParts(toDateParts(value, dateOrder));
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : null;
}
export function toDateTime(value, dateOrder) {
  const p = validParts(toDateParts(value, dateOrder));
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}` : null;
}
const toNumber = (value) => {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const toInteger = (value) => { const n = toNumber(value); return n == null ? null : Math.round(n); };
const toBool = (value) => value === true || /^(true|yes|y|1|✓|x)$/i.test(String(value ?? '').trim());
const toList = (value) => (text(value) ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const toRows = (value) => {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isInteger);
  const s = text(value);
  if (!s) return [];
  try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isInteger); } catch { /* comma list */ }
  return s.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 1);
};
function pick(value, options) {
  const s = squash(value);
  return options.find((option) => squash(option) === s) ?? null;
}
/** JSON columns may be empty or malformed: unparsable text becomes a plain objective (spec). */
function toJson(value, fallbackKey = 'objective') {
  const s = text(value);
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string' && parsed.trim()) return { [fallbackKey]: parsed.trim() };
  } catch { /* plain text */ }
  return { [fallbackKey]: s };
}
function toLog(value) {
  const s = text(value);
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.filter((e) => e && text(e.text)).map((e) => ({ at: toDateTime(e.at) ?? null, text: String(e.text) }));
  } catch { /* plain text */ }
  return [{ at: null, text: s }];
}
const ATTACHMENT_LINE = /📎\s*(.+?)\s+[—–-]\s+(https?:\/\/\S+)/gu;
export function attachmentsFromNotes(notes) {
  return [...String(notes ?? '').matchAll(ATTACHMENT_LINE)].map((m) => ({ name: m[1].trim(), url: m[2].trim() }));
}
export function normaliseStatus(value) {
  const s = text(value);
  if (!s) return { status: 'Brief', legacy: false };
  if (LEGACY_STATUS[s.toLowerCase()]) return { status: LEGACY_STATUS[s.toLowerCase()], legacy: true };
  const exact = pick(s, LEDGER_STATUSES);
  return exact ? { status: exact, legacy: false } : { status: 'Brief', legacy: true, unknown: s };
}
function normaliseRepeat(value) {
  const s = squash(value);
  if (!s || s === 'none') return null;
  if (s.startsWith('weekday') || s === 'monfri') return 'weekdays';
  return ['daily', 'weekly', 'monthly'].includes(s) ? s : null;
}

/** Header row → { field: columnIndex } for a tab. */
function columnMap(headerRow, spec) {
  const index = new Map((headerRow ?? []).map((h, i) => [squash(h), i]));
  const map = {};
  for (const [field, aliases] of Object.entries(spec.fields)) {
    for (const alias of aliases) {
      if (index.has(squash(alias))) { map[field] = index.get(squash(alias)); break; }
    }
  }
  return map;
}

const ROW_BUILDERS = {
  tasks(get, row, { dateOrder, stats }) {
    const status = normaliseStatus(get('status'));
    if (status.legacy) stats.legacy_statuses += 1;
    if (status.unknown) stats.warnings.push(`Row ${row}: unknown status "${status.unknown}" read as Brief.`);
    const notes = text(get('notes'));
    const entryKind = squash(get('entry_kind')) === 'support' ? 'support' : null;
    return {
      legacy_row: row, logged_at: toDateTime(get('logged_at'), dateOrder), work_date: toDay(get('work_date'), dateOrder),
      brand: text(get('brand')), title: text(get('title')), status: status.status,
      priority: pick(get('priority'), ['High', 'Medium', 'Low']) ?? 'Medium',
      deadline: toDay(get('deadline'), dateOrder), start_date: toDay(get('start_date'), dateOrder), end_date: toDay(get('end_date'), dateOrder),
      notes, attachments: attachmentsFromNotes(notes), last_updated: toDay(get('last_updated'), dateOrder),
      repeat: normaliseRepeat(get('repeat')), pinned: toBool(get('pinned')), type: text(get('type')), campaign: text(get('campaign')),
      tags: toList(get('tags')), revision: toInteger(get('revision')) ?? 0, status_since: toDay(get('status_since'), dateOrder),
      waiting_on: text(get('waiting_on')), focus_date: toDay(get('focus_date'), dateOrder), outcome: text(get('outcome')),
      est_cost: toNumber(get('est_cost')), actual_cost: toNumber(get('actual_cost')), vendor: text(get('vendor')),
      brief: toJson(get('brief')), for_whom: text(get('for_whom')), minutes: toInteger(get('minutes')), entry_kind: entryKind,
      approved_version: text(get('approved_version')), depends_on_row: toInteger(get('depends_on')),
    };
  },
  subtasks: (get, row) => ({ legacy_row: row, parent_row: toInteger(get('parent_row')), text: text(get('text')), done: toBool(get('done')), created_at: toDateTime(get('created_at')) }),
  deliverables: (get, row, { dateOrder }) => ({ legacy_row: row, parent_row: toInteger(get('parent_row')), type: text(get('type')),
    version: text(get('version')), link: text(get('link')), used_where: text(get('used_where')), added_at: toDateTime(get('added_at'), dateOrder) }),
  progress: (get, row, { dateOrder }) => ({ legacy_row: row, task_row: toInteger(get('task_row')), date: toDay(get('date'), dateOrder), note: text(get('note')), minutes: toInteger(get('minutes')) }),
  campaigns(get, row, { dateOrder }) {
    let stage = pick(get('stage'), STAGES);
    // Older rows carry only a status: Done → Reviewed, Planning → Captured, anything else → Developing.
    if (!stage) stage = ({ done: 'Reviewed', planning: 'Captured' })[squash(get('status'))] ?? (text(get('status')) ? 'Developing' : 'Captured');
    return {
      legacy_row: row, name: text(get('name')), brand: text(get('brand')), launch_date: toDay(get('launch_date'), dateOrder),
      brief_link: text(get('brief_link')), notes: text(get('notes')), created_at: toDateTime(get('created_at'), dateOrder), stage,
      priority: pick(get('priority'), ['High', 'Medium', 'Low']) ?? 'Medium', objective: text(get('objective')),
      next_action: text(get('next_action')), milestone: text(get('milestone')), milestone_date: toDay(get('milestone_date'), dateOrder),
      blocker: text(get('blocker')), decision: text(get('decision')), budget: text(get('budget')),
      brief: toJson(get('brief'), 'insight'), measure: toJson(get('measure'), 'primary'), results: toJson(get('results'), 'happened'),
      log: toLog(get('log')), idea_rows: toRows(get('idea_rows')),
    };
  },
  ideas: (get, row, { dateOrder }) => ({ legacy_row: row, text: text(get('text')), original: text(get('original')), brand: text(get('brand')),
    tags: toList(get('tags')), links: text(get('links')), status: pick(get('status'), IDEA_STATUSES) ?? 'Open',
    created_at: toDateTime(get('created_at'), dateOrder), revisit_date: toDay(get('revisit_date'), dateOrder), revisit_when: text(get('revisit_when')),
    concept: toJson(get('concept'), 'oneLine'), task_row: toInteger(get('task_row')), campaign_row: toInteger(get('campaign_row')) }),
  key_dates: (get, row, { dateOrder }) => ({ legacy_row: row, name: text(get('name')), date: toDay(get('date'), dateOrder), brand: text(get('brand')),
    lead_days: toInteger(get('lead_days')), notes: text(get('notes')) }),
  vendors: (get, row, { dateOrder }) => {
    const rating = toInteger(get('rating'));
    return { legacy_row: row, name: text(get('name')), role: text(get('role')), phone: text(get('phone')), email: text(get('email')),
      rate: text(get('rate')), rating: rating >= 1 && rating <= 5 ? rating : null, notes: text(get('notes')), last_worked: toDay(get('last_worked'), dateOrder) };
  },
  templates: (get, row) => ({ legacy_row: row, name: text(get('name')), type: text(get('type')),
    subtasks: (text(get('subtasks')) ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }),
  brands: (get, row, { dateOrder }) => ({ legacy_row: row, brand: text(get('brand')), positioning: text(get('positioning')), audiences: text(get('audiences')),
    tone: text(get('tone')), visual: text(get('visual')), offerings: text(get('offerings')), claims: text(get('claims')), updated_at: toDateTime(get('updated_at'), dateOrder) }),
  reminders: (get, row, { dateOrder }) => ({ legacy_row: row, text: text(get('text')), due_at: toDateTime(get('due_at'), dateOrder),
    repeat: normaliseRepeat(get('repeat')), done: toBool(get('done')), calendar_event_id: text(get('calendar_event_id')),
    created_at: toDateTime(get('created_at'), dateOrder), source: squash(get('source')) === 'followup' ? 'followup' : 'reminder',
    task_row: toInteger(get('task_row')) }),
};

/** Which canonical tab a sheet name (or CSV file name, e.g. "Work Ledger - Subtasks.csv") is. */
export function tabKind(sheetName) {
  const base = String(sheetName).replace(/\.csv$/i, '').split(' - ').at(-1);
  const s = squash(base);
  return Object.entries(LEDGER_TABS).find(([, spec]) => spec.names.some((name) => squash(name) === s))?.[0] ?? null;
}

/**
 * sheets: { [sheetName]: rows[][] } where rows[0] is the header row and rows keep blank lines.
 * Returns { kinds: {kind: rows[]}, stats: {kind: {rows, skipped}}, problems: string[], legacy_statuses }.
 */
export function parseLedgerSheets(sheets, { dateOrder = 'DMY' } = {}) {
  const kinds = Object.fromEntries(IMPORT_ORDER.map((kind) => [kind, []]));
  const stats = {}; const problems = []; const warnings = []; const context = { dateOrder, stats: { legacy_statuses: 0, warnings } };
  for (const [sheetName, rows] of Object.entries(sheets)) {
    const kind = tabKind(sheetName);
    if (!kind) { if (rows?.length) warnings.push(`Tab "${sheetName}" was not recognised and is skipped.`); continue; }
    const spec = LEDGER_TABS[kind];
    const columns = columnMap(rows[0], spec);
    if (columns[spec.key] === undefined) { problems.push(`Tab "${sheetName}" has no "${spec.fields[spec.key][0]}" column.`); continue; }
    stats[kind] = { rows: 0, skipped: 0 };
    rows.slice(1).forEach((cells, index) => {
      const row = index + 2;
      const get = (field) => (columns[field] === undefined ? null : cells?.[columns[field]] ?? null);
      // A blank key cell is how the original app soft-deleted a record.
      if (text(get(spec.key)) == null) { if ((cells ?? []).some((c) => text(c) != null)) stats[kind].skipped += 1; return; }
      const built = ROW_BUILDERS[kind](get, row, context);
      stats[kind].rows += 1;
      kinds[kind].push(built);
    });
  }
  // Cross-tab references, then the second-pass links.
  const taskRows = new Set(kinds.tasks.map((t) => t.legacy_row));
  const ideaRows = new Set(kinds.ideas.map((i) => i.legacy_row));
  const campaignRows = new Set(kinds.campaigns.map((c) => c.legacy_row));
  for (const [kind, field] of [['subtasks', 'parent_row'], ['deliverables', 'parent_row'], ['progress', 'task_row']]) {
    for (const item of kinds[kind]) if (!taskRows.has(item[field])) problems.push(`${kind} row ${item.legacy_row} points to task row ${item[field] ?? '(blank)'}, which is not in the WorkLog.`);
  }
  for (const task of kinds.tasks) {
    if (task.depends_on_row) {
      if (taskRows.has(task.depends_on_row)) kinds.links.push({ kind: 'task_depends', legacy_row: task.legacy_row, depends_on_row: task.depends_on_row });
      else warnings.push(`Task row ${task.legacy_row} depends on row ${task.depends_on_row}, which is missing.`);
    }
    delete task.depends_on_row;
  }
  for (const idea of kinds.ideas) {
    if (idea.task_row || idea.campaign_row) kinds.links.push({ kind: 'idea_refs', legacy_row: idea.legacy_row,
      task_row: taskRows.has(idea.task_row) ? idea.task_row : null, campaign_row: campaignRows.has(idea.campaign_row) ? idea.campaign_row : null });
    delete idea.task_row; delete idea.campaign_row;
  }
  for (const campaign of kinds.campaigns) {
    const rows = campaign.idea_rows.filter((r) => ideaRows.has(r));
    if (rows.length) kinds.links.push({ kind: 'campaign_ideas', legacy_row: campaign.legacy_row, idea_rows: rows });
    delete campaign.idea_rows;
  }
  for (const reminder of kinds.reminders) if (reminder.task_row && !taskRows.has(reminder.task_row)) reminder.task_row = null;
  const taskCampaigns = new Set(kinds.tasks.map((t) => t.campaign?.toLowerCase()).filter(Boolean));
  const named = new Set(kinds.campaigns.map((c) => c.name.toLowerCase()));
  const created = [...taskCampaigns].filter((name) => !named.has(name)).length;
  return { kinds, stats, problems, warnings, legacy_statuses: context.stats.legacy_statuses, campaigns_created_from_tasks: created };
}

/** A SheetJS workbook → sheets, keeping blank rows so row numbers stay true. */
export function sheetsFromWorkbook(XLSX, workbook) {
  return Object.fromEntries(workbook.SheetNames.map((name) => [name,
    XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true })]));
}

/** Split rows into batches the server accepts within its time limit. */
export function importBatches(rows, size = 200) {
  const batches = [];
  for (let i = 0; i < rows.length; i += size) batches.push(rows.slice(i, i + size));
  return batches;
}
