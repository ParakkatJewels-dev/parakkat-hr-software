// A filter that says what it filters.
//
// Extracted from the Directory so Attendance — and anything else with a filter bar — uses the
// same control. Bare selects in identical grey pills read as "PP Imitations / All Branches /
// Sales / Active" with nothing saying which dimension each belongs to, and nothing showing that
// a filter is applied at all, so a list narrowed to 12 people looks like the whole company.
import React from 'react';

/**
 * A filter that says what it filters.
 *
 * These were four bare selects in identical grey pills. Once one was set, the row read
 * "PP Imitations / All Branches / Sales / Active" with nothing to say which dimension each
 * belonged to, and nothing to show a filter was even applied. Now each carries its label, and an
 * active one takes the accent colour so a narrowed list never looks like the whole company.
 */
export default function FilterSelect({ label, value, options, onChange, allValue }) {
  const active = value !== allValue;
  const id = `filter-${label.toLowerCase()}`;
  return (
    <div
      className={`filter-select flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-1.5 rounded-xl border px-3 py-2 sm:py-1.5 w-full sm:w-auto transition-colors ${
        active
          ? 'border-[#0ea971]/40 bg-[#0ea971]/10'
          : 'border-neutral-200 dark:border-neutral-855 bg-neutral-50/80 dark:bg-charcoal-900/50'
      }`}
    >
      <label
        htmlFor={id}
        className={`text-2xs font-bold uppercase tracking-wider shrink-0 ${
          active ? 'text-[#0c9765] dark:text-[#10b981]' : 'text-neutral-400'
        }`}
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`bg-transparent border-none text-sm font-semibold cursor-pointer w-full sm:max-w-[150px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50 rounded-md ${
          active ? 'text-[#0c9765] dark:text-[#10b981]' : 'text-neutral-700 dark:text-neutral-300'
        }`}
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-white dark:bg-black text-neutral-800 dark:text-neutral-200">
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
