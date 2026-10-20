// Team ledgers: the Work Ledgers a line manager may read (people below them in their department,
// branch, zone or company — see app.ledger_can_read in 0169). Read-only, and never reminders or
// calendars. /team-ledgers lists them; /team-ledgers/<user id> opens one.
import React, { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLedgerTeam } from '../data/workLedger';
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
    <div className="ledger-page">
      <header className="ledger-masthead">
        <div>
          <p className="ledger-kicker">Work Ledger</p>
          <h1>Team ledgers</h1>
          <p className="ledger-standfirst">Read the ledgers of the people you manage. You can see their work and reports, never their reminders or calendar, and you cannot change anything.</p>
        </div>
      </header>
      {selected && <p className="ledger-alert" role="alert">That ledger link is not valid.</p>}
      {team.isLoading && <p className="ledger-quiet">Finding your team…</p>}
      {team.error && <p className="ledger-alert" role="alert">{humanDbError(team.error) || 'Your team could not be loaded.'}</p>}
      {!team.isLoading && !team.error && !people.length && (
        <p className="ledger-empty">No ledgers to show. This lists people whose line manager you are, in your department, branch, zone or company.</p>
      )}
      {departments.map((department) => (
        <section key={department} className="ledger-section" aria-label={department}>
          <h3>{department} <span className="ledger-count">{people.filter((p) => (p.department ?? 'No department') === department).length}</span></h3>
          <ul className="ledger-rows-list">
            {people.filter((p) => (p.department ?? 'No department') === department).map((person) => (
              <li key={person.user_id}>
                <button type="button" className="ledger-idea-row" onClick={() => navigate(`/team-ledgers/${person.user_id}`)}>
                  <span className="ledger-item-title">{person.name}</span>
                  <span className="ledger-quiet">{[person.designation, person.code].filter(Boolean).join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
