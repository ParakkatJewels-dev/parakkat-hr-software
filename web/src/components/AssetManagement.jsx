// The asset register: everything the company owns, and a way into each item's own record.
//
// Master-detail, the same shape the Directory uses — the list stands in for the detail screen
// rather than sitting beside it, so a phone gets one thing at a time and the filters and page you
// had are still there when you come back.
import React, { useState, useMemo } from 'react';
import {
  Package, Laptop, Smartphone, Monitor, KeyRound, Car, Armchair, Loader2, AlertTriangle,
  Plus, Search, X, SearchX, ChevronRight, Boxes,
} from 'lucide-react';
import {
  useAssets, useUpsertAsset, ASSET_CATEGORIES, ASSET_STATUSES, ASSET_CONDITIONS, ASSET_TYPES,
} from '../data/assets';
import { useOrg } from '../data/org';
import { usePermissions } from '../auth/usePermissions';
import Pagination, { usePagination } from './ui/Pagination';
import PageHeader from './ui/PageHeader';
import FilterSelect from './ui/FilterSelect';
import FormSection, { Field, FIELD } from './ui/FormSection';
import AssetDetail from './AssetDetail';

const categoryIcon = (a) => {
  if (a?.category === 'Software') return KeyRound;
  if (a?.category === 'Vehicle') return Car;
  if (a?.category === 'Furniture') return Armchair;
  if (a?.asset_type === 'Laptop' || a?.asset_type === 'Desktop') return Laptop;
  if (a?.asset_type === 'Mobile' || a?.asset_type === 'Tablet') return Smartphone;
  if (a?.asset_type === 'Monitor') return Monitor;
  return Package;
};

const statusTone = (s) =>
  s === 'Allocated' ? 'is-allocated'
    : s === 'Available' ? 'is-available'
    : s === 'Retired' ? 'is-retired'
    : s === 'Lost' || s === 'Damaged' ? 'is-bad'
    : 'is-repair';

// No `status`: it is derived from custody by trigger, and a form that posted it would write back
// whatever it was when the form opened. Deliberate states are set from the detail page.
const EMPTY_FORM = {
  category: 'Hardware', asset_type: '', name: '', asset_code: '', make: '', model: '',
  serial: '', condition: 'New', location: '', notes: '',
  purchase_date: '', purchase_cost: '', vendor: '', invoice_no: '', warranty_expires: '',
  licence_key: '', licence_seats: '', licence_expires: '',
  owner_entity_id: '', owner_branch_id: '',
};

