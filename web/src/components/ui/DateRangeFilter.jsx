// The period filter used across attendance: Today, Last week, This month, Last 3 months, Custom.
//
// One control, one set of arithmetic. Before this, each screen rolled its own — the per-person view
// offered 30/60/90 days, the exceptions view offered two bare date boxes, and both computed their
// dates with toISOString(). That is UTC, this company is UTC+5:30, and so between midnight and
// 05:30 IST both screens quietly showed a range ending yesterday. src/data/attendance.js has
// carried a comment warning against exactly that; the fix is one place that gets it right rather
// than a rule every screen has to remember.
//
// The arithmetic lives in src/lib/dateRange.js, with no React or network imports, so it can be
// tested directly — see dateRange.test.js.
import { useState } from 'react';
import { todayIso } from '../../data/attendance';
import { RANGE_PRESETS, rangeFor } from '../../lib/dateRange';

/**
 * The whole filter as one piece of state.
 *
 * Returns { preset, from, to, setPreset, setFrom, setTo } so a screen holds one thing instead of
 * three that can disagree. Picking a preset recomputes the dates; editing a date switches to
 * Custom, because a highlighted chip that no longer matches the dates on screen is a lie about
 * what you are looking at.
 */
export function useDateRange(initialKey = 'month') {
  const [state, setState] = useState(() => ({
    preset: initialKey,
    ...(rangeFor(initialKey, todayIso()) ?? { from: todayIso(), to: todayIso() }),
  }));

  return {
    ...state,
    setPreset: (key) => setState((s) => ({ ...s, preset: key, ...(rangeFor(key, todayIso()) ?? {}) })),
    // Keeping from <= to here rather than in the inputs: a keyboard-typed date bypasses the
    // min/max attributes entirely, and a backwards range returns an empty table that looks like
    // "no records" rather than a mistake.
    setFrom: (from) => setState((s) => ({ ...s, preset: 'custom', from, to: from > s.to ? from : s.to })),
    setTo: (to) => setState((s) => ({ ...s, preset: 'custom', to, from: to < s.from ? to : s.from })),
  };
}

const dateInput =
  'text-sm rounded-lg px-2 py-1.5 bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800';

/**
 * Controlled period filter. Spread the pieces of useDateRange straight in.
 *
 * The date boxes stay visible rather than hiding behind the Custom chip: they are what the chips
 * actually did, and the first question anyone asks of a filter — "so what dates am I looking at?"
 * — should not need a click to answer.
 */
export default function DateRangeFilter({ preset, from, to, setPreset, setFrom, setTo, className = '' }) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {RANGE_PRESETS.filter((p) => p.key !== 'custom').map((p) => (
        <button
          key={p.key}
          type="button"
          aria-pressed={preset === p.key}
          onClick={() => setPreset(p.key)}
          className={`rounded-lg px-2.5 py-1.5 text-sm font-bold cursor-pointer transition-colors ${
            preset === p.key
              ? 'bg-[#0ea971]/15 text-[#0c9765] dark:text-[#10b981]'
              : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-charcoal-800'
          }`}
        >
          {p.label}
        </button>
      ))}

      <span className="flex w-full sm:w-auto items-center gap-1.5">
        <input
          type="date" value={from} max={to} aria-label="From"
          onChange={(e) => e.target.value && setFrom(e.target.value)}
          className={dateInput}
        />
        <span className="text-xs text-neutral-400">to</span>
        <input
          type="date" value={to} min={from} aria-label="To"
          onChange={(e) => e.target.value && setTo(e.target.value)}
          className={dateInput}
        />
      </span>

      {preset === 'custom' ? (
        <span className="text-2xs font-bold uppercase tracking-wider text-[#0c9765] dark:text-[#10b981]">
          Custom
        </span>
      ) : null}
    </div>
  );
}
