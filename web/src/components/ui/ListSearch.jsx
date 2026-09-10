import { Search } from 'lucide-react';

export default function ListSearch({ value, onChange, label = 'Search records', placeholder = 'Search by name or code…' }) {
  return <label className="flex min-w-0 items-center gap-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2.5 text-neutral-500 focus-within:ring-2 focus-within:ring-brand/30">
    <Search size={16} className="shrink-0" aria-hidden="true" />
    <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className="w-full min-w-0 bg-transparent text-base text-neutral-900 dark:text-neutral-100 outline-none" />
  </label>;
}
