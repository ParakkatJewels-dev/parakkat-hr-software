import React, { useState, useMemo, useDeferredValue } from 'react';
import {
  Search, User, ArrowLeft, ArrowRight, X, AlertTriangle,
  List, LayoutGrid, Download, ArrowUpDown, Plus, Copy, Check, Loader2, Rows3, SlidersHorizontal,
  Users, Building2, MapPin, Briefcase, Mail, CalendarDays,
} from 'lucide-react';
import { useEmployees, useCreateEmployee, useUpdateEmployee } from '../data/employees';
import { useOrg } from '../data/org';
import { usePermissions } from '../auth/usePermissions';
import { EmployeeOrgFields } from './EmployeeOrgFields';
import ProfileDrawer from './EmployeeProfile';
import GrantAccessPanel, { grantableRoles, randomPassword } from './GrantAccessPanel';
import { useAuth } from '../auth/AuthContext';
import { useGrantAppAccess } from '../data/admin';
import { SkeletonRows } from './ui/Skeleton';
import FilterSelect from './ui/FilterSelect';
import { btnClass } from './ui/Btn';

const initials = (name) =>
  (name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase() || '?';

const statusClass = (status) =>
  status === 'Active'
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-450 border border-emerald-500/10'
    : status === 'On Leave'
    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-450 border border-amber-500/10'
    : status === 'Probation'
    ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-405 border border-blue-500/10'
    : 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-450 border border-rose-500/10';

const monthStartIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

const pct = (value, total) => (total > 0 ? Math.round((value / total) * 100) : 0);

const employeeCompleteness = (emp) => {
  const fields = [
    emp.full_name, emp.employee_code, emp.email, emp.phone, emp.join_date, emp.status,
    emp.entity?.name, emp.branch?.name || emp.branch?.code, emp.department?.name, emp.designation?.title,
  ];
  return pct(fields.filter(Boolean).length, fields.length);
};

function PeopleOverview({ employees, filtered, activeFilterCount }) {
  const active = employees.filter((e) => e.status === 'Active').length;
  const probation = employees.filter((e) => e.status === 'Probation').length;
  const onLeave = employees.filter((e) => e.status === 'On Leave').length;
  const joinedMtd = employees.filter((e) => e.join_date && e.join_date >= monthStartIso()).length;
  const noEmail = employees.filter((e) => !e.email).length;
  const noPlacement = employees.filter((e) => !e.branch_id && !e.department_id).length;
  const activeRate = pct(active, employees.length);
  const visibleRate = pct(filtered.length, employees.length);
  const topBranches = Object.entries(
    employees.reduce((m, e) => {
      const key = e.branch?.name || e.branch?.code || 'Unplaced';
      m[key] = (m[key] || 0) + 1;
      return m;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const stats = [
    { label: 'Active roster', value: active, sub: `${activeRate}% of visible scope`, icon: Users, tone: 'green' },
    { label: 'On probation', value: probation, sub: 'Needs closer follow-up', icon: Briefcase, tone: 'blue' },
    { label: 'On leave', value: onLeave, sub: 'Current status', icon: CalendarDays, tone: 'amber' },
    { label: 'Joined MTD', value: joinedMtd, sub: 'This month', icon: Building2, tone: 'violet' },
  ];

  return (
    <section className="directory-overview">
      <div className="directory-overview-copy">
        <span className="directory-eyebrow">People overview</span>
        <h2>Roster health at a glance</h2>
        <p>
          {activeFilterCount
            ? `${filtered.length} people match the current filters, covering ${visibleRate}% of your visible roster.`
            : `${employees.length} people are visible in your current role scope.`}
        </p>
        <div className="directory-overview-bars" aria-label="Largest branches">
          {topBranches.map(([branch, count]) => (
            <span key={branch}>
              <strong>{branch}</strong>
              <i style={{ width: `${pct(count, employees.length)}%` }} />
              <em>{count}</em>
            </span>
          ))}
        </div>
      </div>

      <div className="directory-overview-stats">
        {stats.map(({ label, value, sub, icon: Icon, tone }) => (
          <div key={label} className="directory-overview-stat" data-tone={tone}>
            <span><Icon size={14} /></span>
            <strong>{value}</strong>
            <small>{label}</small>
            <em>{sub}</em>
          </div>
        ))}
      </div>

      <div className="directory-overview-quality">
        <div>
          <span className="directory-eyebrow">Data quality</span>
          <strong>{noEmail + noPlacement === 0 ? 'Clean enough to work' : `${noEmail + noPlacement} records need attention`}</strong>
        </div>
        <div className="directory-quality-grid">
          <span><Mail size={12} /> {noEmail} missing email</span>
          <span><MapPin size={12} /> {noPlacement} missing placement</span>
        </div>
      </div>
    </section>
  );
}

export default function Directory() {
  const { data: employees = [], isLoading, error } = useEmployees();
  const { data: org } = useOrg();
  const { canAny, isSuperAdmin } = usePermissions();
  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();
  const grantAccess = useGrantAppAccess();
  const canCreate = canAny('employee.create');
  const canUpdate = canAny('employee.update');
  // Matches grant_app_access's own rule (0030): super admins anywhere, rbac.manage holders
  // inside their own scope. This was hardcoded to isSuperAdmin, which hid the action from the
  // entity admins and (since 0044) the managers who can actually perform it.
  const canManageAccess = isSuperAdmin || canAny('rbac.manage');
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...emp} = edit
  const [grantFor, setGrantFor] = useState(null);
  const [newLogin, setNewLogin] = useState(null); // credentials to hand over after a create+access
  // Which row to point at after coming back from the form. Cleared on a timer: it is a "here it
  // is" cue, not a selection, and leaving it on meant one row stayed highlighted all session.
  const [justSaved, setJustSaved] = useState(null);
  React.useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(null), 6000);
    return () => clearTimeout(t);
  }, [justSaved]);

  const [search, setSearch] = useState('');
  const [selectedEntity, setSelectedEntity] = useState('All Entities');
  const [selectedStatus, setSelectedStatus] = useState('All Statuses');
  const [selectedDept, setSelectedDept] = useState('All Departments');
  const [selectedBranch, setSelectedBranch] = useState('All Branches');
  const [sortBy, setSortBy] = useState('name-asc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewMode, setViewMode] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches ? 'grid' : 'list'
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedEmp, setSelectedEmp] = useState(null);
  
  const [pageSize, setPageSize] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches ? 12 : 15
  );
  const [compact, setCompact] = useState(false);
  const itemsPerPage = pageSize;

  // One pass over the roster instead of four. At 500 employees each `.map` walked the whole list
  // to fill a single dropdown; the filter bar needs all four, so it collects them together.
  const { entityOptions, statusOptions, departmentOptions, branchOptions } = useMemo(() => {
    const ents = new Set(), stats = new Set(), depts = new Set(), brs = new Set();
    for (const e of employees) {
      if (e.entity?.name) ents.add(e.entity.name);
      if (e.status) stats.add(e.status);
      if (e.department?.name) depts.add(e.department.name);
      const b = e.branch?.name || e.branch?.code;
      if (b) brs.add(b);
    }
    return {
      entityOptions: ['All Entities', ...ents],
      statusOptions: ['All Statuses', ...stats],
      departmentOptions: ['All Departments', ...depts],
      branchOptions: ['All Branches', ...brs],
    };
  }, [employees]);

  // The input updates immediately; re-filtering and re-rendering up to 120 rows is allowed to
  // lag a frame behind, so holding a key down never feels sticky.
  const deferredSearch = useDeferredValue(search);

  const filtered = useMemo(() => {
    const q = deferredSearch.toLowerCase();
    return employees.filter((emp) => {
      const matchSearch =
        !q ||
        (emp.full_name || '').toLowerCase().includes(q) ||
        (emp.employee_code || '').toLowerCase().includes(q) ||
        (emp.designation?.title || '').toLowerCase().includes(q) ||
        (emp.email || '').toLowerCase().includes(q);
      const matchEntity = selectedEntity === 'All Entities' || emp.entity?.name === selectedEntity;
      const matchStatus = selectedStatus === 'All Statuses' || emp.status === selectedStatus;
      const matchDept = selectedDept === 'All Departments' || emp.department?.name === selectedDept;
      const matchBranch = selectedBranch === 'All Branches' || (emp.branch?.name || emp.branch?.code) === selectedBranch;
      return matchSearch && matchEntity && matchStatus && matchDept && matchBranch;
    });
  }, [employees, deferredSearch, selectedEntity, selectedStatus, selectedDept, selectedBranch]);

  const sorted = useMemo(() => {
    const items = [...filtered];
    if (sortBy === 'name-asc') {
      items.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    } else if (sortBy === 'name-desc') {
      items.sort((a, b) => (b.full_name || '').localeCompare(a.full_name || ''));
    } else if (sortBy === 'code-asc') {
      items.sort((a, b) => (a.employee_code || '').localeCompare(b.employee_code || ''));
    } else if (sortBy === 'join-date') {
      items.sort((a, b) => new Date(a.join_date || 0) - new Date(b.join_date || 0));
    }
    return items;
  }, [filtered, sortBy]);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [search, selectedEntity, selectedStatus, selectedDept, selectedBranch, sortBy, viewMode, pageSize]);

  // How many dimensions are currently narrowing the list — drives the "Clear N filters" button
  // and lets the no-results state offer the right way out.
  const activeFilterCount =
    (search ? 1 : 0) +
    (selectedEntity !== 'All Entities' ? 1 : 0) +
    (selectedStatus !== 'All Statuses' ? 1 : 0) +
    (selectedDept !== 'All Departments' ? 1 : 0) +
    (selectedBranch !== 'All Branches' ? 1 : 0);

  const clearFilters = () => {
    setSearch('');
    setSelectedEntity('All Entities');
    setSelectedStatus('All Statuses');
    setSelectedDept('All Departments');
    setSelectedBranch('All Branches');
    setFiltersOpen(false);
  };

  const activeFilterChips = [
    search ? { label: 'Search', value: search, clear: () => setSearch('') } : null,
    selectedEntity !== 'All Entities' ? { label: 'Company', value: selectedEntity, clear: () => setSelectedEntity('All Entities') } : null,
    selectedBranch !== 'All Branches' ? { label: 'Branch', value: selectedBranch, clear: () => setSelectedBranch('All Branches') } : null,
    selectedDept !== 'All Departments' ? { label: 'Dept', value: selectedDept, clear: () => setSelectedDept('All Departments') } : null,
    selectedStatus !== 'All Statuses' ? { label: 'Status', value: selectedStatus, clear: () => setSelectedStatus('All Statuses') } : null,
  ].filter(Boolean);

  // Clicking a column header sorts by it, and clicking the active one flips direction — the
  // convention for any table of records. The sort dropdown stays in step.
  const toggleSort = (asc, desc) => setSortBy((s) => (s === asc ? desc : asc));

  const totalPages = Math.ceil(sorted.length / itemsPerPage) || 1;
  const paginated = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sorted.slice(start, start + itemsPerPage);
  }, [sorted, currentPage, itemsPerPage]);

  const handleExport = () => {
    const headers = ['Employee Code', 'Full Name', 'Email', 'Phone', 'Entity', 'Branch', 'Department', 'Designation', 'Status', 'Join Date'];
    const csvRows = [
      headers.join(','),
      ...sorted.map(e => [
        e.employee_code || '',
        `"${e.full_name || ''}"`,
        e.email || '',
        e.phone || '',
        `"${e.entity?.name || ''}"`,
        `"${e.branch?.name || e.branch?.code || ''}"`,
        `"${e.department?.name || ''}"`,
        `"${e.designation?.title || ''}"`,
        e.status || '',
        e.join_date || ''
      ].join(','))
    ];
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Employee_Directory_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (isLoading) {
    return (
      <div className="page-shell space-y-5">
        <Header count={0} />
        <SkeletonRows rows={8} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-shell space-y-4 animate-fade-in">
        <Header count={0} />
        <div className="premium-card p-5 flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Couldn't load employees.</p>
            <p className="text-neutral-500 dark:text-neutral-400 mt-1">
              {error.message}. Ensure Supabase is configured, migrations have run, and the import script has loaded staff.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Adding or editing someone is a task in its own right, not an annex to the list. The form is a
  // dozen fields plus a role picker — appended below the table it opened under a full page of rows
  // and the pagination controls, and nothing in the list is any use while you fill it in. So it
  // takes over the view, with a way back. Directory itself stays mounted, so filters, sort and
  // page number are exactly as you left them when you return.
  if (editing) {
    const isEdit = Boolean(editing.id);
    return (
      <div className="page-shell space-y-5 animate-fade-in">
        <div>
          <button
            onClick={() => { createEmployee.reset(); updateEmployee.reset(); grantAccess.reset(); setEditing(null); }}
            className="inline-flex items-center gap-1.5 text-sm font-bold text-neutral-500 hover:text-[#0ea971] cursor-pointer transition-colors"
          >
            <ArrowLeft size={13} /> Back to directory
          </button>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white font-sans mt-2">
            {isEdit ? `Edit ${editing.full_name}` : 'Add a person'}
          </h1>
          {/* Say what you are coming back to. The list is out of sight, so the anxious question
              is whether the filters and page you had set are still there. They are. */}
          <p className="text-xs text-neutral-400 mt-1">
            Returning to {sorted.length} {sorted.length === 1 ? 'person' : 'people'}
            {activeFilterCount > 0 ? ` · ${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} still applied` : ''}
            {totalPages > 1 ? ` · page ${currentPage}` : ''}
          </p>
          <p className="text-base text-neutral-500 dark:text-neutral-400 mt-0.5">
            {isEdit
              ? [editing.employee_code, editing.designation?.name, editing.branch?.name || editing.branch?.code]
                  .filter(Boolean).join(' · ') || 'Update their details and placement.'
              : 'Their details, where they sit, and whether they get a login — in one go.'}
          </p>
        </div>

        {/* Wide enough for the form and its summary side by side; the form column itself stays
            a readable measure because the summary takes the rest. */}
        <div className="max-w-5xl">
          <EmployeeFormModal
            employee={editing.id ? editing : null}
            org={org}
            busy={createEmployee.isPending || updateEmployee.isPending || grantAccess.isPending}
            error={createEmployee.error?.message || updateEmployee.error?.message
              || (grantAccess.error && `Employee saved, but the login could not be created: ${grantAccess.error.message}`)}
            onClose={() => { createEmployee.reset(); updateEmployee.reset(); grantAccess.reset(); setEditing(null); }}
            onSubmit={async (payload, wantAccess) => {
              try {
                if (editing.id) {
                  await updateEmployee.mutateAsync({ id: editing.id, ...payload });
                  setJustSaved(editing.id);
                  setEditing(null);
                  return;
                }
                const created = await createEmployee.mutateAsync(payload);
                setJustSaved(created.id);
                if (!wantAccess) {
                  setEditing(null);
                  return;
                }
                // The employee row exists now, so the login can be created against it in the same
                // gesture. If this half fails the employee is still saved — say so plainly rather
                // than pretending the whole thing failed and inviting a duplicate.
                await grantAccess.mutateAsync({ employee_id: created.id, ...wantAccess });
                setEditing(null);
                setNewLogin({ name: created.full_name, email: wantAccess.email, password: wantAccess.password });
              } catch { /* surfaced in the form */ }
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell space-y-5 animate-slide-up">
      {/* The one thing that must not be lost when the form closes: the password. It is shown
          once, is not recoverable, and the admin has to hand it over. */}
      {newLogin && (
        <div className="premium-card border-[#0ea971]/40 animate-fade-in">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <span className="shrink-0 w-8 h-8 rounded-xl bg-[#0ea971]/10 text-[#0ea971] flex items-center justify-center">
                <Check size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-base font-bold text-neutral-900 dark:text-white">
                  {newLogin.name} can now sign in
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  No email was sent — pass these on yourself. The password is not shown again.
                </p>
              </div>
            </div>
            <button
              onClick={() => setNewLogin(null)}
              aria-label="Dismiss the new login details"
              className="shrink-0 p-1.5 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer transition-colors"
            >
              <X size={15} />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[['Email', newLogin.email], ['Temporary password', newLogin.password]].map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between gap-2 rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-855 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-2xs uppercase tracking-wider font-bold text-neutral-400">{label}</p>
                  <p className="text-base font-mono text-neutral-800 dark:text-neutral-200 truncate">{value}</p>
                </div>
                <button
                  onClick={() => navigator.clipboard?.writeText(value)}
                  title={`Copy ${label.toLowerCase()}`}
                  aria-label={`Copy ${label.toLowerCase()}`}
                  className="shrink-0 p-1.5 rounded-lg text-neutral-400 hover:text-[#0ea971] cursor-pointer transition-colors"
                >
                  <Copy size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Give app access — inline section above the list, not an overlay */}
      {grantFor && (
        // key: without it React reuses the instance when you switch employees, so the form would
        // still hold the previous person's id/email while showing the new person's name.
        <GrantAccessPanel
          key={grantFor.id}
          employee={grantFor}
          onClose={() => setGrantFor(null)}
          onDone={() => setSelectedEmp(null)}
        />
      )}

      {/* Header and Toolbar actions */}
      <div className="directory-mobile-head flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <Header count={filtered.length} total={employees.length} />
        <div className="mobile-toolbar-actions directory-toolbar-actions flex flex-wrap items-center justify-between sm:justify-end gap-2.5 w-full sm:w-auto">
          {/* View toggle switcher */}
          <div className="directory-view-tools">
            <div className="directory-view-toggle">
              <button
                onClick={() => setViewMode('list')}
                className={`directory-view-button ${
                  viewMode === 'list'
                    ? 'is-active'
                    : ''
                }`}
                title="Table View" aria-label="Table View"
              >
                <List size={14} />
              </button>
              <button
                onClick={() => setViewMode('grid')}
                className={`directory-view-button ${
                  viewMode === 'grid'
                    ? 'is-active'
                    : ''
                }`}
                title="Grid Cards View" aria-label="Grid Cards View"
              >
                <LayoutGrid size={14} />
              </button>
            </div>
            {/* Density. Only meaningful in the table view. */}
            {viewMode === 'list' && (
              <button
                onClick={() => setCompact((v) => !v)}
                aria-pressed={compact}
                title={compact ? 'Comfortable rows' : 'Compact rows — fit more on screen'}
                aria-label={compact ? 'Switch to comfortable rows' : 'Switch to compact rows'}
                className={`directory-density-button ${compact ? 'is-active' : ''}`}
              >
                <Rows3 size={14} />
              </button>
            )}
          </div>

          <div className="directory-action-group">
            <button
              onClick={handleExport}
              className="directory-action-button directory-action-button-secondary"
              title="Export csv" aria-label="Export csv"
            >
              <Download size={13} />
              <span className="hidden sm:inline">Export CSV</span>
              <span className="sm:hidden">CSV</span>
            </button>
            {/* Add employee */}
            {canCreate && (
              <button
                onClick={() => setEditing({})}
                className="directory-action-button directory-action-button-primary"
              >
                <Plus size={13} />
                <span>Add person</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <PeopleOverview employees={employees} filtered={filtered} activeFilterCount={activeFilterCount} />

      {/* Advanced search, filters and sort controls */}
      <div className="directory-filter-shell premium-card mobile-filter-card">
        <div className="directory-filter-primary">
          {/* Search Input */}
          <div className="directory-search-control relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500" size={15} />
            <input
              type="search"
              placeholder="Search name, code, designation or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search employees"
              className="w-full bg-neutral-50/50 dark:bg-charcoal-900/60 border border-neutral-200/80 dark:border-neutral-855 rounded-xl pl-10 pr-9 py-2 text-base text-neutral-850 dark:text-neutral-100 placeholder-neutral-450 focus:outline-none focus:border-[#0ea971] focus:ring-2 focus:ring-[#0ea971]/20 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label="Clear the search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer transition-colors"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Sort. Duplicated by the sortable column headers below — kept because the grid view
              has no headers to click, and because "Date joined" is not a visible column. */}
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            className="directory-filter-button sm:hidden"
          >
            <span className="inline-flex items-center gap-1.5">
              <SlidersHorizontal size={14} /> Filters
            </span>
            <span>{activeFilterCount || '0'}</span>
          </button>

          <div className="directory-sort-control flex items-center gap-2 bg-neutral-50/50 dark:bg-charcoal-900/60 border border-neutral-200/80 dark:border-neutral-855 rounded-xl px-3 py-2">
            <ArrowUpDown size={12} className="text-neutral-450 shrink-0" />
            <label htmlFor="dir-sort" className="text-2xs font-bold uppercase tracking-wider text-neutral-400 shrink-0">
              Sort
            </label>
            <select
              id="dir-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="w-full bg-transparent border-none text-sm font-semibold text-neutral-700 dark:text-neutral-300 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50 rounded-md"
            >
              <option value="name-asc" className="bg-white dark:bg-black">Name (A–Z)</option>
              <option value="name-desc" className="bg-white dark:bg-black">Name (Z–A)</option>
              <option value="code-asc" className="bg-white dark:bg-black">Employee ID</option>
              <option value="join-date" className="bg-white dark:bg-black">Date joined</option>
            </select>
          </div>
        </div>

        <div className="directory-filter-chips mobile-active-filter-row flex flex-wrap items-center gap-1.5">
          {activeFilterChips.map((chip) => (
            <button
              key={`${chip.label}-${chip.value}`}
              type="button"
              onClick={chip.clear}
              className="active-filter-chip inline-flex items-center gap-1.5 rounded-full border border-[#0ea971]/25 bg-[#0ea971]/10 px-2.5 py-1 text-xs font-bold text-[#0c9765] dark:text-[#10b981]"
              title={`Clear ${chip.label}`}
            >
              <span className="text-2xs uppercase tracking-wider opacity-75">{chip.label}</span>
              <span className="max-w-[9rem] truncate">{chip.value}</span>
              <X size={11} />
            </button>
          ))}
          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center justify-center gap-1.5 text-xs font-bold text-neutral-500 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer py-1"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Each filter carries its own label and shows when it is narrowing the list. */}
        <div className={`directory-filter-row mobile-filter-panel ${filtersOpen ? 'is-open' : ''}`}>
          <FilterSelect label="Company" value={selectedEntity} options={entityOptions}
            onChange={setSelectedEntity} allValue="All Entities" />
          <FilterSelect label="Branch" value={selectedBranch} options={branchOptions}
            onChange={setSelectedBranch} allValue="All Branches" />
          <FilterSelect label="Dept" value={selectedDept} options={departmentOptions}
            onChange={setSelectedDept} allValue="All Departments" />
          <FilterSelect label="Status" value={selectedStatus} options={statusOptions}
            onChange={setSelectedStatus} allValue="All Statuses" />

          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="hidden sm:inline-flex items-center justify-center gap-1.5 text-sm font-bold text-neutral-500 hover:text-red-600 dark:hover:text-red-400 transition-colors sm:ml-auto cursor-pointer py-1.5"
            >
              <X size={12} /> Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>

      {/* Master-detail split: listings on the left, inline profile section on the right */}
      <div className="flex flex-col lg:flex-row gap-5 items-start">
      <div className={`flex-1 min-w-0 w-full space-y-5 ${selectedEmp ? 'hidden lg:block' : ''}`}>
      {/* Main Listings */}
      {viewMode === 'list' ? (
        /* High Density Table View */
        <div className="premium-card directory-table-card overflow-hidden shadow-xs border border-neutral-200/80 dark:border-neutral-850 rounded-2xl">
          <div className="table-scroll">
            <table className={`premium-table ${compact ? 'is-compact' : ''}`}>
              <thead>
                <tr>
                  <th className="w-24 hidden lg:table-cell">
                    <SortHeader label="Employee ID" active={sortBy === 'code-asc'} dir="asc"
                      onClick={() => setSortBy('code-asc')} />
                  </th>
                  <th>
                    <SortHeader
                      label="Name & title"
                      active={sortBy === 'name-asc' || sortBy === 'name-desc'}
                      dir={sortBy === 'name-desc' ? 'desc' : 'asc'}
                      onClick={() => toggleSort('name-asc', 'name-desc')}
                    />
                  </th>
                  <th className="hidden sm:table-cell">Location</th>
                  <th className="hidden md:table-cell">Department</th>
                  <th className={`hidden ${selectedEmp ? 'xl:table-cell' : 'lg:table-cell'}`}>Email</th>
                  <th className={`hidden ${selectedEmp ? '' : 'xl:table-cell'}`}>Company</th>
                  <th className="text-center w-24">Status</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((emp) => {
                  const open = selectedEmp?.id === emp.id;
                  return (
                    // The row is the control that opens a profile, so it has to be reachable and
                    // operable from the keyboard — it was a plain onClick, which left every
                    // profile unreachable without a mouse.
                    <tr
                      key={emp.id}
                      onClick={() => setSelectedEmp(emp)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedEmp(emp);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`Open the profile for ${emp.full_name}`}
                      aria-current={open ? 'true' : undefined}
                      className={`cursor-pointer group transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0ea971]/60 ${
                        open
                          ? 'bg-[#0ea971]/8 dark:bg-[#0ea971]/10'
                          : justSaved === emp.id
                          // Just came back from the form — show which row it was.
                          ? 'bg-[#0ea971]/10 dark:bg-[#0ea971]/12'
                          : 'hover:bg-neutral-50 dark:hover:bg-charcoal-900/40'
                      }`}
                    >
                      <td data-label="Employee ID" className="font-mono text-sm text-neutral-500 py-3 hidden lg:table-cell">
                        {emp.employee_code || '—'}
                      </td>
                      <td data-label="Name & title" className="py-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {/* Steady colours. The avatar used to invert to solid black on hover,
                              which flickered down the whole list as the pointer travelled. */}
                          <div className="avatar-cell directory-avatar w-8 h-8 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-700 dark:text-[#10b981] flex items-center justify-center font-bold text-xs shrink-0 font-mono select-none">
                            {initials(emp.full_name)}
                          </div>
                          <div className="min-w-0">
                            {/* The name is what you scan for — it leads the row. */}
                            <span className="block text-md font-bold text-neutral-900 dark:text-white truncate">
                              {emp.full_name}
                            </span>
                            <span className="row-sub block text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
                              {emp.designation?.title || 'No designation'}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td data-label="Location" className="text-sm text-neutral-600 dark:text-neutral-300 py-3 hidden sm:table-cell">
                        {emp.branch ? `${emp.branch.name || emp.branch.code}` : '—'}
                      </td>
                      <td data-label="Department" className="text-sm text-neutral-600 dark:text-neutral-300 py-3 hidden md:table-cell">
                        {emp.department?.name || '—'}
                      </td>
                      <td data-label="Email" className={`text-sm text-neutral-500 dark:text-neutral-400 py-3 truncate max-w-[180px] hidden ${selectedEmp ? 'xl:table-cell' : 'lg:table-cell'}`}>
                        {emp.email || '—'}
                      </td>
                      <td data-label="Company" className={`text-sm text-neutral-500 dark:text-neutral-400 py-3 truncate max-w-[120px] hidden ${selectedEmp ? '' : 'xl:table-cell'}`}>
                        {emp.entity?.name || '—'}
                      </td>
                      <td data-label="Status" className="py-3 text-center">
                        <span className={`text-2xs inline-block px-2 py-0.5 rounded-full font-bold tracking-wide uppercase leading-none ${statusClass(emp.status)}`}>
                          {emp.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Grid Card View */
        <div className={`directory-card-grid grid grid-cols-1 sm:grid-cols-2 gap-4 ${selectedEmp ? 'md:grid-cols-2 xl:grid-cols-3' : 'md:grid-cols-3 lg:grid-cols-4'}`}>
          {paginated.map((emp) => (
            // A real <button> rather than a clickable div: keyboard operable and announced,
            // for free. Hover changes colour only — the old -translate-y nudged every card as
            // the pointer crossed it.
            <button
              key={emp.id}
              type="button"
              onClick={() => setSelectedEmp(emp)}
              aria-label={`Open the profile for ${emp.full_name}`}
              aria-current={selectedEmp?.id === emp.id ? 'true' : undefined}
              className={`premium-card directory-person-card text-left cursor-pointer flex flex-col justify-between transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50 ${
                selectedEmp?.id === emp.id
                  ? 'border-[#0ea971]/45 bg-[#0ea971]/5'
                  : 'hover:border-neutral-300 dark:hover:border-[#0ea971]/35'
              }`}
            >
              <div className="w-full">
                <div className="mobile-list-row flex items-start justify-between gap-2">
                  <div className="directory-avatar w-10 h-10 rounded-xl bg-neutral-100 dark:bg-charcoal-800 text-neutral-700 dark:text-[#10b981] flex items-center justify-center font-bold text-sm shrink-0 font-mono select-none">
                    {initials(emp.full_name)}
                  </div>
                  <span className={`text-2xs px-2 py-0.5 rounded-full font-bold tracking-wide uppercase shrink-0 ${statusClass(emp.status)}`}>
                    {emp.status}
                  </span>
                </div>
                <div className="mt-3">
                  <h3 className="font-bold text-neutral-900 dark:text-white text-md truncate">
                    {emp.full_name}
                  </h3>
                  <p className="text-neutral-500 dark:text-neutral-400 text-xs mt-0.5 truncate">
                    {emp.designation?.title || 'No designation'}
                  </p>
                </div>
                <div className="directory-completeness" title={`Profile completeness ${employeeCompleteness(emp)}%`}>
                  <span style={{ width: `${employeeCompleteness(emp)}%` }} />
                </div>
              </div>
              {/* Where they sit — the question a card in a directory is actually asked. */}
              <div className="border-t border-neutral-100 dark:border-neutral-855/60 pt-2.5 mt-3.5 space-y-1 w-full">
                <p className="text-xs text-neutral-600 dark:text-neutral-300 truncate">
                  {emp.branch?.name || emp.branch?.code || emp.entity?.name || 'No branch'}
                  {emp.department?.name ? ` · ${emp.department.name}` : ''}
                </p>
                <p className="text-2xs font-mono text-neutral-450 truncate">
                  {emp.employee_code || 'No code'}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Two different dead ends, two different ways out: an empty directory needs someone
          added, a filtered-to-nothing one needs the filters dropped. Both offer the action
          rather than describing it. */}
      {filtered.length === 0 && (
        <div className="premium-card p-8 text-center">
          <User size={28} className="mx-auto text-neutral-300 dark:text-neutral-700" />
          {employees.length === 0 ? (
            <>
              <h3 className="text-lg font-bold text-neutral-900 dark:text-white mt-3">
                No people here yet
              </h3>
              <p className="text-base text-neutral-500 dark:text-neutral-400 mt-1 max-w-sm mx-auto">
                {canCreate
                  ? 'Add your first person, or run the roster import to bring the whole company in at once.'
                  : 'Nobody falls inside the area your role covers. An administrator can widen it.'}
              </p>
              {canCreate && (
                <button
                  onClick={() => setEditing({})}
                  className={btnClass('primary')}
                >
                  <Plus size={13} /> Add the first person
                </button>
              )}
            </>
          ) : (
            <>
              <h3 className="text-lg font-bold text-neutral-900 dark:text-white mt-3">
                Nobody matches
              </h3>
              <p className="text-base text-neutral-500 dark:text-neutral-400 mt-1 max-w-sm mx-auto">
                {search
                  ? <>No one matches “{search}”{activeFilterCount > 1 ? ' with these filters' : ''}. Check the spelling, or search by employee code instead.</>
                  : 'No one falls into every filter at once. Try widening one of them.'}
              </p>
              <button
                onClick={clearFilters}
                className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 border border-neutral-200 dark:border-neutral-800 rounded-xl text-base font-bold text-neutral-700 dark:text-neutral-200 hover:border-[#0ea971]/40 cursor-pointer transition-colors"
              >
                <X size={13} /> Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Pagination component */}
      {filtered.length > itemsPerPage && (
        <nav className="premium-card pagination-shell" aria-label="People pagination">
          <div className="pagination-summary">
            <span className="pagination-range">
              <b>{(currentPage - 1) * itemsPerPage + 1}–{Math.min(currentPage * itemsPerPage, sorted.length)}</b>
              <span>of {sorted.length} people</span>
            </span>
            <span className="pagination-page-label">Page {currentPage} of {totalPages}</span>
          </div>

          <div className="pagination-pages" aria-label="Pages">
            {/* 500 employees at 15 a page is 34 pages. Prev/Next alone means 19 clicks to reach
                page 20, so the numbers are here, with first/last and an ellipsis window. */}
            <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}
              aria-label="Previous page" className="pagination-nav-button">
              <ArrowLeft size={12} />
            </button>
            {pageWindow(currentPage, totalPages).map((n, i) =>
              n === '…' ? (
                <span key={`gap-${i}`} className="pagination-ellipsis" aria-hidden="true">…</span>
              ) : (
                <button
                  key={n}
                  onClick={() => setCurrentPage(n)}
                  aria-label={`Page ${n}`}
                  aria-current={n === currentPage ? 'page' : undefined}
                  className="pagination-number"
                >
                  {n}
                </button>
              )
            )}
            <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}
              aria-label="Next page" className="pagination-nav-button">
              <ArrowRight size={12} />
            </button>
          </div>

          <label className="pagination-size">
            <span>Per page</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
              aria-label="Rows per page"
            >
              {[15, 30, 60, 120].map((n) => <option key={n} value={n} className="bg-white dark:bg-black">{n}</option>)}
            </select>
          </label>
        </nav>
      )}

      </div>

      {/* Inline employee profile section */}
      {selectedEmp && (
        <aside className="mobile-detail-panel w-full lg:w-[24rem] xl:w-[26rem] shrink-0 lg:sticky lg:top-4">
          <ProfileDrawer
            emp={selectedEmp}
            onClose={() => setSelectedEmp(null)}
            onEdit={canUpdate ? () => { setEditing(selectedEmp); setSelectedEmp(null); } : null}
            onGrantAccess={canManageAccess ? () => setGrantFor(selectedEmp) : null}
          />
        </aside>
      )}
      </div>

    </div>
  );
}

const FORM_INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-855 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';
/** Page numbers to show: always first and last, a window around the current page, ellipses between. */
function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(total - 1, current + 1);
  if (from > 2) out.push('…');
  for (let n = from; n <= to; n++) out.push(n);
  if (to < total - 1) out.push('…');
  out.push(total);
  return out;
}

const EMP_STATUSES = ['Active', 'Probation', 'On Leave', 'Inactive'];

// The summary card's submit button sits outside the <form>, so it targets it by id.
const FORM_ID = 'employee-form';
const SUBMIT_BTN = btnClass('primary');
const CANCEL_BTN = btnClass('ghost');
function EmployeeFormModal({ employee, org, busy, error, onClose, onSubmit }) {
  const isEdit = Boolean(employee);
  const [form, setForm] = useState(() => ({
    full_name: employee?.full_name ?? '',
    employee_code: employee?.employee_code ?? '',
    email: employee?.email ?? '',
    phone: employee?.phone ?? '',
    join_date: employee?.join_date ?? '',
    status: employee?.status ?? 'Active',
    entity_id: employee?.entity_id ?? '',
    branch_id: employee?.branch_id ?? '',
    department_id: employee?.department_id ?? '',
    designation_id: employee?.designation_id ?? '',
    // Statutory and banking (migration 0047). All optional here — the form reports what is still
    // missing rather than refusing to save an incomplete person.
    date_of_birth: employee?.date_of_birth ?? '',
    gender: employee?.gender ?? '',
    father_name: employee?.father_name ?? '',
    pan: employee?.pan ?? '',
    aadhaar: employee?.aadhaar ?? '',
    uan: employee?.uan ?? '',
    esi_number: employee?.esi_number ?? '',
    bank_name: employee?.bank_name ?? '',
    bank_account: employee?.bank_account ?? '',
    bank_ifsc: employee?.bank_ifsc ?? '',
    account_holder: employee?.account_holder ?? '',
    emergency_name: employee?.emergency_name ?? '',
    emergency_phone: employee?.emergency_phone ?? '',
    emergency_relation: employee?.emergency_relation ?? '',
  }));
  const patch = (p) => setForm((f) => ({ ...f, ...p }));

  // App access, folded into this form so adding a person is one job rather than two screens.
  const { rank: myRank, permissions } = useAuth();
  const { can } = usePermissions();
  const roleOptions = useMemo(() => grantableRoles(myRank), [myRank]);

  // The narrowest placement this user can file someone under, for the blocker wording below. A
  // department head has to name a department; an entity admin only has to name the company.
  const placementNoun = useMemo(() => {
    const scopes = new Set(
      (permissions ?? []).filter((p) => p.permission === 'employee.create').map((p) => p.scope_type)
    );
    if (scopes.has('global') || scopes.has('entity')) return 'company';
    if (scopes.has('zone')) return 'zone';
    if (scopes.has('branch')) return 'branch';
    if (scopes.has('department')) return 'department';
    return 'placement';
  }, [permissions]);
  const [access, setAccess] = useState(() => ({
    // Every new person gets a login; Employee (self-service) is the default because it is what
    // most of them need — it exposes only their own attendance, leave and payslips.
    roleKey: 'employee',
    email: '',
    touched: false,
    password: randomPassword(),
  }));

  // The login email follows the employee's email until the admin types a different one.
  const accessEmail = access.touched ? access.email : form.email.trim();

  // Which placement field this role's area comes from, and whether it has been filled in.
  const accessScope = useMemo(() => {
    const preset = roleOptions.find((r) => r.key === access.roleKey);
    if (!preset || !preset.from) return { type: 'self', id: null, noun: null, missing: false };
    const noun = { department_id: 'department', branch_id: 'branch', zone_id: 'zone', entity_id: 'company' }[preset.from];
    // zone_id is not on this form — it is derived from the branch when the employee is saved.
    const id = preset.from === 'zone_id'
      ? (org?.branches ?? []).find((b) => b.id === form.branch_id)?.zone_id ?? null
      : form[preset.from] || null;
    return { type: preset.scopeType, id, noun, missing: !id };
  }, [access.roleKey, roleOptions, form, org]);

  const wantsAccess = !isEdit && roleOptions.length > 0;
  const accessReady =
    !wantsAccess || (accessEmail && access.password.length >= 6 && !accessScope.missing);

  // Will the database accept this placement from THIS user?
  //
  // The employees INSERT policy is app.has_perm('employee.create', entity, zone, branch, dept, id),
  // and has_perm matches a department-scoped grant with `scope_id = _dept` — which is NULL-blind.
  // So a department head who left the department field empty (it is optional on this form) sent
  // department_id: null, matched no grant, and got back the raw
  //   new row violates row-level security policy for table "employees"
  // after filling in the whole form. Same for a branch manager who left the branch empty.
  //
  // can() is the UI mirror of that same function, so asking it here turns a Postgres error into a
  // blocker line next to the others. It is not the security boundary — RLS still is — it just
  // means the form stops asking for something the database is going to refuse.
  const derivedZoneId =
    (org?.branches ?? []).find((b) => b.id === form.branch_id)?.zone_id ?? null;
  const placementAllowed = can('employee.create', {
    entityId: form.entity_id || null,
    zoneId: derivedZoneId,
    branchId: form.branch_id || null,
    deptId: form.department_id || null,
    employeeId: null,
  });

  const canSubmit = form.full_name.trim() && form.entity_id && accessReady && placementAllowed;

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(
      {
        full_name: form.full_name.trim(),
        employee_code: form.employee_code.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        join_date: form.join_date || null,
        status: form.status,
        entity_id: form.entity_id,
        branch_id: form.branch_id || null,
        department_id: form.department_id || null,
        designation_id: form.designation_id || null,
        date_of_birth: form.date_of_birth || null,
        gender: form.gender || null,
        father_name: form.father_name.trim() || null,
        pan: form.pan.trim() || null,
        aadhaar: form.aadhaar.trim() || null,
        uan: form.uan.trim() || null,
        esi_number: form.esi_number.trim() || null,
        bank_name: form.bank_name.trim() || null,
        bank_account: form.bank_account.trim() || null,
        bank_ifsc: form.bank_ifsc.trim() || null,
        account_holder: form.account_holder.trim() || null,
        emergency_name: form.emergency_name.trim() || null,
        emergency_phone: form.emergency_phone.trim() || null,
        emergency_relation: form.emergency_relation.trim() || null,
      },
      // Second argument: what to do about a login, once the employee row exists.
      wantsAccess
        ? {
            email: accessEmail.trim().toLowerCase(),
            password: access.password,
            role_key: access.roleKey,
            scope_type: accessScope.type,
            scope_id: accessScope.id,
          }
        : null
    );
  };

  const L = 'block text-base font-semibold text-neutral-600 dark:text-neutral-300 mb-1';

  // What the summary needs: names, not ids.
  const nameOf = (list, id, fmt = (x) => x.name) => {
    const row = (list ?? []).find((x) => x.id === id);
    return row ? fmt(row) : null;
  };
  const placement = {
    company: nameOf(org?.entities, form.entity_id),
    branch: nameOf(org?.branches, form.branch_id, (b) => b.name || b.code),
    dept: nameOf(org?.departments, form.department_id),
    designation: nameOf(org?.designations, form.designation_id, (d) => d.title || d.name),
  };
  const rolePreset = roleOptions.find((r) => r.key === access.roleKey);

  // What is still standing between this form and a saved person. Shown in the summary rather
  // than as a disabled button with no explanation.
  const blockers = [];
  if (!form.full_name.trim()) blockers.push('a full name');
  if (!form.entity_id) blockers.push('a company');
  if (wantsAccess && !accessEmail) blockers.push('a login email');
  if (wantsAccess && access.password.length < 6) blockers.push('a longer password');
  if (wantsAccess && accessScope.missing) blockers.push(`a ${accessScope.noun} for that role`);
  if (form.entity_id && !placementAllowed) blockers.push(`a ${placementNoun} you have access to`);

  return (
    // Two columns: the form on the left, and on the right a card that fills in as you type. A
    // dozen fields is a lot to hold in your head — the summary turns "did I get that right?"
    // into something you can read back before committing.
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem] gap-5 items-start">
      <form id={FORM_ID} onSubmit={submit} className="space-y-4 min-w-0">
        <FormBlock step={1} title="Who they are" hint="Name is required; the rest can follow later.">
          {/* Six fields, three even rows — paired by what they have to do with each other:
              who they are, how to reach them, when and on what terms they joined. The name used
              to span the full width, which left the join date stranded alone on the last row. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={L} htmlFor="emp-full-name">Full name *</label>
              <input id="emp-full-name" className={FORM_INPUT} value={form.full_name} onChange={(e) => patch({ full_name: e.target.value })} placeholder="e.g. Anita Rao" required autoFocus />
            </div>
            <div>
              <label className={L} htmlFor="emp-code">Employee code</label>
              <input id="emp-code" className={FORM_INPUT} value={form.employee_code} onChange={(e) => patch({ employee_code: e.target.value })} placeholder="e.g. PPI-0243" />
            </div>
            <div>
              <label className={L} htmlFor="emp-email">Email</label>
              <input id="emp-email" type="email" className={FORM_INPUT} value={form.email} onChange={(e) => patch({ email: e.target.value })} placeholder="name@parakkatjewels.com" />
            </div>
            <div>
              <label className={L} htmlFor="emp-phone">Phone</label>
              <input id="emp-phone" className={FORM_INPUT} value={form.phone} onChange={(e) => patch({ phone: e.target.value })} placeholder="+91…" />
            </div>
            <div>
              <label className={L} htmlFor="emp-join-date">Join date</label>
              <input id="emp-join-date" type="date" className={FORM_INPUT} value={form.join_date || ''} onChange={(e) => patch({ join_date: e.target.value })} />
            </div>
            <div>
              <label className={L} htmlFor="emp-status">Status</label>
              <select id="emp-status" className={FORM_INPUT} value={form.status} onChange={(e) => patch({ status: e.target.value })}>
                {EMP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </FormBlock>

        <FormBlock step={2} title="Where they sit" hint="This decides who manages them and what they can see.">
          <EmployeeOrgFields org={org} value={form} onChange={patch} inputClass={FORM_INPUT} labelClass={L} />
        </FormBlock>

        {/* Everything below is optional to SAVE but required to PAY. A person with no bank
            account and IFSC cannot be paid at all; no PAN means no Form 16; no UAN means they
            cannot appear on a PF filing. The summary card lists whatever is still missing. */}
        <FormBlock step={3} title="Pay & statutory" hint="Needed before this person can be paid or filed for. Can be filled in later.">
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={L} htmlFor="emp-bank-account">Bank account number</label>
                <input id="emp-bank-account" className={FORM_INPUT + ' font-mono'} value={form.bank_account}
                  onChange={(e) => patch({ bank_account: e.target.value })} placeholder="0000 0000 0000" />
              </div>
              <div>
                <label className={L} htmlFor="emp-ifsc">IFSC</label>
                <input id="emp-ifsc" className={FORM_INPUT + ' font-mono uppercase'} value={form.bank_ifsc}
                  onChange={(e) => patch({ bank_ifsc: e.target.value })} placeholder="SBIN0001234" />
              </div>
              <div>
                <label className={L} htmlFor="emp-bank-name">Bank</label>
                <input id="emp-bank-name" className={FORM_INPUT} value={form.bank_name}
                  onChange={(e) => patch({ bank_name: e.target.value })} placeholder="State Bank of India" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={L} htmlFor="emp-pan">PAN</label>
                <input id="emp-pan" className={FORM_INPUT + ' font-mono uppercase'} value={form.pan}
                  onChange={(e) => patch({ pan: e.target.value })} placeholder="ABCPE1234F" maxLength={10} />
              </div>
              <div>
                <label className={L} htmlFor="emp-uan">UAN <span className="font-normal text-neutral-400">(PF)</span></label>
                <input id="emp-uan" className={FORM_INPUT + ' font-mono'} value={form.uan}
                  onChange={(e) => patch({ uan: e.target.value })} placeholder="12 digits" maxLength={14} />
              </div>
              <div>
                <label className={L} htmlFor="emp-esi">ESI number</label>
                <input id="emp-esi" className={FORM_INPUT + ' font-mono'} value={form.esi_number}
                  onChange={(e) => patch({ esi_number: e.target.value })} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={L} htmlFor="emp-dob">Date of birth</label>
                <input id="emp-dob" type="date" className={FORM_INPUT} value={form.date_of_birth || ''}
                  onChange={(e) => patch({ date_of_birth: e.target.value })} />
              </div>
              <div>
                <label className={L} htmlFor="emp-gender">Gender</label>
                <select id="emp-gender" className={FORM_INPUT} value={form.gender}
                  onChange={(e) => patch({ gender: e.target.value })}>
                  <option value="">—</option>
                  {['Male', 'Female', 'Other'].map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className={L} htmlFor="emp-aadhaar">Aadhaar</label>
                <input id="emp-aadhaar" className={FORM_INPUT + ' font-mono'} value={form.aadhaar}
                  onChange={(e) => patch({ aadhaar: e.target.value })} placeholder="12 digits" maxLength={14} />
              </div>
            </div>
          </div>
        </FormBlock>

        <FormBlock step={4} title="Next of kin" hint="Who to contact in an emergency. Optional.">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={L} htmlFor="emp-emg-name">Name</label>
              <input id="emp-emg-name" className={FORM_INPUT} value={form.emergency_name}
                onChange={(e) => patch({ emergency_name: e.target.value })} />
            </div>
            <div>
              <label className={L} htmlFor="emp-emg-phone">Phone</label>
              <input id="emp-emg-phone" className={FORM_INPUT} value={form.emergency_phone}
                onChange={(e) => patch({ emergency_phone: e.target.value })} placeholder="+91…" />
            </div>
            <div>
              <label className={L} htmlFor="emp-emg-rel">Relationship</label>
              <input id="emp-emg-rel" className={FORM_INPUT} value={form.emergency_relation}
                onChange={(e) => patch({ emergency_relation: e.target.value })} placeholder="Spouse, parent…" />
            </div>
          </div>
        </FormBlock>

        {/* App access — part of adding a person, not a separate errand in another section.
            Only on create: an existing employee's access is managed from their profile, where
            you can see what they already have. */}
        {!isEdit && roleOptions.length > 0 && (
          <FormBlock step={5} title="App access" hint="Everyone added here gets a login. Pick what it lets them reach.">
                <div className="space-y-3">
                  <div>
                    <label className={L} htmlFor="emp-role">Role</label>
                    <select
                      id="emp-role"
                      className={FORM_INPUT}
                      value={access.roleKey}
                      onChange={(e) => setAccess((a) => ({ ...a, roleKey: e.target.value }))}
                    >
                      {roleOptions.map((r) => (
                        <option key={r.key} value={r.key}>{r.label}</option>
                      ))}
                    </select>
                    {/* A dropdown hides the descriptions the radio list used to show, so the one
                        that matters — what the chosen role actually reaches — stays visible. */}
                    {rolePreset?.blurb && (
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{rolePreset.blurb}</p>
                    )}
                  </div>

                  {/* The area is read off the placement fields above — no second scope picker. */}
                  <p
                    className={`text-xs rounded-xl px-3 py-2 border ${
                      accessScope.missing
                        ? 'text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/10'
                        : 'text-neutral-500 dark:text-neutral-400 border-neutral-200 dark:border-neutral-855 bg-neutral-50 dark:bg-neutral-950'
                    }`}
                  >
                    {accessScope.missing ? (
                      <>Set this person's {accessScope.noun} under <b>Where they sit</b> first — it decides what they manage.</>
                    ) : accessScope.noun ? (
                      <>This role manages their <b>{accessScope.noun}</b>, taken from step 2.</>
                    ) : (
                      <>Sees only their own records.</>
                    )}
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={L} htmlFor="emp-login-email">Login email *</label>
                      <input
                        id="emp-login-email"
                        type="email"
                        className={FORM_INPUT}
                        value={accessEmail}
                        onChange={(e) => setAccess((a) => ({ ...a, email: e.target.value, touched: true }))}
                        placeholder="name@parakkatjewels.com"
                      />
                      {!access.touched && form.email.trim() && (
                        <p className="text-2xs text-neutral-400 mt-1">Taken from the email above.</p>
                      )}
                    </div>
                    <div>
                      <label className={L} htmlFor="emp-temp-password">Temporary password</label>
                      <div className="flex gap-1.5">
                        <input
                          id="emp-temp-password"
                          className={FORM_INPUT + ' font-mono'}
                          value={access.password}
                          onChange={(e) => setAccess((a) => ({ ...a, password: e.target.value }))}
                        />
                        <button
                          type="button"
                          onClick={() => navigator.clipboard?.writeText(access.password)}
                          title="Copy password"
                          aria-label="Copy the temporary password"
                          className="shrink-0 px-2 rounded-xl border border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-[#0ea971] cursor-pointer transition-colors"
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                      <p className="text-2xs text-neutral-400 mt-1">
                        Hand this over securely. They can change it after signing in.
                      </p>
                    </div>
                  </div>
                </div>
          </FormBlock>
        )}

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
            <AlertTriangle size={14} className="text-rose-500 shrink-0 mt-0.5" />
            <p className="text-sm text-rose-600 dark:text-rose-300 break-words">{error}</p>
          </div>
        )}

        {/* Actions travel with the form on narrow screens; on wide ones the summary card carries
            its own copy so you can submit from wherever you finished reading. */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 lg:hidden">
          <button type="button" onClick={onClose} className={CANCEL_BTN}>Cancel</button>
          <button type="submit" disabled={busy || !canSubmit} className={SUBMIT_BTN}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {isEdit ? 'Save changes' : 'Create person'}
          </button>
        </div>
      </form>

      {/* Live summary. Sticky, so it stays with you as the form scrolls. */}
      <aside className="hidden lg:block lg:sticky lg:top-4 space-y-3">
        <div className="premium-card">
          <p className="text-2xs font-bold uppercase tracking-wider text-neutral-400 mb-3">
            {isEdit ? 'After saving' : 'You are adding'}
          </p>

          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center font-bold text-base font-mono shrink-0 select-none transition-colors ${
              form.full_name.trim()
                ? 'bg-[#0ea971]/12 text-[#0c9765] dark:text-[#10b981]'
                : 'bg-neutral-100 dark:bg-charcoal-800 text-neutral-400'
            }`}>
              {form.full_name.trim() ? initials(form.full_name) : '—'}
            </div>
            <div className="min-w-0">
              <p className={`text-lg font-bold truncate ${
                form.full_name.trim() ? 'text-neutral-900 dark:text-white' : 'text-neutral-400 italic font-medium'
              }`}>
                {form.full_name.trim() || 'Unnamed'}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                {placement.designation || 'No designation'}
                {form.employee_code ? ` · ${form.employee_code}` : ''}
              </p>
            </div>
          </div>

          <div className="mt-3.5 pt-3.5 border-t border-neutral-100 dark:border-neutral-855">
            <p className="text-2xs font-bold uppercase tracking-wider text-neutral-400 mb-1.5">Sits in</p>
            {placement.company ? (
              <div className="flex flex-wrap gap-1">
                {[placement.company, placement.branch, placement.dept].filter(Boolean).map((chip) => (
                  <span key={chip} className="text-xs px-2 py-0.5 rounded-lg bg-neutral-50 dark:bg-charcoal-800/60 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-200">
                    {chip}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-neutral-400 italic">Not placed yet</p>
            )}
          </div>

          {!isEdit && roleOptions.length > 0 && (
            <div className="mt-3.5 pt-3.5 border-t border-neutral-100 dark:border-neutral-855">
              <p className="text-2xs font-bold uppercase tracking-wider text-neutral-400 mb-1.5">App access</p>
              <p className="text-sm font-bold text-neutral-800 dark:text-neutral-100">{rolePreset?.label}</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{rolePreset?.blurb}</p>
              {accessEmail && (
                <p className="text-2xs font-mono text-neutral-450 mt-1.5 truncate">{accessEmail}</p>
              )}
            </div>
          )}

          {/* What still stops this person being paid. Distinct from `blockers` below, which is
              about saving the form — these do not prevent saving, they prevent payroll. */}
          {(() => {
            const gaps = [
              !(form.bank_account.trim() && form.bank_ifsc.trim()) && 'bank account',
              !form.pan.trim() && 'PAN',
              !form.uan.trim() && 'UAN',
              !form.date_of_birth && 'date of birth',
            ].filter(Boolean);
            if (!gaps.length) {
              return (
                <p className="mt-3.5 pt-3.5 border-t border-neutral-100 dark:border-neutral-855 text-xs text-[#0c9765] dark:text-[#10b981]">
                  Ready for payroll.
                </p>
              );
            }
            return (
              <div className="mt-3.5 pt-3.5 border-t border-neutral-100 dark:border-neutral-855">
                <p className="text-2xs font-bold uppercase tracking-wider text-neutral-400 mb-1">
                  Before payroll
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Still needs {gaps.join(', ')}. You can save without it.
                </p>
              </div>
            );
          })()}

          {/* Say what is missing instead of just greying the button out. */}
          {blockers.length > 0 && (
            <p className="mt-3.5 pt-3.5 border-t border-neutral-100 dark:border-neutral-855 text-xs text-amber-700 dark:text-amber-300">
              Still needs {blockers.join(', ')}.
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <button type="submit" form={FORM_ID} disabled={busy || !canSubmit} className={SUBMIT_BTN + ' w-full justify-center'}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              {isEdit ? 'Save changes' : 'Create person'}
            </button>
            <button type="button" onClick={onClose} className={CANCEL_BTN + ' w-full text-center'}>Cancel</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** One titled step of the form. Numbered so three groups read as three groups, not one wall. */
function FormBlock({ step, title, hint, children }) {
  return (
    <section className="premium-card">
      <div className="flex items-baseline gap-2.5 mb-3.5">
        <span className="shrink-0 w-5 h-5 rounded-md bg-[#0ea971]/12 text-[#0c9765] dark:text-[#10b981] text-xs font-bold flex items-center justify-center tabular-nums">
          {step}
        </span>
        <div className="min-w-0">
          <h2 className="text-md font-bold text-neutral-900 dark:text-white">{title}</h2>
          {hint && <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Header({ count, total }) {
  const filtered = total != null && count !== total;
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-[#0ea971] flex items-center gap-1.5">
        <User size={12} /> People
      </p>
      <h1 className="text-xl font-bold text-neutral-900 dark:text-white font-sans mt-1">Directory</h1>
      <p className="text-base text-neutral-500 dark:text-neutral-400 mt-0.5">
        {filtered
          ? `${count} of ${total} people match your filters.`
          : `${count} ${count === 1 ? 'person' : 'people'} visible to you — scoped by company hierarchy.`}
      </p>
    </div>
  );
}

/** A column header you can sort by, which is where people look for it first. */
function SortHeader({ label, active, dir, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
      className={`inline-flex items-center gap-1 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50 rounded ${
        active ? 'text-[#0c9765] dark:text-[#10b981]' : 'hover:text-neutral-900 dark:hover:text-white'
      }`}
    >
      {label}
      <ArrowUpDown size={10} className={active ? 'opacity-100' : 'opacity-40'} />
    </button>
  );
}
