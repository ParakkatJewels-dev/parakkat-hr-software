// Library, shared by the creative team: vendors, task templates, key dates (the festival calendar) and
// brand notes. Plain ruled tables with inline add and edit; removing an entry hides it (nothing is erased).
import React, { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCreativeLibrary, useCreativeWrite } from '../../data/creative';
import { useBrandNames } from './LedgerCampaigns';
import { Message, Suggest, dateLabel } from './ui';
import { btnClass } from '../ui/Btn';

const LIBRARY_TABS = [{ id: 'vendors', label: 'Vendors' }, { id: 'templates', label: 'Templates' }, { id: 'key_dates', label: 'Key dates' }, { id: 'brands', label: 'Brand notes' }];
const TABLES = {
  vendors: { kind: 'vendor', noun: 'vendor', columns: [
    ['name', 'Name'], ['role', 'Role'], ['phone', 'Phone'], ['email', 'Email'], ['rate', 'Rate'], ['rating', 'Rating', 'rating'], ['notes', 'Notes', 'long'],
    ['last_worked', 'Last worked', 'date']] },
  templates: { kind: 'template', noun: 'template', columns: [['name', 'Name'], ['type', 'Type'], ['subtasks', 'Subtasks', 'lines']] },
  key_dates: { kind: 'key_date', noun: 'key date', columns: [
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
  const brands = useBrandNames();
  const write = useCreativeWrite();
  const [values, setValues] = useState(() => Object.fromEntries(table.columns.map(([key, , kind]) => [key, kind === 'lines' ? (row?.[key] ?? []).join('\n') : row?.[key] ?? ''])));
  const submit = async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(table.columns.map(([key, , kind]) => {
      const value = typeof values[key] === 'string' ? values[key].trim() : values[key];
      if (kind === 'lines') return [key, String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean)];
      return [key, value === '' ? null : kind === 'number' || kind === 'rating' ? Number(value) : value];
    }).filter(([key, value]) => row || value !== null || key === 'name'));
    try { await write.mutateAsync({ op: 'library', id: row?.id, kind: table.kind, values: payload }); onDone(); }
    catch { /* shown below */ }
  };
  return (
    <form className="ledger-library-form" onSubmit={submit} aria-label={row ? `Edit ${row.name}` : `New ${table.noun}`}>
      {table.columns.map(([key, label, kind]) => (
        <label key={key} className="ledger-field" data-wide={kind === 'long' || kind === 'lines' || undefined}><span>{label}</span>
          {kind === 'lines' ? <textarea className="ledger-input" rows={4} value={values[key]} placeholder="One step per line" onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
            : kind === 'long' ? <textarea className="ledger-input" rows={2} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
            : kind === 'brand' ? <Suggest value={values[key]} onChange={(v) => setValues({ ...values, [key]: v })} options={brands} maxLength={80} />
            : kind === 'rating' ? <select className="ledger-input" value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })}>
              <option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            : <input className="ledger-input" type={kind === 'date' ? 'date' : kind === 'number' ? 'number' : key === 'email' ? 'email' : 'text'} min={kind === 'number' ? 0 : undefined}
              required={key === 'name' || (key === 'date' && table.kind === 'key_date')} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />}
        </label>))}
      <Message error={write.error} />
      <div className="ledger-actions ledger-form-wide">
        <button type="submit" className={btnClass('primary')} disabled={write.isPending}>{row ? 'Save' : `Add ${table.noun}`}</button>
        <button type="button" className={btnClass('ghost')} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function LibraryTable({ tab, rows }) {
  const act = useCreativeWrite();
  const table = TABLES[tab];
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState('');
  const shown = table.columns.filter(([, , kind]) => kind !== 'long');
  return (
    <section className="ledger-section" aria-label={LIBRARY_TABS.find((t) => t.id === tab).label}>
      <div className="ledger-actions">
          {editing !== 'new' && <button type="button" className={btnClass('ghost')} onClick={() => setEditing('new')}><Plus size={14} /> Add {table.noun}</button>}
          {tab === 'key_dates' && <button type="button" className={btnClass('ghost')} onClick={async () => {
            setMessage('');
            try { const added = await act.mutateAsync({ op: 'refresh-dates' }); setMessage(added ? `${added} festival date${added === 1 ? '' : 's'} added.` : 'Festival dates are up to date.'); }
            catch { /* shown below */ }
          }}>Refresh festival dates</button>}
      </div>
      {editing === 'new' && <RowEditor table={table} onDone={() => setEditing(null)} />}
      <Message error={act.error}>{message}</Message>
      {!rows.length ? <p className="ledger-empty">No {table.noun}s yet.</p> : (
        <div className="ledger-table-scroll">
          <table className="ledger-table">
            <thead><tr>{shown.map(([key, label]) => <th key={key}>{label}</th>)}{tab === 'vendors' && <th>Tasks</th>}<th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{rows.map((row) => editing === row.id ? (
              <tr key={row.id}><td colSpan={shown.length + 2}><RowEditor table={table} row={row} onDone={() => setEditing(null)} /></td></tr>
            ) : (
              <tr key={row.id}>
                {shown.map((column) => <td key={column[0]}>{display(row, column)}{column[0] === 'name' && row.starter && <span className="ledger-tag">starter</span>}
                  {column[0] === 'name' && row.notes && <div className="ledger-quiet">{row.notes}</div>}</td>)}
                {tab === 'vendors' && <td>{row.tasks}</td>}
                <td className="ledger-row-actions">
                  <button type="button" className={btnClass('subtle', 'sm', true)} aria-label={`Edit ${row.name}`} onClick={() => setEditing(row.id)}><Pencil size={13} /></button>
                  <button type="button" className={btnClass('subtle', 'sm', true)} aria-label={`Remove ${row.name}`} onClick={() => {
                    if (window.confirm(`Remove “${row.name}”?`)) act.mutate({ op: 'remove-library', kind: table.kind, id: row.id });
                  }}><Trash2 size={13} /></button></td>
              </tr>))}</tbody>
          </table>
        </div>)}
    </section>
  );
}

