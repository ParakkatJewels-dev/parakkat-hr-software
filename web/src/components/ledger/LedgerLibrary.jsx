// Library: vendors, task templates, key dates (the festival calendar) and brand notes. Plain
// ruled tables with inline add and edit; removing an entry hides it (nothing is erased).
import React, { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { newId, useLedgerAction, useLedgerLibrary } from '../../data/workLedger';
import { Message, ReadOnlyNote, Suggest, dateLabel, useLedger } from './ui';

const LIBRARY_TABS = [{ id: 'vendors', label: 'Vendors' }, { id: 'templates', label: 'Templates' }, { id: 'key_dates', label: 'Key dates' }, { id: 'brands', label: 'Brand notes' }];
const TABLES = {
  vendors: { kind: 'vendor', save: 'ledger_save_vendor', arg: '_v', noun: 'vendor', columns: [
    ['name', 'Name'], ['role', 'Role'], ['phone', 'Phone'], ['email', 'Email'], ['rate', 'Rate'], ['rating', 'Rating', 'rating'], ['notes', 'Notes', 'long'],
    ['last_worked', 'Last worked', 'date']] },
  templates: { kind: 'template', save: 'ledger_save_template', arg: '_t', noun: 'template', columns: [['name', 'Name'], ['type', 'Type'], ['subtasks', 'Subtasks', 'lines']] },
  key_dates: { kind: 'key_date', save: 'ledger_save_key_date', arg: '_k', noun: 'key date', columns: [
    ['name', 'Name'], ['date', 'Date', 'date'], ['brand', 'Brand', 'brand'], ['lead_days', 'Lead days', 'number'], ['notes', 'Notes', 'long']] },
};
const FOUNDATION = [['label', 'Short label'], ['positioning', 'Positioning'], ['audiences', 'Audiences'], ['tone', 'Tone'], ['visual', 'Visual'],
  ['offerings', 'Offerings'], ['claims', 'Claims']];

const display = (row, [key, , kind]) => {
  const value = row[key];
  if (kind === 'date') return dateLabel(value);
  if (kind === 'lines') return (value ?? []).join(' · ');
  if (kind === 'rating') return value ? '★'.repeat(value) : '';
  return value ?? '';
};

function RowEditor({ table, row, onDone }) {
  const { boot } = useLedger();
  const act = useLedgerAction();
  const [values, setValues] = useState(() => Object.fromEntries(table.columns.map(([key, , kind]) => [key, kind === 'lines' ? (row?.[key] ?? []).join('\n') : row?.[key] ?? ''])));
  const submit = async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(table.columns.map(([key, , kind]) => {
      const value = typeof values[key] === 'string' ? values[key].trim() : values[key];
      return [key, value === '' ? null : kind === 'number' || kind === 'rating' ? Number(value) : value];
    }).filter(([key, value]) => row || value !== null || key === 'name'));
    try { await act.mutateAsync({ name: table.save, args: { _id: row?.id ?? newId(), [table.arg]: payload } }); onDone(); }
    catch { /* shown below */ }
  };
  return (
    <form className="ledger-library-form" onSubmit={submit} aria-label={row ? `Edit ${row.name}` : `New ${table.noun}`}>
      {table.columns.map(([key, label, kind]) => (
        <label key={key} className="ledger-field" data-wide={kind === 'long' || kind === 'lines' || undefined}><span>{label}</span>
          {kind === 'lines' ? <textarea className="ledger-input" rows={4} value={values[key]} placeholder="One step per line" onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
            : kind === 'long' ? <textarea className="ledger-input" rows={2} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
            : kind === 'brand' ? <Suggest value={values[key]} onChange={(v) => setValues({ ...values, [key]: v })} options={(boot?.brands ?? []).map((b) => b.name)} maxLength={80} />
            : kind === 'rating' ? <select className="ledger-input" value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })}>
              <option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            : <input className="ledger-input" type={kind === 'date' ? 'date' : kind === 'number' ? 'number' : key === 'email' ? 'email' : 'text'} min={kind === 'number' ? 0 : undefined}
              required={key === 'name' || (key === 'date' && table.kind === 'key_date')} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />}
        </label>))}
      <Message error={act.error} />
      <div className="ledger-actions ledger-form-wide">
        <button type="submit" className="ledger-button ledger-button-primary" disabled={act.isPending}>{row ? 'Save' : `Add ${table.noun}`}</button>
        <button type="button" className="ledger-button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function LibraryTable({ tab, rows }) {
  const { readOnly } = useLedger();
  const act = useLedgerAction();
  const table = TABLES[tab];
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState('');
  const shown = table.columns.filter(([, , kind]) => kind !== 'long');
  return (
    <section className="ledger-section" aria-label={LIBRARY_TABS.find((t) => t.id === tab).label}>
      {!readOnly && (
        <div className="ledger-actions">
          {editing !== 'new' && <button type="button" className="ledger-button" onClick={() => setEditing('new')}><Plus size={14} /> Add {table.noun}</button>}
          {tab === 'key_dates' && <button type="button" className="ledger-button" onClick={async () => {
            setMessage('');
            try { await act.mutateAsync({ name: 'ledger_refresh_key_dates', args: {} }); setMessage('Festival dates refreshed.'); } catch { /* shown below */ }
          }}>Refresh festival dates</button>}
        </div>)}
      {editing === 'new' && <RowEditor table={table} onDone={() => setEditing(null)} />}
      <Message error={act.error}>{message}</Message>
      {!rows.length ? <p className="ledger-empty">No {table.noun}s yet.</p> : (
        <div className="ledger-table-scroll">
          <table className="ledger-table">
            <thead><tr>{shown.map(([key, label]) => <th key={key}>{label}</th>)}{tab === 'vendors' && <th>Tasks</th>}{!readOnly && <th><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>{rows.map((row) => editing === row.id ? (
              <tr key={row.id}><td colSpan={shown.length + 2}><RowEditor table={table} row={row} onDone={() => setEditing(null)} /></td></tr>
            ) : (
              <tr key={row.id}>
                {shown.map((column) => <td key={column[0]}>{display(row, column)}{column[0] === 'name' && row.starter && <span className="ledger-tag">starter</span>}
                  {column[0] === 'name' && row.notes && <div className="ledger-quiet">{row.notes}</div>}</td>)}
                {tab === 'vendors' && <td>{row.tasks}</td>}
                {!readOnly && <td className="ledger-row-actions">
                  <button type="button" className="ledger-icon-button ledger-icon-small" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row.id)}><Pencil size={13} /></button>
                  <button type="button" className="ledger-icon-button ledger-icon-small" aria-label={`Remove ${row.name}`} onClick={() => {
                    if (window.confirm(`Remove “${row.name}”?`)) act.mutate({ name: 'ledger_delete_library_item', args: { _kind: table.kind, _id: row.id } });
                  }}><Trash2 size={13} /></button></td>}
              </tr>))}</tbody>
          </table>
        </div>)}
    </section>
  );
}

