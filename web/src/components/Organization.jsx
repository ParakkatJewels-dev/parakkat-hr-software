import React, { useState, useMemo } from 'react';
import {
  Plus, Pencil, Power, Loader2, Network, X, Search, Trash2,
} from 'lucide-react';
import { useOrgAll, useOrgMutation, useQuickSetup } from '../data/org';
import FormSection, { Field, FIELD } from './ui/FormSection';
import InlineRowForm from './ui/InlineRowForm';
import ConfirmDialog from './ui/ConfirmDialog';
import { btnClass } from './ui/Btn';
import { usePermissions } from '../auth/usePermissions';
import { useEmployees } from '../data/employees';

// The parts of a company, in the order you actually set them up. All four are optional — only the
// company itself is required (employees.entity_id is NOT NULL) — so each says what it is for and
// nobody has to guess whether they must fill it in.
//
// Shown one at a time, picked from a rail that carries the counts. Two earlier attempts were
// worse: tabs hid the counts so you had to click each to learn it was empty, and four cards side
// by side meant a 50-branch list sat in half the width next to a 5-row neighbour. The rail keeps
// "what exists" visible while giving the list you are working in the whole page.
const SECTIONS = [
  {
    key: 'branches',
    label: 'Branches',
    singular: 'branch',
    blurb: 'Shops, factories and offices. A Branch Manager manages everyone in one of these.',
  },
  {
    key: 'departments',
    label: 'Departments',
    singular: 'department',
    blurb: 'Teams within the company — Sales, Accounts, Production. Optional.',
  },
  {
    key: 'designations',
    label: 'Designations',
    singular: 'designation',
    blurb: 'Job titles you can assign to people. Optional.',
  },
  {
    key: 'zones',
    label: 'Zones',
    singular: 'zone',
    blurb: 'Only needed if you group several branches under one regional manager.',
    advanced: true,
  },
];

