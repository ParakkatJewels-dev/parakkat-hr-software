// A filter that says what it filters.
//
// Extracted from the Directory so Attendance — and anything else with a filter bar — uses the
// same control. Bare selects in identical grey pills read as "PP Imitations / All Branches /
// Sales / Active" with nothing saying which dimension each belongs to, and nothing showing that
// a filter is applied at all, so a list narrowed to 12 people looks like the whole company.
import React from 'react';
import SearchSelect, { SEARCH_FROM } from './SearchSelect';

/**
 * A filter that says what it filters.
 *
 * These were four bare selects in identical grey pills. Once one was set, the row read
 * "PP Imitations / All Branches / Sales / Active" with nothing to say which dimension each
 * belonged to, and nothing to show a filter was even applied. Now each carries its label, and an
 * active one takes the coral tint so a narrowed list never looks like the whole company.
 */
export default function FilterSelect({ label, value, options, onChange, allValue }) {
  const active = value !== allValue;
  const id = `filter-${label.toLowerCase()}`;
  return (
    <div
      className={`input-shell filter-select flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-1.5 rounded-xl border px-3 py-2 sm:py-1.5 w-full sm:w-auto transition-colors ${
        active
          ? 'border-coral-500/40 bg-coral-50'
          : 'border-neutral-300 dark:border-neutral-855 bg-white dark:bg-charcoal-900/50'
      }`}
    >
      <label
        htmlFor={id}
        className={`text-xs font-medium shrink-0 ${
          active ? 'text-coral-700 dark:text-coral-500' : 'text-neutral-500 dark:text-neutral-400'
        }`}
      >
        {label}
      </label>
      {/* Long lists (branches, departments…) get the searchable dropdown; short ones stay native. */}
      {options.length >= SEARCH_FROM ? (
        <SearchSelect
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          options={options.map((o) => ({ value: o, label: o }))}
          aria-label={label}
          className={`bg-transparent border-none text-sm font-semibold w-full sm:max-w-[160px] focus:outline-none focus-visible:ring-2 focus-visible:ring-coral-500/50 rounded-md ${
            active ? 'text-coral-700 dark:text-coral-500' : 'text-neutral-800 dark:text-neutral-200'
          }`}
        />
      ) : (
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`bg-transparent border-none text-sm font-semibold cursor-pointer w-full sm:max-w-[160px] focus:outline-none focus-visible:ring-2 focus-visible:ring-coral-500/50 rounded-md ${
          active ? 'text-coral-700 dark:text-coral-500' : 'text-neutral-800 dark:text-neutral-200'
        }`}
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-white dark:bg-black text-neutral-800 dark:text-neutral-200">
            {o}
          </option>
        ))}
      </select>
      )}
    </div>
  );
}
