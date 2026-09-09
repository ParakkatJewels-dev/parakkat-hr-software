// "What can this person actually reach, and why?"
//
// Users & Access is organised around the role — pick a role, see who holds it. The question an
// administrator arrives with is the other one, about a named person, and answering it meant
// reading a row of role chips and doing the ladder arithmetic in your head.
//
// THREE ANSWERS, IN THE ORDER THEY ARE ASKED
//   1. Anything worth a second look, first, because that is why most people open this.
//   2. The screens they see — rendered from lib/navMap.js, the same definition the real sidebar
//      uses, so this cannot drift into telling a comfortable lie.
//   3. Every permission, with the assignment that granted it — the list you need to work out
//      which role to take away.
//
// WHY THIS IS NOT "LOG IN AS THEM"
// A true impersonation would need the database to answer as somebody else. It cannot here, and
// faking it client-side would be worse than not having it: the sidebar would be theirs and every
// row of data behind it would still be the administrator's own, because RLS answers to the signed
// -in user. An admin checking "can Ramesh see payroll?" would be shown Ramesh's menu over their
// own payslips and conclude the opposite of the truth. So this reports access rather than
// pretending to be them, which is the question that was actually being asked.
import React, { useMemo, useState } from 'react';
import {
  X, ShieldAlert, Eye, KeyRound, ChevronRight, Layers, UserRound, AlertTriangle,
} from 'lucide-react';
import { visibleSections, predicatesFor } from '../lib/navMap';
import { effectiveAccess, groupByPermission, accessFlags, accessSummary } from '../lib/accessInspect';
import { ROLE_PRIORITY } from '../lib/roles';

const SEVERITY = {
  high: 'border-red-300 dark:border-red-900/50 bg-red-50 dark:bg-red-950/25 text-red-800 dark:text-red-300',
  medium: 'border-amber-300 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/25 text-amber-800 dark:text-amber-300',
  low: 'border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300',
};

