import React, { useState, useMemo } from 'react';
import { Settings, X, Laptop, Smartphone, Monitor, Package, Loader2, AlertTriangle, Plus } from 'lucide-react';
import { useAssets, useUpsertAsset } from '../data/assets';
import { usePermissions } from '../auth/usePermissions';

const TYPES = ['Laptop', 'Monitor', 'Mobile', 'Accessories', 'Other'];
const STATUSES = ['Available', 'Allocated', 'Under Repair', 'Damaged', 'Retired'];

const typeIcon = (t) =>
  t === 'Laptop' ? Laptop : t === 'Mobile' ? Smartphone : t === 'Monitor' ? Monitor : Package;

const statusClass = (s) =>
  s === 'Allocated'
    ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30'
    : s === 'Available'
    ? 'bg-neutral-105 text-neutral-500 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-450 dark:border-neutral-800'
    : 'bg-amber-100 text-amber-805 border-amber-200 dark:bg-amber-950/40 dark:text-amber-450 dark:border-amber-900/30';

export default function AssetManagement() {
  const { data: assets = [], isLoading, error } = useAssets();
  const { canAny } = usePermissions();
  const upsert = useUpsertAsset();
  const canManage = canAny('asset.manage');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ asset_type: 'Laptop', name: '', serial: '', status: 'Available' });

  const stats = useMemo(() => {
    const c = (s) => assets.filter((a) => a.status === s).length;
    return { total: assets.length, allocated: c('Allocated'), available: c('Available'), repair: c('Under Repair') };
  }, [assets]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name) return;
    try {
      await upsert.mutateAsync({ ...form });
      setForm({ asset_type: 'Laptop', name: '', serial: '', status: 'Available' });
      setShowForm(false);
    } catch { /* shown below */ }
  };

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Asset Management</h2>
          <p className="text-xs text-neutral-500 dark:text-slate-400">Company hardware inventory and allocations, scoped to your access.</p>
        </div>
        {canManage && !showForm && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 px-4 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 cursor-pointer shadow-md">
            <Plus size={13} /> Add asset
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Total Items" value={stats.total} />
        <Stat label="Allocated" value={stats.allocated} />
        <Stat label="Available" value={stats.available} />
        <Stat label="Under Repair" value={stats.repair} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
              <Settings size={16} className="mr-2 text-gold-500" /> Inventory
            </h3>
            {isLoading ? (
              <div className="flex justify-center py-10 text-gold-500"><Loader2 size={22} className="animate-spin" /></div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
            ) : assets.length === 0 ? (
              <p className="text-xs text-neutral-500 py-8 text-center">No assets visible to you yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="premium-table">
                  <thead>
                    <tr><th>Item</th><th>Type</th><th className="font-mono">Serial</th><th>Allocated To</th><th className="text-right">Status</th></tr>
                  </thead>
                  <tbody>
                    {assets.map((a) => {
                      const Icon = typeIcon(a.asset_type);
                      return (
                        <tr key={a.id}>
                          <td className="font-semibold text-neutral-800 dark:text-slate-200">{a.name}</td>
                          <td><span className="flex items-center gap-1.5 py-3"><Icon size={12} className="text-neutral-450" /> {a.asset_type || '—'}</span></td>
                          <td className="font-mono text-[10.5px] text-neutral-500">{a.serial || '—'}</td>
                          <td>{a.employee?.full_name || '—'}</td>
                          <td className="text-right"><span className={`px-2 py-0.5 rounded-full text-[8.5px] font-bold uppercase tracking-wider border ${statusClass(a.status)}`}>{a.status}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-1">
          {showForm && canManage ? (
            <div className="premium-card p-5 space-y-4 animate-fade-in">
              <div className="flex justify-between items-center border-b border-neutral-100 dark:border-neutral-900 pb-2.5">
                <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-150">Add Asset</h3>
                <button onClick={() => setShowForm(false)} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded text-neutral-450 cursor-pointer"><X size={15} /></button>
              </div>
              <form onSubmit={submit} className="space-y-3 text-xs">
                <Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. MacBook Pro 14" className={INPUT} /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Type"><select value={form.asset_type} onChange={(e) => setForm({ ...form, asset_type: e.target.value })} className={INPUT}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
                  <Field label="Status"><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={INPUT}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
                </div>
                <Field label="Serial"><input value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} placeholder="SN-…" className={INPUT} /></Field>
                {upsert.error && <p className="text-[11px] text-red-500">{upsert.error.message}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
                  <button type="submit" disabled={upsert.isPending} className="px-3.5 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 disabled:opacity-60 cursor-pointer flex items-center gap-1.5">{upsert.isPending && <Loader2 size={13} className="animate-spin" />} Save</button>
                </div>
              </form>
            </div>
          ) : (
            <div className="premium-card p-5 space-y-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5">Allocation Policy</h3>
              <p className="text-xs text-neutral-500 leading-relaxed">Company hardware remains Parakkat property and is verified during exit clearance. {canManage ? 'Use "Add asset" to register new inventory.' : 'Ask your admin to register or allocate hardware.'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-gold-500';
const Stat = ({ label, value }) => (
  <div className="premium-card p-4">
    <span className="text-neutral-500 dark:text-neutral-450 text-[10px] font-bold uppercase tracking-wider block">{label}</span>
    <span className="text-2xl font-extrabold font-mono text-neutral-850 dark:text-slate-100 block mt-1">{value}</span>
  </div>
);
const Field = ({ label, children }) => (
  <div className="space-y-1"><label className="text-neutral-500 font-semibold uppercase text-[9px] tracking-wider">{label}</label>{children}</div>
);
