import React, { useState } from 'react';
import {
  Plus, Pencil, Power, X, Loader2
} from 'lucide-react';
import { useOrg, useOrgMutation } from '../data/org';
import { usePermissions } from '../auth/usePermissions';

// Sub-sections shown under a selected entity.
const SUB_TABS = [
  { key: 'zones', label: 'Zones' },
  { key: 'branches', label: 'Branches' },
  { key: 'departments', label: 'Departments' },
  { key: 'designations', label: 'Designations' },
];

// Form fields per table
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
    { key: 'zone_id', label: 'Zone (optional)', type: 'select', from: 'zones' },
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

// Minimal classes
const BTN_PRIMARY = 'inline-flex items-center gap-2 text-xs font-medium px-4 py-2 border border-neutral-900 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 dark:border-white hover:opacity-80 transition-opacity cursor-pointer';
const ICON_BTN = 'p-1.5 text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer';
const INPUT = 'w-full text-sm py-2 bg-transparent border-b border-neutral-300 dark:border-neutral-700 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-neutral-900 dark:focus:border-white transition-colors placeholder-neutral-400 rounded-none';

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

  const zoneName = (id) => (id ? labelOf(zones.find((z) => z.id === id)) : '—');
  const branchName = (id) => (id ? labelOf(branches.find((b) => b.id === id)) : '—');
  const deptName = (id) => (id ? labelOf(departments.find((d) => d.id === id)) : '—');

  // Minimal column config
  const COLUMNS = {
    zones: [
      { h: 'Name', c: (r) => r.name },
      { h: 'Code', c: (r) => <span className="text-neutral-500 font-mono text-[11px]">{r.code || '—'}</span> },
    ],
    branches: [
      { h: 'Name / Code', c: (r) => <span>{r.name || '—'} <span className="text-neutral-500 font-mono text-[11px] ml-2">{r.code}</span></span> },
      { h: 'City', c: (r) => <span className="text-neutral-500">{r.city || '—'}</span> },
      { h: 'Zone', c: (r) => <span className="text-neutral-500">{zoneName(r.zone_id)}</span> },
    ],
    departments: [
      { h: 'Name / Code', c: (r) => <span>{r.name} <span className="text-neutral-500 font-mono text-[11px] ml-2">{r.code || '—'}</span></span> },
      { h: 'Branch', c: (r) => <span className="text-neutral-500">{branchName(r.branch_id)}</span> },
    ],
    designations: [
      { h: 'Title / Grade', c: (r) => <span>{r.title} <span className="text-neutral-500 font-mono text-[11px] ml-2">{r.grade || '—'}</span></span> },
      { h: 'Department', c: (r) => <span className="text-neutral-500">{deptName(r.department_id)}</span> },
    ],
  };

  const openAdd = (table) => setModal({ open: true, table, mode: 'add', form: table === 'entities' ? {} : { entity_id: activeEntityId } });
  const openEdit = (table, row) => setModal({ open: true, table, mode: 'edit', form: { ...row } });
  const closeModal = () => { mutation.reset(); setModal({ open: false }); };

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
    } catch { /* error handled in modal */ }
  };

  if (isLoading) return <div className="p-12 text-neutral-400 flex justify-center"><Loader2 className="animate-spin" size={24} /></div>;
  if (error) return <div className="p-8 text-sm text-red-600 border border-red-200 mt-8 max-w-2xl mx-auto">{error.message}</div>;

  return (
    <div className="w-full mx-auto py-8   space-y-12 animate-fade-in text-neutral-900 dark:text-neutral-100">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 pb-6 border-b border-neutral-200 dark:border-neutral-800">
        <div>
          <h2 className="text-2xl font-light tracking-tight">Organization</h2>
          <p className="text-xs text-neutral-500 mt-1">Manage corporate entities and structures.</p>
        </div>
        {canManage && isSuperAdmin && (
          <button onClick={() => openAdd('entities')} className={BTN_PRIMARY}>
            <Plus size={14} /> Add Entity
          </button>
        )}
      </div>

      {/* Entities Row */}
      {entities.length > 0 && (
        <div className="space-y-4">
          <div className="flex gap-8 overflow-x-auto pb-4 hide-scrollbar">
            {entities.map(e => {
              const isActive = e.id === activeEntityId;
              return (
                <button
                  key={e.id}
                  onClick={() => setSelectedEntityId(e.id)}
                  className={`flex flex-col text-left transition-all ${isActive ? 'text-neutral-900 dark:text-white' : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300'
                    }`}
                >
                  <span className={`text-sm tracking-wide ${isActive ? 'font-medium' : 'font-light'}`}>{e.name}</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] font-mono">{e.code}</span>
                    {isActive && <div className="h-[1px] w-4 bg-neutral-900 dark:bg-white" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Active Entity Content */}
      {activeEntityId && (
        <div className="space-y-8 pt-4">

          {/* Sub Navigation */}
          <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800">
            <div className="flex gap-8">
              {SUB_TABS.map(t => (
                <button
                  key={t.key}
                  onClick={() => setSubTab(t.key)}
                  className={`pb-3 text-sm transition-all border-b border-transparent ${subTab === t.key
                    ? 'text-neutral-900 dark:text-white border-neutral-900 dark:border-white font-medium'
                    : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                    }`}
                >
                  {t.label} <span className="text-[10px] ml-1 opacity-50">{listsByKey[t.key].length}</span>
                </button>
              ))}
            </div>

            {canManage && (
              <button onClick={() => openAdd(subTab)} className={`pb-3 text-xs text-neutral-900 dark:text-white flex items-center gap-1 hover:opacity-70 transition-opacity`}>
                <Plus size={12} /> Add new
              </button>
            )}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            {listsByKey[subTab].length === 0 ? (
              <div className="py-12 text-center text-sm text-neutral-400 font-light border-b border-neutral-200 dark:border-neutral-800">
                No entries found.
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 dark:border-neutral-800 text-neutral-500 text-[10px] uppercase tracking-widest font-medium">
                    {COLUMNS[subTab].map((col) => (
                      <th key={col.h} className="py-3 font-medium">{col.h}</th>
                    ))}
                    <th className="py-3 w-24">Status</th>
                    {canManage && <th className="py-3 w-16 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900/50">
                  {listsByKey[subTab].sort((a, b) => labelOf(a).localeCompare(labelOf(b))).map((r) => (
                    <tr key={r.id} className="group transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/30">
                      {COLUMNS[subTab].map((col) => (
                        <td key={col.h} className="py-3 font-light">{col.c(r)}</td>
                      ))}
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <div className={`w-1.5 h-1.5 rounded-full ${r.is_active ? 'bg-neutral-900 dark:bg-white' : 'bg-neutral-300 dark:bg-neutral-700'}`} />
                          <span className={`text-[10px] tracking-wider uppercase ${r.is_active ? 'text-neutral-900 dark:text-white' : 'text-neutral-400'}`}>
                            {r.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                      </td>
                      {canManage && (
                        <td className="py-3 text-right">
                          <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => openEdit(subTab, r)} className={ICON_BTN}><Pencil size={12} /></button>
                            <button onClick={() => toggleActive(subTab, r)} className={`${ICON_BTN} ${r.is_active ? '' : 'text-red-400'}`}>
                              <Power size={12} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Form Modal */}
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

function FormModal({ modal, fieldOptions, onChange, onSubmit, onClose, busy, errorMsg }) {
  const { table, mode, form } = modal;
  const fields = FORM_FIELDS[table] || [];
  const setField = (key, val) => onChange({ ...form, [key]: val });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/90 dark:bg-neutral-950/90 backdrop-blur-sm p-4 animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-xl font-light tracking-tight text-neutral-900 dark:text-white capitalize">
            {mode} {table.slice(0, -1)}
          </h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-6">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="block text-[10px] uppercase tracking-widest text-neutral-500 mb-1">
                {f.label} {f.required && '*'}
              </label>
              {f.type === 'select' ? (
                <div className="relative">
                  <select
                    value={form[f.key] ?? ''}
                    onChange={(e) => setField(f.key, e.target.value)}
                    className={`${INPUT} appearance-none pr-8 cursor-pointer`}
                  >
                    <option value="">—</option>
                    {(fieldOptions[f.from] ?? []).map((o) => (
                      <option key={o.id} value={o.id}>{labelOf(o)}</option>
                    ))}
                  </select>
                </div>
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
            <div className="text-xs text-red-600 mt-2">{errorMsg}</div>
          )}

          <div className="flex gap-4 pt-4">
            <button type="submit" disabled={busy} className={`${BTN_PRIMARY} w-full justify-center`}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
