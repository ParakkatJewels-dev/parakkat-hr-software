import React, { useState, useMemo } from 'react';
import {
  Search, Filter, Mail, Phone, Calendar, User, ArrowLeft, ArrowRight, X, Building2, Loader2, AlertTriangle,
} from 'lucide-react';
import { useEmployees } from '../data/employees';

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
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-450'
    : status === 'On Leave'
    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-450'
    : status === 'Probation'
    ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-405'
    : 'bg-rose-105 text-rose-805 dark:bg-rose-950/45 dark:text-rose-450';

export default function Directory() {
  const { data: employees = [], isLoading, error } = useEmployees();

  const [search, setSearch] = useState('');
  const [selectedEntity, setSelectedEntity] = useState('All Entities');
  const [selectedStatus, setSelectedStatus] = useState('All Statuses');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedEmp, setSelectedEmp] = useState(null);
  const itemsPerPage = 12;

  const entityOptions = useMemo(
    () => ['All Entities', ...new Set(employees.map((e) => e.entity?.name).filter(Boolean))],
    [employees]
  );
  const statusOptions = useMemo(
    () => ['All Statuses', ...new Set(employees.map((e) => e.status).filter(Boolean))],
    [employees]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return employees.filter((emp) => {
      const matchSearch =
        !q ||
        (emp.full_name || '').toLowerCase().includes(q) ||
        (emp.employee_code || '').toLowerCase().includes(q) ||
        (emp.designation?.title || '').toLowerCase().includes(q);
      const matchEntity = selectedEntity === 'All Entities' || emp.entity?.name === selectedEntity;
      const matchStatus = selectedStatus === 'All Statuses' || emp.status === selectedStatus;
      return matchSearch && matchEntity && matchStatus;
    });
  }, [employees, search, selectedEntity, selectedStatus]);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [search, selectedEntity, selectedStatus]);

  const totalPages = Math.ceil(filtered.length / itemsPerPage) || 1;
  const paginated = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filtered.slice(start, start + itemsPerPage);
  }, [filtered, currentPage]);

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
    <div className="page-shell space-y-6 animate-slide-up">
      <Header count={filtered.length} />

      {/* Search + filters */}
      <div className="premium-card p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500" size={16} />
          <input
            type="text"
            placeholder="Search name, code, or designation..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200/80 dark:border-neutral-850 rounded-xl pl-10 pr-4 py-2 text-xs text-neutral-850 dark:text-neutral-100 placeholder-neutral-450 focus:outline-none focus:border-black dark:focus:border-white transition-all"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3.5">
          <div className="flex items-center space-x-1.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200/80 dark:border-neutral-850 rounded-xl px-3 py-1.5 text-xs text-neutral-700 dark:text-neutral-350">
            <Filter size={12} className="text-neutral-450" />
            <select
              value={selectedEntity}
              onChange={(e) => setSelectedEntity(e.target.value)}
              className="bg-transparent border-none focus:outline-none cursor-pointer font-medium max-w-[180px]"
            >
              {entityOptions.map((o) => (
                <option key={o} value={o} className="bg-white dark:bg-black">{o}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center space-x-1.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200/80 dark:border-neutral-850 rounded-xl px-3 py-1.5 text-xs text-neutral-700 dark:text-neutral-350">
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="bg-transparent border-none focus:outline-none cursor-pointer font-medium"
            >
              {statusOptions.map((o) => (
                <option key={o} value={o} className="bg-white dark:bg-black">{o}</option>
              ))}
            </select>
          </div>

          <span className="text-[10px] font-mono text-neutral-450 font-semibold tracking-wider uppercase">
            {filtered.length} profiles
          </span>
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {paginated.map((emp) => (
          <div
            key={emp.id}
            onClick={() => setSelectedEmp(emp)}
            className="premium-card p-4 hover:border-black dark:hover:border-white cursor-pointer group flex flex-col justify-between"
          >
            <div>
              <div className="flex items-start justify-between">
                <div className="w-10 h-10 rounded-xl bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-800 dark:text-neutral-200 flex items-center justify-center font-bold text-xs shrink-0 group-hover:bg-black dark:group-hover:bg-white group-hover:text-white dark:group-hover:text-black transition-all duration-300 font-mono">
                  {initials(emp.full_name)}
                </div>
                <span className={`text-[8.5px] px-2 py-0.5 rounded-full font-bold font-mono tracking-wider uppercase ${statusClass(emp.status)}`}>
                  {emp.status}
                </span>
              </div>
              <div className="mt-3.5">
                <h4 className="font-bold text-neutral-850 dark:text-slate-200 text-xs truncate group-hover:text-black dark:group-hover:text-white transition-colors">
                  {emp.full_name}
                </h4>
                <span className="text-neutral-500 text-[10px] block mt-0.5 truncate">
                  {emp.designation?.title || 'No designation'}
                </span>
              </div>
            </div>
            <div className="border-t border-neutral-100 dark:border-neutral-900/60 pt-2.5 mt-4 flex items-center justify-between text-[10px] text-neutral-500">
              <span className="font-mono">{emp.employee_code || '—'}</span>
              <span className="font-mono">{emp.branch?.code || emp.entity?.code || '—'}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Empty */}
      {filtered.length === 0 && (
        <div className="text-center py-16 premium-card">
          <User size={36} className="mx-auto text-neutral-400 dark:text-neutral-600 mb-2.5 opacity-55" />
          <h4 className="text-sm font-semibold text-neutral-500">
            {employees.length === 0 ? 'No employees visible to you yet' : 'No records match your filters'}
          </h4>
          <p className="text-xs text-neutral-400 mt-0.5">
            {employees.length === 0
              ? 'Run the import script, or your role may not have visibility to any staff.'
              : 'Try widening your search or filters.'}
          </p>
        </div>
      )}

      {/* Pagination */}
      {filtered.length > itemsPerPage && (
        <div className="flex justify-between items-center bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-900 p-3.5 rounded-xl">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="flex items-center space-x-1 px-3 py-1.5 bg-neutral-50 dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 text-[11px] font-semibold rounded-lg text-neutral-700 dark:text-neutral-350 cursor-pointer disabled:cursor-not-allowed transition-all"
          >
            <ArrowLeft size={12} /> <span>Previous</span>
          </button>
          <span className="text-[11px] text-neutral-500 font-mono">Page {currentPage} of {totalPages}</span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="flex items-center space-x-1 px-3 py-1.5 bg-neutral-50 dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 text-[11px] font-semibold rounded-lg text-neutral-700 dark:text-neutral-350 cursor-pointer disabled:cursor-not-allowed transition-all"
          >
            <span>Next</span> <ArrowRight size={12} />
          </button>
        </div>
      )}

      {/* Profile drawer */}
      {selectedEmp && <ProfileDrawer emp={selectedEmp} onClose={() => setSelectedEmp(null)} />}
    </div>
  );
}

function Header({ count }) {
  return (
    <div>
      <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Employee Directory</h2>
      <p className="text-xs text-neutral-500 dark:text-slate-400">
        {count} {count === 1 ? 'profile' : 'profiles'} visible to you — scoped to your role, entity, and branch.
      </p>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between border-t border-neutral-100 dark:border-neutral-900 pt-2 text-[11px]">
      <span className="text-neutral-450">{label}</span>
      <span className="text-neutral-800 dark:text-slate-350 font-semibold text-right">{value || '—'}</span>
    </div>
  );
}

function ProfileDrawer({ emp, onClose }) {
  const salary = emp.salary || null;
  return (
    <div className="fixed inset-0 bg-neutral-950/70 backdrop-blur-xs z-50 flex justify-end animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-white dark:bg-neutral-950 border-l border-neutral-200 dark:border-neutral-900 h-full p-6 flex flex-col overflow-y-auto relative animate-slide-up shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-1.5 bg-neutral-50 dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl text-neutral-500 hover:text-black dark:hover:text-white transition-all cursor-pointer border border-neutral-200 dark:border-neutral-800"
        >
          <X size={16} />
        </button>

        <div className="space-y-6 flex-1">
          {/* header */}
          <div className="flex items-center space-x-4 border-b border-neutral-100 dark:border-neutral-900 pb-5 pr-12">
            <div className="w-14 h-14 rounded-xl bg-black dark:bg-white text-white dark:text-black flex items-center justify-center font-bold text-lg font-mono">
              {initials(emp.full_name)}
            </div>
            <div className="space-y-0.5">
              <h3 className="text-lg font-bold text-neutral-900 dark:text-slate-100">{emp.full_name}</h3>
              <span className="text-neutral-500 text-xs block">{emp.designation?.title || 'No designation'}</span>
              <div className="flex flex-wrap gap-2 pt-1">
                <span className="text-[9px] px-2 py-0.5 bg-neutral-50 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 rounded-full font-mono border border-neutral-200/80 dark:border-neutral-800">
                  {emp.employee_code || '—'}
                </span>
                <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold font-mono uppercase ${statusClass(emp.status)}`}>
                  {emp.status}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
            {/* contact */}
            <div className="space-y-3">
              <span className="text-[9px] uppercase font-bold tracking-wider text-neutral-400 block">Contact</span>
              <div className="space-y-2 text-neutral-600 dark:text-neutral-400">
                <div className="flex items-center space-x-2 text-[11px]">
                  <Mail size={13} className="text-neutral-400 shrink-0" />
                  <span className="truncate">{emp.email || '—'}</span>
                </div>
                <div className="flex items-center space-x-2 text-[11px]">
                  <Phone size={13} className="text-neutral-400 shrink-0" />
                  <span>{emp.phone || '—'}</span>
                </div>
                <div className="flex items-center space-x-2 text-[11px]">
                  <Calendar size={13} className="text-neutral-400 shrink-0" />
                  <span>Joined: {emp.join_date || '—'}</span>
                </div>
              </div>
            </div>

            {/* org placement */}
            <div className="space-y-3">
              <span className="text-[9px] uppercase font-bold tracking-wider text-neutral-400 flex items-center gap-1">
                <Building2 size={11} /> Org Placement
              </span>
              <div className="space-y-2 text-neutral-600 dark:text-neutral-400">
                <Row label="Entity" value={emp.entity?.name} />
                <Row label="Branch" value={emp.branch ? `${emp.branch.name || emp.branch.code}` : '— entity-wide —'} />
                <Row label="Department" value={emp.department?.name} />
                <Row label="Grade" value={emp.designation?.grade} />
              </div>
            </div>
          </div>

          {/* compensation — only if present (import leaves salary null) */}
          {salary && (
            <div className="space-y-3">
              <span className="text-[9px] uppercase font-bold tracking-wider text-neutral-400 block">Compensation</span>
              <div className="p-4 bg-neutral-50 dark:bg-neutral-900/40 rounded-xl border border-neutral-200 dark:border-neutral-900 space-y-1.5 text-[11px] font-mono text-neutral-600 dark:text-neutral-400">
                {salary.ctc != null && (
                  <div className="flex justify-between">
                    <span>Annual CTC</span>
                    <span className="text-neutral-900 dark:text-white font-extrabold">₹{Number(salary.ctc).toLocaleString()}</span>
                  </div>
                )}
                {salary.base != null && (
                  <div className="flex justify-between">
                    <span>Monthly Base</span>
                    <span>₹{Number(salary.base).toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-neutral-250 dark:border-neutral-900 pt-4 mt-6">
          <button
            onClick={onClose}
            className="w-full py-2 bg-neutral-900 hover:bg-neutral-800 dark:bg-neutral-100 dark:text-black dark:hover:bg-white text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
          >
            Close Profile
          </button>
        </div>
      </div>
    </div>
  );
}
