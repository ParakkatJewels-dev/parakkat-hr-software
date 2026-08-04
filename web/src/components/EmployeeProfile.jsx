// Employee profile — inline detail section shown beside the Directory list/grid (master-detail),
// not an overlay. Identity header (avatar, chips, key stats, tab switcher) stays fixed within the
// section; each tab scrolls beneath it. Shows only real record data — nothing estimated or mocked.
import React, { useState, useEffect } from 'react';
import { btnClass } from './ui/Btn';
import {
  X, Pencil, Mail, Phone, Copy, Check, Calendar, Building2, MapPin, Layers,
  Briefcase, Award, ShieldAlert, ExternalLink, KeyRound,
} from 'lucide-react';

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

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

// '3y 4m' since join_date (null when unknown / in the future).
const tenureOf = (join) => {
  if (!join) return null;
  const start = new Date(join);
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) return null;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y > 0 ? `${y}y ${m}m` : `${m}m`;
};

const TABS = [
  ['overview', 'Overview'],
  ['work', 'Work'],
  ['pay', 'Pay'],
];

function Stat({ label, value }) {
  return (
    <div className="px-2 text-center min-w-0">
      <span className="block text-xs font-extrabold text-neutral-855 dark:text-warm-gray-150 truncate">
        {value || '—'}
      </span>
      <span className="block text-2xs uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 mt-0.5">
        {label}
      </span>
    </div>
  );
}

function SectionCard({ title, icon: Icon, children }) {
  return (
    <div className="premium-card space-y-3 bg-neutral-50/40 dark:bg-charcoal-900/10">
      <span className="text-2xs uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 flex items-center gap-1.5">
        {Icon && <Icon size={11} />} {title}
      </span>
      {children}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex justify-between gap-3 border-t border-neutral-100 dark:border-neutral-905 pt-2 text-xs">
      <span className="text-neutral-455 font-medium shrink-0">{label}</span>
      <span className="text-neutral-800 dark:text-warm-gray-200 font-semibold text-right truncate">
        {value || '—'}
      </span>
    </div>
  );
}

function HierarchyNode({ icon: Icon, label, value, last }) {
  return (
    <div className="flex gap-3 relative">
      {!last && (
        <span className="absolute left-[15px] top-8 bottom-[-12px] w-px bg-neutral-200 dark:bg-charcoal-800" />
      )}
      <div className="w-8 h-8 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-600 dark:text-[#10b981] flex items-center justify-center shrink-0 border border-neutral-250/20 dark:border-neutral-750 relative z-10">
        <Icon size={13} />
      </div>
      <div className="min-w-0 pt-0.5">
        <span className="block text-2xs uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500 leading-none">
          {label}
        </span>
        <span className="block text-xs font-bold text-neutral-855 dark:text-warm-gray-150 truncate mt-1">
          {value || '—'}
        </span>
      </div>
    </div>
  );
}