const prettyRole = (key) =>
  String(key || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const TABS = [
  { id: 'flags', label: 'Worth a look', icon: ShieldAlert },
  { id: 'screens', label: 'What they see', icon: Eye },
  { id: 'perms', label: 'Every permission', icon: KeyRound },
];

export default function UserAccessPanel({ user, roles = [], scopeLabel, onClose }) {
  const [tab, setTab] = useState('flags');

  const assignments = user?.roles ?? [];
  const isSuperAdmin = Boolean(user?.is_super_admin);

  // useRoles() gives the catalogue as the database holds it, so the ladder here is the real one
  // rather than a copy that has to be kept in step.
  const permissionsByRole = useMemo(() => {
    const out = {};
    for (const r of roles) out[r.key] = r.permissionKeys ?? [];
    return out;
  }, [roles]);

  const access = useMemo(
    () => effectiveAccess(assignments, permissionsByRole, { isSuperAdmin }),
    [assignments, permissionsByRole, isSuperAdmin]
  );
  const grouped = useMemo(() => groupByPermission(access), [access]);
  const flags = useMemo(() => accessFlags(access), [access]);
  const summary = useMemo(() => accessSummary(access), [access]);

  // The tree they get is decided by their most senior role, exactly as App.jsx decides it.
  const primaryRole = isSuperAdmin
    ? 'super_admin'
    : ROLE_PRIORITY.find((r) => assignments.some((a) => (a.role_key ?? a.role) === r)) ?? 'employee';

  const sections = useMemo(
    () => visibleSections(primaryRole, predicatesFor(access, { isSuperAdmin })),
    [primaryRole, access, isSuperAdmin]
  );

  const name = user?.employee_name || user?.email || 'this login';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-neutral-950/70 backdrop-blur-sm p-0 sm:p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Access for ${name}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-3xl max-h-[92vh] sm:max-h-[86vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800 shadow-2xl"
      >
        {/* header */}
        <div className="flex items-start gap-3 p-4 sm:p-5 border-b border-neutral-200 dark:border-neutral-800">
          <div className="w-9 h-9 rounded-xl bg-[#0ea971]/10 text-[#0c7d55] dark:text-[#10b981] flex items-center justify-center shrink-0">
            <UserRound size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-neutral-900 dark:text-white truncate">{name}</h2>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              {isSuperAdmin && (
                <span className="text-2xs font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#0ea971]/15 text-[#0c7d55] dark:text-[#10b981]">
                  super admin
                </span>
              )}
              {assignments.length === 0 && !isSuperAdmin ? (
                <span className="text-xs text-neutral-500">No roles — this login can sign in and see nothing.</span>
              ) : (
                assignments.map((a, i) => (
                  <span
                    key={`${a.role_key}-${a.scope_type}-${a.scope_id}-${i}`}
                    className="text-2xs font-mono px-1.5 py-0.5 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300"
                  >
                    {prettyRole(a.role_key)}
                    <span className="opacity-60"> · {scopeLabel?.(a.scope_type, a.scope_id) ?? a.scope_type}</span>
                  </span>
                ))
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close access panel"
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer shrink-0"
          >
            <X size={17} />
          </button>
        </div>

        {/* counts */}
        <div className="grid grid-cols-3 divide-x divide-neutral-200 dark:divide-neutral-800 border-b border-neutral-200 dark:border-neutral-800">
          <Count value={summary.beyondSelf} label="Over others" />
          <Count value={summary.selfOnly} label="Own records" />
          <Count value={summary.flags} label="Worth a look" accent={summary.flags > 0} />
        </div>

        {/* tabs */}
        <div className="mobile-segmented mobile-segmented-dense flex gap-1.5 p-3 sm:px-5 border-b border-neutral-200 dark:border-neutral-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-base font-bold cursor-pointer transition-colors ${
                tab === t.id
                  ? 'bg-[#0ea971]/15 text-[#0c7d55] dark:text-[#10b981] border border-[#0ea971]/25'
                  : 'bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 dark:text-neutral-400 border border-transparent hover:text-neutral-800 dark:hover:text-warm-gray-200'
              }`}
            >
              <t.icon size={12} /> {t.label}
              {t.id === 'flags' && flags.length > 0 && (
                <span className="text-2xs font-mono px-1.5 rounded-full bg-amber-500 text-white">{flags.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* body */}
        <div className="overflow-y-auto p-4 sm:p-5 space-y-3">
          {tab === 'flags' && (
            flags.length === 0 ? (
              <Empty>
                Nothing here needs a second look. This login holds no ability that reaches other
                people’s pay, documents, statutory details or roles.
              </Empty>
            ) : (
              flags.map((f) => (
                <div key={f.permission} className={`rounded-xl border p-3.5 ${SEVERITY[f.severity]}`}>
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                    <div className="min-w-0 space-y-1">
                      <p className="font-bold text-sm">{f.label}</p>
                      <p className="text-xs opacity-90">{f.why}</p>
                      <p className="text-2xs font-mono opacity-75">
                        {f.permission} · via {f.sources.map((s) => prettyRole(s.via)).join(', ')}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )
          )}

          {tab === 'screens' && (
            sections.length === 0 ? (
              <Empty>This login sees no screens at all — it can sign in and go nowhere.</Empty>
            ) : (
              <>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Their sidebar, built from the same definition the real one uses. Data inside each
                  screen is still scoped to their area by the database.
                </p>
                {sections.map((sec) => (
                  <div key={sec.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                    <div className="px-3.5 py-2 bg-neutral-50 dark:bg-neutral-900/60 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-2">
                      <Layers size={12} className="text-neutral-400 shrink-0" />
                      <span className="text-xs font-bold text-neutral-700 dark:text-neutral-200">{sec.label}</span>
                    </div>
                    <ul className="divide-y divide-neutral-100 dark:divide-neutral-900/60">
                      {sec.tabs.map((t) => (
                        <li key={t.id} className="px-3.5 py-2 flex items-center gap-2 text-sm">
                          <ChevronRight size={12} className="text-neutral-300 dark:text-neutral-700 shrink-0" />
                          <span className="text-neutral-700 dark:text-neutral-200">{t.label}</span>
                          {t.perm && (
                            <span className="ml-auto text-2xs font-mono text-neutral-400 shrink-0">{t.perm}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )
          )}

          {tab === 'perms' && (
            grouped.length === 0 ? (
              <Empty>No permissions at all.</Empty>
            ) : (
              <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden divide-y divide-neutral-100 dark:divide-neutral-900/60">
                {grouped.map((g) => (
                  <div key={g.permission} className="px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                    <span className="font-mono text-xs text-neutral-800 dark:text-neutral-200 sm:w-56 shrink-0">
                      {g.permission}
                    </span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400 min-w-0 flex-1">
                      {g.sources.map((s, i) => (
                        <span key={i}>
                          {i > 0 && ', '}
                          {prettyRole(s.via)}
                          <span className="opacity-70"> · {scopeLabel?.(s.scope_type, s.scope_id) ?? s.scope_type}</span>
                        </span>
                      ))}
                    </span>
                    <span
                      className={`text-2xs font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
                        g.beyondSelf
                          ? 'bg-[#0ea971]/12 text-[#0c7d55] dark:text-[#10b981]'
                          : 'bg-neutral-100 dark:bg-neutral-900 text-neutral-400'
                      }`}
                    >
                      {g.beyondSelf ? 'over others' : 'own only'}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function Count({ value, label, accent = false }) {
  return (
    <div className="px-3 py-2.5 text-center">
      <div className={`text-lg font-extrabold font-mono ${accent ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-900 dark:text-white'}`}>
        {value}
      </div>
      <div className="text-2xs uppercase tracking-wider text-neutral-500">{label}</div>
    </div>
  );
}

const Empty = ({ children }) => (
  <p className="text-sm text-neutral-500 dark:text-neutral-400 text-center py-8 px-4 max-w-prose mx-auto">
    {children}
  </p>
);
