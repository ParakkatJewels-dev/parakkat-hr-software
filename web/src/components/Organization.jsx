import React, { useState } from 'react';
import {
  Network, Building2, MapPin, Layers, Briefcase, Plus, Pencil, Power,
  X, Save, Loader2, AlertTriangle,
} from 'lucide-react';
import { useOrg, useOrgMutation } from '../data/org';
import { usePermissions } from '../auth/usePermissions';

// Sub-sections shown under a selected entity.
const SUB_TABS = [
  { key: 'zones', label: 'Zones', icon: MapPin },
  { key: 'branches', label: 'Branches', icon: Building2 },
  { key: 'departments', label: 'Departments', icon: Layers },
  { key: 'designations', label: 'Designations', icon: Briefcase },
];

// Form fields per table (drives the add/edit modal). `from` = which list feeds a re-parent <select>.
const FORM_FIELDS = {
  entities: [
    { key: 'code', label: 'Code', required: true, placeholder: 'PPI' },
    { key: 'name', label: 'Name', required: true },
    { key: 'legal_name', label: 'Legal name' },
    { key: 'gstin', label: 'GSTIN' },
  ],
  zones: [
    { key: 'name', label: 'Zone name', required: true },
    { key: 'code', label: 'Code' },
  ],
  branches: [
    { key: 'code', label: 'Code', required: true, placeholder: 'CDA' },
    { key: 'name', label: 'Name' },
    { key: 'city', label: 'City' },
    { key: 'zone_id', label: 'Zone (re-parent)', type: 'select', from: 'zones' },
  ],
  departments: [
    { key: 'name', label: 'Department name', required: true },
    { key: 'code', label: 'Code' },
    { key: 'branch_id', label: 'Branch (optional)', type: 'select', from: 'branches' },
  ],
  designations: [
    { key: 'title', label: 'Designation title', required: true },
    { key: 'code', label: 'Code' },
    { key: 'grade', label: 'Grade' },
    { key: 'department_id', label: 'Department (optional)', type: 'select', from: 'departments' },
  ],
};

const labelOf = (row) => row?.name || row?.title || row?.code || '—';

// Reusable class strings (kept inline so this screen needs no global CSS additions).
const BTN_ADD =
  'inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg cursor-pointer transition-opacity bg-black text-white dark:bg-gold-450 dark:text-charcoal-900 hover:opacity-90';
const ICON_BTN =
  'p-1.5 rounded-lg cursor-pointer transition-colors text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white';
const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-gold-500 transition-colors';