function BrandNotes({ brands }) {
  const { readOnly } = useLedger();
  const act = useLedgerAction();
  const [editing, setEditing] = useState(null);
  const [values, setValues] = useState({});
  return (
    <section className="ledger-section" aria-label="Brand notes">
      <p className="ledger-quiet">Reference notes for briefing each brand: positioning, audiences, tone, visual style, offerings and the claims you can make.</p>
      {brands.map((brand) => {
        const foundation = { ...(brand.foundation ?? {}), label: brand.label };
        return (
          <article key={brand.id} className="ledger-brand-notes">
            <h3>{brand.name}{!readOnly && editing !== brand.id && <button type="button" className="ledger-link" onClick={() => { setValues(foundation); setEditing(brand.id); }}>Edit</button>}</h3>
            {editing === brand.id ? (
              <form className="ledger-form" onSubmit={async (event) => {
                event.preventDefault();
                try { await act.mutateAsync({ name: 'ledger_save_brand', args: { _name: brand.name, _f: Object.fromEntries(FOUNDATION.map(([key]) => [key, values[key]?.trim() || null])) } }); setEditing(null); }
                catch { /* shown below */ }
              }}>
                {FOUNDATION.map(([key, label]) => (
                  <label key={key} className="ledger-field" data-wide={key !== 'label' || undefined}><span>{label}</span>
                    {key === 'label' ? <input className="ledger-input" maxLength={40} value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
                      : <textarea className="ledger-input" rows={2} value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />}</label>))}
                <Message error={act.error} />
                <div className="ledger-actions ledger-form-wide"><button type="submit" className="ledger-button ledger-button-primary" disabled={act.isPending}>Save notes</button>
                  <button type="button" className="ledger-button" onClick={() => setEditing(null)}>Cancel</button></div>
              </form>
            ) : (
              <dl className="ledger-dl">{FOUNDATION.slice(1).filter(([key]) => foundation[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{foundation[key]}</dd></div>)}
                {!FOUNDATION.slice(1).some(([key]) => foundation[key]) && <p className="ledger-quiet">No notes yet.</p>}</dl>)}
          </article>);
      })}
    </section>
  );
}

export default function LedgerLibrary() {
  const { owner } = useLedger();
  const library = useLedgerLibrary(owner);
  const [tab, setTab] = useState('vendors');
  return (
    <div className="ledger-library">
      <ReadOnlyNote />
      <div className="ledger-segmented" role="radiogroup" aria-label="Library">
        {LIBRARY_TABS.map((item) => (
          <button key={item.id} type="button" role="radio" aria-checked={tab === item.id} className="ledger-segment" onClick={() => setTab(item.id)}>{item.label}</button>))}
      </div>
      {library.isLoading && <p className="ledger-quiet">Loading the library…</p>}
      {library.error && <Message error={library.error} />}
      {library.data && (tab === 'brands' ? <BrandNotes brands={library.data.brands} /> : <LibraryTable key={tab} tab={tab} rows={library.data[tab]} />)}
    </div>
  );
}
