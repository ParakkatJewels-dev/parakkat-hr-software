import React from 'react';

// Reusable cascading org selectors for an employee: Entity → Branch → Department → Designation.
// Controlled: `value` holds { entity_id, branch_id, department_id, designation_id } and every change
// calls `onChange(partialPatch)`. Selecting a higher level clears the lower ones so the choice stays
// consistent. entity_id is required (employees.entity_id is NOT NULL); the rest are optional.
export function EmployeeOrgFields({ org, value, onChange, inputClass, labelClass }) {
  const entities = org?.entities ?? [];
  const active = (r) => r.is_active !== false;
  const branches = (org?.branches ?? []).filter((b) => b.entity_id === value.entity_id && active(b));
  const departments = (org?.departments ?? []).filter(
    (d) => d.entity_id === value.entity_id && active(d) && (!value.branch_id || !d.branch_id || d.branch_id === value.branch_id)
  );
  const designations = (org?.designations ?? []).filter(
    (g) => active(g) && (value.department_id ? g.department_id === value.department_id : g.entity_id === value.entity_id)
  );

  const L = labelClass ?? 'block text-[11px] font-semibold text-neutral-600 dark:text-neutral-300 mb-1';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className={L}>Entity *</label>
        <select
          className={inputClass}
          value={value.entity_id ?? ''}
          required
          onChange={(e) => onChange({ entity_id: e.target.value, branch_id: '', department_id: '', designation_id: '' })}
        >
          <option value="">Select…</option>
          {entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.name}</option>)}
        </select>
      </div>
      <div>
        <label className={L}>Branch</label>
        <select
          className={inputClass}
          value={value.branch_id ?? ''}
          disabled={!value.entity_id}
          onChange={(e) => onChange({ branch_id: e.target.value, department_id: '', designation_id: '' })}
        >
          <option value="">—</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.code}{b.name ? ` · ${b.name}` : ''}</option>)}
        </select>
      </div>
      <div>
        <label className={L}>Department</label>
        <select
          className={inputClass}
          value={value.department_id ?? ''}
          disabled={!value.entity_id}
          onChange={(e) => onChange({ department_id: e.target.value, designation_id: '' })}
        >
          <option value="">—</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div>
        <label className={L}>Designation</label>
        <select
          className={inputClass}
          value={value.designation_id ?? ''}
          disabled={!value.entity_id}
          onChange={(e) => onChange({ designation_id: e.target.value })}
        >
          <option value="">—</option>
          {designations.map((g) => <option key={g.id} value={g.id}>{g.title}{g.grade ? ` (${g.grade})` : ''}</option>)}
        </select>
      </div>
    </div>
  );
}
