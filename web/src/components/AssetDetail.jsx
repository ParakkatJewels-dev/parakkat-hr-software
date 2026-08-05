// One asset's whole record, and everywhere it has been.
//
// The layout primitives here (emp-section, emp-field-grid, emp-rail…) are the record-page shell
// introduced with the employee profile. They are structural rather than employee-specific, and
// reusing them keeps the two detail screens looking like one product; the `emp-` prefix is a
// naming debt worth paying off the next time both are touched.
import React, { useMemo, useState } from 'react';
import {
  ArrowLeft, Pencil, Package, Laptop, Smartphone, Monitor, KeyRound, Car, Armchair,
  Calendar, Landmark, MapPin, ShieldCheck, History, UserRound, Undo2, UserPlus,
  Loader2, AlertTriangle, Eye, EyeOff, Search, X, Check,
} from 'lucide-react';
import {
  useAsset, useAssetHistory, useAssignAsset, useReturnAsset, ASSET_CONDITIONS,
} from '../data/assets';
import { useEmployees } from '../data/employees';
import { usePermissions } from '../auth/usePermissions';
import { spanLabel } from '../lib/assetSpan';

const categoryIcon = (asset) => {
  if (asset?.category === 'Software') return KeyRound;
  if (asset?.category === 'Vehicle') return Car;
  if (asset?.category === 'Furniture') return Armchair;
  const t = asset?.asset_type;
  if (t === 'Laptop' || t === 'Desktop') return Laptop;
  if (t === 'Mobile' || t === 'Tablet') return Smartphone;
  if (t === 'Monitor') return Monitor;
  return Package;
};

const statusTone = (s) =>
  s === 'Allocated' ? 'is-allocated'
    : s === 'Available' ? 'is-available'
    : s === 'Retired' ? 'is-retired'
    : s === 'Lost' || s === 'Damaged' ? 'is-bad'
    : 'is-repair';

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const inr = (n) => (n == null ? null : '₹' + Number(n).toLocaleString('en-IN'));

function Field({ label, value, mono }) {
  const empty = value == null || value === '';
  return (
    <div className={`emp-field${empty ? ' is-empty' : ''}`}>
      <span>{label}</span>
      <strong className={mono ? 'is-mono' : undefined}>{empty ? 'Not recorded' : value}</strong>
    </div>
  );
}

