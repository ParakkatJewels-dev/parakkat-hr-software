import React, { useMemo, useState } from 'react';
import { Users, Building2, ShieldCheck, Link2, Search, X, ChevronDown, SlidersHorizontal } from 'lucide-react';
import Pagination, { usePagination } from './ui/Pagination';
import { buildUserDirectory, filterUserDirectory } from '../lib/userDirectory';
import './users-directory.css';

const EMPTY_FILTERS = { search: '', company: '', branch: '', role: '', status: '', sort: 'name' };

export default function UsersDirectory({ users, employees, org, roles, actions, busy = false, children }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const rows = useMemo(() => buildUserDirectory(users, employees, org, roles), [users, employees, org, roles]);
  const shown = useMemo(() => filterUserDirectory(rows, filters), [rows, filters]);
  const pager = usePagination(shown, 25, null, JSON.stringify(filters));
  const companies = org?.entities ?? [];
  const branches = (org?.branches ?? []).filter((b) => !filters.company || b.entity_id === filters.company);
  const update = (key, value) => setFilters((old) => ({ ...old, [key]: value, ...(key === 'company' ? { branch: '' } : {}) }));
  const activeFilters = Object.entries(filters).filter(([key, value]) => value && (key !== 'sort' || value !== 'name')).length;
  const metrics = [
    { label: 'User accounts', value: rows.length, icon: Users, note: 'Within your access' },
    { label: 'Companies', value: companies.length, icon: Building2, note: 'Managed in one place' },
    { label: 'Needs a role', value: rows.filter((u) => !u.hasRole).length, icon: ShieldCheck, note: 'Signed in, no role assigned' },
    { label: 'Not linked', value: rows.filter((u) => !u.employee_id).length, icon: Link2, note: 'No employee record attached' },
  ];
  return (
    <div className="users-directory">
      <section className="users-overview" aria-label="Account overview">
        {metrics.map(({ label, value, icon: Icon, note }) => (
          <div className="users-metric" key={label}>
            <div><span>{label}</span><Icon size={16} aria-hidden="true" /></div>
            <strong>{value.toLocaleString()}</strong><small>{note}</small>
          </div>
        ))}
      </section>

      <section className="users-workspace" aria-label="User account directory">
        <div className="users-workspace-heading">
          <div><h2>Account directory</h2><p>Find a person, check their company, then expand their account to manage access.</p></div>
          <div className="users-create-actions">{actions}</div>
        </div>
        <div className="users-filter-panel">
          <label className="users-search">
            <Search size={17} aria-hidden="true" />
            <input value={filters.search} disabled={busy} onChange={(e) => update('search', e.target.value)}
              aria-label="Search user accounts" placeholder="Search name, email, employee code or company…" />
            {filters.search && <button type="button" disabled={busy} onClick={() => update('search', '')} aria-label="Clear account search"><X size={15} /></button>}
          </label>
          <div className="users-filters">
            <Filter label="Company" value={filters.company} disabled={busy} onChange={(value) => update('company', value)}>
              <option value="">All companies</option>
              {companies.map((e) => <option value={e.id} key={e.id}>{e.code ? `${e.code} · ` : ''}{e.name}</option>)}
              <option value="unassigned">No company linked</option>
            </Filter>
            <Filter label="Branch" value={filters.branch} disabled={busy || filters.company === 'unassigned'} onChange={(value) => update('branch', value)}>
              <option value="">All branches</option>
              {branches.map((b) => <option value={b.id} key={b.id}>{b.code || b.name}{b.code && b.name ? ` · ${b.name}` : ''}</option>)}
            </Filter>
            <Filter label="Role" value={filters.role} disabled={busy} onChange={(value) => update('role', value)}>
              <option value="">All roles</option>
              {[...roles].sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key)).map((r) => <option value={r.key} key={r.id}>{r.name || r.key.replace(/_/g, ' ')}</option>)}
            </Filter>
            <Filter label="Account status" value={filters.status} disabled={busy} onChange={(value) => update('status', value)}>
              <option value="">All accounts</option><option value="ready">Role assigned</option>
              <option value="no_role">Needs a role</option><option value="unlinked">Not linked to an employee</option>
            </Filter>
            <Filter label="Sort accounts" value={filters.sort} disabled={busy} onChange={(value) => update('sort', value)}>
              <option value="name">Name A–Z</option><option value="name_desc">Name Z–A</option><option value="company">Company, then name</option>
            </Filter>
          </div>
          <div className="users-filter-summary">
            <span role="status"><SlidersHorizontal size={13} aria-hidden="true" /> {shown.length.toLocaleString()} of {rows.length.toLocaleString()} accounts</span>
            {activeFilters > 0 && <button type="button" disabled={busy} onClick={() => setFilters(EMPTY_FILTERS)}><X size={13} /> Clear filters</button>}
            {pager.totalPages > 1 && <label className="users-page-jump">Go to page
              <input type="number" min="1" max={pager.totalPages} key={`${pager.page}:${pager.totalPages}`} defaultValue={pager.page}
                aria-label="Go to account page" disabled={busy}
                onBlur={(e) => { if (e.target.value) pager.setPage(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pager.setPage(e.currentTarget.value); } }} />
            </label>}
          </div>
        </div>

        <Pagination {...pager} noun="accounts" sizes={[10, 25, 50, 100]} keepVisible disabled={busy} className="users-pagination" />
        <div className="users-column-head" aria-hidden="true"><span>Person & sign-in</span><span>Company & branch</span><span>Roles</span><span>Account status</span><span>Actions</span></div>
        <div className="users-account-list">
          {pager.slice.map((row) => (
            <details key={row.user_id} className="users-account" name="account-management">
              <summary className="users-account-row" aria-label={`Manage access for ${row.displayName}`}
                onClick={(e) => { if (busy) e.preventDefault(); }}>
                <span className="users-person">
                  <span className="users-avatar" aria-hidden="true">{row.displayName.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
                  <span className="users-identity"><strong title={row.displayName}>{row.displayName}</strong>
                    <span title={row.email}>{row.email}</span>
                    {(row.employee_code || row.employee?.employee_code) && <small>{row.employee_code || row.employee.employee_code}</small>}
                  </span>
                </span>
                <span className="users-placement"><strong title={row.companyLabel}>{row.companyLabel}</strong><small>{row.branchLabel || (row.employee_id ? 'No branch assigned' : 'Standalone login')}</small></span>
                <span className="users-role-summary">
                  {row.global ? <span className="users-role-chip">Super Admin</span> : row.roleLabels.length ? <>
                    {row.roleLabels.slice(0, 2).map((label, index) => <span className="users-role-chip" key={`${label}-${index}`}>{label}</span>)}
                    {row.roleLabels.length > 2 && <span className="users-more-roles">+{row.roleLabels.length - 2} more</span>}
                  </> : <span className="users-muted">No role assigned</span>}
                </span>
                <span className="users-account-status"><span className={`users-status ${row.hasRole ? 'is-configured' : 'is-pending'}`}><i aria-hidden="true" />{row.hasRole ? 'Role assigned' : 'Needs a role'}</span>
                  {!row.employee_id && <small>Not linked</small>}
                </span>
                <span className="users-manage-label">Manage <ChevronDown size={15} aria-hidden="true" /></span>
              </summary>
              <div className="users-expanded">{children(row)}</div>
            </details>
          ))}
          {shown.length === 0 && <div className="users-empty"><Search size={28} /><h3>{rows.length ? 'No matching accounts' : 'No user accounts yet'}</h3>
            <p>{rows.length ? 'Try another name or clear the company, role and status filters.' : 'Give an employee app access to create their account and assign a role.'}</p>
            {activeFilters > 0 && <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>}
          </div>}
        </div>
        {pager.totalPages > 1 && <Pagination {...pager} noun="accounts" sizes={[10, 25, 50, 100]} disabled={busy} className="users-pagination users-pagination-bottom" />}
      </section>
    </div>
  );
}

function Filter({ label, value, onChange, disabled, children }) {
  return <label className="users-filter"><span>{label}</span><select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{children}</select></label>;
}
