// Team ledgers: the Work Ledgers a line manager may read (people below them in their department,
// branch, zone or company — see app.ledger_can_read in 0169). Read-only, and never reminders or
// calendars. /team-ledgers lists them; /team-ledgers/<user id> opens one.
import React, { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { useLedgerTeam } from '../data/workLedger';
import { SkeletonRows } from './ui/Skeleton';
import { humanDbError } from '../lib/dbErrors';
import './ledger/ledger.css';

const WorkLedger = lazy(() => import('./WorkLedger'));
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function TeamLedgers() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const selected = pathname.replace(/^\/+|\/+$/g, '').split('/')[1] || null;
  const team = useLedgerTeam();
  if (selected && USER_ID.test(selected)) {
    return (
      <Suspense fallback={<p className="ledger-quiet">Opening the ledger…</p>}>
        <WorkLedger key={selected} owner={selected} onBack={() => navigate('/team-ledgers')} />
      </Suspense>
    );
  }
  const people = team.data ?? [];
  const departments = [...new Set(people.map((person) => person.department ?? 'No department'))];
  return (
    <div className="page-shell space-y-5 animate-fade-in ledger-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
            <Users size={20} className="text-brand-ink" /> Team ledgers
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Read the work ledgers of the people you manage. You see their work and reports, never their reminders or calendar, and you cannot change anything.
          </p>
        </div>
      </div>
      {selected && <p className="ledger-alert" role="alert">That ledger link is not valid.</p>}
      {team.isLoading && <SkeletonRows rows={4} label="Finding your team" />}
      {team.error && <p className="ledger-alert" role="alert">{humanDbError(team.error) || 'Your team could not be loaded.'}</p>}
      {!team.isLoading && !team.error && !people.length && (
        <div className="premium-card p-8 text-center text-xs text-neutral-500">
          No ledgers to show. This lists people whose line manager you are, in your department, branch, zone or company.
        </div>
      )}
      {departments.map((department) => {
        const members = people.filter((p) => (p.department ?? 'No department') === department);
        return (
          <section key={department} className="premium-card" aria-label={department}>
            <h3 className="text-base font-bold text-neutral-900 dark:text-white flex items-center gap-2 mb-2">{department}
              <span className="text-xs font-semibold text-neutral-500">{members.length}</span></h3>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {members.map((person) => (
                <li key={person.user_id}>
                  <button type="button" className="w-full flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-left cursor-pointer group"
                    onClick={() => navigate(`/team-ledgers/${person.user_id}`)}>
                    <span className="text-sm font-bold text-neutral-900 dark:text-white group-hover:text-brand-ink">{person.name}</span>
                    <span className="text-xs text-neutral-500">{[person.designation, person.code].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
