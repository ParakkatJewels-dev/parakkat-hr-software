// My team — who is in the department I run, and putting the right people in it.
//
// WHY THIS SCREEN EXISTS. Everybody's department came from Easy Time Pro's enrolment data and a
// good deal of it is wrong. A department head could already see their department and act on almost
// everything in it — approve leave, read attendance, assign tasks, set goals — but could not say
// who was actually on the team. Fixing that through the Directory would have meant handing them
// employee.update, and salary and statutory ids sit on the same row.
//
// So: one screen, two verbs, and a database function behind each (migration 0099). Nothing here
// reaches Easy Time Pro — that integration is read-only towards the terminal by construction, so a
// correction made here changes nothing on any biometric reader.
import React, { useState, useDeferredValue } from 'react';
import {
  Users, UserPlus, UserMinus, Search, Loader2, AlertTriangle, History, X, Building2,
} from 'lucide-react';
import {
  useMyDepartments, useDepartmentMembers, useAssignableEmployees,
  useDepartmentMoves, useMoveEmployeeDepartment,
} from '../data/team';
import { btnClass } from './ui/Btn';
import IconInput from './ui/IconInput';
import ConfirmDialog from './ui/ConfirmDialog';
import { relativeTime } from '../lib/dates';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

const initials = (name) =>
  (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function Avatar({ name }) {
  return (
    <div className="w-8 h-8 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-700 dark:text-[#10b981] flex items-center justify-center font-bold text-xs shrink-0 font-mono select-none">
      {initials(name)}
    </div>
  );
}

export default function Team() {
  const { data: departments = [], isLoading: loadingDepts, error: deptError } = useMyDepartments();
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  // Whichever department they picked, else the first one they run.
  const department = departments.find((d) => d.id === selectedId) ?? departments[0] ?? null;
  const departmentId = department?.id ?? null;

  const { data: members = [], isLoading: loadingMembers } = useDepartmentMembers(departmentId);
  const move = useMoveEmployeeDepartment();

  if (loadingDepts) {
    return <div className="page-shell flex justify-center py-16 text-[#0ea971]"><Loader2 size={24} className="animate-spin" /></div>;
  }

  if (deptError) {
    return (
      <div className="page-shell">
        <div className="premium-card p-5 flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Couldn't load your teams.</p>
            <p className="text-neutral-500 dark:text-neutral-400 mt-1">
              {deptError.message}. If it mentions <code>my_departments</code>, run migration <code>0099</code>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Holding the permission but heading nothing is a real state — a manager whose grant is at branch
  // or entity scope over a company with no departments yet. Say so rather than showing an empty page.
  if (departments.length === 0) {
    return (
      <div className="page-shell">
        <div className="premium-card p-10 text-center text-xs text-neutral-500 space-y-1.5">
          <Building2 size={22} className="mx-auto text-neutral-300 dark:text-neutral-700" />
          <p className="font-semibold text-neutral-700 dark:text-neutral-300">No department to build.</p>
          <p>You don't head a department yet. An administrator assigns that in Administration → Users &amp; Access.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
            <Users size={20} className="text-[#0ea971]" /> My Team
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Who works in your department. Changes here stay in this app — nothing is written back to
            the attendance terminal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowHistory((v) => !v)} className={btnClass('ghost')}>
            <History size={13} /> <span>{showHistory ? 'Hide changes' : 'Recent changes'}</span>
          </button>
          <button onClick={() => setAdding(true)} className={btnClass('primary')}>
            <UserPlus size={14} /> <span>Add someone</span>
          </button>
        </div>
      </div>

      {/* Only worth a picker when they run more than one. */}
      {departments.length > 1 && (
        <div className="mobile-segmented flex flex-wrap items-center gap-1.5">
          {departments.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelectedId(d.id)}
              aria-current={d.id === departmentId ? 'page' : undefined}
              className={`text-base font-semibold px-2.5 py-1 rounded-lg border cursor-pointer transition-colors ${
                d.id === departmentId
                  ? 'bg-black text-white border-black dark:bg-[#0ea971] dark:text-white dark:border-neutral-700'
                  : 'bg-neutral-50 dark:bg-neutral-900 text-neutral-500 border-neutral-200 dark:border-neutral-850 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              {d.name} <span className="font-mono text-2xs opacity-70">{d.headcount}</span>
            </button>
          ))}
        </div>
      )}

      {move.error && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-600 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{move.error.message}</span>
        </div>
      )}

      {showHistory && <MoveHistory departmentId={departmentId} />}

      {adding && department && (
        <AddToTeam
          department={department}
          busy={move.isPending}
          onClose={() => { move.reset(); setAdding(false); }}
          onPick={async (employeeId) => {
            try { await move.mutateAsync({ employeeId, departmentId }); } catch { /* shown above */ }
          }}
        />
      )}

      <section className="space-y-2.5">
        <h2 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 px-1">
          {department?.name} · {members.length} {members.length === 1 ? 'person' : 'people'}
        </h2>

        {loadingMembers ? (
          <div className="flex justify-center py-12 text-[#0ea971]"><Loader2 size={20} className="animate-spin" /></div>
        ) : members.length === 0 ? (
          <div className="premium-card p-10 text-center text-xs text-neutral-500 space-y-1.5">
            <p className="font-semibold text-neutral-700 dark:text-neutral-300">Nobody in this department yet.</p>
            <p>Use <span className="font-semibold">Add someone</span> to bring in the people who work for you.</p>
          </div>
        ) : (
          <div className="premium-card p-0 overflow-hidden divide-y divide-neutral-100 dark:divide-neutral-900/60">
            {members.map((m) => (
              <div key={m.id} className="mobile-list-row flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar name={m.full_name} />
                  <div className="min-w-0">
                    <span className="block text-md font-bold text-neutral-900 dark:text-white truncate">{m.full_name}</span>
                    <span className="block text-2xs font-mono text-neutral-500">
                      {m.employee_code}
                      {m.designation?.title ? ` · ${m.designation.title}` : ''}
                      {m.branch?.code ? ` · ${m.branch.code}` : ''}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setRemoving(m)}
                  title={`Remove ${m.full_name} from ${department?.name}`}
                  aria-label={`Remove ${m.full_name} from the team`}
                  className="p-1.5 rounded-lg text-neutral-400 hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-950/40 cursor-pointer shrink-0"
                >
                  <UserMinus size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>


      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.full_name}?`}
          confirmLabel="Remove from team"
          busy={move.isPending}
          error={move.error?.message}
          onCancel={() => { move.reset(); setRemoving(null); }}
          onConfirm={async () => {
            try { await move.mutateAsync({ employeeId: removing.id, departmentId: null }); setRemoving(null); }
            catch { /* shown in the dialog */ }
          }}
        >
          <p>They leave <span className="font-semibold">{department?.name}</span> and end up in no department at all until someone puts them in one.</p>
          <p>Their record, attendance and payslips are untouched. This does not remove them from the company.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** The picker. Deliberately search-first: the pool is everyone in the company, which is not a list. */
function AddToTeam({ department, busy, onClose, onPick }) {
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q);
  const { data: candidates = [], isLoading } = useAssignableEmployees(department.id, deferredQ);

  return (
    <div className="premium-card form-section space-y-4 animate-fade-in">
      <div className="form-section-header flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <UserPlus size={15} className="text-[#0ea971] shrink-0" />
          <div className="min-w-0">
            <h3 className="font-bold text-sm text-neutral-900 dark:text-white">Add to {department.name}</h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              Anyone active in the same company. Someone already on another team will be moved across,
              and their old team will see them go.
            </p>
          </div>
        </div>
        <button
          type="button" onClick={onClose} aria-label="Close add to team"
          className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer shrink-0"
        >
          <X size={16} />
        </button>
      </div>

      <IconInput
        icon={Search}
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search people to add"
        placeholder="Search by name or employee code…"
        inputClassName={INPUT}
      />

      {isLoading ? (
        <div className="flex justify-center py-8 text-[#0ea971]"><Loader2 size={18} className="animate-spin" /></div>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-neutral-500 py-4 text-center">
          {q.trim() ? `Nobody active matches “${q.trim()}” in this company.` : 'Everyone in this company is already on your team.'}
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto border border-neutral-200 dark:border-neutral-850 rounded-xl divide-y divide-neutral-150 dark:divide-neutral-850/60">
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              onClick={() => onPick(c.id)}
              className="w-full text-left px-3 py-2.5 hover:bg-neutral-100 dark:hover:bg-neutral-900 flex items-center justify-between gap-3 cursor-pointer disabled:opacity-50"
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Avatar name={c.full_name} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-neutral-800 dark:text-neutral-200 truncate">{c.full_name}</span>
                  <span className="block text-2xs font-mono text-neutral-500">
                    {c.employee_code}
                    {c.branch_code ? ` · ${c.branch_code}` : ''}
                  </span>
                </span>
              </span>
              {/* Where they are now, so nobody is moved off another team by accident. */}
              <span className={`text-2xs font-mono shrink-0 ${c.department_name ? 'text-amber-600 dark:text-amber-300' : 'text-neutral-400'}`}>
                {c.department_name ? `now in ${c.department_name}` : 'no department'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What was changed by hand — the list to reconcile against once Easy Time Pro is corrected. */
function MoveHistory({ departmentId }) {
  const { data: moves = [], isLoading } = useDepartmentMoves(departmentId);
  if (isLoading) return null;
  return (
    <section className="premium-card space-y-2">
      <h2 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500">
        Recent changes
      </h2>
      {moves.length === 0 ? (
        <p className="text-xs text-neutral-500">Nothing has been moved in or out of this team yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {moves.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate">
                <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                  {m.employee?.full_name ?? 'Someone'}
                </span>
                <span className="text-neutral-500">
                  {' '}{m.from_department?.name ?? 'no department'} → {m.to_department?.name ?? 'no department'}
                </span>
              </span>
              <span className="font-mono text-2xs text-neutral-400 shrink-0">{relativeTime(m.moved_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
