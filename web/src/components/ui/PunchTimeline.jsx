// The punches of one day, drawn to scale.
//
// Staff punch out for tea and lunch, so a normal day here is six to eight punches, not two. A
// column of "in 09:39 / out 18:33" hides the three breaks in between and makes two very different
// days look identical. This draws the day as a bar: solid where they were in, hollow where they
// were out, so a long lunch is visible at a glance without reading any numbers.
//
// Pairing follows the engine exactly — first punch in, last punch out, the middle ones alternate
// out/in. See splitSessions() in services/attendance/src/engine/processDay.ts. The terminals send
// punch_state 255 on every record, so there is no direction flag to read; order is all there is.
import React, { useEffect, useRef, useState } from 'react';
import './PunchTimeline.css';
import { labelLayout, rowCount, spanLabels } from '../../lib/punchLayout';
import { formatClock } from '../../lib/clock';
import { useClockFormat } from '../../lib/timeFormat';

// One shape for the whole component. It used to print "9:37 am" in the header and "09:37" on the
// bar immediately below — the same punch, twice, differently.

const mins = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));

/**
 * Split an ordered punch list into the stretches present and the stretches away.
 * Returns [] for anything that cannot describe a day (0 or 1 punch).
 *
 * This mirrors splitSessions() in the engine and must keep mirroring it: the breaks are the PAIRED
 * middle punches, not simply every other gap. The two are the same while the count is even, and
 * diverge the moment somebody forgets a punch. Marking every odd gap as a break would treat the
 * final punch of a nine-punch day as a return rather than a departure, and report a break the
 * engine never counted — the UI would then contradict the hours on the same screen.
 */
export function segments(punches) {
  if (!Array.isArray(punches) || punches.length < 2) return [];

  const middle = punches.slice(1, -1);
  const breakStarts = new Set();
  for (let i = 0; i + 1 < middle.length; i += 2) breakStarts.add(i + 1); // index within `punches`
  // An odd middle count leaves one punch with no partner; the span after it cannot be classified.
  const unpairedAt = middle.length % 2 === 1 ? punches.length - 2 : -1;

  const out = [];
  for (let i = 0; i + 1 < punches.length; i += 1) {
    out.push({
      from: punches[i],
      to: punches[i + 1],
      minutes: mins(punches[i], punches[i + 1]),
      away: breakStarts.has(i),
      unknown: i === unpairedAt,
    });
  }
  return out;
}

/**
 * The compact form: "3 breaks · 78m", amber when a punch is missing.
 * Used in table cells where a bar would be too much.
 */
export function BreakSummary({ row }) {
  const n = Array.isArray(row.punches) ? row.punches.length : 0;
  if (n < 4) {
    return <span className="text-neutral-450">{row.breaks_incomplete ? 'punch missing' : '—'}</span>;
  }
  const count = segments(row.punches).filter((s) => s.away).length;
  return (
    <span className={row.breaks_incomplete ? 'text-amber-600 dark:text-amber-400' : ''}>
      <span className="tabular-nums font-semibold">{count}</span>
      <span className="text-neutral-450"> · </span>
      <span className="tabular-nums">{row.break_minutes}m</span>
      {row.breaks_incomplete && <span className="ml-1 text-2xs">?</span>}
    </span>
  );
}

/**
 * The bar. Scaled to the day's own span rather than a fixed clock window, because a 09:00-18:00 day
 * and a 22:00-06:00 night shift both need to read well and a shared axis would squash one of them.
 */
