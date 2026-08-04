// Add or edit a record without leaving the table it belongs to.
//
// A branch is four short fields that already have columns above them. Opening a panel somewhere
// else on the page to collect them costs you the context you were looking at, and when you are
// entering six branches in a row it means six round trips. Typing straight into the list is both
// faster and more obvious: the new row appears where the record will actually live.
//
// Deliberately NOT one input per column. Mapping form fields onto display columns breaks the
// moment the two lists diverge (branches show "Name / Code" as one column but are two fields), so
// the row spans the table and lays its fields out inline. It still reads as a row of the list.
//
// Bigger records — a shift with seven time fields, a payroll component with scope rules — stay in
// a panel. This is for records you can describe in a line.
import React, { useEffect, useRef, useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { btnClass } from './Btn';

const INPUT =
  'w-full min-w-0 text-sm rounded-lg px-2 py-1.5 bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:border-[#0ea971] focus:ring-2 focus:ring-[#0ea971]/20 transition-colors';

/**
 * @param fields       [{ key, label, required, placeholder, type:'select', from }]
 * @param fieldOptions { [from]: rows[] } for select fields
 * @param initial      existing row when editing, {} when adding
 * @param labelOf      how to render an option
 * @param colSpan      how many columns of the host table to span
 */
export default function InlineRowForm({
  fields, fieldOptions = {}, initial = {}, labelOf = (r) => r.name ?? r.title ?? r.code ?? '—',
  colSpan, onSave, onCancel, busy = false, error, submitLabel = 'Save',
}) {
  const [form, setForm] = useState(() => ({ ...initial }));
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const canSave = fields.every((f) => !f.required || String(form[f.key] ?? '').trim());

  const save = () => { if (canSave && !busy) onSave(form); };

  // Enter saves, Escape abandons — the two keys anyone typing into a grid already expects.
  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <tr className="bg-[#0ea971]/5">
      <td colSpan={colSpan} className="py-2.5">
        <div className="inline-row-form flex flex-wrap items-end gap-2" onKeyDown={onKeyDown}>
          {fields.map((f, i) => (
            <div key={f.key} className={f.type === 'select' ? 'inline-row-field inline-row-field-select min-w-[10rem] flex-1' : 'inline-row-field min-w-[7rem] flex-1'}>
              <label
                htmlFor={`inline-${f.key}`}
                className="block text-2xs font-bold uppercase tracking-wider text-neutral-450 mb-1"
              >
                {f.label}
                {f.required && <span className="text-rose-500 ml-0.5" aria-hidden="true">*</span>}
              </label>
              {f.type === 'select' ? (
                <select
                  id={`inline-${f.key}`}
                  ref={i === 0 ? firstRef : undefined}
                  value={form[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={INPUT + ' cursor-pointer'}
                >
                  <option value="">—</option>
                  {(fieldOptions[f.from] ?? []).map((o) => (
                    <option key={o.id} value={o.id}>{labelOf(o)}</option>
                  ))}
                </select>
              ) : (
                <input
                  id={`inline-${f.key}`}
                  ref={i === 0 ? firstRef : undefined}
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder || ''}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={INPUT}
                />
              )}
            </div>
          ))}

          <div className="inline-row-actions flex items-center gap-1 pb-0.5 shrink-0">
            <button
              type="button"
              onClick={save}
              disabled={!canSave || busy}
              title={submitLabel}
              aria-label={submitLabel}
              className={btnClass('primary', 'sm')}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            </button>
            <button
              type="button"
              onClick={onCancel}
              title="Cancel"
              aria-label="Cancel"
              className="p-1.5 rounded-lg text-neutral-450 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-xs text-rose-600 dark:text-rose-300 mt-1.5">{error}</p>
        )}
      </td>
    </tr>
  );
}