export default function ProfileDrawer({ emp, onClose, onEdit, onGrantAccess }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [copied, setCopied] = useState(false);

  // Escape closes the drawer (parity with the app's other overlays).
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyEmail = () => {
    if (!emp.email) return;
    navigator.clipboard.writeText(emp.email);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tenure = tenureOf(emp.join_date);

  // Compensation — only what the record actually holds (no estimated components).
  const salary = emp.salary || null;
  const ctc = salary?.ctc != null ? Number(salary.ctc) : null;
  const baseMonthly = salary?.base != null ? Number(salary.base) : null;
  const baseAnnual = baseMonthly != null ? baseMonthly * 12 : null;
  const basePct =
    ctc > 0 && baseAnnual > 0 ? Math.min(100, Math.round((baseAnnual / ctc) * 100)) : null;

  return (
    <section className="premium-card p-0 w-full bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl flex flex-col overflow-hidden animate-fade-in lg:max-h-[calc(100vh-6rem)]">

        {/* ---- Fixed identity header ---- */}
        <div className="p-4 sm:p-5 pb-0 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className={btnClass('primary')}>
                {initials(emp.full_name)}
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-neutral-900 dark:text-white truncate leading-snug">
                  {emp.full_name}
                </h3>
                <span className="text-neutral-500 dark:text-neutral-400 text-xs block truncate mt-0.5 font-medium">
                  {emp.designation?.title || 'No designation'}
                  {emp.department?.name ? ` · ${emp.department.name}` : ''}
                </span>
                <div className="flex items-center gap-1.5 pt-1.5 flex-wrap">
                  <span className="text-2xs px-2 py-0.5 bg-neutral-100 dark:bg-charcoal-800 text-neutral-600 dark:text-warm-gray-300 rounded font-mono font-bold border border-neutral-200/50 dark:border-neutral-800">
                    {emp.employee_code || '—'}
                  </span>
                  <span className={`text-2xs px-1.5 py-0.5 rounded font-bold font-mono uppercase leading-none ${statusClass(emp.status)}`}>
                    {emp.status}
                  </span>
                  {emp.entity?.code && (
                    <span className="text-2xs px-1.5 py-0.5 rounded font-bold font-mono uppercase leading-none bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 dark:text-neutral-400 border border-neutral-200/50 dark:border-neutral-800">
                      {emp.entity.code}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {onEdit && (
                <button
                  onClick={onEdit}
                  aria-label="Edit employee"
                  title="Edit employee"
                  className="p-2 hover:bg-neutral-100 dark:hover:bg-charcoal-800 rounded-lg text-neutral-450 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-warm-gray-100 transition-colors duration-200 border border-neutral-200/50 dark:border-neutral-800 cursor-pointer"
                >
                  <Pencil size={14} />
                </button>
              )}
              <button
                onClick={onClose}
                aria-label="Close profile"
                className="p-2 hover:bg-neutral-100 dark:hover:bg-charcoal-800 rounded-lg text-neutral-450 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-warm-gray-100 transition-colors duration-200 border border-neutral-200/50 dark:border-neutral-800 cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {/* Key stats */}
          <div className="grid grid-cols-3 divide-x divide-neutral-150 dark:divide-neutral-850 border-y border-neutral-150 dark:border-neutral-855 py-2.5 mt-4">
            <Stat label="Tenure" value={tenure} />
            <Stat label="Branch" value={emp.branch?.name || emp.branch?.code || 'Entity-wide'} />
            <Stat label="Grade" value={emp.designation?.grade} />
          </div>

          {/* Tab switcher */}
          <div className="profile-tabbar mobile-segmented flex p-0.5 bg-neutral-100 dark:bg-charcoal-800/60 rounded-xl mt-3.5" role="tablist">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={activeTab === key}
                onClick={() => setActiveTab(key)}
                className={`flex-1 py-1.5 text-base font-bold rounded-[10px] transition-all duration-200 cursor-pointer ${
                  activeTab === key
                    ? 'bg-white dark:bg-charcoal-900 text-neutral-900 dark:text-[#10b981] shadow-sm border border-neutral-200/60 dark:border-neutral-800'
                    : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-warm-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Scrollable tab content ---- */}
        <div className="flex-1 overflow-y-auto min-h-0 p-4 sm:p-5 pt-4 space-y-4">
          {activeTab === 'overview' && (
            <div className="space-y-4 animate-fade-in">
              <SectionCard title="Contact Information" icon={Mail}>
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 text-xs font-semibold text-neutral-700 dark:text-neutral-355 min-w-0">
                      <Mail size={12} className="text-neutral-455 shrink-0" />
                      <span className="truncate">{emp.email || 'No email on record'}</span>
                    </div>
                    {emp.email && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={copyEmail}
                          aria-label="Copy email address"
                          title="Copy email"
                          className="p-1.5 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 hover:text-black dark:hover:text-[#0ea971] transition-colors duration-200 cursor-pointer"
                        >
                          {copied ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                        <a
                          href={`mailto:${emp.email}`}
                          aria-label="Send email"
                          title="Send email"
                          className="p-1.5 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 hover:text-black dark:hover:text-[#0ea971] transition-colors duration-200 cursor-pointer"
                        >
                          <ExternalLink size={11} />
                        </a>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-neutral-100 dark:border-neutral-905 pt-2.5">
                    <div className="flex items-center gap-2.5 text-xs font-semibold text-neutral-700 dark:text-neutral-355 min-w-0">
                      <Phone size={12} className="text-neutral-455 shrink-0" />
                      <span className="truncate">{emp.phone || 'No phone on record'}</span>
                    </div>
                    {emp.phone && (
                      <a
                        href={`tel:${emp.phone}`}
                        aria-label="Call employee"
                        title="Call"
                        className="p-1.5 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 hover:text-black dark:hover:text-[#0ea971] transition-colors duration-200 cursor-pointer shrink-0"
                      >
                        <Phone size={11} />
                      </a>
                    )}
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Employment Snapshot" icon={Calendar}>
                <div className="space-y-2">
                  <DetailRow
                    label="Joined on"
                    value={
                      fmtDate(emp.join_date)
                        ? `${fmtDate(emp.join_date)}${tenure ? ` · ${tenure}` : ''}`
                        : null
                    }
                  />
                  <DetailRow label="Employee code" value={emp.employee_code} />
                  <DetailRow label="Status" value={emp.status} />
                </div>
              </SectionCard>
            </div>
          )}

          {activeTab === 'work' && (
            <div className="space-y-4 animate-fade-in">
              <SectionCard title="Organization Path" icon={Building2}>
                <div className="space-y-3 pt-1">
                  <HierarchyNode icon={Building2} label="Entity" value={emp.entity?.name} />
                  <HierarchyNode
                    icon={MapPin}
                    label="Location / Branch"
                    value={emp.branch ? emp.branch.name || emp.branch.code : 'Entity-wide'}
                  />
                  <HierarchyNode icon={Layers} label="Department" value={emp.department?.name} />
                  <HierarchyNode
                    icon={Briefcase}
                    label="Designation"
                    value={emp.designation?.title}
                    last
                  />
                </div>
              </SectionCard>

              <SectionCard title="Role Details" icon={Briefcase}>
                <div className="space-y-2">
                  <DetailRow label="Designation" value={emp.designation?.title} />
                  <DetailRow label="Grade level" value={emp.designation?.grade} />
                  <DetailRow label="Classification" value={emp.status} />
                </div>
              </SectionCard>
            </div>
          )}

          {activeTab === 'pay' && (
            <div className="space-y-4 animate-fade-in">
              <SectionCard title="Compensation" icon={Award}>
                {ctc != null || baseMonthly != null ? (
                  <div className="space-y-4">
                    {ctc != null && (
                      <div>
                        <span className="block text-2xs uppercase font-bold tracking-wider text-neutral-455 dark:text-neutral-500">
                          Annual CTC
                        </span>
                        <span className="block text-xl font-extrabold font-mono text-neutral-900 dark:text-white mt-0.5">
                          {inr(ctc)}
                        </span>
                      </div>
                    )}

                    {basePct != null && (
                      <div className="space-y-1.5">
                        <div className="flex h-2.5 rounded-full overflow-hidden bg-neutral-100 dark:bg-charcoal-800">
                          <div
                            style={{ width: `${basePct}%` }}
                            className="bg-[#0ea971]"
                            title={`Base: ${basePct}%`} aria-label={`Base: ${basePct}%`}
                          />
                          <div
                            style={{ width: `${100 - basePct}%` }}
                            className="bg-[#6b8f89]"
                            title={`Other components: ${100 - basePct}%`} aria-label={`Other components: ${100 - basePct}%`}
                          />
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-2xs text-neutral-455 dark:text-neutral-550 font-bold uppercase tracking-wider">
                          <span className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#0ea971]" /> Base ({basePct}%)
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#6b8f89]" /> Other components ({100 - basePct}%)
                          </span>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2 pt-1">
                      {baseMonthly != null && (
                        <DetailRow label="Monthly base salary" value={inr(baseMonthly)} />
                      )}
                      {baseAnnual != null && (
                        <DetailRow label="Annualized base" value={inr(baseAnnual)} />
                      )}
                    </div>

                    <p className="text-2xs text-neutral-450 dark:text-neutral-550 leading-relaxed border-t border-neutral-100 dark:border-neutral-905 pt-2.5">
                      Figures come directly from the employee record. Component breakdowns beyond
                      base pay are managed in Payroll.
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-6 space-y-2 bg-neutral-50/50 dark:bg-charcoal-900/20 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800">
                    <ShieldAlert size={20} className="mx-auto text-neutral-450" />
                    <p className="text-2xs text-neutral-500 px-6">
                      Compensation details are restricted or not recorded for this profile.
                    </p>
                  </div>
                )}
              </SectionCard>
            </div>
          )}
        </div>

        {/* ---- Footer actions ---- */}
        <div className="border-t border-neutral-200/80 dark:border-neutral-850 p-4 sm:px-5 flex flex-wrap gap-2 shrink-0">
          {onGrantAccess && (
            <button
              onClick={onGrantAccess}
              className="w-full py-2.5 bg-[#0ea971] hover:bg-[#0c9765] text-white rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer shadow-sm active:scale-99 flex items-center justify-center gap-1.5"
            >
              <KeyRound size={12} /> Give app access
            </button>
          )}
          {onEdit && (
            <button
              onClick={onEdit}
              className="flex-1 py-2.5 bg-neutral-900 hover:bg-[#0ea971] dark:bg-[#0ea971] dark:text-charcoal-900 dark:hover:bg-[#0ea971]/85 text-white rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer shadow-sm active:scale-99 flex items-center justify-center gap-1.5"
            >
              <Pencil size={12} /> Edit Profile
            </button>
          )}
          <button
            onClick={onClose}
            className={`${onEdit ? 'flex-1' : 'w-full'} py-2.5 bg-neutral-100 hover:bg-neutral-200 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 text-neutral-700 dark:text-warm-gray-200 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer`}
          >
            Close
          </button>
        </div>
    </section>
  );
}
