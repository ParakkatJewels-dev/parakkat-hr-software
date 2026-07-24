import React, { useState, useMemo } from 'react';
import {
  Search, Filter, Mail, Phone, Calendar, User, ArrowLeft, ArrowRight, X, Building2, Loader2, AlertTriangle,
  List, LayoutGrid, Download, ArrowUpDown, ShieldAlert, Award, Briefcase, Plus, Pencil
} from 'lucide-react';
import { useEmployees, useCreateEmployee, useUpdateEmployee } from '../data/employees';
import { useOrg } from '../data/org';
import { usePermissions } from '../auth/usePermissions';
import { EmployeeOrgFields } from './EmployeeOrgFields';

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

export default function Directory() {
  const { data: employees = [], isLoading, error } = useEmployees();
  const { data: org } = useOrg();
  const { canAny } = usePermissions();
  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();
  const canCreate = canAny('employee.create');
  const canUpdate = canAny('employee.update');
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...emp} = edit

  const [search, setSearch] = useState('');
  const [selectedEntity, setSelectedEntity] = useState('All Entities');
  const [selectedStatus, setSelectedStatus] = useState('All Statuses');
  const [selectedDept, setSelectedDept] = useState('All Departments');
  const [selectedBranch, setSelectedBranch] = useState('All Branches');
  const [sortBy, setSortBy] = useState('name-asc');
  const [viewMode, setViewMode] = useState('list'); // Default to 'list' for high density
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedEmp, setSelectedEmp] = useState(null);
  
  const itemsPerPage = viewMode === 'list' ? 15 : 12;

  const entityOptions = useMemo(
    () => ['All Entities', ...new Set(employees.map((e) => e.entity?.name).filter(Boolean))],
    [employees]
  );
  const statusOptions = useMemo(
    () => ['All Statuses', ...new Set(employees.map((e) => e.status).filter(Boolean))],
    [employees]
  );
  const departmentOptions = useMemo(
    () => ['All Departments', ...new Set(employees.map((e) => e.department?.name).filter(Boolean))],
    [employees]
  );
  const branchOptions = useMemo(
    () => ['All Branches', ...new Set(employees.map((e) => e.branch?.name || e.branch?.code).filter(Boolean))],
    [employees]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
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
  }, [employees, search, selectedEntity, selectedStatus, selectedDept, selectedBranch]);

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
  }, [search, selectedEntity, selectedStatus, selectedDept, selectedBranch, sortBy, viewMode]);

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
      <div className="page-shell flex items-center justify-center py-24 text-gold-500">
        <Loader2 size={26} className="animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-shell space-y-4 animate-fade-in">
        <Header count={0} />
        <div className="glass-panel p-5 rounded-2xl flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
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

  return (
    <div className="page-shell space-y-5 animate-slide-up">
      {/* Header and Toolbar actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <Header count={filtered.length} />
        <div className="flex items-center justify-between sm:justify-end gap-2.5 w-full sm:w-auto">
          {/* View toggle switcher */}
          <div className="flex items-center bg-neutral-105 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-855 rounded-xl p-0.5 shadow-sm">
            <button
              onClick={() => setViewMode('list')}
              className={`p-2 rounded-lg transition-all ${
                viewMode === 'list'
                  ? 'bg-white dark:bg-charcoal-800 text-neutral-900 dark:text-[#dfbd62] shadow-xs'
                  : 'text-neutral-500 hover:text-neutral-850 dark:hover:text-warm-gray-200'
              }`}
              title="Table View"
            >
              <List size={14} />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-2 rounded-lg transition-all ${
                viewMode === 'grid'
                  ? 'bg-white dark:bg-charcoal-800 text-neutral-900 dark:text-[#dfbd62] shadow-xs'
                  : 'text-neutral-500 hover:text-neutral-850 dark:hover:text-warm-gray-200'
              }`}
              title="Grid Cards View"
            >
              <LayoutGrid size={14} />
            </button>
          </div>
          {/* Export action */}
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 bg-neutral-105 dark:bg-charcoal-900 hover:bg-neutral-200 dark:hover:bg-charcoal-800 text-neutral-700 dark:text-warm-gray-200 border border-neutral-200 dark:border-neutral-855 rounded-xl text-xs font-semibold shadow-xs transition-all cursor-pointer"
            title="Export csv"
          >
            <Download size={13} />
            <span>Export CSV</span>
          </button>
          {/* Add employee */}
          {canCreate && (
            <button
              onClick={() => setEditing({})}
              className="flex items-center gap-2 px-3 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 hover:opacity-90 text-white rounded-xl text-xs font-semibold shadow-md transition-all cursor-pointer"
            >
              <Plus size={13} />
              <span>Add Employee</span>
            </button>
          )}
        </div>
      </div>

      {/* Advanced search, filters and sort controls */}
      <div className="premium-card p-4 space-y-3.5">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3.5">
          {/* Search Input */}
          <div className="relative md:col-span-8">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500" size={15} />
            <input
              type="text"
              placeholder="Search employee name, code, designation, or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-neutral-50/50 dark:bg-charcoal-900/60 border border-neutral-200/80 dark:border-neutral-855 rounded-xl pl-10 pr-4 py-2 text-xs text-neutral-850 dark:text-neutral-100 placeholder-neutral-450 focus:outline-none focus:border-neutral-400 dark:focus:border-gold-500/30 transition-all shadow-inner"
            />
          </div>

          {/* Sort Selection */}
          <div className="flex items-center space-x-2 bg-neutral-50/50 dark:bg-charcoal-900/60 border border-neutral-200/80 dark:border-neutral-855 rounded-xl px-3 py-2 text-xs text-neutral-700 dark:text-neutral-350 md:col-span-4">
            <ArrowUpDown size={12} className="text-neutral-455 shrink-0" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="w-full bg-transparent border-none focus:outline-none cursor-pointer font-semibold"
            >
              <option value="name-asc" className="bg-white dark:bg-black">Sort by: Name (A-Z)</option>
              <option value="name-desc" className="bg-white dark:bg-black">Sort by: Name (Z-A)</option>
              <option value="code-asc" className="bg-white dark:bg-black">Sort by: Employee ID</option>
              <option value="join-date" className="bg-white dark:bg-black">Sort by: Date Joined</option>
            </select>
          </div>
        </div>

        {/* Dropdown Filters Grid / Line */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-neutral-100 dark:border-neutral-850 sm:flex sm:flex-wrap sm:items-center sm:gap-2.5">
          <div className="flex items-center space-x-1.5 bg-neutral-50/80 dark:bg-charcoal-900/50 border border-neutral-250/50 dark:border-neutral-855 rounded-xl px-3 py-1.5 text-xs text-neutral-750 dark:text-neutral-300 w-full sm:w-auto">
            <Filter size={11} className="text-neutral-455 shrink-0" />
            <select
              value={selectedEntity}
              onChange={(e) => setSelectedEntity(e.target.value)}
              className="bg-transparent border-none focus:outline-none cursor-pointer font-medium w-full sm:max-w-[140px]"
            >
              {entityOptions.map((o) => (
                <option key={o} value={o} className="bg-white dark:bg-black">{o}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center space-x-1.5 bg-neutral-50/80 dark:bg-charcoal-900/50 border border-neutral-250/50 dark:border-neutral-855 rounded-xl px-3 py-1.5 text-xs text-neutral-755 dark:text-neutral-300 w-full sm:w-auto">
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              className="bg-transparent border-none focus:outline-none cursor-pointer font-medium w-full sm:max-w-[140px]"
            >
              {branchOptions.map((o) => (
                <option key={o} value={o} className="bg-white dark:bg-black">{o}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center space-x-1.5 bg-neutral-50/80 dark:bg-charcoal-900/50 border border-neutral-250/50 dark:border-neutral-855 rounded-xl px-3 py-1.5 text-xs text-neutral-755 dark:text-neutral-300 w-full sm:w-auto">
            <select
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
              className="bg-transparent border-none focus:outline-none cursor-pointer font-medium w-full sm:max-w-[145px]"
            >
              {departmentOptions.map((o) => (
                <option key={o} value={o} className="bg-white dark:bg-black">{o}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center space-x-1.5 bg-neutral-50/80 dark:bg-charcoal-900/50 border border-neutral-250/50 dark:border-neutral-855 rounded-xl px-3 py-1.5 text-xs text-neutral-755 dark:text-neutral-300 w-full sm:w-auto">
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="bg-transparent border-none focus:outline-none cursor-pointer font-medium w-full"
            >
              {statusOptions.map((o) => (
                <option key={o} value={o} className="bg-white dark:bg-black">{o}</option>
              ))}
            </select>
          </div>

          {/* Reset Filters button */}
          {(selectedEntity !== 'All Entities' || selectedStatus !== 'All Statuses' || selectedDept !== 'All Departments' || selectedBranch !== 'All Branches' || search !== '') && (
            <button
              onClick={() => {
                setSearch('');
                setSelectedEntity('All Entities');
                setSelectedStatus('All Statuses');
                setSelectedDept('All Departments');
                setSelectedBranch('All Branches');
              }}
              className="text-[10.5px] font-bold text-red-500 hover:text-red-700 transition-colors col-span-2 sm:ml-auto cursor-pointer flex items-center justify-center sm:justify-start gap-1 py-1.5 sm:py-0"
            >
              <X size={12} /> Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* Main Listings */}
      {viewMode === 'list' ? (
        /* High Density Table View */
        <div className="premium-card overflow-hidden shadow-xs border border-neutral-200/80 dark:border-neutral-850 rounded-2xl">
          <div className="overflow-x-auto">
            <table className="premium-table">
              <thead>
                <tr>
                  <th className="w-24 hidden lg:table-cell">Employee ID</th>
                  <th>Name & Title</th>
                  <th className="hidden sm:table-cell">Location</th>
                  <th className="hidden md:table-cell">Department</th>
                  <th className="hidden lg:table-cell">Corporate Email</th>
                  <th className="hidden xl:table-cell">Entity</th>
                  <th className="text-center w-24">Status</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((emp) => (
                  <tr
                    key={emp.id}
                    onClick={() => setSelectedEmp(emp)}
                    className="cursor-pointer group hover:bg-neutral-50/50 dark:hover:bg-charcoal-900/40 transition-colors"
                  >
                    <td className="font-mono text-xs text-neutral-600 dark:text-warm-gray-400 py-3 hidden lg:table-cell">
                      {emp.employee_code || '—'}
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        {/* Avatar */}
                        <div className="w-8 h-8 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-800 dark:text-gold-300 flex items-center justify-center font-bold text-xs shrink-0 font-mono group-hover:bg-neutral-900 group-hover:text-white dark:group-hover:bg-white dark:group-hover:text-black transition-all duration-200">
                          {initials(emp.full_name)}
                        </div>
                        <div className="min-w-0">
                          <span className="block text-xs font-bold text-neutral-800 dark:text-warm-gray-150 group-hover:text-black dark:group-hover:text-white truncate">{emp.full_name}</span>
                          <span className="block text-[10px] text-neutral-455 dark:text-neutral-500 mt-0.5 truncate">{emp.designation?.title || 'No designation'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="text-xs text-neutral-600 dark:text-warm-gray-455 py-3 hidden sm:table-cell">
                      {emp.branch ? `${emp.branch.name || emp.branch.code}` : '—'}
                    </td>
                    <td className="text-xs text-neutral-600 dark:text-warm-gray-455 py-3 hidden md:table-cell">
                      {emp.department?.name || '—'}
                    </td>
                    <td className="text-xs text-neutral-600 dark:text-warm-gray-405 font-mono py-3 truncate max-w-[180px] hidden lg:table-cell">
                      {emp.email || '—'}
                    </td>
                    <td className="text-xs text-neutral-500 dark:text-neutral-455 py-3 truncate max-w-[120px] hidden xl:table-cell">
                      {emp.entity?.name || '—'}
                    </td>
                    <td className="py-3 text-center">
                      <span className={`text-[8.5px] inline-block px-2 py-0.5 rounded-full font-bold font-mono tracking-wider uppercase leading-none ${statusClass(emp.status)}`}>
                        {emp.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Grid Card View */
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {paginated.map((emp) => (
            <div
              key={emp.id}
              onClick={() => setSelectedEmp(emp)}
              className="premium-card p-4 hover:border-neutral-350 dark:hover:border-gold-500/35 cursor-pointer group flex flex-col justify-between hover:-translate-y-0.5 transition-all duration-300"
            >
              <div>
                <div className="flex items-start justify-between">
                  <div className="w-10 h-10 rounded-xl bg-neutral-100 dark:bg-charcoal-800 text-neutral-800 dark:text-gold-300 flex items-center justify-center font-bold text-xs shrink-0 group-hover:bg-neutral-900 group-hover:text-white dark:group-hover:bg-white dark:group-hover:text-black transition-all duration-300 font-mono shadow-inner border border-neutral-200/50 dark:border-neutral-800/80">
                    {initials(emp.full_name)}
                  </div>
                  <span className={`text-[8.5px] px-2 py-0.5 rounded-full font-bold font-mono tracking-wider uppercase ${statusClass(emp.status)}`}>
                    {emp.status}
                  </span>
                </div>
                <div className="mt-4">
                  <h4 className="font-bold text-neutral-855 dark:text-warm-gray-105 text-xs truncate group-hover:text-neutral-950 dark:group-hover:text-white transition-colors">
                    {emp.full_name}
                  </h4>
                  <span className="text-neutral-500 text-[10px] block mt-0.5 truncate font-semibold">
                    {emp.designation?.title || 'No designation'}
                  </span>
                </div>
              </div>
              <div className="border-t border-neutral-100 dark:border-neutral-855/60 pt-2.5 mt-4 flex items-center justify-between text-[10px] text-neutral-505 font-semibold font-mono">
                <span>{emp.employee_code || '—'}</span>
                <span>{emp.branch?.code || emp.entity?.code || '—'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty Results view */}
      {filtered.length === 0 && (
        <div className="text-center py-16 premium-card p-8">
          <User size={32} className="mx-auto text-neutral-400 dark:text-neutral-600 mb-2.5 opacity-55" />
          <h4 className="text-xs uppercase font-bold tracking-wider text-neutral-550 mb-1">
            {employees.length === 0 ? 'No employees visible to you yet' : 'No records match your filters'}
          </h4>
          <p className="text-[11px] text-neutral-400 max-w-sm mx-auto">
            {employees.length === 0
              ? 'Run the database import script, or check your HR role scopes.'
              : 'Try checking your spellings or clearing active filters.'}
          </p>
        </div>
      )}

      {/* Pagination component */}
      {filtered.length > itemsPerPage && (
        <div className="flex justify-between items-center bg-white dark:bg-charcoal-900/40 border border-neutral-200/80 dark:border-neutral-855 p-3 rounded-xl shadow-xs">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-105 dark:bg-charcoal-800 hover:bg-neutral-200 dark:hover:bg-charcoal-700 disabled:opacity-50 text-[10.5px] font-bold rounded-lg text-neutral-700 dark:text-warm-gray-200 cursor-pointer disabled:cursor-not-allowed transition-all"
          >
            <ArrowLeft size={11} /> <span>Previous</span>
          </button>
          <span className="text-[10px] text-neutral-505 dark:text-neutral-455 font-bold font-mono">Page {currentPage} of {totalPages}</span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-105 dark:bg-charcoal-800 hover:bg-neutral-200 dark:hover:bg-charcoal-700 disabled:opacity-50 text-[10.5px] font-bold rounded-lg text-neutral-700 dark:text-warm-gray-200 cursor-pointer disabled:cursor-not-allowed transition-all"
          >
            <span>Next</span> <ArrowRight size={11} />
          </button>
        </div>
      )}

      {/* Profile drawer component */}
      {selectedEmp && (
        <ProfileDrawer
          emp={selectedEmp}
          onClose={() => setSelectedEmp(null)}
          onEdit={canUpdate ? () => { setEditing(selectedEmp); setSelectedEmp(null); } : null}
        />
      )}

      {/* Create / edit employee */}
      {editing && (
        <EmployeeFormModal
          employee={editing.id ? editing : null}
          org={org}
          busy={createEmployee.isPending || updateEmployee.isPending}
          error={createEmployee.error?.message || updateEmployee.error?.message}
          onClose={() => { createEmployee.reset(); updateEmployee.reset(); setEditing(null); }}
          onSubmit={async (payload) => {
            try {
              if (editing.id) await updateEmployee.mutateAsync({ id: editing.id, ...payload });
              else await createEmployee.mutateAsync(payload);
              setEditing(null);
            } catch { /* shown in modal */ }
          }}
        />
      )}
    </div>
  );
}

const FORM_INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-855 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-gold-500 transition-colors';
const EMP_STATUSES = ['Active', 'Probation', 'On Leave', 'Inactive'];

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
  }));
  const patch = (p) => setForm((f) => ({ ...f, ...p }));
  const canSubmit = form.full_name.trim() && form.entity_id;

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
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
    });
  };

  const L = 'block text-[11px] font-semibold text-neutral-600 dark:text-neutral-300 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-fade-in" onClick={onClose}>
      <div className="w-full max-w-lg bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-gold-500/15 rounded-2xl shadow-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold flex items-center gap-2">
            {isEdit ? <><Pencil size={15} className="text-gold-500" /> Edit employee</> : <><Plus size={15} className="text-gold-500" /> Add employee</>}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-charcoal-800 cursor-pointer"><X size={15} /></button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={L}>Full name *</label>
              <input className={FORM_INPUT} value={form.full_name} onChange={(e) => patch({ full_name: e.target.value })} placeholder="e.g. Anita Rao" required />
            </div>
            <div>
              <label className={L}>Employee code</label>
              <input className={FORM_INPUT} value={form.employee_code} onChange={(e) => patch({ employee_code: e.target.value })} placeholder="e.g. PPI-0243" />
            </div>
            <div>
              <label className={L}>Email</label>
              <input type="email" className={FORM_INPUT} value={form.email} onChange={(e) => patch({ email: e.target.value })} placeholder="name@parakkatjewels.com" />
            </div>
            <div>
              <label className={L}>Phone</label>
              <input className={FORM_INPUT} value={form.phone} onChange={(e) => patch({ phone: e.target.value })} placeholder="+91…" />
            </div>
            <div>
              <label className={L}>Join date</label>
              <input type="date" className={FORM_INPUT} value={form.join_date || ''} onChange={(e) => patch({ join_date: e.target.value })} />
            </div>
            <div>
              <label className={L}>Status</label>
              <select className={FORM_INPUT} value={form.status} onChange={(e) => patch({ status: e.target.value })}>
                {EMP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="pt-1 border-t border-neutral-100 dark:border-neutral-855">
            <p className="text-[10px] uppercase tracking-wider font-bold text-neutral-400 mt-2 mb-2">Placement</p>
            <EmployeeOrgFields org={org} value={form} onChange={patch} inputClass={FORM_INPUT} labelClass={L} />
          </div>

          {error && (
            <p className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">{error}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
            <button type="submit" disabled={busy || !canSubmit}
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-2 rounded-lg cursor-pointer bg-black text-white dark:bg-gold-450 dark:text-charcoal-900 hover:opacity-90 disabled:opacity-60">
              {busy ? <Loader2 size={13} className="animate-spin" /> : (isEdit ? <Pencil size={13} /> : <Plus size={13} />)} {isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Header({ count }) {
  return (
    <div>
      <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Employee Directory</h2>
      <p className="text-[11px] text-neutral-450 dark:text-neutral-500 mt-0.5">
        {count} {count === 1 ? 'profile' : 'profiles'} visible to you — scoped by company hierarchy.
      </p>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between border-t border-neutral-100 dark:border-neutral-905 pt-2 text-[11px]">
      <span className="text-neutral-455 font-medium">{label}</span>
      <span className="text-neutral-800 dark:text-warm-gray-200 font-semibold text-right">{value || '—'}</span>
    </div>
  );
}

function ProfileDrawer({ emp, onClose, onEdit }) {
  const salary = emp.salary || null;
  const [activeTab, setActiveTab] = useState('overview'); // 'overview', 'work', 'compensation'
  const [copiedEmail, setCopiedEmail] = useState(false);

  const handleCopyEmail = () => {
    if (emp.email) {
      navigator.clipboard.writeText(emp.email);
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 2000);
    }
  };

  // Compensation segments calculation
  const ctcVal = salary?.ctc ? Number(salary.ctc) : 0;
  const baseVal = salary?.base ? Number(salary.base) * 12 : 0; // Annualized base
  const basePercent = ctcVal > 0 ? Math.round((baseVal / ctcVal) * 100) : 60;
  const hraPercent = Math.round((100 - basePercent) * 0.5);
  const allowancesPercent = 100 - basePercent - hraPercent;

  return (
    <>
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-neutral-950/70 backdrop-blur-xs z-40 animate-fade-in" 
        onClick={onClose} 
      />
      {/* Drawer */}
      <div
        className="fixed inset-y-0 right-0 w-full sm:max-w-md bg-white dark:bg-charcoal-900 border-l border-neutral-200 dark:border-gold-500/15 p-4 sm:p-5 flex flex-col justify-between overflow-hidden animate-slide-up shadow-2xl z-50"
      >
        <div className="flex-1 flex flex-col min-h-0">
          {/* Edit + close buttons */}
          <div className="absolute top-5 right-5 flex items-center gap-2">
            {onEdit && (
              <button
                onClick={onEdit}
                title="Edit employee"
                className="p-1.5 hover:bg-neutral-100 dark:hover:bg-charcoal-800 rounded-lg text-neutral-450 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-warm-gray-100 transition-colors border border-neutral-200/50 dark:border-neutral-800 cursor-pointer"
              >
                <Pencil size={14} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-neutral-100 dark:hover:bg-charcoal-800 rounded-lg text-neutral-450 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-warm-gray-100 transition-colors border border-neutral-200/50 dark:border-neutral-800 cursor-pointer"
            >
              <X size={15} />
            </button>
          </div>

          {/* Header section */}
          <div className="flex items-center space-x-3.5 border-b border-neutral-150 dark:border-neutral-855 pb-4 pr-20">
            <div className="w-12 h-12 rounded-xl bg-black dark:bg-[#dfbd62] text-white dark:text-charcoal-900 flex items-center justify-center font-bold text-base font-mono shadow-md">
              {initials(emp.full_name)}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-neutral-900 dark:text-white truncate leading-snug">{emp.full_name}</h3>
              <span className="text-neutral-500 dark:text-neutral-400 text-xs block truncate mt-0.5 font-medium">{emp.designation?.title || 'No designation'}</span>
              <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                <span className="text-[9px] px-2 py-0.2 bg-neutral-100 dark:bg-charcoal-800 text-neutral-600 dark:text-warm-gray-300 rounded font-mono font-bold border border-neutral-200/50 dark:border-neutral-800">
                  {emp.employee_code || '—'}
                </span>
                <span className={`text-[8px] px-1.5 py-0.2 rounded font-bold font-mono uppercase leading-none ${statusClass(emp.status)}`}>
                  {emp.status}
                </span>
              </div>
            </div>
          </div>

          {/* Drawer tab switcher */}
          <div className="flex space-x-4 mt-4 border-b border-neutral-105 dark:border-neutral-855 pb-2">
            <button
              onClick={() => setActiveTab('overview')}
              className={`drawer-tab ${activeTab === 'overview' ? 'drawer-tab-active' : ''}`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab('work')}
              className={`drawer-tab ${activeTab === 'work' ? 'drawer-tab-active' : ''}`}
            >
              Work Details
            </button>
            <button
              onClick={() => setActiveTab('compensation')}
              className={`drawer-tab ${activeTab === 'compensation' ? 'drawer-tab-active' : ''}`}
            >
              Compensation
            </button>
          </div>

          {/* Drawer tabs content */}
          <div className="flex-1 overflow-y-auto mt-4 pr-1 min-h-0 space-y-4">
            {activeTab === 'overview' && (
              <div className="space-y-4 animate-fade-in">
                {/* Contact information card */}
                <div className="premium-card p-3.5 space-y-3 bg-neutral-50/40 dark:bg-charcoal-900/10">
                  <span className="text-[9.5px] uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 block">Contact Information</span>
                  <div className="space-y-3 text-neutral-700 dark:text-neutral-355">
                    <div className="flex items-center justify-between gap-2 border-b border-neutral-100 dark:border-neutral-855/60 pb-2">
                      <div className="flex items-center space-x-2.5 text-xs font-semibold truncate">
                        <Mail size={12} className="text-neutral-455 shrink-0" />
                        <span className="truncate">{emp.email || '—'}</span>
                      </div>
                      {emp.email && (
                        <button 
                          onClick={handleCopyEmail}
                          className="text-[9.5px] font-bold text-neutral-500 hover:text-black dark:hover:text-[#dfbd62] px-1.5 py-0.5 bg-neutral-100 dark:bg-charcoal-800 rounded transition-all cursor-pointer select-none shrink-0"
                        >
                          {copiedEmail ? 'Copied' : 'Copy'}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center space-x-2.5 text-xs font-semibold py-1">
                      <Phone size={12} className="text-neutral-455 shrink-0" />
                      <span>{emp.phone || '—'}</span>
                    </div>
                  </div>
                </div>

                {/* Important dates card */}
                <div className="premium-card p-3.5 space-y-2 bg-neutral-50/40 dark:bg-charcoal-900/10">
                  <span className="text-[9.5px] uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 block">Corporate Timeline</span>
                  <div className="flex items-center gap-2.5 text-xs font-semibold text-neutral-700 dark:text-neutral-355">
                    <Calendar size={12} className="text-neutral-450 shrink-0" />
                    <span>Hired / Joined on: <span className="font-mono text-neutral-900 dark:text-white font-bold ml-1">{emp.join_date || '—'}</span></span>
                  </div>
                </div>

                {/* Quick actions card */}
                <div className="premium-card p-3.5 space-y-2.5 bg-neutral-50/40 dark:bg-charcoal-900/10">
                  <span className="text-[9.5px] uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 block">Actions</span>
                  <div className="flex flex-col sm:flex-row gap-2">
                    {emp.email && (
                      <a 
                        href={`mailto:${emp.email}`}
                        className="w-full sm:flex-1 text-center py-2 bg-neutral-100 hover:bg-neutral-200 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 text-neutral-800 dark:text-warm-gray-200 font-bold rounded-lg text-[10.5px] transition-all cursor-pointer"
                      >
                        Email Employee
                      </a>
                    )}
                    <button 
                      onClick={() => alert('Opening workspace chat (mock)...')}
                      className="w-full sm:flex-1 py-2 bg-neutral-100 hover:bg-neutral-200 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 text-neutral-800 dark:text-warm-gray-200 font-bold rounded-lg text-[10.5px] transition-all cursor-pointer"
                    >
                      Ping on Chat
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'work' && (
              <div className="space-y-4 animate-fade-in">
                {/* Visual Connected Org Hierarchy Card */}
                <div className="premium-card p-4 space-y-4 bg-neutral-50/40 dark:bg-charcoal-900/10">
                  <span className="text-[9.5px] uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 flex items-center gap-1.5">
                    <Building2 size={11} /> Org Hierarchy Flow
                  </span>
                  
                  <div className="pl-2 space-y-3 relative before:absolute before:left-[17px] before:top-2 before:bottom-2 before:w-0.5 before:bg-neutral-200 dark:before:bg-charcoal-800">
                    {/* Entity block */}
                    <div className="flex items-center gap-3 relative z-10">
                      <div className="w-9 h-9 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-800 dark:text-gold-300 flex items-center justify-center font-bold text-xs shrink-0 select-none shadow-sm border border-neutral-250/20 dark:border-neutral-750">
                        Ent
                      </div>
                      <div className="min-w-0">
                        <span className="block text-[10px] text-neutral-455 dark:text-neutral-500 uppercase font-bold tracking-wide leading-none">Entity</span>
                        <span className="block text-xs font-bold text-neutral-855 dark:text-warm-gray-150 truncate mt-1">{emp.entity?.name || '—'}</span>
                      </div>
                    </div>

                    {/* Branch block */}
                    <div className="flex items-center gap-3 relative z-10">
                      <div className="w-9 h-9 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-800 dark:text-gold-300 flex items-center justify-center font-bold text-xs shrink-0 select-none shadow-sm border border-neutral-250/20 dark:border-neutral-750">
                        Loc
                      </div>
                      <div className="min-w-0">
                        <span className="block text-[10px] text-neutral-455 dark:text-neutral-500 uppercase font-bold tracking-wide leading-none">Location / Branch</span>
                        <span className="block text-xs font-bold text-neutral-855 dark:text-warm-gray-150 truncate mt-1">{emp.branch ? `${emp.branch.name || emp.branch.code}` : 'Entity-Wide'}</span>
                      </div>
                    </div>

                    {/* Department block */}
                    <div className="flex items-center gap-3 relative z-10">
                      <div className="w-9 h-9 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-800 dark:text-gold-300 flex items-center justify-center font-bold text-xs shrink-0 select-none shadow-sm border border-neutral-250/20 dark:border-neutral-750">
                        Dep
                      </div>
                      <div className="min-w-0">
                        <span className="block text-[10px] text-neutral-455 dark:text-neutral-505 uppercase font-bold tracking-wide leading-none">Department</span>
                        <span className="block text-xs font-bold text-neutral-855 dark:text-warm-gray-150 truncate mt-1">{emp.department?.name || '—'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Job Info card */}
                <div className="premium-card p-4 space-y-3 bg-neutral-50/40 dark:bg-charcoal-900/10">
                  <span className="text-[9.5px] uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 flex items-center gap-1.5">
                    <Briefcase size={11} /> Employment Details
                  </span>
                  <div className="space-y-2.5">
                    <Row label="Role Designation" value={emp.designation?.title} />
                    <Row label="Grade Level" value={emp.designation?.grade} />
                    <Row label="Employment Classification" value={emp.status} />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'compensation' && (
              <div className="space-y-4 animate-fade-in">
                {/* Compensation Package card */}
                <div className="premium-card p-4 space-y-4 bg-neutral-50/40 dark:bg-charcoal-900/10">
                  <span className="text-[9.5px] uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 flex items-center gap-1.5">
                    <Award size={11} /> Compensation Structure
                  </span>

                  {salary ? (
                    <div className="space-y-4">
                      {/* Segmented Progress Bar */}
                      <div className="space-y-1.5">
                        <div className="flex h-2.5 rounded-full overflow-hidden bg-neutral-100 dark:bg-charcoal-800">
                          <div style={{ width: `${basePercent}%` }} className="bg-[#dfbd62]" title={`Base: ${basePercent}%`} />
                          <div style={{ width: `${hraPercent}%` }} className="bg-[#6b8f89]" title={`HRA: ${hraPercent}%`} />
                          <div style={{ width: `${allowancesPercent}%` }} className="bg-[#a98b5d]" title={`Allowances: ${allowancesPercent}%`} />
                        </div>
                        
                        <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-[9px] text-neutral-455 dark:text-neutral-550 font-bold uppercase tracking-wider">
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#dfbd62]" /> Base ({basePercent}%)</span>
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#6b8f89]" /> HRA ({hraPercent}%)</span>
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#a98b5d]" /> Allowances ({allowancesPercent}%)</span>
                        </div>
                      </div>

                      {/* Numeric data list */}
                      <div className="space-y-2 pt-2 border-t border-neutral-100 dark:border-neutral-855/60 font-mono text-[11px] text-neutral-600 dark:text-warm-gray-350">
                        {salary.ctc != null && (
                          <div className="flex justify-between items-center py-1">
                            <span className="font-sans font-medium text-neutral-500">Annual CTC</span>
                            <span className="text-neutral-900 dark:text-white font-extrabold text-xs">₹{Number(salary.ctc).toLocaleString('en-IN')}</span>
                          </div>
                        )}
                        {salary.base != null && (
                          <div className="flex justify-between items-center py-1">
                            <span className="font-sans font-medium text-neutral-500">Monthly Base Salary</span>
                            <span className="text-neutral-855 dark:text-warm-gray-150 font-bold">₹{Number(salary.base).toLocaleString('en-IN')}</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center py-1">
                          <span className="font-sans font-medium text-neutral-500">HRA Allowance (Estimated)</span>
                          <span>₹{Number(Math.round(salary.base * 0.4)).toLocaleString('en-IN')}</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-6 space-y-2 bg-neutral-50/50 dark:bg-charcoal-900/20 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800">
                      <ShieldAlert size={20} className="mx-auto text-neutral-450" />
                      <p className="text-[10px] text-neutral-500">Compensation details are restricted or not loaded for this profile.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="border-t border-neutral-200/80 dark:border-neutral-850 pt-4 mt-6">
          <button
            onClick={onClose}
            className="w-full py-2.5 bg-neutral-900 hover:bg-black dark:bg-[#dfbd62] dark:text-charcoal-900 dark:hover:bg-[#dfbd62]/85 text-white rounded-xl text-xs font-bold transition-all cursor-pointer shadow-sm active:scale-99"
          >
            Close Employee Profile
          </button>
        </div>
      </div>
    </>
  );
}