// Form fields per table
const FORM_FIELDS = {
  entities: [
    { key: 'code', label: 'Short code', required: true, placeholder: 'PPI' },
    { key: 'name', label: 'Company name', required: true },
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
const BTN_PRIMARY = btnClass('primary');
const ICON_BTN = btnClass('subtle', 'sm', true);
export default function Organization() {
  // The management screen, so it sees switched-off rows too — otherwise an inactive branch
  // could never be found to switch back on.
  const { data: org, isLoading, error } = useOrgAll();
  const { data: allEmployees = [] } = useEmployees();
  const mutation = useOrgMutation();
  const { canAny, isSuperAdmin } = usePermissions();
  const canManage = isSuperAdmin || canAny('org.manage');

  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [modal, setModal] = useState({ open: false });
  const [quickSetup, setQuickSetup] = useState(false);
  // Which part of the company is on screen. Branches first — it is the one everybody sets up.
  const [activePart, setActivePart] = useState('branches');
  // One mutation object serves every section, so its error outlived the section that caused it —
  // a rejected branch code then appeared under Departments. Clear it when the part changes.
  const showPart = (key) => { mutation.reset(); setActivePart(key); };

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
      { h: 'Code', c: (r) => <span className="text-neutral-500 font-mono text-xs">{r.code || '—'}</span> },
    ],
    branches: [
      { h: 'Name / Code', c: (r) => <span>{r.name || '—'} <span className="text-neutral-500 font-mono text-xs ml-2">{r.code}</span></span> },
      { h: 'City', c: (r) => <span className="text-neutral-500">{r.city || '—'}</span> },
      { h: 'Zone', c: (r) => <span className="text-neutral-500">{zoneName(r.zone_id)}</span> },
    ],
    departments: [
      { h: 'Name / Code', c: (r) => <span>{r.name}{r.code ? <span className="text-neutral-500 font-mono text-xs ml-2">{r.code}</span> : null}</span> },
      { h: 'Branch', c: (r) => <span className="text-neutral-500">{r.branch_id ? branchName(r.branch_id) : 'Whole company'}</span> },
    ],
    designations: [
      { h: 'Title / Grade', c: (r) => <span>{r.title}{r.grade ? <span className="text-neutral-500 font-mono text-xs ml-2">{r.grade}</span> : null}</span> },
      { h: 'Department', c: (r) => <span className="text-neutral-500">{deptName(r.department_id)}</span> },
    ],
  };

  // Companies are the one thing still edited in a panel — they are not rows in any table here,
  // so there is no line to type into. Everything inside a company edits in place.
  const openEdit = (table, row) => setModal({ open: true, table, mode: 'edit', form: { ...row } });
  const closeModal = () => { mutation.reset(); setModal({ open: false }); };

  // Both inline paths land here. New rows inherit the company currently on screen; empty selects
  // must become null, not '', or the FK insert is rejected.
  const saveRow = async (table, op, form) => {
    const row = { ...form };
    ['zone_id', 'branch_id', 'department_id'].forEach((k) => { if (row[k] === '') row[k] = null; });
    if (op === 'insert') row.entity_id = activeEntityId;
    mutation.reset();
    await mutation.mutateAsync({ table, op, row });
  };

  const toggleActive = (table, row) =>
    mutation.mutate({ table, op: 'update', row: { id: row.id, is_active: !row.is_active } });

  // Deleting is offered because "deactivate" is not always what you want — a branch typed by
  // mistake should not linger forever. Postgres refuses if people are still attached, and
  // friendlyOrgError turns that refusal into an instruction.
  const [confirmDelete, setConfirmDelete] = useState(null); // { table, row } | null
  const [confirmCompany, setConfirmCompany] = useState(null); // the company awaiting confirmation

  /**
   * Deleting a company CASCADES to its branches, departments, designations, zones, shifts,
   * holiday calendars, jobs, onboarding, pay components and payroll runs. Employees block it
   * outright (ON DELETE NO ACTION), which is the only reason this is not catastrophic — so the
   * dialog states the count for each rather than asking "are you sure?" about an unknown.
   */
  const companyImpact = (id) => ({
    employees: allEmployees.filter((e) => e.entity_id === id).length,
    branches: (org?.branches ?? []).filter((b) => b.entity_id === id).length,
    departments: (org?.departments ?? []).filter((d) => d.entity_id === id).length,
    designations: (org?.designations ?? []).filter((d) => d.entity_id === id).length,
    zones: (org?.zones ?? []).filter((z) => z.entity_id === id).length,
  });

  const deleteCompany = async () => {
    if (!confirmCompany) return;
    try {
      await mutation.mutateAsync({ table: 'entities', op: 'delete', row: { id: confirmCompany.id } });
      if (selectedEntityId === confirmCompany.id) setSelectedEntityId(null);
      setConfirmCompany(null);
    } catch { /* shown in the dialog */ }
  };
  const deleteRow = async () => {
    if (!confirmDelete) return;
    try {
      await mutation.mutateAsync({ table: confirmDelete.table, op: 'delete', row: { id: confirmDelete.row.id } });
      setConfirmDelete(null);
    } catch { /* shown in the dialog */ }
  };

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
    <div className="page-shell space-y-8 animate-fade-in text-neutral-900 dark:text-neutral-100">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[#0ea971] flex items-center gap-1.5">
            <Network size={12} /> Organisation
          </p>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white mt-1">Structure</h1>
          <p className="text-base text-neutral-500 mt-0.5">
            Companies and what sits inside them. Placement here decides who manages whom.
          </p>
        </div>
        {canManage && isSuperAdmin && entities.length > 0 && !quickSetup && (
          <button onClick={() => setQuickSetup(true)} className={BTN_PRIMARY}>
            <Plus size={14} /> Add company
          </button>
        )}
      </div>

      {/* Nothing exists yet. This used to render an empty page: every "Add" control lived inside
          `activeEntityId && (...)`, so with no company there was no way to add a branch, a
          department — or, for anyone but a super admin, anything at all. */}
      {quickSetup ? (
        <QuickSetup
          onDone={(entity) => { if (entity?.id) setSelectedEntityId(entity.id); setQuickSetup(false); }}
          onCancel={() => setQuickSetup(false)}
        />
      ) : entities.length === 0 ? (
        <div className="premium-card p-10 text-center">
          <Network size={28} className="mx-auto text-neutral-300 dark:text-neutral-700" />
          <h2 className="text-lg font-bold text-neutral-900 dark:text-white mt-3">
            Set up your organisation
          </h2>
          <p className="text-base text-neutral-500 dark:text-neutral-400 mt-1.5 max-w-md mx-auto">
            Everything hangs off a company — its branches, departments and the people in them.
            Add one to get started; you can add the rest afterwards.
          </p>
          {isSuperAdmin ? (
            <button onClick={() => setQuickSetup(true)} className={BTN_PRIMARY + ' mt-5 mx-auto'}>
              <Plus size={14} /> Add your first company
            </button>
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-4 max-w-md mx-auto">
              Only a super admin can create a company. Once one exists you'll be able to add
              branches and departments inside it.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {/* Which company you are looking at, and the only way to correct one. Shown even for a
              single company — you could previously create one but never fix a typo in its name. */}
          <div className="flex flex-wrap items-center gap-2">
            {entities.map((e) => {
              const isActive = e.id === activeEntityId;
              return (
                <div
                  key={e.id}
                  className={`flex items-center gap-1 rounded-xl border pr-1 transition-colors ${
                    isActive
                      ? 'border-[#0ea971]/45 bg-[#0ea971]/8'
                      : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700'
                  }`}
                >
                  <button
                    onClick={() => setSelectedEntityId(e.id)}
                    aria-current={isActive ? 'true' : undefined}
                    className="px-3 py-2 text-left cursor-pointer min-w-0"
                  >
                    <span className={`block text-base truncate ${isActive ? 'font-bold text-neutral-900 dark:text-white' : 'font-semibold text-neutral-600 dark:text-neutral-300'}`}>
                      {e.name}
                    </span>
                    <span className="block text-2xs text-neutral-450 mt-0.5">
                      <span className="font-mono">{e.code}</span>
                      <span className="mx-1.5 opacity-40">·</span>
                      {allEmployees.filter((x) => x.entity_id === e.id).length} people
                    </span>
                  </button>
                  {canManage && isActive && (
                    <>
                      <button
                        onClick={() => openEdit('entities', e)}
                        className={ICON_BTN}
                        aria-label={`Edit ${e.name}`}
                        title="Edit company"
                      >
                        <Pencil size={13} />
                      </button>
                      {isSuperAdmin && (
                        <button
                          onClick={() => { mutation.reset(); setConfirmCompany(e); }}
                          className={ICON_BTN + ' hover:text-red-500!'}
                          aria-label={`Delete ${e.name}`}
                          title="Delete company"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* What this company is made of, in one line. Four stacked lists give no sense of scale
              until you scroll all of them; this answers "how big is this?" up front and keeps the
              company you are editing on screen as you work down the page. */}
          {/* Pick a part of the company, then work in it at full width.
              Four cards side by side worked while every list was short. At 50 branches one card
              becomes ten times the height of its neighbour, and squeezing 50 rows into a
              half-width pane wastes the screen on a list that needs it. Choosing one at a time
              gives it the whole width — and the counts in the rail still answer "what exists?"
              without opening anything. */}
          <div className="grid grid-cols-1 lg:grid-cols-[13rem_minmax(0,1fr)] gap-5 items-start">
            <nav aria-label="Parts of this company" className="premium-card p-1.5 lg:sticky lg:top-2">
              <ul className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible">
                {SECTIONS.map((s) => {
                  const isOn = s.key === activePart;
                  const count = listsByKey[s.key].length;
                  return (
                    <li key={s.key} className="shrink-0 lg:shrink">
                      <button
                        onClick={() => showPart(s.key)}
                        aria-current={isOn ? 'true' : undefined}
                        className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left cursor-pointer transition-colors ${
                          isOn
                            ? 'bg-[#0ea971]/12 text-[#0c9765] dark:text-[#10b981]'
                            : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-charcoal-800'
                        }`}
                      >
                        <span className={`text-base font-bold whitespace-nowrap ${isOn ? '' : ''}`}>
                          {s.label}
                        </span>
                        <span
                          className={`ml-auto text-xs font-bold tabular-nums px-1.5 py-0.5 rounded ${
                            isOn
                              ? 'bg-[#0ea971]/20'
                              : count === 0
                              ? 'text-neutral-400'
                              : 'bg-neutral-100 dark:bg-charcoal-800 text-neutral-500'
                          }`}
                        >
                          {count}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="min-w-0">
              {SECTIONS.filter((s) => s.key === activePart).map((s) => (
                <StructureSection
                  key={s.key}
                  section={s}
                  rows={listsByKey[s.key]}
                  columns={COLUMNS[s.key]}
                  canManage={canManage}
                  fields={FORM_FIELDS[s.key]}
                  fieldOptions={listsByKey}
                  busy={mutation.isPending}
                  error={mutation.error?.message}
                  onSave={(op, row) => saveRow(s.key, op, row)}
                  onToggle={(row) => toggleActive(s.key, row)}
                  onDelete={(row) => { mutation.reset(); setConfirmDelete({ table: s.key, row }); }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {confirmCompany && (() => {
        const n = companyImpact(confirmCompany.id);
        const blocked = n.employees > 0;
        const cascades = [
          [n.branches, 'branch', 'branches'],
          [n.departments, 'department', 'departments'],
          [n.designations, 'designation', 'designations'],
          [n.zones, 'zone', 'zones'],
        ].filter(([c]) => c > 0);

        return (
          <ConfirmDialog
            title={blocked ? `${confirmCompany.name} still has people` : `Delete ${confirmCompany.name}?`}
            confirmLabel={blocked ? 'Delete anyway' : 'Delete company'}
            busy={mutation.isPending}
            error={mutation.error?.message}
            onCancel={() => { mutation.reset(); setConfirmCompany(null); }}
            onConfirm={deleteCompany}
          >
            {blocked ? (
              <>
                <p>
                  <b>{n.employees} {n.employees === 1 ? 'person is' : 'people are'}</b> still assigned to
                  this company, so the database will refuse to delete it.
                </p>
                <p className="text-neutral-500 dark:text-neutral-400">
                  Move them to another company first, or remove them. That refusal is deliberate —
                  it is what stops a company delete taking employee records with it.
                </p>
              </>
            ) : (
              <>
                <p>This permanently deletes the company{cascades.length ? ' and everything inside it' : ''}.</p>
                {cascades.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {cascades.map(([c, one, many]) => (
                      <li key={many} className="flex items-center gap-1.5">
                        <span className="w-1 h-1 rounded-full bg-red-500 shrink-0" />
                        <b>{c}</b> {c === 1 ? one : many}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-neutral-500 dark:text-neutral-400">
                  Its shifts, holiday calendar, pay components and any payroll runs go too. This
                  cannot be undone.
                </p>
              </>
            )}
          </ConfirmDialog>
        );
      })()}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${labelOf(confirmDelete.row)}?`}
          confirmLabel="Delete"
          busy={mutation.isPending}
          error={mutation.error?.message}
          onCancel={() => { mutation.reset(); setConfirmDelete(null); }}
          onConfirm={deleteRow}
        >
          <p>
            This removes the {SECTIONS.find((x) => x.key === confirmDelete.table)?.singular ?? 'record'} permanently.
          </p>
          <p className="text-neutral-500 dark:text-neutral-400">
            If anyone is still assigned to it the database will refuse, and you will see why.
            To retire it without losing history, use <b>Deactivate</b> instead.
          </p>
        </ConfirmDialog>
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

/**
 * Company + branches + departments in one submit.
 *
 * The data model forces company-first, but nothing forces the *user* to make three separate trips
 * to satisfy it. Repeatable rows here, one call underneath (see useQuickSetup), so a four-company
 * jewellery group can be stood up in four passes instead of forty.
 */
function QuickSetup({ onDone, onCancel }) {
  const setup = useQuickSetup();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [branches, setBranches] = useState([{ code: '', name: '', city: '' }]);
  const [departments, setDepartments] = useState([{ name: '', code: '', branchCode: '' }]);

  const setRow = (list, setList) => (i, patch) =>
    setList(list.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const addRow = (list, setList, blank) => () => setList([...list, blank]);
  const dropRow = (list, setList) => (i) => setList(list.filter((_, n) => n !== i));

  // Codes must be unique within a company. Deriving one from the name by slicing six characters
  // gave "Kochi Main" and "Kochi Market" the same code — "KOCHI " — and the duplicate key error
  // rejected the ENTIRE batch of branches, blaming "branches" in general. Strip punctuation, then
  // disambiguate against codes already claimed in this form.
  const cleanBranches = useMemo(() => {
    const taken = new Set();
    return branches
      .filter((b) => b.code.trim() || b.name.trim())
      .map((b) => {
        let code = (b.code.trim() || b.name.trim()).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        if (!code) code = 'BR';
        let candidate = code, n = 2;
        while (taken.has(candidate)) candidate = `${code.slice(0, 5)}${n++}`;
        taken.add(candidate);
        return { code: candidate, name: b.name.trim() || null, city: b.city.trim() || null };
      });
  }, [branches]);
  const cleanDepts = departments.filter((d) => d.name.trim()).map((d) => ({
    name: d.name.trim(),
    code: d.code.trim().toUpperCase() || null,
    branchCode: d.branchCode || null,
  }));
  const canSubmit = name.trim() && code.trim() && !setup.isPending;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      const made = await setup.mutateAsync({
        company: { name: name.trim(), code: code.trim().toUpperCase() },
        branches: cleanBranches,
        departments: cleanDepts,
      });
      // Hand the new company back so the page switches to it — landing on entities[0] after
      // adding your second company looked like the save had done nothing.
      onDone?.(made?.entity);
    } catch { /* shown below */ }
  };

  const rowInput = FIELD + ' text-sm';

  return (
    <form onSubmit={submit} className="premium-card space-y-5">
      <div>
        <h2 className="text-lg font-bold text-neutral-900 dark:text-white">Set up a company</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
          Add its branches and departments at the same time — you can always add more later.
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-2xs font-bold uppercase tracking-wider text-neutral-400 mb-2">1 · Company</legend>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-3">
          <Field label="Company name" htmlFor="qs-name" required>
            <input id="qs-name" className={FIELD} value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. PP Imitations" required autoFocus />
          </Field>
          <Field label="Short code" htmlFor="qs-code" required>
            <input id="qs-code" className={FIELD + ' font-mono uppercase'} value={code}
              onChange={(e) => setCode(e.target.value)} placeholder="PPI" required />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-2 pt-1 border-t border-neutral-100 dark:border-neutral-855">
        <legend className="text-2xs font-bold uppercase tracking-wider text-neutral-400 mt-2 mb-2">
          2 · Branches <span className="font-normal normal-case tracking-normal">— code, name, city. Zones come later, in the Zones section.</span>
        </legend>
        {branches.map((b, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-[5rem_1fr_1fr_auto] gap-2 items-center">
            <input aria-label={`Branch ${i + 1} code`} className={rowInput + ' font-mono uppercase'} value={b.code}
              onChange={(e) => setRow(branches, setBranches)(i, { code: e.target.value })} placeholder="CDA" />
            <input aria-label={`Branch ${i + 1} name`} className={rowInput} value={b.name}
              onChange={(e) => setRow(branches, setBranches)(i, { name: e.target.value })} placeholder="Chalakudy" />
            <input aria-label={`Branch ${i + 1} city`} className={rowInput} value={b.city}
              onChange={(e) => setRow(branches, setBranches)(i, { city: e.target.value })} placeholder="City" />
            <button type="button" onClick={() => dropRow(branches, setBranches)(i)}
              disabled={branches.length === 1} aria-label={`Remove branch ${i + 1}`}
              className={ICON_BTN + ' disabled:opacity-30 disabled:cursor-not-allowed'}>
              <X size={14} />
            </button>
          </div>
        ))}
        <button type="button" onClick={addRow(branches, setBranches, { code: '', name: '', city: '' })}
          className="text-sm font-bold text-[#0ea971] hover:underline cursor-pointer">
          + Add another branch
        </button>
      </fieldset>

      <fieldset className="space-y-2 pt-1 border-t border-neutral-100 dark:border-neutral-855">
        <legend className="text-2xs font-bold uppercase tracking-wider text-neutral-400 mt-2 mb-2">
          3 · Departments <span className="font-normal normal-case tracking-normal">— optional. Leave the branch as "Whole company" if it spans all of them.</span>
        </legend>
        {departments.map((d, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_6rem_1fr_auto] gap-2 items-center">
            <input aria-label={`Department ${i + 1} name`} className={rowInput} value={d.name}
              onChange={(e) => setRow(departments, setDepartments)(i, { name: e.target.value })} placeholder="Sales" />
            <input aria-label={`Department ${i + 1} code`} className={rowInput + ' font-mono uppercase'} value={d.code}
              onChange={(e) => setRow(departments, setDepartments)(i, { code: e.target.value })} placeholder="SAL" />
            {/* Branches from this same form, referenced by code until they have ids. */}
            <select aria-label={`Department ${i + 1} branch`} className={rowInput + ' cursor-pointer'} value={d.branchCode}
              onChange={(e) => setRow(departments, setDepartments)(i, { branchCode: e.target.value })}>
              <option value="">Whole company</option>
              {cleanBranches.map((b) => (
                <option key={b.code} value={b.code}>{b.name || b.code}</option>
              ))}
            </select>
            <button type="button" onClick={() => dropRow(departments, setDepartments)(i)}
              disabled={departments.length === 1} aria-label={`Remove department ${i + 1}`}
              className={ICON_BTN + ' disabled:opacity-30 disabled:cursor-not-allowed'}>
              <X size={14} />
            </button>
          </div>
        ))}
        <button type="button" onClick={addRow(departments, setDepartments, { name: '', code: '', branchCode: '' })}
          className="text-sm font-bold text-[#0ea971] hover:underline cursor-pointer">
          + Add another department
        </button>
      </fieldset>

      {setup.error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-300 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
          {setup.error.message}
        </p>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1 border-t border-neutral-100 dark:border-neutral-855">
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2 text-base font-bold text-neutral-600 dark:text-neutral-300 cursor-pointer">
            Cancel
          </button>
        )}
        <button type="submit" disabled={!canSubmit}
          className={btnClass('primary')}>
          {setup.isPending && <Loader2 size={13} className="animate-spin" />}
          Create company
          {cleanBranches.length > 0 && ` + ${cleanBranches.length} branch${cleanBranches.length === 1 ? '' : 'es'}`}
          {cleanDepts.length > 0 && ` + ${cleanDepts.length} dept${cleanDepts.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </form>
  );
}

/**
 * One part of the company — branches, departments, and so on.
 *
 * Each carries its own Add button, so the action is next to the thing it creates rather than in a
 * single toolbar that acted on whichever tab happened to be open. Empty sections say what they are
 * for and offer the action, instead of "No entries found."
 */
function StructureSection({ section, rows, columns, canManage, fields, fieldOptions, onSave, onToggle, onDelete, busy, error }) {
  // null = nothing open, 'new' = adding, or the id of the row being edited. One at a time.
  const [editing, setEditing] = useState(null);
  // 50+ branches is normal here, so a section needs finding as well as listing. The box only
  // appears once a list is long enough to need it.
  const [q, setQ] = useState('');
  // Switched-off rows are hidden by default. This screen is the only place they can be switched
  // back on, so they must stay reachable — but 46 branches reading INACTIVE, one per site with no
  // terminal yet, buries the two that are in use.
  const [showInactive, setShowInactive] = useState(false);
  const colSpan = columns.length + (canManage ? 1 : 0);

  const inactiveCount = useMemo(() => rows.filter((r) => r.is_active === false).length, [rows]);
  const visible = useMemo(
    () => (showInactive ? rows : rows.filter((r) => r.is_active !== false)),
    [rows, showInactive]
  );
  const searchable = visible.length > 8;

  // Declared after the state it reads — `const` is not hoisted, so computing this above `q`
  // throws "Cannot access 'q' before initialization" on first render.
  const sorted = useMemo(() => {
    const t = q.trim().toLowerCase();
    return [...visible]
      .filter((r) => !t || [r.name, r.title, r.code, r.city, r.grade]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(t)))
      // Anything switched off sinks below what is in use, so a shown list never opens with rows
      // nobody can be assigned to.
      .sort((a, b) => (a.is_active === false) - (b.is_active === false)
        || labelOf(a).localeCompare(labelOf(b)));
  }, [visible, q]);

  const save = async (form) => {
    await onSave(editing === 'new' ? 'insert' : 'update', form);
    setEditing(null);
  };

  return (
    <section className="premium-card">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-md font-bold text-neutral-900 dark:text-white">{section.label}</h2>
            <span className="text-2xs font-bold tabular-nums px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-charcoal-800 text-neutral-500">
              {q.trim() ? `${sorted.length} / ${visible.length}` : visible.length}
            </span>
            {inactiveCount > 0 && (
              <button
                onClick={() => setShowInactive((v) => !v)}
                className={`text-2xs font-bold px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                  showInactive
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                    : 'bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                }`}
                title={showInactive
                  ? 'Hide the ones switched off'
                  : 'Switched off — kept on record, hidden from assignment. Show them to edit or switch back on.'}
              >
                {showInactive ? `${inactiveCount} off shown` : `+${inactiveCount} off`}
              </button>
            )}
            {section.advanced && (
              <span className="text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-charcoal-800 text-neutral-450">
                Advanced
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{section.blurb}</p>
        </div>
        {canManage && editing !== 'new' && (
          <button
            onClick={() => setEditing('new')}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1.5 text-sm font-bold text-neutral-700 dark:text-neutral-200 hover:border-[#0ea971]/40 cursor-pointer transition-colors"
          >
            <Plus size={12} /> Add {section.singular}
          </button>
        )}
      </div>

      {searchable && (
        <div className="relative mb-2.5">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={`Search ${section.label.toLowerCase()}`}
            placeholder={`Search ${rows.length} ${section.label.toLowerCase()}…`}
            className="w-full text-sm rounded-lg pl-8 pr-8 py-1.5 bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] focus:ring-2 focus:ring-[#0ea971]/20 transition-colors"
          />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer">
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {sorted.length === 0 && editing !== 'new' ? (
        <p className="text-sm text-neutral-400 py-5 text-center border-t border-neutral-100 dark:border-neutral-855">
          {q.trim() ? <>Nothing matches “{q}”.</>
            : inactiveCount > 0 ? <>
                {/* Saying "none yet" while rows sit hidden sends people off to create duplicates
                    of records that already exist. */}
                All {inactiveCount} {section.label.toLowerCase()} here are switched off
                {' — '}
                <button onClick={() => setShowInactive(true)} className="font-bold text-[#0ea971] hover:underline cursor-pointer">show them</button>
                {canManage ? <> or <button onClick={() => setEditing('new')} className="font-bold text-[#0ea971] hover:underline cursor-pointer">add a new one</button>.</> : '.'}
              </>
            : <>
                No {section.label.toLowerCase()} yet
                {canManage ? <> — <button onClick={() => setEditing('new')} className="font-bold text-[#0ea971] hover:underline cursor-pointer">add the first one</button>.</> : '.'}
              </>}
        </p>
      ) : (
        <div className="table-scroll border-t border-neutral-100 dark:border-neutral-855">
          <table className="premium-table w-full text-left">
            <thead>
              <tr className="text-neutral-500 text-2xs uppercase tracking-widest font-bold">
                {columns.map((col) => <th key={col.h} className="py-2.5 font-bold">{col.h}</th>)}
                {canManage && <th className="py-2.5 w-16 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900/50">
              {/* First row, not last: with 50 branches on screen the add row was below the fold
                  the moment you clicked Add. */}
              {editing === 'new' && (
                <InlineRowForm
                  fields={fields}
                  fieldOptions={fieldOptions}
                  labelOf={labelOf}
                  colSpan={colSpan}
                  busy={busy}
                  error={error}
                  onSave={save}
                  onCancel={() => setEditing(null)}
                  submitLabel={`Add ${section.singular}`}
                />
              )}
              {sorted.map((r) => (
                editing === r.id ? (
                  <InlineRowForm
                    key={r.id}
                    fields={fields}
                    fieldOptions={fieldOptions}
                    labelOf={labelOf}
                    initial={r}
                    colSpan={colSpan}
                    busy={busy}
                    error={error}
                    onSave={save}
                    onCancel={() => setEditing(null)}
                    submitLabel="Save changes"
                  />
                ) : (
                <tr key={r.id} className={`group transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/30 ${r.is_active ? '' : 'opacity-55'}`}>
                  {columns.map((col, ci) => (
                    <td key={col.h} data-label={col.h} className="py-2.5 text-base">
                      {col.c(r)}
                      {/* Inactive is the exception, so it is marked where you read the name
                          rather than given a column of its own. */}
                      {ci === 0 && !r.is_active && (
                        <span className="ml-2 text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-charcoal-800 text-neutral-500">
                          Inactive
                        </span>
                      )}
                    </td>
                  ))}
                  {canManage && (
                    <td data-label="Actions" className="py-2.5 text-right">
                      {/* Always present, not revealed on hover — a control you cannot see is a
                          control you cannot reach with a keyboard or a finger. */}
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setEditing(r.id)} className={ICON_BTN} aria-label={`Edit ${labelOf(r)}`} title="Edit">
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => onToggle(r)}
                          className={`${ICON_BTN} ${r.is_active ? '' : 'text-amber-500'}`}
                          aria-label={`${r.is_active ? 'Deactivate' : 'Reactivate'} ${labelOf(r)}`}
                          title={r.is_active ? 'Deactivate — keeps history, hides from new assignments' : 'Reactivate'}
                        >
                          <Power size={13} />
                        </button>
                        <button
                          onClick={() => onDelete(r)}
                          className={ICON_BTN + ' hover:text-red-500!'}
                          aria-label={`Delete ${labelOf(r)}`}
                          title="Delete permanently"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
                )
              ))}

            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FormModal({ modal, fieldOptions, onChange, onSubmit, onClose, busy, errorMsg }) {
  const { table, mode, form } = modal;
  const fields = FORM_FIELDS[table] || [];
  const setField = (key, val) => onChange({ ...form, [key]: val });
  // 'entities' -> 'company', everything else just drops the plural s.
  const noun = table === 'entities' ? 'company' : table.slice(0, -1);

  return (
    // Name the row being edited — the form opens below the table, so "Edit branch" alone
    // leaves you unsure which branch you clicked.
    <FormSection
      title={mode === 'edit' ? `Edit ${form.name || form.code || noun}` : `New ${noun}`}
      subtitle={mode === 'edit' ? undefined : `Adds a ${noun} to the hierarchy.`}
      icon={Network}
      onClose={onClose}
      onSubmit={onSubmit}
      submitLabel="Save"
      busy={busy}
      error={errorMsg}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`org-${f.key}`} required={f.required}>
            {f.type === 'select' ? (
              <select
                id={`org-${f.key}`}
                value={form[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
                className={`${FIELD} cursor-pointer`}
              >
                <option value="">—</option>
                {(fieldOptions[f.from] ?? []).map((o) => (
                  <option key={o.id} value={o.id}>{labelOf(o)}</option>
                ))}
              </select>
            ) : (
              <input
                id={`org-${f.key}`}
                type="text"
                required={f.required}
                value={form[f.key] ?? ''}
                placeholder={f.placeholder || ''}
                onChange={(e) => setField(f.key, e.target.value)}
                className={FIELD}
              />
            )}
          </Field>
        ))}
      </div>
    </FormSection>
  );
}
