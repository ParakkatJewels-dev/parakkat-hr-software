import { formatClock } from '../../lib/clock';
import { useClockFormat } from '../../lib/timeFormat';
import { recordedPunches, punchDate } from '../../lib/recordedPunches';

export default function PunchDetails({ row, expanded = false }) {
  const { hour12 } = useClockFormat();
  const punches = recordedPunches(row);
  if (!punches.length) return <span className="text-neutral-450">No recorded punches</span>;
  const endpointsOnly = !Array.isArray(row?.punches) || row.punches.length === 0;
  return (
    <details open={expanded || undefined} className="min-w-40 text-xs" onClick={event => event.stopPropagation()}>
      <summary className="cursor-pointer font-semibold text-brand-ink py-1"
        aria-label={`Punch details for ${row?.employee?.full_name ? `${row.employee.full_name}, ` : ''}${row?.work_date || punchDate(punches[0])}`}>
        {endpointsOnly ? 'Recorded endpoints' : `${punches.length} punch${punches.length === 1 ? '' : 'es'}`} · Details
      </summary>
      <div className="mt-2 space-y-2 min-w-52">
        <ol aria-label="Recorded punches in time order" className="space-y-1.5">
          {punches.map((time, index) => {
            const gap = index ? Math.round((Date.parse(time) - Date.parse(punches[index - 1])) / 60_000) : null;
            const date = punchDate(time);
            return <li key={time} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-neutral-500">{index + 1}.</span>
              <time dateTime={time} className="font-mono font-semibold whitespace-nowrap">
                {formatClock(time, hour12)}{date !== (row?.work_date || punchDate(punches[0])) ? ` (${date})` : ''}
              </time>
              <span className="text-neutral-500">
                {index === 0 ? 'First punch' : index === punches.length - 1 ? 'Latest punch' : 'Punch'}
                {gap != null && ` · ${gap} min after previous`}
              </span>
            </li>;
          })}
        </ol>
        {endpointsOnly && <p className="text-neutral-500">Only the first and latest recorded times are available for this record.</p>}
        <p className="text-neutral-500">{!endpointsOnly && 'Every recorded punch is shown. '}The latest punch may be a return from a break.</p>
        {row?.regularization_id && <p className="text-neutral-500">
          Approved attendance: {formatClock(row.check_in, hour12)} – {formatClock(row.check_out, hour12)}. Recorded punches stay unchanged.
        </p>}
      </div>
    </details>
  );
}