export default function PunchTimeline({ punches, breakMinutes = 0, incomplete = false, className = '' }) {
  const { hour12 } = useClockFormat();
  const container = useRef(null);
  const [width, setWidth] = useState(520);
  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const resize = () => setWidth(Math.max(1, element.getBoundingClientRect().width));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [punches?.length]);
  const time = (ts) => formatClock(ts, hour12);
  const segs = segments(punches);
  if (!segs.length) {
    return (
      <div className={`text-2xs text-neutral-450 ${className}`}>
        {punches?.length === 1 ? `One punch only, at ${time(punches[0])} — no way to tell in from out.` : 'No punches.'}
      </div>
    );
  }

  const start = new Date(punches[0]).getTime();
  const total = new Date(punches[punches.length - 1]).getTime() - start;
  const pct = (ts) => (total > 0 ? ((new Date(ts).getTime() - start) / total) * 100 : 0);
  const worked = segs.filter((s) => !s.away && !s.unknown).reduce((a, s) => a + s.minutes, 0);
  // The monospace 12px labels need actual room at every container width, including
  // a narrow detail panel on a desktop. Padding also leaves space between neighbours.
  const percentPerChar = 7.5 / width * 100;
  const timeWidth = (Math.max(...punches.map((punch) => time(punch).length)) + 2) * percentPerChar;
  const layout = labelLayout(punches, timeWidth);
  const rows = rowCount(layout);
  // How long each stretch lasted, over the stretch itself. Durations describe spans and go above
  // the bar; punch times describe moments and go below it, so which is which is never in doubt.
  const spans = spanLabels(segs, punches, percentPerChar);
  const spanRows = rowCount(spans);

  return (
    <div ref={container} className={`punch-timeline ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mb-1.5">
        <span className="font-semibold text-neutral-900 dark:text-white tabular-nums">
          {time(punches[0])} → {time(punches[punches.length - 1])}
        </span>
        <span className="text-neutral-500">
          <span className="tabular-nums font-semibold text-brand-ink dark:text-brand-ink">
            {(worked / 60).toFixed(1)}h
          </span> in
        </span>
        {breakMinutes > 0 && (
          <span className="text-neutral-500">
            <span className="tabular-nums font-semibold text-amber-600 dark:text-amber-400">{breakMinutes}m</span> out
            <span className="text-neutral-450"> over {segs.filter((s) => s.away).length}</span>
          </span>
        )}
        <span className="text-neutral-450 tabular-nums">{punches.length} punches</span>
        {incomplete && (
          <span className="text-amber-600 dark:text-amber-400">
            a punch is missing — time out is at least this much
          </span>
        )}
      </div>

      <div className="relative punch-duration-labels" style={{ height: `${spanRows * 20 + 2}px` }}>
        {spans.map((sp, i) => (
          <React.Fragment key={i}>
            <span aria-hidden="true" className="absolute bottom-0 w-px bg-neutral-300 dark:bg-neutral-700"
              style={{ left: `${sp.pct}%`, height: `${sp.row * 20 + 3}px` }} />
            <span
              className={`punch-timeline-label absolute px-1 rounded text-xs font-mono tabular-nums leading-none py-0.5 whitespace-nowrap ${
                sp.unknown ? 'text-neutral-450' : sp.away
                  ? 'text-amber-700 dark:text-amber-400 font-semibold'
                  : 'text-neutral-500 dark:text-neutral-400'
              }`}
              style={{ left: `${sp.labelPct}%`, bottom: `${sp.row * 20 + 3}px`, transform: 'translateX(-50%)' }}
              title={sp.unknown ? 'A punch is missing — this stretch cannot be classified'
                : sp.away ? `Away ${sp.minutes} minutes` : `Present ${sp.minutes} minutes`}
            >{sp.text}</span>
          </React.Fragment>
        ))}
      </div>

      {/* The bar itself. role=img with a written-out label so this is not purely visual. */}
      <div
        className="relative h-5 rounded bg-neutral-150 dark:bg-neutral-800 overflow-hidden"
        role="img"
        aria-label={segs
          .map((s) => `${s.unknown ? 'Unaccounted' : s.away ? 'Out' : 'In'} ${time(s.from)} to ${time(s.to)}, ${s.minutes} minutes`)
          .join('. ')}
      >
        {segs.map((s, i) => (
          <div
            key={i}
            title={`${s.unknown ? 'Unknown — a punch is missing' : s.away ? 'Away' : 'Present'} ${time(s.from)}–${time(s.to)} · ${s.minutes}m`}
            className={`absolute inset-y-0 ${
              s.unknown
                ? 'bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgb(120_120_120/0.4)_3px,rgb(120_120_120/0.4)_6px)]'
                : s.away
                  ? 'bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgb(217_119_6/0.45)_3px,rgb(217_119_6/0.45)_6px)]'
                  : 'bg-brand-action dark:bg-brand-action'
            }`}
            style={{ left: `${pct(s.from)}%`, width: `${Math.max(0.6, pct(s.to) - pct(s.from))}%` }}
          />
        ))}
      </div>

      <div className="relative mt-1 punch-time-labels" style={{ height: `${rows * 20 + 4}px` }}>
        {layout.map(({ punch, pct, labelPct, row }, i) => {
          const first = i === 0;
          const last = i === punches.length - 1;
          const leaving = segs[i]?.away === true;
          const unknown = segs[i]?.unknown === true;
          return (
            <React.Fragment key={`${punch}-${i}`}>
              <span aria-hidden="true" className="absolute top-0 w-px bg-neutral-300 dark:bg-neutral-700"
                style={{ left: `${pct}%`, height: `${row * 20 + 3}px` }} />
              <span
                className={`punch-timeline-label absolute px-1 rounded text-xs font-mono font-semibold tabular-nums leading-none py-0.5 whitespace-nowrap ${
                  first || last ? 'bg-brand/10 text-brand-ink dark:bg-brand/15 dark:text-brand-ink'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                }`}
                style={{ left: `${labelPct}%`, top: `${row * 20 + 3}px`, transform: 'translateX(-50%)' }}
                title={first ? 'Arrived' : last ? 'Left' : unknown ? 'Unpaired punch' : leaving ? 'Went out' : 'Came back'}
              >{time(punch)}</span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
