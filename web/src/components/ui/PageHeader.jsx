// The page header.
//
// The app had eight different title treatments — some h1, some h2, some 20px, some 15px, some
// with an eyebrow and some without. Every screen invented its own, so moving between them felt
// like moving between products.
//
// Structure, top to bottom:
//   eyebrow   which section you are in (People, Organisation, Payroll…)
//   title     the screen, as an <h1> — one per page, which screen readers rely on
//   subtitle  one line on what the screen is for; omit it rather than pad it
//   actions   right-aligned, primary last
//
// Compact: the whole block is ~52px. A data-dense tool cannot spend 120px on a title.
import React from 'react';

export default function PageHeader({ eyebrow, icon: Icon, title, subtitle, actions, meta }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-2xs font-bold uppercase tracking-wider text-[#0ea971] flex items-center gap-1.5">
            {Icon && <Icon size={11} />}
            {eyebrow}
          </p>
        )}
        <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight mt-0.5">
          {title}
        </h1>
        {subtitle && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{subtitle}</p>
        )}
      </div>

      {/* Counts and other at-a-glance facts sit with the actions, not under the title, so the
          header height does not grow with them. */}
      {(actions || meta) && (
        <div className="flex items-center gap-2 shrink-0">
          {meta}
          {actions}
        </div>
      )}
    </div>
  );
}
