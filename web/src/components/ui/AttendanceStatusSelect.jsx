import { ATTENDANCE_STATUSES } from '../../data/attendance';

export default function AttendanceStatusSelect({ row, mutation }) {
  return (
    <select
      value={row.status}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        event.stopPropagation();
        if (event.target.value !== row.status) {
          mutation.mutate({ id: row.id, status: event.target.value });
        }
      }}
      disabled={mutation.isPending || row.is_locked}
      aria-label={`Change attendance status for ${row.employee?.full_name || row.work_date}`}
      title={row.is_locked ? 'Locked by finalized payroll' : 'Change attendance status'}
      className="min-w-24 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-2xs font-bold text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 disabled:opacity-50"
    >
      {ATTENDANCE_STATUSES.map((status) => (
        <option key={status} value={status}>{status}</option>
      ))}
    </select>
  );
}