export default function Organization() {
  const { data: org, isLoading, error } = useOrg();
  const mutation = useOrgMutation();
  const { canAny, isSuperAdmin } = usePermissions();
  const canManage = isSuperAdmin || canAny('org.manage');

  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [subTab, setSubTab] = useState('branches');
  const [modal, setModal] = useState({ open: false });

  const entities = org?.entities ?? [];
  const activeEntityId = selectedEntityId ?? entities[0]?.id ?? null;

  const byEntity = (list) => (org?.[list] ?? []).filter((r) => r.entity_id === activeEntityId);
  const zones = byEntity('zones');
  const branches = byEntity('branches');
  const departments = byEntity('departments');
  const designations = byEntity('designations');
  const listsByKey = { zones, branches, departments, designations };

  const zoneName = (id) => (id ? labelOf(zones.find((z) => z.id === id)) : '— none —');
  const branchName = (id) => (id ? labelOf(branches.find((b) => b.id === id)) : '— entity-wide —');
  const deptName = (id) => (id ? labelOf(departments.find((d) => d.id === id)) : '— none —');

  // Column config per sub-tab.
  const COLUMNS = {
    zones: [
      { h: 'Name', c: (r) => r.name },
      { h: 'Code', c: (r) => r.code || '—', mono: true },
    ],
    branches: [
      { h: 'Code', c: (r) => r.code, mono: true },
      { h: 'Name', c: (r) => r.name || '—' },
      { h: 'City', c: (r) => r.city || '—' },
      { h: 'Zone', c: (r) => zoneName(r.zone_id) },
    ],
    departments: [
      { h: 'Name', c: (r) => r.name },
      { h: 'Code', c: (r) => r.code || '—', mono: true },
      { h: 'Branch', c: (r) => branchName(r.branch_id) },
    ],
    designations: [
      { h: 'Title', c: (r) => r.title },
      { h: 'Grade', c: (r) => r.grade || '—', mono: true },
      { h: 'Department', c: (r) => deptName(r.department_id) },
    ],
  };

  const openAdd = (table) =>
    setModal({ open: true, table, mode: 'add', form: table === 'entities' ? {} : { entity_id: activeEntityId } });
  const openEdit = (table, row) => setModal({ open: true, table, mode: 'edit', form: { ...row } });
  const closeModal = () => {
    mutation.reset();
    setModal({ open: false });
  };

  const toggleActive = (table, row) =>
    mutation.mutate({ table, op: 'update', row: { id: row.id, is_active: !row.is_active } });

  const submit = async (e) => {
    e.preventDefault();
    const { table, mode, form } = modal;
    const row = { ...form };
    ['zone_id', 'branch_id', 'department_id'].forEach((k) => {
      if (row[k] === '') row[k] = null;
    });
    try {
      await mutation.mutateAsync({ table, op: mode === 'add' ? 'insert' : 'update', row });
      closeModal();
    } catch {
      /* error surfaced in the modal via mutation.error */
    }
  };

  // ---- loading / error / empty states ----
  if (isLoading) {
    return (
      <div className="page-shell flex items-center justify-center py-24 text-gold-500">
        <Loader2 size={26} className="animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page-shell space-y-4 animate-fade-in">
        <SectionHeader />
        <div className="glass-panel p-5 rounded-2xl flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Couldn't load the org hierarchy.</p>
            <p className="text-neutral-500 dark:text-neutral-400 mt-1">
              {error.message}. Make sure Supabase is configured and the migrations have run.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell space-y-6 animate-fade-in">
      <SectionHeader />

      {/* Entity selector */}
      <div className="glass-panel p-4 rounded-2xl">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-neutral-400 dark:text-gold-600">
            Legal Entities
          </span>
          {canManage && isSuperAdmin && (
            <button onClick={() => openAdd('entities')} className={BTN_ADD}>
              <Plus size={12} /> Add entity
            </button>
          )}
        </div>
        {entities.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            No entities yet. {isSuperAdmin ? 'Add one above, or run the employee import.' : 'Ask a super admin to set up the org.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {entities.map((e) => {
              const brCount = (org.branches ?? []).filter((b) => b.entity_id === e.id).length;
              const isActive = e.id === activeEntityId;
              return (
                <button
                  key={e.id}
                  onClick={() => setSelectedEntityId(e.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs transition-all cursor-pointer ${
                    isActive
                      ? 'bg-black text-white dark:bg-gold-500 dark:text-charcoal-950 border-transparent font-semibold'
                      : 'bg-neutral-100/50 dark:bg-neutral-950/30 border-neutral-200 dark:border-neutral-850 text-neutral-600 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-gold-500/30'
                  }`}
                >
                  <span className="font-mono">{e.code}</span>
                  <span className="opacity-80">{e.name}</span>
                  <span className="text-[9px] font-mono opacity-70">· {brCount} br</span>
                  {!e.is_active && <span className="text-[9px] uppercase text-red-400">inactive</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected entity detail */}
      {activeEntityId && (
        <div className="glass-panel p-5 rounded-2xl space-y-4">
          {/* sub tabs */}
          <div className="flex border-b border-neutral-200 dark:border-neutral-900 space-x-5 text-xs">
            {SUB_TABS.map((t) => {
              const Icon = t.icon;
              const count = listsByKey[t.key].length;
              return (
                <button
                  key={t.key}
                  onClick={() => setSubTab(t.key)}
                  className={`pb-2.5 flex items-center gap-1.5 font-semibold cursor-pointer border-b-2 transition-all ${
                    subTab === t.key
                      ? 'border-black dark:border-gold-500 text-black dark:text-gold-400'
                      : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                  }`}
                >
                  <Icon size={13} /> {t.label}
                  <span className="text-[9px] font-mono opacity-70">{count}</span>
                </button>
              );
            })}
          </div>

          {/* add button */}
          <div className="flex justify-end">
            {canManage && (
              <button onClick={() => openAdd(subTab)} className={BTN_ADD}>
                <Plus size={12} /> Add {subTab.slice(0, -1)}
              </button>
            )}
          </div>

          {/* table */}
          <OrgTable
            rows={[...listsByKey[subTab]].sort((a, b) => labelOf(a).localeCompare(labelOf(b)))}
            columns={COLUMNS[subTab]}
            canManage={canManage}
            onEdit={(row) => openEdit(subTab, row)}
            onToggle={(row) => toggleActive(subTab, row)}
          />
        </div>
      )}

      {modal.open && (
        <FormModal
          modal={modal}
          fieldOptions={listsByKey}
          onChange={(form) => setModal((m) => ({ ...m, form }))}
          onSubmit={submit}
          onClose={closeModal}
          busy={mutation.isPending}
          errorMsg={mutation.error?.message}
        />
      )}
    </div>
  );
}

function SectionHeader() {
  return (
    <div>
      <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans flex items-center gap-2">
        <Network size={20} className="text-gold-500" /> Organization Hierarchy
      </h2>
      <p className="text-xs text-neutral-500 dark:text-slate-400">
        Manage entities, zones, branches, departments and designations. Changes here define the scopes
        used across the whole system.
      </p>
    </div>
  );
}

function OrgTable({ rows, columns, canManage, onEdit, onToggle }) {
  if (rows.length === 0) {
    return <p className="text-xs text-neutral-500 dark:text-neutral-400 py-6 text-center">Nothing here yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs text-left">
        <thead>
          <tr className="border-b border-neutral-200 dark:border-neutral-850 text-neutral-550 text-[10px] font-bold uppercase tracking-wider">
            {columns.map((col) => (
              <th key={col.h} className="py-2">{col.h}</th>
            ))}
            <th className="py-2">Status</th>
            {canManage && <th className="py-2 text-right">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-150 dark:divide-neutral-850/60 text-neutral-700 dark:text-neutral-300">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-neutral-100/10 transition-colors">
              {columns.map((col) => (
                <td key={col.h} className={`py-2.5 ${col.mono ? 'font-mono' : ''}`}>{col.c(r)}</td>
              ))}
              <td className="py-2.5">
                <span
                  className={`text-[9px] font-mono px-2 py-0.5 rounded-md border ${
                    r.is_active
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/40'
                      : 'bg-neutral-100 dark:bg-neutral-900 text-neutral-500 border-neutral-200 dark:border-neutral-800'
                  }`}
                >
                  {r.is_active ? 'Active' : 'Inactive'}
                </span>
              </td>
              {canManage && (
                <td className="py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => onEdit(r)} title="Edit" className={ICON_BTN}>
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => onToggle(r)} title={r.is_active ? 'Deactivate' : 'Reactivate'} className={ICON_BTN}>
                      <Power size={13} className={r.is_active ? '' : 'text-red-400'} />
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FormModal({ modal, fieldOptions, onChange, onSubmit, onClose, busy, errorMsg }) {
  const { table, mode, form } = modal;
  const fields = FORM_FIELDS[table] || [];
  const setField = (key, val) => onChange({ ...form, [key]: val });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-gold-500/15 rounded-2xl shadow-2xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold capitalize">
            {mode === 'add' ? 'Add' : 'Edit'} {table.slice(0, -1)}
          </h3>
          <button onClick={onClose} className={ICON_BTN}>
            <X size={15} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="block text-[11px] font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                {f.label}
                {f.required && <span className="text-red-400"> *</span>}
              </label>
              {f.type === 'select' ? (
                <select
                  value={form[f.key] ?? ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className={INPUT}
                >
                  <option value="">— none —</option>
                  {(fieldOptions[f.from] ?? []).map((o) => (
                    <option key={o.id} value={o.id}>{labelOf(o)}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  required={f.required}
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder || ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className={INPUT}
                />
              )}
            </div>
          ))}

          {errorMsg && (
            <p className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">
              {errorMsg}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex items-center gap-1.5 bg-black dark:bg-gold-450 text-white dark:text-charcoal-900 font-semibold text-xs px-3.5 py-2 rounded-xl hover:opacity-90 disabled:opacity-60 cursor-pointer"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
