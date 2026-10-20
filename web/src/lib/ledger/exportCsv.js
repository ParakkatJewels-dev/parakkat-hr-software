// "Export everything as CSV": every task with the original 33 columns, in the original order, so
// the file stays a complete backup and can be read back by the importer.
export const EXPORT_COLUMNS = [
  ['Logged At', 'logged_at'], ['Work Date', 'work_date'], ['Brand', 'brand'], ['Task', 'task'], ['Status', 'status'],
  ['Priority', 'priority'], ['Deadline', 'deadline'], ['Start Date', 'start_date'], ['End Date', 'end_date'],
  ['Delegated To', null], ['Deadline Communicated', null], ['Delegated By', null], ['Notes / Links', 'notes'],
  ['Last Updated', 'last_updated'], ['Repeat', 'repeat'], ['Pinned', 'pinned'], ['Type', 'type'], ['Campaign', 'campaign'],
  ['Tags', 'tags'], ['Revision', 'revision'], ['Status Since', 'status_since'], ['Waiting On', 'waiting_on'],
  ['Focus Date', 'focus_date'], ['Outcome', 'outcome'], ['Est Cost', 'est_cost'], ['Actual Cost', 'actual_cost'],
  ['Vendor', 'vendor'], ['Brief', 'brief'], ['For', 'for_whom'], ['Minutes', 'minutes'], ['Entry Kind', 'entry_kind'],
  ['Depends On', 'depends_on'], ['Approved Version', 'approved_version'],
];

function cell(value) {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Export rows (from ledger_export_tasks) → { headers, rows } for downloadCsv. */
export function exportTable(tasks) {
  return {
    headers: EXPORT_COLUMNS.map(([header]) => header),
    rows: tasks.map((task) => EXPORT_COLUMNS.map(([, key]) => (key ? cell(task[key]) : ''))),
  };
}