/** A licence key is a secret sitting on a shared screen. Hidden until somebody asks for it. */
function LicenceKey({ value }) {
  const [shown, setShown] = useState(false);
  if (!value) return <Field label="Licence key" value={null} />;
  return (
    <div className="emp-field">
      <span>Licence key</span>
      <strong className="is-mono asset-secret">
        {shown ? value : '•'.repeat(Math.min(24, value.length))}
        <button type="button" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide the licence key' : 'Show the licence key'}>
          {shown ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      </strong>
    </div>
  );
}

/** Pick a person to hand the asset to. A select over 242 names is a scroll; this is a search. */
function EmployeePicker({ value, onChange }) {
  const { data: employees = [], isLoading } = useEmployees();
  const [q, setQ] = useState('');

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    const active = employees.filter((e) => e.status !== 'Inactive');
    if (!term) return active.slice(0, 8);
    return active
      .filter((e) =>
        e.full_name?.toLowerCase().includes(term)
        || e.employee_code?.toLowerCase().includes(term)
        || e.branch?.name?.toLowerCase().includes(term))
      .slice(0, 8);
  }, [employees, q]);

  const chosen = employees.find((e) => e.id === value);

  if (chosen) {
    return (
      <div className="asset-picked">
        <UserRound size={14} />
        <span>
          <strong>{chosen.full_name}</strong>
          <em>{[chosen.employee_code, chosen.branch?.name || chosen.branch?.code].filter(Boolean).join(' · ')}</em>
        </span>
        <button type="button" onClick={() => onChange(null)} aria-label="Choose somebody else"><X size={13} /></button>
      </div>
    );
  }

  return (
    <div className="asset-picker">
      <div className="asset-picker-search">
        <Search size={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, code or branch…"
          aria-label="Search for an employee"
        />
      </div>
      {isLoading ? (
        <p className="asset-picker-note"><Loader2 size={12} className="animate-spin" /> Loading people…</p>
      ) : matches.length === 0 ? (
        <p className="asset-picker-note">Nobody matches “{q.trim()}”.</p>
      ) : (
        <ul className="asset-picker-list">
          {matches.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => onChange(e.id)}>
                <strong>{e.full_name}</strong>
                <em>{[e.employee_code, e.designation?.title, e.branch?.name || e.branch?.code].filter(Boolean).join(' · ')}</em>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AssetDetail({ assetId, onBack, onEdit }) {
  const { data: asset, isLoading, error } = useAsset(assetId);
  const { data: history = [], isLoading: historyLoading } = useAssetHistory(assetId);
  const { canAny } = usePermissions();
  const assign = useAssignAsset();
  const takeBack = useReturnAsset();

  const canManage = canAny('asset.manage');
  const [mode, setMode] = useState(null); // 'assign' | 'return'
  const [pick, setPick] = useState(null);
  const [condition, setCondition] = useState('');
  const [notes, setNotes] = useState('');

  const open = history.find((h) => !h.returned_at) ?? null;
  const past = history.filter((h) => h.returned_at);

  const reset = () => { setMode(null); setPick(null); setCondition(''); setNotes(''); assign.reset(); takeBack.reset(); };

  const doAssign = async (e) => {
    e.preventDefault();
    if (!pick) return;
    try {
      await assign.mutateAsync({ assetId, employeeId: pick, conditionOut: condition, notes });
      reset();
    } catch { /* surfaced in the panel */ }
  };

  const doReturn = async (e) => {
    e.preventDefault();
    if (!open) return;
    try {
      await takeBack.mutateAsync({ assignmentId: open.id, conditionIn: condition, notes });
      reset();
    } catch { /* surfaced in the panel */ }
  };

  if (isLoading) {
    return <div className="asset-detail-loading"><Loader2 size={22} className="animate-spin" /></div>;
  }
  if (error || !asset) {
    return (
      <div className="emp-doc-error" role="alert">
        <AlertTriangle size={14} /> <span>{error?.message ?? 'That asset could not be loaded.'}</span>
      </div>
    );
  }

  const Icon = categoryIcon(asset);
  const isSoftware = asset.category === 'Software';
  const warrantyGone = asset.warranty_expires && new Date(asset.warranty_expires) < new Date();
  const licenceGone = asset.licence_expires && new Date(asset.licence_expires) < new Date();

  return (
    <section className="emp-profile animate-fade-in">
      <header className="emp-hero">
        <div className="emp-hero-bar">
          <button type="button" onClick={onBack} className="emp-back">
            <ArrowLeft size={14} /> Assets
          </button>
          {canManage && onEdit && (
            <div className="emp-hero-actions">
              <button type="button" onClick={onEdit} title="Edit this asset" aria-label="Edit this asset">
                <Pencil size={14} />
              </button>
            </div>
          )}
        </div>

        <div className="emp-hero-id">
          <div className="emp-avatar asset-avatar"><Icon size={30} /></div>
          <div className="emp-hero-text">
            <h1>{asset.name}</h1>
            <p>
              {[asset.make, asset.model].filter(Boolean).join(' ') || asset.asset_type || asset.category}
              {asset.serial ? ` · ${asset.serial}` : ''}
            </p>
            <div className="emp-hero-chips">
              <span className={`emp-status asset-status ${statusTone(asset.status)}`}>{asset.status}</span>
              <span>{asset.category}</span>
              {asset.asset_code && <span>{asset.asset_code}</span>}
            </div>
          </div>
        </div>
      </header>

      <div className="emp-layout">
        <div className="emp-main">
          <article className="emp-section">
            <h2 className="emp-section-head"><Package size={12} /> Identification</h2>
            <div className="emp-field-grid">
              <Field label="Asset code" value={asset.asset_code} mono />
              <Field label="Category" value={asset.category} />
              <Field label="Type" value={asset.asset_type} />
              <Field label="Make" value={asset.make} />
              <Field label="Model" value={asset.model} />
              <Field label="Serial number" value={asset.serial} mono />
              <Field label="Condition" value={asset.condition} />
              <Field label="Status" value={asset.status} />
            </div>
          </article>

          {isSoftware && (
            <article className="emp-section">
              <h2 className="emp-section-head"><KeyRound size={12} /> Licence</h2>
              <div className="emp-field-grid">
                <LicenceKey value={asset.licence_key} />
                <Field label="Seats" value={asset.licence_seats} mono />
                <Field
                  label="Renews / expires"
                  value={asset.licence_expires ? `${fmtDate(asset.licence_expires)}${licenceGone ? ' · expired' : ''}` : null}
                />
              </div>
            </article>
          )}

          <article className="emp-section">
            <h2 className="emp-section-head"><Landmark size={12} /> Purchase</h2>
            <div className="emp-field-grid">
              <Field label="Purchased on" value={fmtDate(asset.purchase_date)} />
              <Field label="Cost" value={inr(asset.purchase_cost)} mono />
              <Field label="Vendor" value={asset.vendor} />
              <Field label="Invoice number" value={asset.invoice_no} mono />
              <Field
                label="Warranty until"
                value={asset.warranty_expires ? `${fmtDate(asset.warranty_expires)}${warrantyGone ? ' · expired' : ''}` : null}
              />
            </div>
          </article>

          <article className="emp-section">
            <h2 className="emp-section-head"><MapPin size={12} /> Where it belongs</h2>
            <div className="emp-field-grid">
              <Field label="Company" value={asset.entity?.name} />
              <Field label="Branch" value={asset.branch?.name || asset.branch?.code} />
              <Field label="Kept at" value={asset.location} />
              <Field label="Registered on" value={fmtDate(asset.created_at)} />
            </div>
          </article>

          {asset.notes && (
            <article className="emp-section">
              <h2 className="emp-section-head"><ShieldCheck size={12} /> Notes</h2>
              <p className="asset-notes">{asset.notes}</p>
            </article>
          )}

          {/* The point of the whole feature: not just who has it, but everybody who has had it. */}
          <article className="emp-section" id="asset-custody">
            <h2 className="emp-section-head"><History size={12} /> Custody history</h2>

            {canManage && (
              <div className="asset-custody-actions">
                {open ? (
                  <button type="button" onClick={() => (mode === 'return' ? reset() : (reset(), setMode('return')))}>
                    <Undo2 size={13} /> Take it back
                  </button>
                ) : (
                  <button type="button" onClick={() => (mode === 'assign' ? reset() : (reset(), setMode('assign')))}>
                    <UserPlus size={13} /> Allocate to someone
                  </button>
                )}
              </div>
            )}

            {mode === 'assign' && canManage && (
              <form className="asset-panel" onSubmit={doAssign}>
                <span className="asset-panel-title">Hand this over</span>
                <EmployeePicker value={pick} onChange={setPick} />
                <div className="asset-panel-row">
                  <label>
                    Condition going out
                    <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                      <option value="">Not recorded</option>
                      {ASSET_CONDITIONS.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                  <label>
                    Note
                    <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
                  </label>
                </div>
                {assign.error && (
                  <p className="asset-panel-error"><AlertTriangle size={13} /> {assign.error.message}</p>
                )}
                <div className="asset-panel-buttons">
                  <button type="button" onClick={reset}>Cancel</button>
                  <button type="submit" disabled={!pick || assign.isPending} className="is-primary">
                    {assign.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Allocate
                  </button>
                </div>
              </form>
            )}

            {mode === 'return' && canManage && open && (
              <form className="asset-panel" onSubmit={doReturn}>
                <span className="asset-panel-title">Take it back from {open.employee?.full_name ?? 'the current holder'}</span>
                <div className="asset-panel-row">
                  <label>
                    Condition coming back
                    <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                      <option value="">Not recorded</option>
                      {ASSET_CONDITIONS.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                  <label>
                    Note
                    <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
                  </label>
                </div>
                {takeBack.error && (
                  <p className="asset-panel-error"><AlertTriangle size={13} /> {takeBack.error.message}</p>
                )}
                <div className="asset-panel-buttons">
                  <button type="button" onClick={reset}>Cancel</button>
                  <button type="submit" disabled={takeBack.isPending} className="is-primary">
                    {takeBack.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Take back
                  </button>
                </div>
              </form>
            )}

            {historyLoading ? (
              <p className="emp-doc-note"><Loader2 size={13} className="animate-spin" /> Loading history…</p>
            ) : history.length === 0 ? (
              <div className="emp-empty">
                <History size={20} />
                <p>Nobody has held this yet. Allocating it to someone starts its history.</p>
              </div>
            ) : (
              <ol className="asset-timeline">
                {history.map((h) => {
                  const current = !h.returned_at;
                  return (
                    <li key={h.id} className={`asset-timeline-item${current ? ' is-current' : ''}`}>
                      <span className="asset-timeline-mark"><UserRound size={13} /></span>
                      <div className="asset-timeline-body">
                        <div className="asset-timeline-who">
                          <strong>{h.employee?.full_name ?? 'Somebody no longer on record'}</strong>
                          {current && <span className="asset-timeline-now">Holding it now</span>}
                        </div>
                        <span className="asset-timeline-meta">
                          {[h.employee?.employee_code, h.employee?.designation?.title,
                            h.employee?.branch?.name || h.employee?.branch?.code]
                            .filter(Boolean).join(' · ')}
                        </span>
                        <span className="asset-timeline-when">
                          <Calendar size={11} />
                          {fmtDate(h.assigned_at)} → {h.returned_at ? fmtDate(h.returned_at) : 'now'}
                          {spanLabel(h.assigned_at, h.returned_at) ? ` · ${spanLabel(h.assigned_at, h.returned_at)}` : ''}
                        </span>
                        {(h.condition_out || h.condition_in) && (
                          <span className="asset-timeline-condition">
                            {h.condition_out ? `Out: ${h.condition_out}` : ''}
                            {h.condition_out && h.condition_in ? ' · ' : ''}
                            {h.condition_in ? `Back: ${h.condition_in}` : ''}
                          </span>
                        )}
                        {h.notes && <span className="asset-timeline-note">{h.notes}</span>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </article>
        </div>

        <aside className="emp-rail">
          <div className="emp-rail-card">
            <span className="emp-rail-title">Right now</span>
            {open ? (
              <div className="asset-holder">
                <UserRound size={15} />
                <span>
                  <strong>{open.employee?.full_name ?? 'Unknown holder'}</strong>
                  <em>since {fmtDate(open.assigned_at)}{spanLabel(open.assigned_at) ? ` · ${spanLabel(open.assigned_at)}` : ''}</em>
                </span>
              </div>
            ) : (
              <div className="asset-holder is-free">
                <Package size={15} />
                <span>
                  <strong>Not allocated</strong>
                  <em>{asset.location ? `Kept at ${asset.location}` : 'No holder on record'}</em>
                </span>
              </div>
            )}

            <div className="emp-glance-grid asset-glance">
              <div>
                <strong>{past.length}</strong>
                <small>Past holders</small>
              </div>
              <div>
                <strong>{asset.condition || '—'}</strong>
                <small>Condition</small>
              </div>
            </div>
          </div>

          {(warrantyGone || licenceGone) && (
            <div className="emp-rail-card asset-warning">
              <span className="emp-rail-title">Needs attention</span>
              {warrantyGone && <p><AlertTriangle size={13} /> Warranty ended {fmtDate(asset.warranty_expires)}.</p>}
              {licenceGone && <p><AlertTriangle size={13} /> Licence expired {fmtDate(asset.licence_expires)}.</p>}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