function BrandNotes({ brands }) {
  const act = useCreativeWrite();
  const [editing, setEditing] = useState(null);
  const [values, setValues] = useState({});
  return (
    <section className="ledger-section" aria-label="Brand notes">
      <p className="ledger-quiet">Reference notes for briefing each brand: positioning, audiences, tone, visual style, offerings and the claims you can make.</p>
      {brands.map((brand) => {
        const foundation = { ...(brand.foundation ?? {}), label: brand.label };
        return (
          <article key={brand.id} className="ledger-brand-notes">
            <h3>{brand.name}{editing !== brand.id && <button type="button" className="ledger-link" onClick={() => { setValues(foundation); setEditing(brand.id); }}>Edit</button>}</h3>
            {editing === brand.id ? (
              <form className="ledger-form" onSubmit={async (event) => {
                event.preventDefault();
                const foundation = Object.fromEntries(FOUNDATION.slice(1).map(([key]) => [key, values[key]?.trim()]).filter(([, value]) => value));
                try { await act.mutateAsync({ op: 'brand', id: brand.id, short_label: values.label?.trim() || null, foundation }); setEditing(null); }
                catch { /* shown below */ }
              }}>
                {FOUNDATION.map(([key, label]) => (
                  <label key={key} className="ledger-field" data-wide={key !== 'label' || undefined}><span>{label}</span>
                    {key === 'label' ? <input className="ledger-input" maxLength={40} value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
                      : <textarea className="ledger-input" rows={2} value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />}</label>))}
                <Message error={act.error} />
                <div className="ledger-actions ledger-form-wide"><button type="submit" className={btnClass('primary')} disabled={act.isPending}>Save notes</button>
                  <button type="button" className={btnClass('ghost')} onClick={() => setEditing(null)}>Cancel</button></div>
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
  const library = useCreativeLibrary();
  const [tab, setTab] = useState('vendors');
  return (
    <div className="ledger-library">
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