export default function AssetManagement() {
  const { data: assets = [], isLoading, error } = useAssets();
  const { data: org } = useOrg();
  const { canAny } = usePermissions();
  const upsert = useUpsertAsset();
  const canManage = canAny('asset.manage');

  const [selectedId, setSelectedId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All categories');
  const [status, setStatus] = useState('All statuses');

  const stats = useMemo(() => {
    const by = (s) => assets.filter((a) => a.status === s).length;
    return [
      { label: 'Registered', value: assets.length, sub: 'Items in your scope', tone: 'green' },
      { label: 'Allocated', value: by('Allocated'), sub: 'Out with somebody', tone: 'blue' },
      { label: 'Available', value: by('Available'), sub: 'Ready to hand out', tone: 'amber' },
      { label: 'Off the road', value: by('Under Repair') + by('Damaged') + by('Lost'), sub: 'Repair, damaged or lost', tone: 'violet' },
    ];
  }, [assets]);

  // Everything printed on a row is searchable: what you remember about a laptop is its serial, or
  // who has it, or the sticker on the lid — rarely the name somebody typed when registering it.
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return assets.filter((a) => {
      if (category !== 'All categories' && a.category !== category) return false;
      if (status !== 'All statuses' && a.status !== status) return false;
      if (!term) return true;
      return [a.name, a.asset_code, a.make, a.model, a.serial, a.asset_type,
        a.employee?.full_name, a.employee?.employee_code, a.location, a.vendor]
        .some((f) => f?.toLowerCase().includes(term));
    });
  }, [assets, search, category, status]);

  const pager = usePagination(filtered);
  const activeFilters = (search.trim() ? 1 : 0)
    + (category !== 'All categories' ? 1 : 0) + (status !== 'All statuses' ? 1 : 0);

  const openForm = (asset) => {
    setEditing(asset ?? null);
    setForm(asset
      ? { ...EMPTY_FORM, ...Object.fromEntries(Object.keys(EMPTY_FORM).map((k) => [k, asset[k] ?? ''])) }
      : EMPTY_FORM);
    upsert.reset();
    setShowForm(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    try {
      await upsert.mutateAsync({ id: editing?.id, ...form });
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    } catch { /* surfaced in the form */ }
  };

  // The detail screen replaces the list, so state above survives the trip.
  if (selectedId && !showForm) {
    return (
      <div className="page-shell people-page space-y-5 animate-fade-in">
        <AssetDetail
          assetId={selectedId}
          onBack={() => setSelectedId(null)}
          onEdit={canManage ? () => openForm(assets.find((a) => a.id === selectedId)) : null}
        />
      </div>
    );
  }

  const branchesForEntity = (org?.branches ?? []).filter(
    (b) => !form.owner_entity_id || b.entity_id === form.owner_entity_id
  );
  const typeOptions = ASSET_TYPES[form.category] ?? ASSET_TYPES.Other;

  return (
    <div className="page-shell people-page space-y-5 animate-fade-in">
      <PageHeader
        eyebrow="Asset Management"
        icon={Boxes}
        title="Assets"
        subtitle="Everything the company owns — hardware, software and the rest — and who has it."
        actions={canManage && !showForm && (
          <button onClick={() => openForm(null)} className="people-action-button people-action-button-primary">
            <Plus size={14} /> Register an asset
          </button>
        )}
      />

      <section className="people-insight-grid">
        {stats.map((s) => (
          <div key={s.label} className="people-insight-card" data-tone={s.tone}>
            <span>{s.label}</span>
            <strong>{s.value}</strong>
            <em>{s.sub}</em>
          </div>
        ))}
      </section>

      {showForm && canManage && (
        <FormSection
          title={editing ? `Edit ${editing.name}` : 'Register an asset'}
          subtitle="Anything the company owns and wants back: a laptop, a licence, a chair, a scooter."
          icon={Package}
          onClose={() => { setShowForm(false); setEditing(null); upsert.reset(); }}
          onSubmit={submit}
          submitLabel={editing ? 'Save changes' : 'Register'}
          busy={upsert.isPending}
          error={upsert.error?.message}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label="Name" htmlFor="as-name" required>
              <input id="as-name" required value={form.name} className={FIELD}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. MacBook Pro 14 or Tally Prime" />
            </Field>
            <Field label="Category" htmlFor="as-cat">
              <select id="as-cat" value={form.category} className={FIELD + ' cursor-pointer'}
                onChange={(e) => {
                  const next = e.target.value;
                  // Only clear the type when it came from the old category's suggestions. Something
                  // typed by hand — "Espresso machine" — is not ours to throw away because the
                  // category changed underneath it.
                  const wasSuggestion = (ASSET_TYPES[form.category] ?? []).includes(form.asset_type);
                  setForm({ ...form, category: next, asset_type: wasSuggestion ? '' : form.asset_type });
                }}>
                {ASSET_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            {/* Free text with the category's common types offered as suggestions. A closed dropdown
                cannot cover what a jewellery business actually owns — safes, weighing scales,
                hallmarking equipment — and the column is free text, so the list should suggest
                rather than restrict. */}
            <Field label="Type" htmlFor="as-type" hint="Type anything, or pick a suggestion">
              <input
                id="as-type"
                list="asset-type-options"
                value={form.asset_type}
                className={FIELD}
                onChange={(e) => setForm({ ...form, asset_type: e.target.value })}
                placeholder={typeOptions.slice(0, 3).join(', ') + '…'}
              />
              <datalist id="asset-type-options">
                {typeOptions.map((t) => <option key={t} value={t} />)}
              </datalist>
            </Field>

            <Field label="Asset code" htmlFor="as-code">
              <input id="as-code" value={form.asset_code} className={FIELD + ' font-mono'}
                onChange={(e) => setForm({ ...form, asset_code: e.target.value })}
                placeholder="The tag on the item" />
            </Field>
            <Field label="Make" htmlFor="as-make">
              <input id="as-make" value={form.make} className={FIELD}
                onChange={(e) => setForm({ ...form, make: e.target.value })} placeholder="Apple, Dell…" />
            </Field>
            <Field label="Model" htmlFor="as-model">
              <input id="as-model" value={form.model} className={FIELD}
                onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </Field>

            <Field label="Serial number" htmlFor="as-serial">
              <input id="as-serial" value={form.serial} className={FIELD + ' font-mono'}
                onChange={(e) => setForm({ ...form, serial: e.target.value })} />
            </Field>
            <Field label="Condition" htmlFor="as-cond">
              <select id="as-cond" value={form.condition} className={FIELD + ' cursor-pointer'}
                onChange={(e) => setForm({ ...form, condition: e.target.value })}>
                <option value="">Not recorded</option>
                {ASSET_CONDITIONS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>

            {/* Who OWNS it, which is not the same as who currently has it. This is what the asset
                falls back to when it is returned, and what makes unallocated stock visible to
                anyone but a global admin — see migration 0076. */}
            <Field label="Owned by (company)" htmlFor="as-entity" required>
              <select id="as-entity" required value={form.owner_entity_id} className={FIELD + ' cursor-pointer'}
                onChange={(e) => setForm({ ...form, owner_entity_id: e.target.value, owner_branch_id: '' })}>
                <option value="">Choose a company…</option>
                {(org?.entities ?? []).map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select>
            </Field>
            <Field label="Owned by (branch)" htmlFor="as-branch">
              <select id="as-branch" value={form.owner_branch_id} className={FIELD + ' cursor-pointer'}
                onChange={(e) => setForm({ ...form, owner_branch_id: e.target.value })}>
                <option value="">Company-wide</option>
                {branchesForEntity.map((b) => <option key={b.id} value={b.id}>{b.name || b.code}</option>)}
              </select>
            </Field>
            <Field label="Kept at" htmlFor="as-loc">
              <input id="as-loc" value={form.location} className={FIELD}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="Store room, IT cupboard…" />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            <Field label="Purchased on" htmlFor="as-pdate">
              <input id="as-pdate" type="date" value={form.purchase_date} className={FIELD}
                onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} />
            </Field>
            <Field label="Cost (₹)" htmlFor="as-cost">
              <input id="as-cost" type="number" min="0" step="0.01" value={form.purchase_cost} className={FIELD + ' font-mono'}
                onChange={(e) => setForm({ ...form, purchase_cost: e.target.value })} />
            </Field>
            <Field label="Vendor" htmlFor="as-vendor">
              <input id="as-vendor" value={form.vendor} className={FIELD}
                onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
            </Field>
            <Field label="Invoice number" htmlFor="as-inv">
              <input id="as-inv" value={form.invoice_no} className={FIELD + ' font-mono'}
                onChange={(e) => setForm({ ...form, invoice_no: e.target.value })} />
            </Field>
            <Field label="Warranty until" htmlFor="as-warr">
              <input id="as-warr" type="date" value={form.warranty_expires} className={FIELD}
                onChange={(e) => setForm({ ...form, warranty_expires: e.target.value })} />
            </Field>
          </div>

          {form.category === 'Software' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              <Field label="Licence key" htmlFor="as-key">
                <input id="as-key" value={form.licence_key} className={FIELD + ' font-mono'}
                  onChange={(e) => setForm({ ...form, licence_key: e.target.value })} />
              </Field>
              <Field label="Seats" htmlFor="as-seats">
                <input id="as-seats" type="number" min="1" value={form.licence_seats} className={FIELD + ' font-mono'}
                  onChange={(e) => setForm({ ...form, licence_seats: e.target.value })} />
              </Field>
              <Field label="Renews / expires" htmlFor="as-lexp">
                <input id="as-lexp" type="date" value={form.licence_expires} className={FIELD}
                  onChange={(e) => setForm({ ...form, licence_expires: e.target.value })} />
              </Field>
            </div>
          )}

          <Field label="Notes" htmlFor="as-notes">
            <textarea id="as-notes" rows={2} value={form.notes} className={FIELD}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Anything the next person should know about this item." />
          </Field>
        </FormSection>
      )}

      <div className="premium-card people-library-card space-y-4">
        <div className="people-panel-head">
          <span><Boxes size={15} /> Register</span>
          <em>
            {pager.count === 0 && activeFilters ? `No matches · ${assets.length} in all`
              : `${pager.from}–${pager.to} of ${pager.count}${activeFilters ? ` matching · ${assets.length} in all` : ''}`}
          </em>
        </div>

        <div className="asset-toolbar">
          <div className="asset-search relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500" size={15} />
            <input
              type="search"
              placeholder="Search name, code, serial, make or who has it…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search assets"
              className="w-full bg-neutral-50/50 dark:bg-charcoal-900/60 border border-neutral-200/80 dark:border-neutral-855 rounded-xl pl-10 pr-9 py-2 text-base text-neutral-850 dark:text-neutral-100 placeholder-neutral-450 focus:outline-none focus:border-[#0ea971] focus:ring-2 focus:ring-[#0ea971]/20 transition-colors"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear the search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer transition-colors">
                <X size={13} />
              </button>
            )}
          </div>
          <FilterSelect
            label="Category" value={category} allValue="All categories"
            options={['All categories', ...ASSET_CATEGORIES]} onChange={setCategory}
          />
          <FilterSelect
            label="Status" value={status} allValue="All statuses"
            options={['All statuses', ...ASSET_STATUSES]} onChange={setStatus}
          />
        </div>

        {isLoading ? (
          <div className="flex justify-center py-10 text-[#0ea971]"><Loader2 size={22} className="animate-spin" /></div>
        ) : error ? (
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span>
          </div>
        ) : assets.length === 0 ? (
          <div className="people-empty-state is-compact">
            <Boxes size={24} />
            <strong>Nothing registered yet</strong>
            <span>{canManage ? 'Register the first item and its history starts from there.' : 'Ask an admin to register company assets.'}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="people-empty-state is-compact">
            <SearchX size={24} />
            <strong>Nothing matches these filters</strong>
            <span>Searched names, codes, serials, makes and holders across {assets.length} items.</span>
            <button type="button" className="people-action-button mt-2"
              onClick={() => { setSearch(''); setCategory('All categories'); setStatus('All statuses'); }}>
              <X size={13} /> Clear the filters
            </button>
          </div>
        ) : (
          <ul className="asset-list">
            {pager.slice.map((a) => {
              const Icon = categoryIcon(a);
              return (
                <li key={a.id}>
                  {/* Closing the form here too. The detail view is gated on `!showForm`, so a row
                      clicked while the form is open used to do nothing visible and then decide
                      where you landed when the form finally closed. */}
                  <button
                    type="button"
                    className="asset-row"
                    onClick={() => { setSelectedId(a.id); setShowForm(false); setEditing(null); upsert.reset(); }}
                  >
                    <span className="asset-row-icon"><Icon size={16} /></span>
                    <span className="asset-row-main">
                      <strong>{a.name}</strong>
                      <em>
                        {[a.asset_code, [a.make, a.model].filter(Boolean).join(' '), a.serial]
                          .filter(Boolean).join(' · ') || a.asset_type || a.category}
                      </em>
                    </span>
                    <span className="asset-row-holder">
                      {a.employee?.full_name
                        ? <><strong>{a.employee.full_name}</strong><em>{a.employee.employee_code || 'Holding it now'}</em></>
                        : <em>Not allocated</em>}
                    </span>
                    <span className={`asset-status ${statusTone(a.status)}`}>{a.status}</span>
                    <ChevronRight size={15} className="asset-row-chevron" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <Pagination {...pager} noun="assets" />
      </div>
    </div>
  );
}
